import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair } from "@near-js/crypto";

test("creates one protected agent key and prints only its public key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "estate-agent-key-"));
  const output = join(directory, "driver.key.json");
  const command = [
    fileURLToPath(new URL("./agent-key-new.mjs", import.meta.url)),
    "--account",
    "driver.testnet",
    "--out",
    output,
  ];
  try {
    const result = spawnSync(process.execPath, command, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const printed = JSON.parse(result.stdout);
    const saved = JSON.parse(await readFile(output, "utf8"));
    assert.equal(printed.publicKey, saved.publicKey);
    assert.equal(
      KeyPair.fromString(saved.secretKey).getPublicKey().toString(),
      saved.publicKey,
    );
    assert.equal(result.stdout.includes(saved.secretKey), false);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const second = spawnSync(process.execPath, command, { encoding: "utf8" });
    assert.notEqual(second.status, 0);
    assert.equal(await readFile(output, "utf8"), JSON.stringify(saved));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plot agent receives a separate protected role key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "estate-plot-agent-key-"));
  const output = join(directory, "owner.plot.key.json");
  try {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./agent-key-new.mjs", import.meta.url)),
        "--account",
        "owner.testnet",
        "--role",
        "plot",
        "--out",
        output,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(await readFile(output, "utf8"));
    assert.equal(record.role, "plot");
    assert.equal(record.accountId, "owner.testnet");
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(result.stdout.includes(record.secretKey), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
