import { expect, test } from "@playwright/test";

test("all sixty building and level combinations fit the height envelope", async ({
  page,
}) => {
  await page.goto("/graphics-lab.html");
  const violations = await page.evaluate(async () => {
    const { choices, paintBuilding } = await import("/src/frontage-art.ts");
    const { LEVEL_HEIGHTS } = await import("/src/frontage-layout.ts");
    const failures: string[] = [];
    for (const choice of choices) {
      for (const level of [1, 2, 3, 4] as const) {
        const canvas = document.createElement("canvas");
        canvas.width = choice.units * 85;
        canvas.height = 190;
        const context = canvas.getContext("2d")!;
        paintBuilding(context, choice, 0, 190, null, true, level);
        const pixels = context.getImageData(0, 0, canvas.width, 190).data;
        let first = 190;
        for (let y = 0; y < 190; y++) {
          for (let x = 0; x < canvas.width; x++) {
            if (pixels[(y * canvas.width + x) * 4 + 3] > 0)
              first = Math.min(first, y);
          }
        }
        if (first < 190 - LEVEL_HEIGHTS[level])
          failures.push(`${choice.id} level ${level}: ${first}`);
      }
    }
    return failures;
  });
  expect(violations).toEqual([]);
});
