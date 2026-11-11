import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { KeyPair } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import {
  actionCreators,
  createTransaction,
  encodeTransaction,
} from "@near-js/transactions";
import { baseDecode, baseEncode } from "@near-js/utils";
import { serializeNep413 } from "@near-wallet-selector/core";
import { ChainPlot } from "@estate/shared";
import sharp from "sharp";
import { ChainReader } from "../apps/web/src/chain-reader.js";
import { createApiApp } from "../services/api/src/app.js";
import { NearChainGateway } from "../services/api/src/chain.js";
import { NearModeratorGateway } from "../services/api/src/moderator.js";
import { ApiStore } from "../services/api/src/store.js";

const mode = process.argv[2];
if (
  mode !== "--prepare" &&
  mode !== "--approve" &&
  mode !== "--prepare-shared" &&
  mode !== "--approve-shared" &&
  mode !== "--prepare-shared-billboard" &&
  mode !== "--approve-shared-billboard" &&
  mode !== "--prepare-shared-revalidate" &&
  mode !== "--approve-shared-revalidate" &&
  mode !== "--prepare-shared-revalidate-billboard" &&
  mode !== "--approve-shared-revalidate-billboard" &&
  mode !== "--prepare-shared-level2-revalidate" &&
  mode !== "--approve-shared-level2-revalidate" &&
  mode !== "--prepare-shared-level2-revalidate-billboard" &&
  mode !== "--approve-shared-level2-revalidate-billboard"
)
  throw new Error(
    "Pass --prepare/--approve, optionally with -shared, -revalidate or -billboard",
  );
const sharedCity = mode.includes("-shared");
const revalidating = mode.includes("-revalidate");
const level2Revalidation = mode.includes("-level2-revalidate");
const kind = mode.endsWith("-billboard") ? "Billboard" : "Logo";
const prepare = mode.startsWith("--prepare");
const projectRoot = resolve(import.meta.dirname, "..");
const dataDir = process.env.ESTATE_MEDIA_DATA_DIR;
if (!dataDir || !dataDir.startsWith("/"))
  throw new Error("Set ESTATE_MEDIA_DATA_DIR outside the repository");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
if (realpathSync(dataDir).startsWith(`${projectRoot}/`))
  throw new Error("Media journey data must stay outside the repository");
chmodSync(dataDir, 0o700);

function credential(name: string) {
  const path = process.env[name];
  if (!path || !path.startsWith("/"))
    throw new Error(`Set ${name} to a private absolute key file`);
  if (realpathSync(path).startsWith(`${projectRoot}/`))
    throw new Error(`${name} must stay outside the repository`);
  if ((statSync(path).mode & 0o077) !== 0)
    throw new Error(`${name} must not be readable by group or others`);
  const record = JSON.parse(readFileSync(path, "utf8")) as {
    account_id: string;
    public_key?: string;
    secret_key?: `ed25519:${string}`;
    private_key?: `ed25519:${string}`;
  };
  const secret = record.secret_key ?? record.private_key;
  if (!secret) throw new Error(`${name} has no private key`);
  const pair = KeyPair.fromString(secret);
  if (record.public_key && record.public_key !== pair.getPublicKey().toString())
    throw new Error(`${name} public key mismatch`);
  return { accountId: record.account_id, secret, pair };
}

const evidencePath = resolve(
  projectRoot,
  sharedCity
    ? "deployments/testnet.json"
    : "deployments/testnet-moderation-journey.json",
);
const original = JSON.parse(readFileSync(evidencePath, "utf8")) as {
  contractId: string;
  ownerId?: string;
  moderatorId: string;
};
const contract = credential("ESTATE_MEDIA_CONTRACT_KEY_FILE");
const owner = credential("ESTATE_MEDIA_OWNER_KEY_FILE");
const runtime = credential("ESTATE_MODERATOR_RUNTIME_KEY_FILE");
assert.equal(contract.accountId, original.contractId);
if (original.ownerId) assert.equal(owner.accountId, original.ownerId);
assert.equal(runtime.accountId, original.moderatorId);
const reader = new ChainReader(original.contractId);
const chain = new NearChainGateway(original.contractId);
const moderator = new NearModeratorGateway(
  original.contractId,
  runtime.accountId,
  runtime.secret,
);
const store = new ApiStore(
  resolve(dataDir, "estate.sqlite"),
  resolve(dataDir, "assets"),
);
const origin = "http://localhost:8080";
const adminPassword = randomBytes(32).toString("hex");
const adminAuth = `Basic ${Buffer.from(`local-reviewer:${adminPassword}`).toString("base64")}`;
const app = createApiApp({
  store,
  chain,
  moderator,
  appOrigin: origin,
  adminCredentials: { user: "local-reviewer", password: adminPassword },
});
const plotId = sharedCity ? "plot-main-n-2" : "plot-main-n-1";
const preparedPath = resolve(
  dataDir,
  level2Revalidation
    ? kind === "Billboard"
      ? "shared-level2-billboard-revalidation-prepared.json"
      : "shared-level2-logo-revalidation-prepared.json"
    : revalidating
      ? kind === "Billboard"
        ? "shared-billboard-revalidation-prepared.json"
        : "shared-logo-revalidation-prepared.json"
      : kind === "Billboard"
        ? "shared-billboard-prepared.json"
        : sharedCity
          ? "shared-media-prepared.json"
          : "prepared.json",
);
const transactions: Array<{ action: string; hash: string }> = [];

async function signedCall(
  signer: typeof contract,
  actionName: string,
  receiverId: string,
  actions: Parameters<typeof createTransaction>[4],
) {
  const access = await reader.accessKey(
    signer.accountId,
    signer.pair.getPublicKey().toString(),
  );
  const transaction = createTransaction(
    signer.accountId,
    signer.pair.getPublicKey(),
    receiverId,
    access.nonce + 1n,
    actions,
    baseDecode(access.blockHash),
  );
  const [hashBytes, signed] = await KeyPairSigner.fromSecretKey(
    signer.secret,
  ).signTransaction(transaction);
  const hash = baseEncode(hashBytes);
  const bytes = Buffer.from(encodeTransaction(signed)).toString("base64");
  let outcome: "success" | "failure" | "pending" = "pending";
  try {
    outcome = await reader.sendSignedTransaction(bytes);
  } catch {
    // Query the exact hash after a lost submission response.
  }
  for (let attempt = 0; outcome === "pending" && attempt < 8; attempt++) {
    await new Promise((done) => setTimeout(done, 1_000));
    const status = await reader.transactionStatus(hash, signer.accountId);
    if (status !== "unknown") outcome = status;
  }
  if (outcome !== "success")
    throw new Error(`${actionName} transaction ${hash} is ${outcome}`);
  transactions.push({ action: actionName, hash });
  return hash;
}

async function postJson(path: string, value: unknown, cookie?: string) {
  return app.request(path, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(value),
  });
}

async function requireStatus(response: Response, expected: number) {
  if (response.status !== expected)
    throw new Error(
      `Expected HTTP ${expected}, got ${response.status}: ${await response.text()}`,
    );
}

async function ownerCookie() {
  const issued = await postJson("/auth/challenge", {
    accountId: owner.accountId,
  });
  await requireStatus(issued, 200);
  const challenge = (await issued.json()) as {
    challengeId: string;
    message: string;
    nonce: string;
    recipient: string;
    callbackUrl: string;
  };
  const payload = serializeNep413({
    message: challenge.message,
    nonce: Buffer.from(challenge.nonce, "base64"),
    recipient: challenge.recipient,
    callbackUrl: challenge.callbackUrl,
  });
  const signature = Buffer.from(
    owner.pair.sign(createHash("sha256").update(payload).digest()).signature,
  ).toString("base64");
  const verified = await postJson("/auth/verify", {
    challengeId: challenge.challengeId,
    signedMessage: {
      accountId: owner.accountId,
      publicKey: owner.pair.getPublicKey().toString(),
      signature,
      state: challenge.challengeId,
    },
  });
  await requireStatus(verified, 200);
  const cookie = verified.headers.get("set-cookie")?.split(";")[0];
  assert(cookie, "Owner session cookie missing");
  return cookie;
}

try {
  if (prepare) {
    let plot = await reader.view(
      "get_plot",
      { plot_id: plotId },
      ChainPlot.nullable(),
    );
    if (!plot) {
      if (sharedCity) throw new Error("Shared-city plot is missing");
      await signedCall(contract, "seed_plot", contract.accountId, [
        actionCreators.functionCall(
          "seed_plot",
          {
            seed: {
              road_id: "main",
              side: "North",
              index: 1,
              building_type: "Retail",
              variant: 1,
            },
          },
          60n * 10n ** 12n,
          10n ** 24n,
        ),
      ]);
      plot = await reader.view(
        "get_plot",
        { plot_id: plotId },
        ChainPlot.nullable(),
      );
    }
    assert(plot, "Second plot was not seeded");
    if (plot.plot.owner === null) {
      if (sharedCity)
        throw new Error("Buy the shared-city plot before uploading media");
      const quote = await reader.plotPurchaseQuote(plotId);
      await signedCall(owner, "buy_plot", contract.accountId, [
        actionCreators.functionCall(
          "buy_plot",
          { plot_id: plotId },
          60n * 10n ** 12n,
          BigInt(quote),
        ),
      ]);
      plot = await reader.view(
        "get_plot",
        { plot_id: plotId },
        ChainPlot.nullable(),
      );
    }
    assert.equal(plot?.plot.owner, owner.accountId);
    if (level2Revalidation) {
      assert.equal(plot.plot.building.level, 2);
      assert(
        plot.plot.building.approved_manifest_hash,
        "Approve the level-2 facade first",
      );
    }
    const slot = kind === "Billboard" ? plot?.plot.billboard : plot?.plot.logo;
    if (revalidating) {
      assert(slot?.active, "Existing approved media is missing");
      assert(
        slot.active.approved_layout_revision <
          plot.plot.building.layout_revision,
        "Media is already approved for the current layout",
      );
    } else assert.equal(slot?.active, null);
    assert.equal(slot?.pending, null);
    const cookie = await ownerCookie();
    const source = Buffer.from(
      kind === "Billboard"
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="256" viewBox="0 0 512 256"><rect width="512" height="256" rx="24" fill="#F6C85F"/><circle cx="90" cy="128" r="62" fill="#B45131"/><path d="M42 128h96" stroke="#73D9A6" stroke-width="16"/><text x="180" y="112" font-family="Arial,sans-serif" font-size="44" font-weight="bold" fill="#173F5F">NEAR &amp; FAR</text><text x="180" y="165" font-family="Arial,sans-serif" font-size="38" fill="#173F5F">BURGERS</text></svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="44" fill="#173F5F"/><path d="M28 184h200" stroke="#FFD166" stroke-width="13"/><text x="128" y="145" text-anchor="middle" font-family="Arial,sans-serif" font-size="100" font-weight="bold" fill="white">NE</text></svg>`,
    );
    const png = await sharp(source).png().toBuffer();
    const form = new FormData();
    form.set("plot_id", plotId);
    form.set(
      "file",
      new File([png], `near-estate-${kind.toLowerCase()}.png`, {
        type: "image/png",
      }),
    );
    const uploaded = await app.request(kind === "Logo" ? "/logos" : "/ads", {
      method: "POST",
      headers: { origin, cookie },
      body: form,
    });
    await requireStatus(uploaded, 200);
    const upload = (await uploaded.json()) as {
      uploadId: string;
      hash: string;
      layoutRevision: number;
    };
    if (revalidating)
      assert.equal(upload.hash, slot.active?.content.asset_hash);
    const link = "https://near.org";
    const created = await postJson(
      "/media/proposals",
      { uploadId: upload.uploadId, link },
      cookie,
    );
    await requireStatus(created, 201);
    const proposal = (await created.json()) as { id: string };
    await signedCall(owner, "propose_media", contract.accountId, [
      actionCreators.functionCall(
        "propose_media",
        {
          plot_id: plotId,
          kind,
          expected_media_revision: slot.revision,
          expected_layout_revision: upload.layoutRevision,
          content: { asset_hash: upload.hash, link },
        },
        60n * 10n ** 12n,
        0n,
      ),
    ]);
    const reconciled = await postJson(
      `/media/proposals/${proposal.id}/reconcile`,
      {},
      cookie,
    );
    await requireStatus(reconciled, 200);
    const page = await app.request("/moderation", {
      headers: { authorization: adminAuth },
    });
    await requireStatus(page, 200);
    const html = await page.text();
    assert.match(html, new RegExp(`Approve exact ${kind.toLowerCase()}`));
    const preview = html.match(
      /Facade with approved media after this decision<\/p><img src="data:image\/png;base64,([^"]+)/,
    )?.[1];
    assert(preview, "The moderator's combined facade preview is missing");
    const previewPath = resolve(
      dataDir,
      kind === "Billboard"
        ? "billboard-review-preview.png"
        : "review-preview.png",
    );
    writeFileSync(previewPath, Buffer.from(preview, "base64"), { mode: 0o600 });
    const prepared = {
      network: "testnet",
      contractId: contract.accountId,
      ownerId: owner.accountId,
      moderatorId: runtime.accountId,
      plotId,
      kind,
      proposalId: proposal.id,
      uploadHash: upload.hash,
      link,
      previewPath,
      transactions,
    };
    writeFileSync(preparedPath, `${JSON.stringify(prepared, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(JSON.stringify(prepared, null, 2));
  } else {
    const prepared = JSON.parse(readFileSync(preparedPath, "utf8")) as {
      contractId: string;
      ownerId: string;
      moderatorId: string;
      plotId: string;
      kind?: "Logo" | "Billboard";
      proposalId: string;
      uploadHash: string;
      link: string;
      transactions: Array<{ action: string; hash: string }>;
    };
    assert.equal(prepared.contractId, contract.accountId);
    assert.equal(prepared.ownerId, owner.accountId);
    assert.equal(prepared.moderatorId, runtime.accountId);
    assert.equal(prepared.kind ?? "Logo", kind);
    const pending = await chain.plot(prepared.plotId);
    const pendingSlot =
      kind === "Billboard" ? pending?.plot.billboard : pending?.plot.logo;
    assert.equal(pendingSlot?.pending?.content.asset_hash, prepared.uploadHash);
    const page = await app.request("/moderation", {
      headers: { authorization: adminAuth },
    });
    await requireStatus(page, 200);
    assert.match(
      await page.text(),
      new RegExp(`Approve exact ${kind.toLowerCase()}`),
    );
    const approved = await app.request(
      `/moderation/media/${prepared.proposalId}/approve`,
      {
        method: "POST",
        headers: { origin, authorization: adminAuth },
      },
    );
    await requireStatus(approved, 303);
    const finalPlot = await chain.plot(prepared.plotId);
    const finalSlot =
      kind === "Billboard" ? finalPlot?.plot.billboard : finalPlot?.plot.logo;
    assert.equal(finalSlot?.active?.content.asset_hash, prepared.uploadHash);
    assert.equal(finalSlot?.active?.content.link, prepared.link);
    assert.equal(
      kind === "Billboard"
        ? finalPlot?.billboard_eligible
        : finalPlot?.logo_eligible,
      true,
    );
    const publicAsset = await app.request(`/assets/${prepared.uploadHash}`);
    assert.equal(publicAsset.status, 200);
    const bytes = Buffer.from(await publicAsset.arrayBuffer());
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      prepared.uploadHash,
    );
    const evidence = {
      network: "testnet",
      sharedCity,
      contractId: contract.accountId,
      ownerId: owner.accountId,
      moderatorId: runtime.accountId,
      plotId: prepared.plotId,
      kind,
      proposalId: prepared.proposalId,
      ...(kind === "Billboard"
        ? { billboardHash: prepared.uploadHash }
        : { logoHash: prepared.uploadHash }),
      link: prepared.link,
      uploadedImageBytes: bytes.length,
      publicAssetHashVerified: true,
      activeOnChain: true,
      ownerTransactions: prepared.transactions,
    };
    const path = resolve(
      projectRoot,
      level2Revalidation
        ? kind === "Billboard"
          ? "deployments/testnet-shared-level2-billboard-revalidation.json"
          : "deployments/testnet-shared-level2-logo-revalidation.json"
        : revalidating
          ? kind === "Billboard"
            ? "deployments/testnet-shared-billboard-revalidation.json"
            : "deployments/testnet-shared-logo-revalidation.json"
          : kind === "Billboard"
            ? "deployments/testnet-shared-billboard-journey.json"
            : sharedCity
              ? "deployments/testnet-shared-media-journey.json"
              : "deployments/testnet-media-api-journey.json",
    );
    writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence, null, 2));
  }
} finally {
  store.close();
}
