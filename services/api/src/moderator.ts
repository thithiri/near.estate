import { Account } from "@near-js/accounts";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { z } from "zod";
import type {
  ChainAppearanceReference,
  ChainMediaIdentity,
  ChainMediaProposal,
} from "@estate/shared";

const MODERATION_GAS = 60n * 10n ** 12n;
const MAX_MODERATOR_ALLOWANCE_YOCTO = 500_000_000_000_000_000_000_000n;
const MODERATION_METHODS = [
  "approve_appearance",
  "reject_appearance",
  "revoke_appearance",
  "approve_media",
  "reject_media",
  "revoke_media",
].sort();
const ModeratorRoles = z.tuple([z.string(), z.string(), z.string()]);
const ModeratorAccessKey = z.object({
  permission: z.object({
    FunctionCall: z.object({
      receiver_id: z.string(),
      method_names: z.array(z.string()),
      allowance: z.string().regex(/^[0-9]+$/),
    }),
  }),
});

export interface ModeratorGateway {
  checkAuthorization(): Promise<void>;
  approveAppearance(
    plotId: string,
    expected: ChainAppearanceReference,
  ): Promise<void>;
  rejectAppearance(
    plotId: string,
    expected: ChainAppearanceReference,
    reason: string,
  ): Promise<void>;
  revokeAppearance(
    plotId: string,
    expectedRevision: number,
    expectedManifestHash: string,
    reason: string,
  ): Promise<void>;
  approveMedia(
    plotId: string,
    kind: "Logo" | "Billboard",
    expected: ChainMediaProposal,
  ): Promise<void>;
  rejectMedia(
    plotId: string,
    kind: "Logo" | "Billboard",
    expected: ChainMediaProposal,
    reason: string,
  ): Promise<void>;
  revokeMedia(
    plotId: string,
    kind: "Logo" | "Billboard",
    expectedMediaRevision: number,
    expectedContent: ChainMediaIdentity,
    reason: string,
  ): Promise<void>;
}

export class NearModeratorGateway implements ModeratorGateway {
  private readonly account: Pick<Account, "callFunctionRaw">;
  private readonly signer: KeyPairSigner;

  constructor(
    private readonly contractId: string,
    private readonly accountId: string,
    secretKey: string,
    private readonly rpcUrl = "https://test.rpc.fastnear.com",
    private readonly fetcher: typeof fetch = (input, init) =>
      fetch(input, init),
    accountOverride?: Pick<Account, "callFunctionRaw">,
  ) {
    if (
      !/^[a-z0-9._-]+\.testnet$/.test(contractId) ||
      !/^[a-z0-9._-]+\.testnet$/.test(accountId)
    )
      throw new Error("Moderator and contract must be testnet accounts");
    if (!rpcUrl.startsWith("https://"))
      throw new Error("Moderator RPC URL must use HTTPS");
    this.signer = KeyPairSigner.fromSecretKey(secretKey as `ed25519:${string}`);
    this.account =
      accountOverride ??
      new Account(accountId, new JsonRpcProvider({ url: rpcUrl }), this.signer);
  }

  private async viewRoles(): Promise<unknown> {
    const response = await this.fetcher(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "near-estate-moderator-role",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: this.contractId,
          method_name: "get_roles",
          args_base64: Buffer.from("{}").toString("base64"),
        },
      }),
    });
    if (!response.ok)
      throw new Error(`Moderator role RPC failed (${response.status})`);
    const body = (await response.json()) as {
      error?: unknown;
      result?: { result?: number[] };
    };
    if (body.error || !body.result?.result)
      throw new Error("Moderator role is unavailable");
    return JSON.parse(
      Buffer.from(body.result.result).toString("utf8"),
    ) as unknown;
  }

  async checkAuthorization(): Promise<void> {
    const publicKey = (await this.signer.getPublicKey()).toString();
    const keyRequest = this.fetcher(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "near-estate-moderator-key",
        method: "query",
        params: {
          request_type: "view_access_key",
          finality: "final",
          account_id: this.accountId,
          public_key: publicKey,
        },
      }),
    });
    const [response, roles] = await Promise.all([keyRequest, this.viewRoles()]);
    if (ModeratorRoles.parse(roles)[1] !== this.accountId)
      throw new Error("Configured account is not the contract moderator");
    if (!response.ok)
      throw new Error(`Moderator key RPC failed (${response.status})`);
    const body = (await response.json()) as {
      error?: unknown;
      result?: unknown;
    };
    if (body.error) throw new Error("Moderator access key is unavailable");
    const key = ModeratorAccessKey.safeParse(body.result);
    if (!key.success)
      throw new Error("Moderator key must have moderation-only permission");
    const permission = key.data.permission.FunctionCall;
    const methodNames = [...permission.method_names].sort();
    const matchesMethods =
      methodNames.length === MODERATION_METHODS.length &&
      methodNames.every(
        (method, index) => method === MODERATION_METHODS[index],
      );
    const allowance = BigInt(permission.allowance);
    if (
      permission.receiver_id !== this.contractId ||
      !matchesMethods ||
      allowance === 0n ||
      allowance > MAX_MODERATOR_ALLOWANCE_YOCTO
    )
      throw new Error("Moderator key must have moderation-only permission");
  }

  private async call(methodName: string, args: object): Promise<void> {
    await this.checkAuthorization();
    const outcome = await this.account.callFunctionRaw({
      contractId: this.contractId,
      methodName,
      args,
      gas: MODERATION_GAS,
      deposit: 0n,
      waitUntil: "FINAL",
    });
    if (
      outcome.final_execution_status !== "FINAL" ||
      outcome.status === null ||
      typeof outcome.status !== "object" ||
      !("SuccessValue" in outcome.status)
    )
      throw new Error("Moderator transaction did not finalize successfully");
  }

  async approveAppearance(
    plotId: string,
    expected: ChainAppearanceReference,
  ): Promise<void> {
    await this.call("approve_appearance", { plot_id: plotId, expected });
  }

  async rejectAppearance(
    plotId: string,
    expected: ChainAppearanceReference,
    reason: string,
  ): Promise<void> {
    await this.call("reject_appearance", { plot_id: plotId, expected, reason });
  }

  async revokeAppearance(
    plotId: string,
    expectedRevision: number,
    expectedManifestHash: string,
    reason: string,
  ): Promise<void> {
    await this.call("revoke_appearance", {
      plot_id: plotId,
      expected_revision: expectedRevision,
      expected_manifest_hash: expectedManifestHash,
      reason,
    });
  }

  async approveMedia(
    plotId: string,
    kind: "Logo" | "Billboard",
    expected: ChainMediaProposal,
  ): Promise<void> {
    await this.call("approve_media", { plot_id: plotId, kind, expected });
  }

  async rejectMedia(
    plotId: string,
    kind: "Logo" | "Billboard",
    expected: ChainMediaProposal,
    reason: string,
  ): Promise<void> {
    await this.call("reject_media", {
      plot_id: plotId,
      kind,
      expected,
      reason,
    });
  }

  async revokeMedia(
    plotId: string,
    kind: "Logo" | "Billboard",
    expectedMediaRevision: number,
    expectedContent: ChainMediaIdentity,
    reason: string,
  ): Promise<void> {
    await this.call("revoke_media", {
      plot_id: plotId,
      kind,
      expected_media_revision: expectedMediaRevision,
      expected_content: expectedContent,
      reason,
    });
  }
}
