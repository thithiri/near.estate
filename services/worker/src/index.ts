import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateCitySeed } from "@estate/shared";

const path = fileURLToPath(
  new URL("../../../contracts/estate/seed.json", import.meta.url),
);
const seed = validateCitySeed(JSON.parse(readFileSync(path, "utf8")));
console.log(
  `Seed audit: ${seed.streets.length} roads, ${seed.plots.length} plots, ${seed.npcSites.length} NPC sites`,
);
