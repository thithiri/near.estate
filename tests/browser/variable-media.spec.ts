import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import sharp from "sharp";

test("illustrated street loads approved media from extensionless asset URLs", async ({
  page,
}) => {
  const logo = await sharp({
    create: {
      width: 256,
      height: 256,
      channels: 4,
      background: "#ee3010",
    },
  })
    .png()
    .toBuffer();
  const billboard = await sharp({
    create: {
      width: 512,
      height: 256,
      channels: 4,
      background: "#ff0000",
    },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: 512,
            height: 136,
            channels: 4,
            background: "#00ff00",
          },
        })
          .png()
          .toBuffer(),
        left: 0,
        top: 60,
      },
    ])
    .png()
    .toBuffer();
  const logoHash = createHash("sha256").update(logo).digest("hex");
  const billboardHash = createHash("sha256").update(billboard).digest("hex");
  const assets = new Map([
    [logoHash, logo],
    [billboardHash, billboard],
  ]);
  await page.route("**/api/assets/*", (route) => {
    const hash = route.request().url().split("/").at(-1)!;
    const bytes = assets.get(hash);
    if (!bytes) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: "image/png", body: bytes });
  });
  await page.route("**/__variable_media_review", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><script type="module">
        import { choices } from "/src/frontage-art.ts";
        import { createGuestFrontage, GuestFrontageTextureCache } from "/src/guest-frontage.ts";
        const diner = choices.find((choice) => choice.id === "diner");
        window.reviewFrontage = createGuestFrontage(diner, 0, 4, null, "Diner", {
          logoHash: "${logoHash}", billboardHash: "${billboardHash}"
        });
        const cache = new GuestFrontageTextureCache();
        cache.setViews([{ x: 0, width: diner.units * 85, group: window.reviewFrontage }]);
        cache.updateVisible(0, diner.units * 85);
      </script></body></html>`,
    }),
  );
  await page.goto("/__variable_media_review");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as typeof window & {
            reviewFrontage?: {
              mediaViews: Array<{ sprite: { visible: boolean } }>;
            };
          }
        ).reviewFrontage?.mediaViews.every((view) => view.sprite.visible),
      ),
    )
    .toBe(true);
  const loaded = await page.evaluate(() => {
    const frontage = (
      window as typeof window & {
        reviewFrontage: {
          mediaViews: Array<{
            kind: string;
            sprite: {
              x: number;
              y: number;
              width: number;
              height: number;
              texture: { width: number; height: number };
            };
          }>;
        };
      }
    ).reviewFrontage;
    return frontage.mediaViews.map(({ kind, sprite }) => ({
      kind,
      x: sprite.x,
      y: sprite.y,
      width: sprite.width,
      height: sprite.height,
      textureWidth: sprite.texture.width,
      textureHeight: sprite.texture.height,
    }));
  });
  expect(loaded).toEqual([
    {
      kind: "Logo",
      x: 48.5,
      y: 135,
      width: 18,
      height: 18,
      textureWidth: 256,
      textureHeight: 256,
    },
    {
      kind: "Billboard",
      x: 41,
      y: 62,
      width: 88,
      height: 20,
      textureWidth: 352,
      textureHeight: 80,
    },
  ]);
  const billboardColors = await page.evaluate(() => {
    const frontage = (
      window as typeof window & {
        reviewFrontage: {
          mediaViews: Array<{
            kind: string;
            sprite: { texture: { source: { resource: HTMLCanvasElement } } };
          }>;
        };
      }
    ).reviewFrontage;
    const canvas = frontage.mediaViews.find(
      (view) => view.kind === "Billboard",
    )!.sprite.texture.source.resource;
    const context = canvas.getContext("2d")!;
    return [1, 40, 78].map((y) =>
      Array.from(context.getImageData(176, y, 1, 1).data),
    );
  });
  expect(billboardColors).toEqual([
    [0, 255, 0, 255],
    [0, 255, 0, 255],
    [0, 255, 0, 255],
  ]);
});

test("missing custom facade keeps the curated building visible", async ({
  page,
}) => {
  await page.route("**/api/assets/*", (route) =>
    route.fulfill({ status: 404 }),
  );
  await page.route("**/__variable_facade_failure", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><script type="module">
        import { choices } from "/src/frontage-art.ts";
        import { createGuestFrontage, GuestFrontageTextureCache } from "/src/guest-frontage.ts";
        const diner = choices.find((choice) => choice.id === "diner");
        window.reviewFrontage = createGuestFrontage(
          diner, 0, 4, null, "Diner", undefined, "${"a".repeat(64)}"
        );
        const cache = new GuestFrontageTextureCache();
        cache.setViews([{ x: 0, width: diner.units * 85, group: window.reviewFrontage }]);
        cache.updateVisible(0, diner.units * 85);
      </script></body></html>`,
    }),
  );
  await page.goto("/__variable_facade_failure");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const group = (
          window as typeof window & {
            reviewFrontage?: {
              children: Array<{
                visible: boolean;
                texture?: { width: number };
              }>;
              customFacadeSprite: { visible: boolean };
            };
          }
        ).reviewFrontage;
        return Boolean(
          group &&
            group.children[0]?.visible === false &&
            group.children[1]?.texture?.width === 680 &&
            group.customFacadeSprite.visible === false,
        );
      }),
    )
    .toBe(true);
});
