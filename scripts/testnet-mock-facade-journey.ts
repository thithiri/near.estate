import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
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
  mode !== "--prepare-shared-level2" &&
  mode !== "--approve-shared-level2"
)
  throw new Error("Pass --prepare, --approve or a shared-city variant");
const sharedCity = mode.includes("-shared");
const sharedLevel2 = mode.endsWith("-shared-level2");
const preparing = mode.startsWith("--prepare");
const selectedCandidateId = sharedLevel2 ? 1 : 2;
const selectedCandidateIndex = selectedCandidateId - 1;
const root = resolve(import.meta.dirname, "..");
const dataDir = process.env.ESTATE_MEDIA_DATA_DIR;
if (!dataDir || !dataDir.startsWith("/"))
  throw new Error("Set ESTATE_MEDIA_DATA_DIR outside the repository");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
if (realpathSync(dataDir).startsWith(`${root}/`))
  throw new Error("Journey data must stay outside the repository");
chmodSync(dataDir, 0o700);

function credential(name: string) {
  const path = process.env[name];
  if (!path || !path.startsWith("/"))
    throw new Error(`Set ${name} to a private absolute key file`);
  if (realpathSync(path).startsWith(`${root}/`))
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

const deployment = JSON.parse(
  readFileSync(
    resolve(
      root,
      sharedCity
        ? "deployments/testnet.json"
        : "deployments/testnet-moderation-journey.json",
    ),
    "utf8",
  ),
) as { contractId: string; ownerId?: string; moderatorId: string };
const sharedOwner = sharedCity
  ? (JSON.parse(
      readFileSync(
        resolve(root, "deployments/testnet-shared-owner-journey.json"),
        "utf8",
      ),
    ) as { contractId: string; ownerId: string; plotId: string })
  : null;
if (sharedOwner) assert.equal(sharedOwner.contractId, deployment.contractId);
const manifest = {
  contractId: deployment.contractId,
  moderatorId: deployment.moderatorId,
  ownerId: sharedOwner?.ownerId ?? deployment.ownerId,
};
const owner = credential("ESTATE_MEDIA_OWNER_KEY_FILE");
assert.equal(owner.accountId, manifest.ownerId);
const runtime = credential("ESTATE_MODERATOR_RUNTIME_KEY_FILE");
assert.equal(runtime.accountId, manifest.moderatorId);
const reader = new ChainReader(manifest.contractId);
const chain = new NearChainGateway(manifest.contractId);
const store = new ApiStore(
  resolve(dataDir, "estate.sqlite"),
  resolve(dataDir, "assets"),
);
const origin = "http://localhost:8080";
const password = randomBytes(32).toString("hex");
const adminAuth = `Basic ${Buffer.from(`local-reviewer:${password}`).toString("base64")}`;
const app = createApiApp({
  store,
  chain,
  moderator: new NearModeratorGateway(
    manifest.contractId,
    runtime.accountId,
    runtime.secret,
  ),
  appOrigin: origin,
  adminCredentials: { user: "local-reviewer", password },
});
const plotId = sharedOwner?.plotId ?? "plot-main-n-0";
const preparedPath = resolve(
  dataDir,
  sharedLevel2
    ? "shared-level2-mock-facade-prepared.json"
    : sharedCity
      ? "shared-mock-facade-prepared.json"
      : "mock-facade-prepared.json",
);
const proposalRecordPath = resolve(
  dataDir,
  sharedLevel2
    ? "shared-level2-mock-facade-proposal.json"
    : sharedCity
      ? "shared-mock-facade-proposal.json"
      : "mock-facade-proposal.json",
);

async function requireStatus(response: Response, expected: number) {
  if (response.status !== expected)
    throw new Error(
      `Expected HTTP ${expected}, got ${response.status}: ${await response.text()}`,
    );
}

async function postJson(path: string, body: unknown, cookie?: string) {
  return app.request(path, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
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

async function propose(expectedRevision: number, manifestHash: string) {
  const access = await reader.accessKey(
    owner.accountId,
    owner.pair.getPublicKey().toString(),
  );
  const transaction = createTransaction(
    owner.accountId,
    owner.pair.getPublicKey(),
    manifest.contractId,
    access.nonce + 1n,
    [
      actionCreators.functionCall(
        "propose_appearance",
        {
          plot_id: plotId,
          expected_revision: expectedRevision,
          manifest_hash: manifestHash,
        },
        60n * 10n ** 12n,
        0n,
      ),
    ],
    baseDecode(access.blockHash),
  );
  const [hashBytes, signed] = await KeyPairSigner.fromSecretKey(
    owner.secret,
  ).signTransaction(transaction);
  const hash = baseEncode(hashBytes);
  writeFileSync(
    proposalRecordPath,
    `${JSON.stringify({ plotId, expectedRevision, manifestHash, hash }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const bytes = Buffer.from(encodeTransaction(signed)).toString("base64");
  let outcome: "success" | "failure" | "pending" = "pending";
  try {
    outcome = await reader.sendSignedTransaction(bytes);
  } catch {
    // The exact hash can still finalize after the RPC reply is lost.
  }
  for (let attempt = 0; outcome === "pending" && attempt < 8; attempt++) {
    await new Promise((done) => setTimeout(done, 1_000));
    const status = await reader.transactionStatus(hash, owner.accountId);
    if (status !== "unknown") outcome = status;
  }
  if (outcome !== "success")
    throw new Error(`Appearance proposal ${hash} is ${outcome}`);
  return hash;
}

try {
  if (preparing) {
    const before = await reader.plot(plotId);
    assert.equal(before?.plot.owner, owner.accountId);
    assert.equal(
      before.plot.building.building_type,
      sharedCity ? "Restaurant" : "Cafe",
    );
    assert.equal(
      before.plot.building.level,
      sharedLevel2 ? 2 : sharedCity ? 1 : 2,
    );
    const cookie = await ownerCookie();
    type Job = {
      id: string;
      mode: string;
      status: string;
      selectedCandidateId?: number | null;
      candidates: Array<{
        id: number;
        manifestHash: string;
        spriteHash: string;
        thumbnailHash: string;
      }>;
    };
    const existing = store.latestGeneration(owner.accountId, plotId);
    const recovering = Boolean(
      (existing?.status === "submitted" || existing?.status === "selected") &&
        existing.selectedCandidateId === selectedCandidateId &&
        before.plot.building.pending_appearance?.manifest_hash ===
          existing.candidates[selectedCandidateIndex]?.manifestHash,
    );
    let job: Job;
    if (recovering) {
      job = existing as Job;
    } else {
      assert.equal(before.plot.building.pending_appearance, null);
      const created = await postJson(
        "/generations",
        {
          plotId,
          description: sharedLevel2
            ? "A taller green restaurant with a planted roof and a broad central arcade"
            : sharedCity
              ? "A welcoming green neighbourhood restaurant with a garden terrace"
              : "A playful blue corner cafe with a distinctive awning",
          palette: sharedCity ? "#73D9A6" : "#69B9E9",
          themeHint: sharedCity ? "Garden" : "Playful",
          materialHints: sharedCity ? ["Timber", "Brick"] : ["Tile", "Timber"],
        },
        cookie,
      );
      await requireStatus(created, 201);
      job = (await created.json()) as Job;
      assert.equal(job.status, "ready");
    }
    assert.equal(job.mode, "curated_mock");
    assert.equal(job.candidates.length, 3);
    const candidate = job.candidates[selectedCandidateIndex]!;
    assert.equal(candidate.id, selectedCandidateId);
    const privateAsset = await app.request(`/assets/${candidate.spriteHash}`);
    assert.equal(privateAsset.status, 404);
    let proposalTransaction: string | null = null;
    if (recovering) {
      if (job.status === "selected") {
        const reconciled = await postJson(
          `/generations/${job.id}/reconcile`,
          {},
          cookie,
        );
        await requireStatus(reconciled, 200);
        assert.equal(
          ((await reconciled.json()) as { status: string }).status,
          "submitted",
        );
      }
      if (existsSync(proposalRecordPath)) {
        const record = JSON.parse(readFileSync(proposalRecordPath, "utf8")) as {
          plotId: string;
          expectedRevision: number;
          manifestHash: string;
          hash: string;
        };
        if (
          record.plotId === plotId &&
          record.expectedRevision ===
            before.plot.building.appearance_revision - 1 &&
          record.manifestHash === candidate.manifestHash
        )
          proposalTransaction = record.hash;
      }
    } else {
      const selected = await postJson(
        `/generations/${job.id}/select`,
        { candidateId: candidate.id },
        cookie,
      );
      await requireStatus(selected, 200);
      const selection = (await selected.json()) as {
        expectedRevision: number;
        manifestHash: string;
      };
      assert.equal(
        selection.expectedRevision,
        before.plot.building.appearance_revision,
      );
      assert.equal(selection.manifestHash, candidate.manifestHash);
      proposalTransaction = await propose(
        selection.expectedRevision,
        candidate.manifestHash,
      );
      const reconciled = await postJson(
        `/generations/${job.id}/reconcile`,
        {},
        cookie,
      );
      await requireStatus(reconciled, 200);
      const submitted = (await reconciled.json()) as { status: string };
      assert.equal(submitted.status, "submitted");
    }
    const pending = await reader.plot(plotId);
    assert.equal(
      pending?.plot.building.pending_appearance?.manifest_hash,
      candidate.manifestHash,
    );
    const page = await app.request("/moderation", {
      headers: { authorization: adminAuth },
    });
    await requireStatus(page, 200);
    const html = await page.text();
    assert.match(html, /Approve exact design/);
    assert(html.includes(candidate.manifestHash));
    const preview = html.match(
      /<img src="data:image\/png;base64,([^"]+)" alt="Selected facade"/,
    )?.[1];
    assert(preview, "Moderator preview image is missing");
    const previewPath = resolve(dataDir, "mock-facade-review.png");
    writeFileSync(previewPath, Buffer.from(preview, "base64"), { mode: 0o600 });
    const prepared = {
      contractId: manifest.contractId,
      ownerId: owner.accountId,
      moderatorId: manifest.moderatorId,
      plotId,
      jobId: job.id,
      candidateId: candidate.id,
      manifestHash: candidate.manifestHash,
      spriteHash: candidate.spriteHash,
      thumbnailHash: candidate.thumbnailHash,
      appearanceRevisionBefore:
        before.plot.building.appearance_revision - (recovering ? 1 : 0),
      layoutRevisionBefore: before.plot.building.layout_revision,
      proposalTransaction,
      previewPath,
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
      jobId: string;
      candidateId: number;
      manifestHash: string;
      spriteHash: string;
      thumbnailHash: string;
      appearanceRevisionBefore: number;
      layoutRevisionBefore: number;
      proposalTransaction: string | null;
    };
    assert.equal(prepared.contractId, manifest.contractId);
    assert.equal(prepared.ownerId, owner.accountId);
    assert.equal(prepared.moderatorId, runtime.accountId);
    const pending = await reader.plot(plotId);
    assert.equal(
      pending?.plot.building.pending_appearance?.manifest_hash,
      prepared.manifestHash,
    );
    const page = await app.request("/moderation", {
      headers: { authorization: adminAuth },
    });
    await requireStatus(page, 200);
    assert((await page.text()).includes(prepared.manifestHash));
    const approved = await app.request(
      `/moderation/generations/${prepared.jobId}/approve`,
      {
        method: "POST",
        headers: { origin, authorization: adminAuth },
      },
    );
    await requireStatus(approved, 303);
    const finalPlot = await reader.plot(plotId);
    assert.equal(
      finalPlot?.plot.building.approved_manifest_hash,
      prepared.manifestHash,
    );
    assert.equal(finalPlot.plot.building.pending_appearance, null);
    assert.equal(
      finalPlot.plot.building.appearance_revision,
      prepared.appearanceRevisionBefore + 1,
    );
    assert.equal(
      finalPlot.plot.building.layout_revision,
      prepared.layoutRevisionBefore + 1,
    );
    const ownerSession = await ownerCookie();
    const jobResponse = await app.request(`/generations/${prepared.jobId}`, {
      headers: { cookie: ownerSession },
    });
    await requireStatus(jobResponse, 200);
    const job = (await jobResponse.json()) as { status: string };
    assert.equal(job.status, "approved");
    const publicManifest = await app.request(
      `/manifests/${prepared.manifestHash}`,
    );
    await requireStatus(publicManifest, 200);
    const publicSprite = await app.request(`/assets/${prepared.spriteHash}`);
    await requireStatus(publicSprite, 200);
    const bytes = Buffer.from(await publicSprite.arrayBuffer());
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      prepared.spriteHash,
    );
    const evidence = {
      network: "testnet",
      contractId: manifest.contractId,
      ownerId: owner.accountId,
      moderatorId: runtime.accountId,
      ...(sharedLevel2
        ? { moderatorRuntimePublicKey: runtime.pair.getPublicKey().toString() }
        : {}),
      plotId,
      jobId: prepared.jobId,
      candidateId: prepared.candidateId,
      manifestHash: prepared.manifestHash,
      spriteHash: prepared.spriteHash,
      appearanceRevision: finalPlot.plot.building.appearance_revision,
      layoutRevision: finalPlot.plot.building.layout_revision,
      proposalTransaction: prepared.proposalTransaction,
      approvedOnChain: true,
      anonymousManifestReadable: true,
      anonymousSpriteHashVerified: true,
      ownerJobStatus: job.status,
    };
    writeFileSync(
      resolve(
        root,
        sharedLevel2
          ? "deployments/testnet-shared-level2-facade-journey.json"
          : sharedCity
            ? "deployments/testnet-shared-facade-journey.json"
            : "deployments/testnet-mock-facade-journey.json",
      ),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    console.log(JSON.stringify(evidence, null, 2));
  }
} finally {
  store.close();
}
