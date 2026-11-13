import {
  ChainAccount,
  ChainCar,
  ChainOwnerConfig,
  ChainPlayerSnapshot,
  ChainPlot,
  ChainPlotV1,
  ChainPlotV2,
  ChainPlotPurchaseBreakdown,
  ChainSession,
  ChainStreetSide,
  ChainStreetSideV1,
  ChainStreetSideV2,
  ChainStreetEconomyConfig,
  ChainTicketRewardStatus,
  CoinString,
  TOWER_FLOORS,
  TOWER_SPACES_PER_FLOOR,
  YoctoNearString,
  type ChainPlayerSnapshot as PlayerSnapshot,
  type ChainOwnerConfig as OwnerConfig,
  type ChainPlot as PlotView,
  type ChainPlotPurchaseBreakdown as PlotPurchaseBreakdown,
  type ChainSession as SessionView,
  type ChainStreetSide as StreetSideView,
  type ChainStreetEconomyConfig as StreetEconomyConfig,
  type ChainTicketRewardStatus as TicketRewardStatus,
} from "@estate/shared";
import { z } from "zod";

const RpcEnvelope = z.object({
  jsonrpc: z.literal("2.0"),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
const RpcFunctionResult = z.object({
  result: z.array(z.number().int().min(0).max(255)).optional(),
  error: z.string().optional(),
  block_hash: z.string().min(1),
});
const RpcAccessKeys = z.object({
  block_hash: z.string().min(1),
  keys: z.array(
    z.object({
      public_key: z.string().min(1),
      access_key: z.object({
        permission: z
          .union([
            z.literal("FullAccess"),
            z.object({
              FunctionCall: z.object({
                receiver_id: z.string(),
                method_names: z.array(z.string()),
                allowance: z.string().nullable(),
              }),
            }),
            z.null(),
          ])
          .catch(null),
      }),
    }),
  ),
});
const RpcAccessKey = z.object({
  block_hash: z.string().min(1),
  block_height: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nonce: z.union([
    z.string().regex(/^\d+$/),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ]),
});
const RpcProtocolConfig = z.object({
  transaction_validity_period: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER),
});
const RpcTransactionOutcome = z.object({
  final_execution_status: z.string(),
  status: z.unknown(),
});
export type TransactionOutcome = "success" | "failure" | "pending";

function transactionOutcome(value: unknown): TransactionOutcome {
  const result = RpcTransactionOutcome.parse(value);
  if (result.final_execution_status !== "FINAL") return "pending";
  if (typeof result.status !== "object" || result.status === null)
    return "pending";
  if ("Failure" in result.status) return "failure";
  if ("SuccessValue" in result.status || "SuccessReceiptId" in result.status)
    return "success";
  return "pending";
}

function contractFailureMessage(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const direct = record.ExecutionError ?? record.panic_msg;
  if (typeof direct === "string") {
    const message = direct
      .replace(/^Smart contract panicked:\s*/i, "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim();
    return message ? message.slice(0, 240) : null;
  }
  for (const nested of Object.values(record)) {
    const message = contractFailureMessage(nested);
    if (message) return message;
  }
  return null;
}

function encodeArguments(args: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeResult(bytes: number[]): unknown {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)),
  );
}

export class ChainReader {
  constructor(
    readonly contractId: string,
    readonly rpcUrl = "https://test.rpc.fastnear.com",
    private readonly fetcher: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
    private readonly rpcTimeoutMs = 10_000,
  ) {
    if (!/^[a-z0-9._-]+\.testnet$/.test(contractId))
      throw new Error("Expected a testnet contract account ID");
    if (!rpcUrl.startsWith("https://"))
      throw new Error("RPC URL must use HTTPS");
    if (!Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs < 1)
      throw new Error("RPC timeout must be positive");
  }

  private async rpcRequest(
    method: string,
    params: object,
    name: string,
    timeoutMs = this.rpcTimeoutMs,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetcher(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "near-estate-view",
          method,
          params,
        }),
      });
      if (!response.ok)
        throw new Error(`NEAR RPC request failed (${response.status})`);
      const envelope = RpcEnvelope.parse(await response.json());
      if (envelope.error !== undefined)
        throw new Error(
          `NEAR RPC rejected ${name}: ${JSON.stringify(envelope.error)}`,
        );
      if (envelope.result === undefined)
        throw new Error(`NEAR RPC omitted the ${name} result`);
      return envelope.result;
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(`NEAR RPC timed out during ${name}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async viewAt<T>(
    method: string,
    args: object,
    schema: z.ZodType<T>,
    blockId?: string,
  ): Promise<{ value: T; blockHash: string }> {
    const result = RpcFunctionResult.parse(
      await this.rpcRequest(
        "query",
        {
          request_type: "call_function",
          ...(blockId ? { block_id: blockId } : { finality: "final" }),
          account_id: this.contractId,
          method_name: method,
          args_base64: encodeArguments(args),
        },
        method,
      ),
    );
    if (result.error) {
      const explanation = result.error.includes("CodeDoesNotExist")
        ? `No game contract is deployed at ${this.contractId}`
        : result.error;
      throw new Error(`NEAR RPC rejected ${method}: ${explanation}`);
    }
    if (!result.result)
      throw new Error(`NEAR RPC omitted the ${method} return value`);
    if (blockId && result.block_hash !== blockId)
      throw new Error(`NEAR RPC returned a different block for ${method}`);
    return {
      value: schema.parse(decodeResult(result.result)),
      blockHash: result.block_hash,
    };
  }

  async accessKeyList(
    accountId: string,
  ): Promise<z.infer<typeof RpcAccessKeys>> {
    return RpcAccessKeys.parse(
      await this.rpcRequest(
        "query",
        {
          request_type: "view_access_key_list",
          finality: "final",
          account_id: accountId,
        },
        "view_access_key_list",
      ),
    );
  }

  async accessKey(
    accountId: string,
    publicKey: string,
  ): Promise<{ nonce: bigint; blockHash: string; blockHeight: number }> {
    const result = RpcAccessKey.parse(
      await this.rpcRequest(
        "query",
        {
          request_type: "view_access_key",
          finality: "final",
          account_id: accountId,
          public_key: publicKey,
        },
        "view_access_key",
      ),
    );
    return {
      nonce: BigInt(result.nonce),
      blockHash: result.block_hash,
      blockHeight: result.block_height,
    };
  }

  async transactionValidityPeriod(): Promise<number> {
    const config = RpcProtocolConfig.parse(
      await this.rpcRequest(
        "EXPERIMENTAL_protocol_config",
        { finality: "final" },
        "EXPERIMENTAL_protocol_config",
      ),
    );
    return config.transaction_validity_period;
  }

  async sendSignedTransaction(
    signedTxBase64: string,
  ): Promise<TransactionOutcome> {
    return transactionOutcome(
      await this.rpcRequest(
        "send_tx",
        { signed_tx_base64: signedTxBase64, wait_until: "FINAL" },
        "send_tx",
        this.rpcTimeoutMs,
      ),
    );
  }

  async transactionStatus(
    hash: string,
    accountId: string,
  ): Promise<TransactionOutcome | "unknown"> {
    try {
      return transactionOutcome(
        await this.rpcRequest(
          "tx",
          { tx_hash: hash, sender_account_id: accountId, wait_until: "NONE" },
          "tx",
        ),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        /UNKNOWN_TRANSACTION|UnknownTransaction/.test(error.message)
      )
        return "unknown";
      throw error;
    }
  }

  async transactionFailureMessage(
    hash: string,
    accountId: string,
  ): Promise<string | null> {
    const result = RpcTransactionOutcome.parse(
      await this.rpcRequest(
        "tx",
        { tx_hash: hash, sender_account_id: accountId, wait_until: "FINAL" },
        "tx failure",
      ),
    );
    if (result.final_execution_status !== "FINAL") return null;
    if (typeof result.status !== "object" || result.status === null)
      return null;
    return contractFailureMessage(
      (result.status as { Failure?: unknown }).Failure,
    );
  }

  async view<T>(
    method: string,
    args: object,
    schema: z.ZodType<T>,
  ): Promise<T> {
    return (await this.viewAt(method, args, schema)).value;
  }

  private async cityVersionAt(
    blockId?: string,
  ): Promise<{ version: 1 | 2; blockHash?: string }> {
    try {
      const result = await this.viewAt(
        "city_version",
        {},
        z.union([z.literal(1), z.literal(2)]),
        blockId,
      );
      return { version: result.value, blockHash: result.blockHash };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("MethodResolveError(MethodNotFound)")
      )
        return { version: 1, blockHash: blockId };
      throw error;
    }
  }

  async cityVersion(): Promise<1 | 2> {
    return (await this.cityVersionAt()).version;
  }

  registrationQuote(): Promise<string> {
    return this.view("registration_quote", {}, YoctoNearString);
  }

  plotPurchaseQuote(plotId: string): Promise<string> {
    return this.view(
      "plot_purchase_quote",
      { plot_id: plotId },
      YoctoNearString,
    );
  }

  plotPurchaseBreakdown(plotId: string): Promise<PlotPurchaseBreakdown> {
    return this.view(
      "plot_purchase_breakdown",
      { plot_id: plotId },
      ChainPlotPurchaseBreakdown,
    );
  }

  ownerConfig(): Promise<OwnerConfig> {
    return this.view("get_config", {}, ChainOwnerConfig);
  }

  ticketRewardStatus(plotId: string): Promise<TicketRewardStatus> {
    return this.view(
      "get_ticket_reward_status",
      { plot_id: plotId },
      ChainTicketRewardStatus,
    );
  }

  streetEconomyConfig(): Promise<StreetEconomyConfig> {
    return this.view("get_config", {}, ChainStreetEconomyConfig);
  }

  async burgerDecalCost(): Promise<string> {
    const config = await this.view(
      "get_config",
      {},
      z.object({ burger_decal_cost: CoinString }),
    );
    return config.burger_decal_cost;
  }

  chainTimeSeconds(): Promise<number> {
    return this.view("chain_time_seconds", {}, z.number().int().nonnegative());
  }

  async plots(): Promise<PlotView[]> {
    const { value: count, blockHash } = await this.viewAt(
      "plot_count",
      {},
      z.number().int().min(0).max(65_535),
    );
    const plots: PlotView[] = [];
    const { version } = await this.cityVersionAt(blockHash);
    for (let fromIndex = 0; fromIndex < count; fromIndex += 50) {
      const page = await this.viewAt(
        "get_plots",
        { from_index: fromIndex, limit: 50 },
        z.array(ChainPlot).max(50),
        blockHash,
      );
      if (page.value.length !== Math.min(50, count - fromIndex))
        throw new Error(
          "The plot list changed while loading; refresh the view",
        );
      plots.push(
        ...(version === 2
          ? z.array(ChainPlotV2).parse(page.value)
          : z.array(ChainPlotV1).parse(page.value)),
      );
    }
    if (new Set(plots.map((plot) => plot.plot.id)).size !== count)
      throw new Error("The plot list contains duplicate IDs");
    return plots;
  }

  async player(accountId: string): Promise<PlayerSnapshot> {
    const { value: account, blockHash } = await this.viewAt(
      "get_account",
      { account_id: accountId },
      ChainAccount.nullable(),
    );
    if (!account) {
      return ChainPlayerSnapshot.parse({
        account_id: accountId,
        account: null,
        cars: [],
        active_session: null,
      });
    }
    const [cars, activeSession] = await Promise.all([
      this.viewAt(
        "get_cars",
        { account_id: accountId },
        z.array(ChainCar),
        blockHash,
      ),
      account.active_session_id === null
        ? Promise.resolve(null)
        : this.viewAt(
            "get_session",
            { session_id: account.active_session_id },
            ChainSession.nullable(),
            blockHash,
          ),
    ]);
    const carList = cars.value;
    const session = activeSession?.value ?? null;
    if (
      carList.length !== account.car_ids.length ||
      carList.some(
        (car) => car.owner !== accountId || !account.car_ids.includes(car.id),
      )
    ) {
      throw new Error("Player cars changed while loading; refresh the view");
    }
    if (
      account.active_session_id !== null &&
      (session?.id !== account.active_session_id ||
        session.driver !== accountId)
    ) {
      throw new Error("Player parking changed while loading; refresh the view");
    }
    return ChainPlayerSnapshot.parse({
      account_id: accountId,
      account,
      cars: carList,
      active_session: session,
    });
  }

  plot(plotId: string): Promise<PlotView | null> {
    return this.view("get_plot", { plot_id: plotId }, ChainPlot.nullable());
  }

  curbSession(plotId: string, slot: number): Promise<SessionView | null> {
    if (!Number.isInteger(slot) || slot < 0 || slot > 2)
      return Promise.reject(new Error("Invalid curb slot"));
    return this.view(
      "get_space_session",
      { plot_id: plotId, slot },
      ChainSession.nullable(),
    );
  }

  towerSession(siteId: string, space: number): Promise<SessionView | null> {
    return this.view(
      "get_tower_space_session",
      { site_id: siteId, space },
      ChainSession.nullable(),
    );
  }

  async towerFloorSessions(
    siteId: string,
    floor: number,
  ): Promise<(SessionView | null)[]> {
    if (!Number.isInteger(floor) || floor < 0 || floor >= TOWER_FLOORS)
      throw new Error("Invalid parking tower floor");
    const firstSpace = floor * TOWER_SPACES_PER_FLOOR;
    let spaces: (SessionView | null)[];
    try {
      spaces = await this.view(
        "get_tower_floor_sessions",
        { site_id: siteId, floor },
        z.array(ChainSession.nullable()).length(TOWER_SPACES_PER_FLOOR),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("MethodResolveError(MethodNotFound)")
      )
        throw error;
      const first = await this.viewAt(
        "get_tower_space_session",
        { site_id: siteId, space: firstSpace },
        ChainSession.nullable(),
      );
      const rest = await Promise.all(
        Array.from({ length: TOWER_SPACES_PER_FLOOR - 1 }, (_, offset) =>
          this.viewAt(
            "get_tower_space_session",
            { site_id: siteId, space: firstSpace + offset + 1 },
            ChainSession.nullable(),
            first.blockHash,
          ).then(({ value }) => value),
        ),
      );
      spaces = [first.value, ...rest];
    }
    return spaces.map((session, offset) => {
      const space = firstSpace + offset;
      if (
        session &&
        (session.facility !== "Tower" ||
          session.location_id !== siteId ||
          session.slot !== space)
      )
        throw new Error(
          `Parking tower space ${space + 1} changed while loading`,
        );
      return session;
    });
  }

  towerAvailability(siteId: string): Promise<number> {
    return this.view(
      "get_tower_availability",
      { site_id: siteId },
      z.number().int().min(0).max(32),
    );
  }

  async towerFloorAvailability(siteId: string): Promise<number[] | null> {
    try {
      return await this.view(
        "get_tower_floor_availability",
        { site_id: siteId },
        z
          .array(z.number().int().min(0).max(TOWER_SPACES_PER_FLOOR))
          .length(TOWER_FLOORS),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("MethodResolveError(MethodNotFound)")
      )
        return null;
      throw error;
    }
  }

  async towerState(
    siteId: string,
  ): Promise<{ floors: number[] | null; available: number }> {
    const floors = await this.towerFloorAvailability(siteId);
    return {
      floors,
      available: floors
        ? floors.reduce((sum, open) => sum + open, 0)
        : await this.towerAvailability(siteId),
    };
  }

  towerOpenSpaceOnFloor(siteId: string, floor: number): Promise<number | null> {
    if (!Number.isInteger(floor) || floor < 0 || floor >= TOWER_FLOORS)
      return Promise.reject(new Error("Invalid parking tower floor"));
    return this.view(
      "get_tower_open_space_on_floor",
      { site_id: siteId, floor },
      z
        .number()
        .int()
        .min(floor * TOWER_SPACES_PER_FLOOR)
        .max((floor + 1) * TOWER_SPACES_PER_FLOOR - 1)
        .nullable(),
    );
  }

  towerOpenSpace(siteId: string): Promise<number | null> {
    return this.view(
      "get_tower_open_space",
      { site_id: siteId },
      z.number().int().min(0).max(31).nullable(),
    );
  }

  async streetSide(
    roadId: StreetSideView["road_id"],
    side: StreetSideView["side"],
  ): Promise<StreetSideView> {
    const { version, blockHash } = await this.cityVersionAt();
    const result = await this.viewAt(
      "get_street_side",
      { road_id: roadId, side },
      ChainStreetSide,
      blockHash,
    );
    const street =
      version === 2
        ? ChainStreetSideV2.parse(result.value)
        : ChainStreetSideV1.parse(result.value);
    if (
      street.road_id !== roadId ||
      street.side !== side ||
      street.plots.length !== (version === 2 ? 10 : 8)
    )
      throw new Error("The requested street side is not fully seeded");
    for (const [index, entry] of street.plots.entries()) {
      const expectedId = `plot-${roadId}-${side === "North" ? "n" : "s"}-${index}`;
      if (entry.plot.plot.id !== expectedId)
        throw new Error("Street plot order changed");
      if (
        version === 2 &&
        (entry.slots.length !==
          (entry.plot.plot as { frontage_units: number }).frontage_units ||
          entry.car_appearances?.length !== entry.slots.length)
      )
        throw new Error("Street plot width does not match its curb spaces");
      for (const [slot, session] of entry.slots.entries()) {
        if (
          session &&
          (session.facility !== "Curb" ||
            session.location_id !== expectedId ||
            session.slot !== slot)
        ) {
          throw new Error("Street parking slot does not match its plot");
        }
        const appearance = entry.car_appearances?.[slot];
        if (
          entry.car_appearances &&
          (Boolean(appearance) !== Boolean(session) ||
            (appearance && session && appearance.id !== session.car_id))
        ) {
          throw new Error("Street parked car does not match its space");
        }
      }
    }
    return street;
  }
}
