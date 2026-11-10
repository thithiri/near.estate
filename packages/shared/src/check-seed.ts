import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateCitySeed } from "./world.js";

const file = fileURLToPath(
  new URL("../../../contracts/estate/seed.json", import.meta.url),
);
const seed = validateCitySeed(JSON.parse(readFileSync(file, "utf8")));
console.log(
  `Validated ${seed.streets.length} roads, ${seed.plots.length} plots, ${seed.npcSites.length} NPC sites`,
);
