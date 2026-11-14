#!/usr/bin/env node
import { mkdir, lstat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, dirname } from "node:path";
import { KeyPair } from "@near-js/crypto";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? null : args[at + 1];
};

async function main() {
  const accountId = option("--account");
  if (!accountId || !/^[a-z0-9._-]+\.testnet$/.test(accountId))
    throw new Error("Pass --account <player.testnet>");
  const defaultDir = join(homedir(), ".near-estate-agent");
  const output = option("--out") ?? join(defaultDir, `${accountId}.key.json`);
  if (!isAbsolute(output)) throw new Error("--out must be an absolute path");
  if (dirname(output) === defaultDir)
    await mkdir(defaultDir, { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(output));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077)
    throw new Error("Key directory must be a private directory (0700)");
  const pair = KeyPair.fromRandom("ed25519");
  const publicKey = pair.getPublicKey().toString();
  await writeFile(
    output,
    JSON.stringify({ accountId, publicKey, secretKey: pair.toString() }),
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify({ accountId, publicKey, keyFile: output }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
