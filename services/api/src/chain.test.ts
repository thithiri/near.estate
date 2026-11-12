import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NearChainGateway } from "./chain.js";

function rpc(value: unknown): Response {
  return Response.json({
    jsonrpc: "2.0",
    result: {
      block_hash: "test-final-block",
      result: [...new TextEncoder().encode(JSON.stringify(value))],
    },
  });
}

test("API selects the reported city version and rejects an unknown one", async () => {
  const reader = new NearChainGateway("estate.testnet", undefined, (async () =>
    rpc(2)) as typeof fetch);
  assert.equal(await reader.cityVersion(), 2);
  const unknown = new NearChainGateway("estate.testnet", undefined, (async () =>
    rpc(3)) as typeof fetch);
  await assert.rejects(unknown.cityVersion());
});

test("API treats only a missing legacy city-version method as version 1", async () => {
  const missing = new NearChainGateway("estate.testnet", undefined, (async () =>
    Response.json({
      jsonrpc: "2.0",
      result: {
        block_hash: "test-final-block",
        error: "MethodResolveError(MethodNotFound)",
      },
    })) as typeof fetch);
  assert.equal(await missing.cityVersion(), 1);
  const otherError = new NearChainGateway(
    "estate.testnet",
    undefined,
    (async () =>
      Response.json({
        jsonrpc: "2.0",
        result: { block_hash: "test-final-block", error: "RPC unavailable" },
      })) as typeof fetch,
  );
  await assert.rejects(otherError.cityVersion(), /RPC unavailable/);
});

test("API parses actual version-2 sandbox plot views before and after facade approval", async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "../../../deployments/variable-city-contract-media-fixture-2026-11-12.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    contractId: string;
    plotId: string;
    appearanceReference: { manifest_hash: string };
    logoHash: string;
    pendingPlot: unknown;
    approvedPlot: unknown;
    logoApprovedPlot: unknown;
  };
  const pendingGateway = new NearChainGateway(
    fixture.contractId,
    undefined,
    (async () => rpc(fixture.pendingPlot)) as typeof fetch,
  );
  const approvedGateway = new NearChainGateway(
    fixture.contractId,
    undefined,
    (async () => rpc(fixture.approvedPlot)) as typeof fetch,
  );
  const logoGateway = new NearChainGateway(
    fixture.contractId,
    undefined,
    (async () => rpc(fixture.logoApprovedPlot)) as typeof fetch,
  );
  const pending = await pendingGateway.plot(fixture.plotId);
  const approved = await approvedGateway.plot(fixture.plotId);
  const logoApproved = await logoGateway.plot(fixture.plotId);
  assert.ok(pending && approved && logoApproved);
  assert.equal(pending.plot.id, fixture.plotId);
  assert.equal(approved.plot.id, fixture.plotId);
  assert.ok("frontage_units" in pending.plot);
  assert.ok("frontage_units" in approved.plot);
  assert.equal(pending.plot.frontage_units, 3);
  assert.equal(approved.plot.frontage_units, 3);
  assert.equal(
    pending.plot.building.pending_appearance?.manifest_hash,
    fixture.appearanceReference.manifest_hash,
  );
  assert.equal(approved.plot.building.pending_appearance, null);
  assert.equal(
    approved.plot.building.approved_manifest_hash,
    fixture.appearanceReference.manifest_hash,
  );
  assert.equal(
    approved.plot.building.last_appearance_decision?.status,
    "Approved",
  );
  assert.ok(
    approved.plot.building.layout_revision >
      pending.plot.building.layout_revision,
  );
  assert.equal(logoApproved.logo_eligible, true);
  assert.equal(
    logoApproved.plot.logo.active?.content.asset_hash,
    fixture.logoHash,
  );
  assert.equal(
    logoApproved.plot.logo.active?.approved_layout_revision,
    logoApproved.plot.building.layout_revision,
  );
});
