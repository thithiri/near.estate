import { execFileSync } from "node:child_process";

const expected = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(expected ?? "")) {
  throw new Error("Pass the exact 40-character source commit SHA.");
}

const run = (args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const config = JSON.parse(
  run(["compose", "-f", "infra/compose.yaml", "config", "--format", "json"]),
);
const records = [];

for (const service of ["api", "indexer", "web"]) {
  const tag = `${config.name}-${service}`;
  const [raw] = JSON.parse(run(["image", "inspect", tag]));
  const revision = raw.Config.Labels?.["org.opencontainers.image.revision"];
  if (revision !== expected) {
    throw new Error(
      `${tag} has revision ${revision ?? "(missing)"}, expected ${expected}`,
    );
  }
  records.push({ service, imageId: raw.Id, sourceRevision: revision });
}

console.log(JSON.stringify({ project: config.name, images: records }, null, 2));
