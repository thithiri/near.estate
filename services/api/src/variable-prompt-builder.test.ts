import assert from "node:assert/strict";
import test from "node:test";
import { FRONTAGE_DESIGN_IDS_V2 } from "@estate/shared";
import { buildVariableGenerationPrompt } from "./variable-prompt-builder.js";

test("version-2 prompts bind all fifteen silhouettes to plot width and design order", () => {
  for (const units of [1, 2, 3] as const) {
    for (let choice = 0; choice < 5; choice++) {
      const spec = buildVariableGenerationPrompt({
        frontageUnits: units,
        designChoice: choice,
        buildingType: "Retail",
        level: 4,
        palette: "#EF8270",
        description: "A few roof plants",
      });
      assert.equal(spec.version, 5);
      assert.equal(spec.renderProfileVersion, 2);
      assert.equal(spec.designId, FRONTAGE_DESIGN_IDS_V2[units][choice]);
      assert.match(spec.prompt, new RegExp(`${units}-unit plot`));
      assert.match(spec.prompt, new RegExp(`${units * 85} × 190`));
      assert.match(spec.promptHash, /^[a-f0-9]{64}$/);
    }
  }
});

test("version-2 prompt offers a billboard only on the approved shape and level", () => {
  const input = {
    frontageUnits: 2 as const,
    designChoice: 1,
    buildingType: "Restaurant" as const,
    level: 3 as const,
    palette: "#F6C85F" as const,
    description: "Warm window lights",
  };
  const diner = buildVariableGenerationPrompt(input);
  assert.match(diner.prompt, /separate billboard/);
  assert.match(
    buildVariableGenerationPrompt({ ...input, level: 2 }).prompt,
    /no approved billboard surface/,
  );
  assert.match(
    buildVariableGenerationPrompt({ ...input, designChoice: 2 }).prompt,
    /no approved billboard surface/,
  );
  assert.equal(
    diner.promptHash,
    buildVariableGenerationPrompt(input).promptHash,
  );
  assert.notEqual(
    diner.promptHash,
    buildVariableGenerationPrompt({ ...input, designChoice: 4 }).promptHash,
  );
});
