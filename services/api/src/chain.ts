import { ChainPlot, type ChainPlot as PlotView } from "@estate/shared";
import { z } from "zod";

export interface ChainGateway {
  hasAccessKey(accountId: string, publicKey: string): Promise<boolean>;
  plot(plotId: string): Promise<PlotView | null>;
}

export class NearChainGateway implements ChainGateway {
  constructor(
    readonly contractId: string,
    readonly rpcUrl = "https://test.rpc.fastnear.com",
    private readonly fetcher: typeof fetch = (input, init) =>
      fetch(input, init),
  ) {
    if (!/^[a-z0-9._-]+\.testnet$/.test(contractId))
      throw new Error("Expected a testnet contract account ID");
    if (!rpcUrl.startsWith("https://"))
      throw new Error("RPC URL must use HTTPS");
  }

  private async query(params: object): Promise<Record<string, unknown>> {
    const response = await this.fetcher(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "near-estate-api",
        method: "query",
        params: { finality: "final", ...params },
      }),
    });
    if (!response.ok) throw new Error(`NEAR RPC failed (${response.status})`);
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null)
      throw new Error("NEAR RPC returned an invalid response");
    return body as Record<string, unknown>;
  }

  async cityVersion(): Promise<1 | 2> {
    const body = await this.query({
      request_type: "call_function",
      account_id: this.contractId,
      method_name: "city_version",
      args_base64: Buffer.from("{}").toString("base64"),
    });
    if (body.error)
      throw new Error(
        `NEAR RPC rejected city version: ${JSON.stringify(body.error)}`,
      );
    const result = z
      .object({
        result: z.array(z.number().int().min(0).max(255)).optional(),
        error: z.string().optional(),
      })
      .parse(body.result);
    if (result.error) {
      if (result.error.includes("MethodResolveError(MethodNotFound)")) return 1;
      throw new Error(`NEAR RPC rejected city version: ${result.error}`);
    }
    if (!result.result) throw new Error("NEAR RPC omitted the city version");
    const value: unknown = JSON.parse(
      Buffer.from(result.result).toString("utf8"),
    );
    return z.union([z.literal(1), z.literal(2)]).parse(value);
  }

  async npcSiteCount(): Promise<number> {
    const body = await this.query({
      request_type: "call_function",
      account_id: this.contractId,
      method_name: "npc_site_count",
      args_base64: Buffer.from("{}").toString("base64"),
    });
    if (body.error)
      throw new Error(
        `NEAR RPC rejected NPC site count: ${JSON.stringify(body.error)}`,
      );
    const result = z
      .object({ result: z.array(z.number().int().min(0).max(255)) })
      .parse(body.result);
    return z
      .number()
      .int()
      .min(0)
      .max(20)
      .parse(JSON.parse(Buffer.from(result.result).toString("utf8")));
  }

  async hasAccessKey(accountId: string, publicKey: string): Promise<boolean> {
    const body = await this.query({
      request_type: "view_access_key",
      account_id: accountId,
      public_key: publicKey,
    });
    if (body.error) {
      const error = JSON.stringify(body.error);
      if (
        /UNKNOWN_ACCESS_KEY|AccessKeyDoesNotExist|unknown access key|does not exist/i.test(
          error,
        )
      )
        return false;
      throw new Error(`NEAR RPC rejected access-key lookup: ${error}`);
    }
    const result = body.result;
    // Only a full-access key proves wallet control. Function-call keys, such as the
    // in-page gameplay key or another app's sign-in key, must not open an API session.
    return Boolean(
      result &&
        typeof result === "object" &&
        "block_hash" in result &&
        (result as { permission?: unknown }).permission === "FullAccess",
    );
  }

  async plot(plotId: string): Promise<PlotView | null> {
    const args = Buffer.from(JSON.stringify({ plot_id: plotId })).toString(
      "base64",
    );
    const body = await this.query({
      request_type: "call_function",
      account_id: this.contractId,
      method_name: "get_plot",
      args_base64: args,
    });
    if (body.error)
      throw new Error(
        `NEAR RPC rejected plot lookup: ${JSON.stringify(body.error)}`,
      );
    const result = body.result;
    if (typeof result !== "object" || result === null || !("result" in result))
      throw new Error("NEAR RPC omitted the plot result");
    const bytes = (result as { result: unknown }).result;
    if (
      !Array.isArray(bytes) ||
      bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
    )
      throw new Error("NEAR RPC returned invalid plot bytes");
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return ChainPlot.nullable().parse(value);
  }
}
