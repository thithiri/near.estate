import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baseDecode } from "@near-js/utils";

const deployment = JSON.parse(
  readFileSync(new URL("../deployments/testnet.json", import.meta.url), "utf8"),
);

function requireResponse(response, path) {
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response;
}

async function request(fetcher, url) {
  return fetcher(url, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
}

async function json(fetcher, origin, path) {
  const response = requireResponse(
    await request(fetcher, `${origin}${path}`),
    path,
  );
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(`${path} did not return JSON`);
  return response.json();
}

async function rpcQuery(fetcher, rpcUrl, params) {
  const response = await fetcher(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "estate-public-release",
      method: "query",
      params,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  requireResponse(response, "Testnet RPC");
  const envelope = await response.json();
  if (envelope.error || !envelope.result)
    throw new Error(
      `Testnet RPC query failed: ${JSON.stringify(envelope.error ?? envelope)}`,
    );
  return envelope.result;
}

async function verifyLiveContract(fetcher, rpcUrl, contractId) {
  const account = await rpcQuery(fetcher, rpcUrl, {
    request_type: "view_account",
    finality: "final",
    account_id: contractId,
  });
  if (
    typeof account.code_hash !== "string" ||
    typeof account.block_hash !== "string" ||
    !Number.isSafeInteger(account.block_height) ||
    account.block_height < 1
  )
    throw new Error(
      "Testnet RPC omitted finalized account code or block details",
    );
  const codeSha256 = Buffer.from(baseDecode(account.code_hash)).toString("hex");
  if (codeSha256 !== deployment.wasmSha256)
    throw new Error("Live contract code differs from the release manifest");
  const pausedView = await rpcQuery(fetcher, rpcUrl, {
    request_type: "call_function",
    block_id: account.block_hash,
    account_id: contractId,
    method_name: "is_paused",
    args_base64: "e30=",
  });
  if (
    pausedView.block_hash !== account.block_hash ||
    !Array.isArray(pausedView.result)
  )
    throw new Error("Testnet RPC pause view did not match the finalized block");
  const paused = JSON.parse(Buffer.from(pausedView.result).toString("utf8"));
  if (paused !== false) throw new Error("Live contract is paused");
  return { codeSha256, finalizedBlockHeight: account.block_height, paused };
}

function webMeta(html, name) {
  const matches = [
    ...html.matchAll(
      new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"\\s*\\/?>`, "g"),
    ),
  ];
  if (matches.length !== 1) throw new Error(`Public web page lacks ${name}`);
  return matches[0][1];
}

export async function verifyPublicRelease(
  origin,
  {
    fetcher = fetch,
    nowMs = Date.now(),
    maxIndexerAgeSeconds = 900,
    contractId = deployment.contractId,
    sourceRevision,
    rpcUrl = process.env.ESTATE_TESTNET_RPC_URL ??
      "https://test.rpc.fastnear.com",
    rpcFetcher = fetcher,
  } = {},
) {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.port
  )
    throw new Error(
      "Pass a public HTTPS origin without credentials, path or port",
    );
  if (
    isIP(url.hostname) ||
    !url.hostname.includes(".") ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost")
  )
    throw new Error("The public release probe needs a public hostname");
  if (!Number.isSafeInteger(maxIndexerAgeSeconds) || maxIndexerAgeSeconds < 1)
    throw new Error("Indexer age limit must be a positive integer");
  if (new URL(rpcUrl).protocol !== "https:")
    throw new Error("Testnet RPC URL must use HTTPS");
  if (fetcher === fetch && process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error("TLS certificate verification is disabled in this process");
  const base = url.origin;
  const [page, health, city, economy, generation] = await Promise.all([
    request(fetcher, `${base}/`),
    json(fetcher, base, "/api/health"),
    json(fetcher, base, "/api/city"),
    json(fetcher, base, "/api/stats/economy"),
    json(fetcher, base, "/api/paid-generations/status"),
  ]);
  requireResponse(page, "/");
  const pageHtml = await page.text();
  if (webMeta(pageHtml, "estate-contract-id") !== contractId)
    throw new Error("Public web bundle is configured for the wrong contract");
  if (
    sourceRevision &&
    webMeta(pageHtml, "estate-source-revision") !== sourceRevision
  )
    throw new Error("Public web bundle is running the wrong source revision");
  const contentPolicy = page.headers.get("content-security-policy") ?? "";
  if (
    !page.headers.get("content-type")?.includes("text/html") ||
    !contentPolicy.includes("object-src 'none'") ||
    !contentPolicy.includes("frame-ancestors 'none'") ||
    page.headers.get("x-content-type-options") !== "nosniff"
  )
    throw new Error("Public web response is missing expected security headers");
  if (
    health.status !== "ok" ||
    health.service !== "api" ||
    health.schemaVersion !== 1
  )
    throw new Error("Public API health response is invalid");
  if (health.contractId !== contractId)
    throw new Error("Public API is configured for the wrong contract");
  if (sourceRevision && health.sourceRevision !== sourceRevision)
    throw new Error("Public API is running the wrong source revision");
  if (
    city.version !== deployment.citySeedVersion ||
    city.streets?.length !== 5 ||
    city.plots?.length !== 100 ||
    city.npcSites?.length !== 7
  )
    throw new Error("Public API is serving the wrong city seed");
  if (generation.enabled !== false)
    throw new Error("Paid image generation is enabled on the public API");
  if (
    !Number.isSafeInteger(economy.indexedThroughHeight) ||
    !Number.isSafeInteger(economy.indexedThroughAt)
  )
    throw new Error("Public event indexer has no finalized cursor");
  const ageSeconds = Math.floor((nowMs - economy.indexedThroughAt) / 1_000);
  if (ageSeconds < 0 || ageSeconds > maxIndexerAgeSeconds)
    throw new Error(`Public event indexer is stale (${ageSeconds} seconds)`);
  const liveContract = await verifyLiveContract(rpcFetcher, rpcUrl, contractId);
  return {
    origin: base,
    contractId: health.contractId,
    sourceRevision: health.sourceRevision,
    cityVersion: city.version,
    streets: city.streets.length,
    plots: city.plots.length,
    npcSites: city.npcSites.length,
    indexedThroughHeight: economy.indexedThroughHeight,
    indexerAgeSeconds: ageSeconds,
    imageGenerationEnabled: false,
    ...liveContract,
    httpsVerifiedByClient: fetcher === fetch,
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const origin = process.argv[2];
  const sourceRevision = process.argv[3];
  if (
    !origin ||
    !/^[a-f0-9]{40}$/.test(sourceRevision ?? "") ||
    process.argv.length !== 4
  )
    throw new Error(
      "Usage: node scripts/verify-public-release.mjs https://game.example.com <40-character-release-commit>",
    );
  console.log(
    JSON.stringify(
      await verifyPublicRelease(origin, { sourceRevision }),
      null,
      2,
    ),
  );
}
