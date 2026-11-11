import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalog = JSON.parse(
  await readFile(join(root, "apps/web/src/preset-catalog.json"), "utf8"),
);
const sprites = join(root, "apps/web/public/presets");
const output = join(root, "docs/images/near-estate-level-neighbours-v1.png");
const contactOutput = join(
  root,
  "docs/images/near-estate-preset-contact-sheet-v1.png",
);
const types = ["Retail", "Cafe", "Restaurant", "Office", "Homes"];
const cellWidth = 530;
const cellHeight = 215;
const sheetWidth = cellWidth * 4;
const sheetHeight = cellHeight * 10;
const entries = new Map(
  catalog.facades.map((entry) => [
    `${entry.buildingType}:${entry.variant}:${entry.level}`,
    entry,
  ]),
);

function titleImage(title) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cellWidth}" height="26"><text x="12" y="19" font-family="Arial" font-size="16" font-weight="bold" fill="#1e2d49">${title}</text></svg>`,
  );
}

const layers = [];
for (let row = 0; row < 10; row++) {
  const type = types[Math.floor(row / 2)];
  const variant = (row % 2) + 1;
  for (let level = 1; level <= 4; level++) {
    const left = (level - 1) * cellWidth;
    const top = row * cellHeight;
    const background = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${cellWidth}" height="${cellHeight}"><rect width="${cellWidth}" height="190" fill="#a6dff6"/><rect y="190" width="${cellWidth}" height="12" fill="#eddccd"/><rect y="202" width="${cellWidth}" height="13" fill="#667587"/><path d="M8 203h64m35 0h64m35 0h64m35 0h64m35 0h64" stroke="#ffffff" stroke-width="2"/><rect width="${cellWidth - 1}" height="214" fill="none" stroke="#d3d7d2" stroke-width="2"/></svg>`,
    );
    layers.push({ input: background, left, top });
    layers.push({
      input: titleImage(`${type} · shape ${variant} · level ${level}`),
      left,
      top,
    });
    for (const [offset, key] of [
      [0, "Restaurant:1:3"],
      [170, `${type}:${variant}:${level}`],
      [340, "Homes:1:1"],
    ]) {
      const entry = entries.get(key);
      if (!entry) throw new Error(`Missing preset ${key}`);
      const png = await sharp(join(sprites, entry.sprite))
        .resize(140, 160)
        .png()
        .toBuffer();
      layers.push({ input: png, left: left + 15 + offset, top: top + 30 });
    }
  }
}
const image = await sharp({
  create: {
    width: sheetWidth,
    height: sheetHeight,
    channels: 4,
    background: "#ffffff",
  },
})
  .composite(layers)
  .png()
  .toBuffer();

const contactCellWidth = 240;
const contactCellHeight = 260;
const contactLayers = [];
for (let variant = 1; variant <= 2; variant++) {
  for (let column = 0; column < types.length; column++) {
    const type = types[column];
    const entry = entries.get(`${type}:${variant}:1`);
    if (!entry)
      throw new Error(`Missing contact-sheet preset ${type}:${variant}`);
    const left = column * contactCellWidth;
    const top = (variant - 1) * contactCellHeight;
    contactLayers.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${contactCellWidth}" height="${contactCellHeight}"><rect x="9" y="9" width="221" height="235" rx="12" fill="#eaf2ed" stroke="#1e2d49" stroke-width="2"/><path d="M18 220h204" stroke="#798b91" stroke-width="3"/><text x="120" y="37" text-anchor="middle" font-family="Arial" font-size="17" font-weight="bold" fill="#1e2d49">${type} ${variant}</text></svg>`,
      ),
      left,
      top,
    });
    contactLayers.push({
      input: await sharp(join(sprites, entry.sprite))
        .extract({ left: 0, top: 280, width: 560, height: 360 })
        .resize(210, 135)
        .png()
        .toBuffer(),
      left: left + 15,
      top: top + 85,
    });
  }
}
const contact = await sharp({
  create: {
    width: contactCellWidth * types.length,
    height: contactCellHeight * 2,
    channels: 4,
    background: "#ffffff",
  },
})
  .composite(contactLayers)
  .png()
  .toBuffer();
if (process.argv.includes("--check")) {
  const [savedNeighbours, savedContact] = await Promise.all([
    readFile(output),
    readFile(contactOutput),
  ]);
  if (!image.equals(savedNeighbours) || !contact.equals(savedContact))
    throw new Error("Preset review sheets differ from the facade catalog");
  console.log("Validated both preset review sheets");
} else {
  await Promise.all([
    writeFile(output, image),
    writeFile(contactOutput, contact),
  ]);
  console.log(`Wrote ${output} and ${contactOutput}`);
}
