import { Account } from "@near-js/accounts";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import {
  ChainSession,
  ChainStreetSide,
  type ChainSession as Session,
  type ChainStreetSide as StreetSide,
} from "@estate/shared";
import { z } from "zod";

const AccessKey = z.object({
  permission: z.object({
    FunctionCall: z.object({
      receiver_id: z.string(),
      method_names: z.array(z.string()),
      allowance: z.string().regex(/^[0-9]+$/),
    }),
  }),
});
const ChainTime = z.number().int().safe().nonnegative();
const TowerFloor = z.array(ChainSession.nullable()).length(8);
const MAX_ALLOWANCE_YOCTO = 5n * 10n ** 24n;
const GAS = 50n * 10n ** 12n;

export interface ExpiryGateway {
  chainTime(): Promise<number>;
  streetSide(roadId: string, side: "North" | "South"): Promise<StreetSide>;
  towerFloor(siteId: string, floor: number): Promise<(Session | null)[]>;
  settleExpired(sessionId: number): Promise<void>;
  session(sessionId: number): Promise<Session | null>;
}

export class NearExpiryGateway implements ExpiryGateway {
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
      throw new Error("Expiry account and contract must be testnet accounts");
    if (!rpcUrl.startsWith("https://"))
      throw new Error("Expiry RPC URL must use HTTPS");
    this.signer = KeyPairSigner.fromSecretKey(secretKey as `ed25519:${string}`);
    this.account = new Account(
      accountId,
      new JsonRpcProvider({ url: rpcUrl }),
      this.signer,
    );
  }

  private async query(requestType: string, fields: object): Promise<unknown> {
    const response = await this.fetcher(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "near-estate-expiry",
        method: "query",
        params: {
          request_type: requestType,
          finality: "final",
          ...fields,
        },
      }),
    });
    if (!response.ok) throw new Error(`Expiry RPC failed (${response.status})`);
    const body = (await response.json()) as {
      error?: unknown;
      result?: unknown;
    };
    if (body.error || !body.result)
      throw new Error(`Expiry ${requestType} query failed`);
    return body.result;
  }

  private async view(method: string, args: object): Promise<unknown> {
    const result = (await this.query("call_function", {
      account_id: this.contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    })) as { result?: number[] };
    if (!result.result) throw new Error(`Expiry view ${method} failed`);
    return JSON.parse(Buffer.from(result.result).toString("utf8")) as unknown;
  }

  async chainTime(): Promise<number> {
    const publicKey = (await this.signer.getPublicKey()).toString();
    const [time, access] = await Promise.all([
      this.view("chain_time_seconds", {}),
      this.query("view_access_key", {
        account_id: this.accountId,
        public_key: publicKey,
      }),
    ]);
    const key = AccessKey.safeParse(access);
    if (
      !key.success ||
      key.data.permission.FunctionCall.receiver_id !== this.contractId ||
      key.data.permission.FunctionCall.method_names.length !== 1 ||
      key.data.permission.FunctionCall.method_names[0] !== "settle_expired" ||
      BigInt(key.data.permission.FunctionCall.allowance) === 0n ||
      BigInt(key.data.permission.FunctionCall.allowance) > MAX_ALLOWANCE_YOCTO
    )
      throw new Error(
        "Expiry key must have a finite settle_expired-only allowance",
      );
    return ChainTime.parse(time);
  }

  async streetSide(
    roadId: string,
    side: "North" | "South",
  ): Promise<StreetSide> {
    return ChainStreetSide.parse(
      await this.view("get_street_side", { road_id: roadId, side }),
    );
  }

  async towerFloor(siteId: string, floor: number): Promise<(Session | null)[]> {
    return TowerFloor.parse(
      await this.view("get_tower_floor_sessions", {
        site_id: siteId,
        floor,
      }),
    );
  }

  async session(sessionId: number): Promise<Session | null> {
    return ChainSession.nullable().parse(
      await this.view("get_session", { session_id: sessionId }),
    );
  }

  async settleExpired(sessionId: number): Promise<void> {
    const outcome = await this.account.callFunctionRaw({
      contractId: this.contractId,
      methodName: "settle_expired",
      args: { expected_session_id: sessionId },
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
      throw new Error("Expiry settlement did not finalize successfully");
  }
}

export type ExpirySweepResult = {
  scanned: number;
  eligible: number;
  attempted: number;
  settled: number;
  raced: number;
  failed: number;
};

export class ExpirySweeper {
  constructor(
    private readonly gateway: ExpiryGateway,
    private readonly roadIds: readonly string[],
    private readonly towers: readonly { id: string; capacity: number }[],
    private readonly maxSettlements = 8,
  ) {
    if (
      !roadIds.length ||
      !Number.isSafeInteger(maxSettlements) ||
      maxSettlements < 1 ||
      maxSettlements > 32
    )
      throw new Error("Expiry sweep needs roads and a limit from 1 to 32");
    if (towers.some(({ capacity }) => capacity < 1 || capacity % 8 !== 0))
      throw new Error("Tower capacity must be a positive multiple of eight");
  }

  async runOnce(): Promise<ExpirySweepResult> {
    const now = await this.gateway.chainTime();
    const expired: Session[] = [];
    const seen = new Set<number>();
    let scanned = 0;
    const consider = (
      session: Session | null,
      locationId: string,
      slot: number,
      facility: "Curb" | "Tower",
    ) => {
      if (!session) return;
      scanned++;
      if (
        session.location_id !== locationId ||
        session.slot !== slot ||
        session.facility !== facility ||
        seen.has(session.id)
      )
        throw new Error("Expiry sweep read an inconsistent parking space");
      seen.add(session.id);
      if (session.expires_at <= now) expired.push(session);
    };
    for (const roadId of this.roadIds) {
      for (const side of ["North", "South"] as const) {
        const street = await this.gateway.streetSide(roadId, side);
        if (street.road_id !== roadId || street.side !== side)
          throw new Error("Expiry sweep read the wrong street side");
        for (const { plot, slots } of street.plots)
          slots.forEach((session, slot) =>
            consider(session, plot.plot.id, slot, "Curb"),
          );
      }
    }
    for (const tower of this.towers) {
      for (let floor = 0; floor < tower.capacity / 8; floor++) {
        const sessions = await this.gateway.towerFloor(tower.id, floor);
        if (sessions.length !== 8)
          throw new Error("Expiry sweep read an incomplete tower floor");
        sessions.forEach((session, index) =>
          consider(session, tower.id, floor * 8 + index, "Tower"),
        );
      }
    }
    expired.sort((a, b) => a.expires_at - b.expires_at || a.id - b.id);
    let settled = 0;
    let raced = 0;
    let failed = 0;
    for (const session of expired.slice(0, this.maxSettlements)) {
      try {
        await this.gateway.settleExpired(session.id);
        settled++;
      } catch (error) {
        try {
          if ((await this.gateway.session(session.id)) === null) {
            raced++;
            continue;
          }
        } catch {
          // An uncertain transaction is left for the next pass.
        }
        failed++;
        console.error(`Expiry settlement ${session.id} needs retry`, error);
      }
    }
    return {
      scanned,
      eligible: expired.length,
      attempted: Math.min(expired.length, this.maxSettlements),
      settled,
      raced,
      failed,
    };
  }
}
