import { randomInt } from "node:crypto";
import { Account } from "@near-js/accounts";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import {
  ChainStreetSide,
  type ChainStreetSide as StreetSide,
} from "@estate/shared";
import { z } from "zod";

const PatrolConfig = z.object({
  inspector_min_age_seconds: z.number().int().min(0).max(86_400),
  inspector_max_attempts_per_window: z.number().int().min(1).max(100),
});
const InspectorRoles = z.tuple([z.string(), z.string(), z.string()]);
const InspectorAccessKey = z.object({
  permission: z.object({
    FunctionCall: z.object({
      receiver_id: z.string(),
      method_names: z.array(z.string()),
      allowance: z.string().regex(/^[0-9]+$/),
    }),
  }),
});
const ChainTime = z.number().int().nonnegative();
const GAS = 50n * 10n ** 12n;
const MAX_INSPECTOR_ALLOWANCE_YOCTO = 250_000_000_000_000_000_000_000n;

export interface InspectorGateway {
  readRules(): Promise<{
    minAgeSeconds: number;
    maxAttempts: number;
    nowSeconds: number;
  }>;
  streetSide(roadId: string, side: "North" | "South"): Promise<StreetSide>;
  inspect(plotId: string, slot: number, sessionId: number): Promise<void>;
}

export class NearInspectorGateway implements InspectorGateway {
  private readonly account: Account;
  private readonly signer: KeyPairSigner;

  constructor(
    private readonly contractId: string,
    private readonly accountId: string,
    secretKey: string,
    private readonly rpcUrl = "https://test.rpc.fastnear.com",
    private readonly fetcher: typeof fetch = (input, init) =>
      fetch(input, init),
  ) {
    if (
      !/^[a-z0-9._-]+\.testnet$/.test(contractId) ||
      !/^[a-z0-9._-]+\.testnet$/.test(accountId)
    )
      throw new Error("Inspector and contract must be testnet accounts");
    if (!rpcUrl.startsWith("https://"))
      throw new Error("Inspector RPC URL must use HTTPS");
    this.signer = KeyPairSigner.fromSecretKey(secretKey as `ed25519:${string}`);
    this.account = new Account(
      accountId,
      new JsonRpcProvider({ url: rpcUrl }),
      this.signer,
    );
  }

  private async checkKey(): Promise<void> {
    const publicKey = (await this.signer.getPublicKey()).toString();
    const response = await this.fetcher(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "near-estate-inspector-key",
        method: "query",
        params: {
          request_type: "view_access_key",
          finality: "final",
          account_id: this.accountId,
          public_key: publicKey,
        },
      }),
    });
    if (!response.ok)
      throw new Error(`Inspector key RPC failed (${response.status})`);
    const body = (await response.json()) as {
      error?: unknown;
      result?: unknown;
    };
    if (body.error) throw new Error("Inspector access key is unavailable");
    const key = InspectorAccessKey.safeParse(body.result);
    if (
      !key.success ||
      key.data.permission.FunctionCall.receiver_id !== this.contractId ||
      key.data.permission.FunctionCall.method_names.length !== 1 ||
      key.data.permission.FunctionCall.method_names[0] !== "inspect" ||
      BigInt(key.data.permission.FunctionCall.allowance) === 0n ||
      BigInt(key.data.permission.FunctionCall.allowance) >
        MAX_INSPECTOR_ALLOWANCE_YOCTO
    )
      throw new Error(
        "Inspector key must have a positive inspect-only allowance",
      );
  }

  private async view(method: string, args: object): Promise<unknown> {
    const response = await this.fetcher(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "near-estate-inspector",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: this.contractId,
          method_name: method,
          args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        },
      }),
    });
    if (!response.ok)
      throw new Error(`Inspector RPC failed (${response.status})`);
    const body = (await response.json()) as {
      error?: unknown;
      result?: { result?: number[] };
    };
    if (body.error || !body.result?.result)
      throw new Error(`Inspector view ${method} failed`);
    return JSON.parse(
      Buffer.from(body.result.result).toString("utf8"),
    ) as unknown;
  }

  async readRules(): Promise<{
    minAgeSeconds: number;
    maxAttempts: number;
    nowSeconds: number;
  }> {
    const [config, time, roles] = await Promise.all([
      this.view("get_config", {}),
      this.view("chain_time_seconds", {}),
      this.view("get_roles", {}),
      this.checkKey(),
    ]);
    if (InspectorRoles.parse(roles)[2] !== this.accountId)
      throw new Error("Configured account is not the contract inspector");
    const parsed = PatrolConfig.parse(config);
    return {
      minAgeSeconds: parsed.inspector_min_age_seconds,
      maxAttempts: parsed.inspector_max_attempts_per_window,
      nowSeconds: ChainTime.parse(time),
    };
  }

  async streetSide(
    roadId: string,
    side: "North" | "South",
  ): Promise<StreetSide> {
    return ChainStreetSide.parse(
      await this.view("get_street_side", { road_id: roadId, side }),
    );
  }

  async inspect(
    plotId: string,
    slot: number,
    sessionId: number,
  ): Promise<void> {
    const outcome = await this.account.callFunctionRaw({
      contractId: this.contractId,
      methodName: "inspect",
      args: { plot_id: plotId, slot, expected_session_id: sessionId },
      gas: GAS,
      deposit: 0n,
      waitUntil: "FINAL",
    });
    if (
      outcome.final_execution_status !== "FINAL" ||
      outcome.status === null ||
      typeof outcome.status !== "object" ||
      !("SuccessValue" in outcome.status)
    )
      throw new Error("Inspector transaction did not finalize successfully");
  }
}

export type PatrolResult = {
  roadId: string;
  side: "North" | "South";
  eligible: number;
  attempted: number;
  failed: number;
};

export class InspectorPatrol {
  constructor(
    private readonly gateway: InspectorGateway,
    private readonly roadIds: readonly string[],
    private readonly random: (max: number) => number = randomInt,
  ) {
    if (!roadIds.length) throw new Error("Patrol needs at least one road");
  }

  async runOnce(): Promise<PatrolResult> {
    const roadId = this.roadIds[this.random(this.roadIds.length)]!;
    const side = this.random(2) === 0 ? "North" : "South";
    const [rules, street] = await Promise.all([
      this.gateway.readRules(),
      this.gateway.streetSide(roadId, side),
    ]);
    if (street.road_id !== roadId || street.side !== side)
      throw new Error("Patrol read the wrong street side");
    const candidates = street.plots.flatMap(({ plot, slots }) =>
      slots.flatMap((session, slot) =>
        session &&
        !session.legal &&
        !session.inspector_attempted &&
        session.facility === "Curb" &&
        session.location_id === plot.plot.id &&
        session.slot === slot &&
        rules.nowSeconds < session.expires_at &&
        rules.nowSeconds - session.started_at >= rules.minAgeSeconds
          ? [{ plotId: plot.plot.id, slot, sessionId: session.id }]
          : [],
      ),
    );
    const limit = Math.min(
      2,
      rules.maxAttempts,
      Math.ceil(candidates.length / 4),
    );
    let failed = 0;
    for (let i = 0; i < limit; i++) {
      const index = this.random(candidates.length);
      const [selected] = candidates.splice(index, 1);
      try {
        await this.gateway.inspect(
          selected!.plotId,
          selected!.slot,
          selected!.sessionId,
        );
      } catch (error) {
        failed++;
        console.error("Inspector attempt failed", error);
      }
    }
    return {
      roadId,
      side,
      eligible: candidates.length + limit,
      attempted: limit,
      failed,
    };
  }
}
