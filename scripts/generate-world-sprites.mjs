import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "apps/web/public/world");
const catalogPath = join(root, "apps/web/src/world-sprites.json");
const civicSourceDir = join(root, "art/source/civic-rendered");
const bodies = [
  "Hatchback",
  "Sedan",
  "SportsCoupe",
  "SUV",
  "Pickup",
  "Microvan",
];
const colors = {
  Red: "#EF8270",
  Blue: "#69B9E9",
  Yellow: "#F6C85F",
  Green: "#73D9A6",
};
const roles = [
  "ParkingTower",
  "RepairGarage",
  "Cinema",
  "BurgerStop",
  "PracticeCourse",
  "HorseCourse",
];
const civicLabels = {
  ParkingTower: { x: 24, y: 36, width: 92, height: 14 },
  RepairGarage: { x: 43, y: 116, width: 54, height: 13 },
  Cinema: { x: 15, y: 77, width: 110, height: 16 },
  BurgerStop: { x: 15, y: 106, width: 110, height: 15 },
  PracticeCourse: { x: 30, y: 70, width: 80, height: 14 },
  HorseCourse: { x: 31, y: 76, width: 78, height: 14 },
};
const ink = "#1e2d49";
const cream = "#fff8eb";
const window = "#bce7ec";

const svg = (width, height, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width * 4}" height="${height * 4}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
const rect = (x, y, w, h, fill, radius = 0, stroke = ink, sw = 1) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const path = (d, fill, stroke = ink, sw = 1.2) =>
  `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"/>`;
const circle = (x, y, r, fill, stroke = ink, sw = 1) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const line = (x1, y1, x2, y2, stroke = ink, sw = 1) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`;

function carSvg(body, color) {
  let silhouette;
  let glazing;
  let wheelX = [15, 49];
  if (body === "Hatchback") {
    silhouette = path(
      "M5 22 L7 15 L15 15 L20 8 L43 8 L50 15 L58 17 L60 23 L57 26 L7 26 Z",
      color,
    );
    glazing = path("M21 10 L41 10 L47 16 L16 16 Z", window);
  } else if (body === "Sedan") {
    silhouette = path(
      "M3 22 L6 16 L16 16 L23 9 L41 9 L47 16 L57 16 L61 22 L59 26 L5 26 Z",
      color,
    );
    glazing = path("M24 11 L40 11 L45 16 L19 16 Z", window);
    wheelX = [14, 50];
  } else if (body === "SportsCoupe") {
    silhouette = path(
      "M2 23 L8 18 L18 17 L31 10 L45 12 L53 18 L61 20 L62 24 L58 26 L5 26 Z",
      color,
    );
    glazing = path("M30 12 L44 14 L50 18 L20 18 Z", window);
    wheelX = [14, 51];
  } else if (body === "SUV") {
    silhouette = path(
      "M4 23 L6 8 L48 8 L54 15 L59 16 L61 23 L58 27 L6 27 Z",
      color,
    );
    glazing = path("M10 11 L46 11 L51 17 L9 17 Z", window);
  } else if (body === "Pickup") {
    silhouette = path("M3 23 L5 9 L32 9 L39 16 L60 16 L61 25 L5 25 Z", color);
    glazing = path("M9 12 L30 12 L35 17 L8 17 Z", window);
    wheelX = [14, 50];
  } else if (body === "Microvan") {
    silhouette = path("M7 25 L7 7 L51 7 L57 12 L59 25 Z", color);
    glazing = path("M11 10 L49 10 L54 14 L54 18 L11 18 Z", window);
  } else throw new Error(`Unknown car body ${body}`);
  const divider =
    body === "Pickup" ? line(39, 17, 39, 24) : line(34, 10, 34, 18);
  const cargo =
    body === "Pickup"
      ? path("M40 18 L59 18 L59 23 L40 23 Z", "#e6d5bf", ink, 0.7)
      : "";
  const bumper = line(5, 25, 59, 25, ink, 1);
  const wheels = wheelX
    .map(
      (x) =>
        circle(x, 26, 4.3, ink, ink, 0.5) +
        circle(x, 26, 2, "#d8dfe2", ink, 0.4),
    )
    .join("");
  return svg(
    64,
    32,
    silhouette +
      glazing +
      divider +
      cargo +
      bumper +
      wheels +
      circle(57, 19, 1.2, cream, "none", 0),
  );
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function renderedSite(role) {
  const source = await readFile(
    join(civicSourceDir, `${role.toLowerCase()}.png`),
  );
  const metadata = await sharp(source).metadata();
  if (!metadata.hasAlpha) throw new Error(`${role} source needs alpha`);
  const { data: trimmed, info } = await sharp(source)
    .trim({ threshold: 10 })
    .png()
    .toBuffer({ resolveWithObject: true });
  const scale = Math.min(536 / info.width, 620 / info.height);
  const width = Math.round(info.width * scale);
  const height = Math.round(info.height * scale);
  const resized = await sharp(trimmed).resize(width, height).png().toBuffer();
  const data = await sharp({
    create: {
      width: 560,
      height: 640,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: resized,
        left: Math.round((560 - width) / 2),
        top: 640 - height,
      },
    ])
    .png()
    .toBuffer();
  return { data, sourceHash: digest(source), labelRect: civicLabels[role] };
}

async function alphaBounds(png, width, height) {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    info.width !== width * 4 ||
    info.height !== height * 4 ||
    info.channels !== 4
  )
    throw new Error(`sprite must be ${width * 4}×${height * 4} RGBA`);
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) throw new Error("sprite has no visible pixels");
  return {
    x: minX / 4,
    y: minY / 4,
    width: (maxX + 1 - minX) / 4,
    height: (maxY + 1 - minY) / 4,
  };
}

function checkBounds(bounds, width, height, key) {
  if (
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.x + bounds.width > width ||
    bounds.y + bounds.height > height
  )
    throw new Error(`${key} exceeds its ${width}×${height} envelope`);
}

async function verify(catalog) {
  if (
    catalog.version !== 1 ||
    !Array.isArray(catalog.cars) ||
    !Array.isArray(catalog.sites) ||
    catalog.cars.length !== 24 ||
    catalog.sites.length !== roles.length
  )
    throw new Error(
      `world sprite catalog must have 24 cars and ${roles.length} sites`,
    );
  const expectedCars = new Set(
    bodies.flatMap((body) =>
      Object.keys(colors).map((color) => `${body}:${color}`),
    ),
  );
  const expectedSites = new Set(roles);
  for (const entry of catalog.cars) {
    const key = `${entry.body}:${entry.color}`;
    if (!expectedCars.delete(key))
      throw new Error(`duplicate or unexpected car ${key}`);
    const data = await readFile(join(output, entry.sprite));
    if (digest(data) !== entry.hash)
      throw new Error(`car hash mismatch ${key}`);
    const bounds = await alphaBounds(data, 64, 32);
    if (JSON.stringify(bounds) !== JSON.stringify(entry.alphaBounds))
      throw new Error(`car alpha bounds mismatch ${key}`);
    checkBounds(bounds, 64, 32, key);
  }
  for (const entry of catalog.sites) {
    if (!expectedSites.delete(entry.role))
      throw new Error(`duplicate or unexpected site ${entry.role}`);
    const data = await readFile(join(output, entry.sprite));
    if (digest(data) !== entry.hash)
      throw new Error(`site hash mismatch ${entry.role}`);
    const source = await renderedSite(entry.role);
    if (entry.sourceHash !== source.sourceHash || !data.equals(source.data))
      throw new Error(`rendered civic source mismatch ${entry.role}`);
    const bounds = await alphaBounds(data, 140, 160);
    if (JSON.stringify(bounds) !== JSON.stringify(entry.alphaBounds))
      throw new Error(`site alpha bounds mismatch ${entry.role}`);
    checkBounds(bounds, 140, 160, entry.role);
    checkBounds(entry.labelRect, 140, 160, `${entry.role} label`);
  }
  if (expectedCars.size || expectedSites.size)
    throw new Error("world sprite catalog is missing a body, color or site");
  console.log(`Validated 24 car and ${roles.length} civic destination sprites`);
}

async function generate() {
  await mkdir(output, { recursive: true });
  const cars = [];
  const sites = [];
  for (const body of bodies) {
    for (const [color, hex] of Object.entries(colors)) {
      const sprite = `${body.toLowerCase()}-${color.toLowerCase()}.png`;
      const data = await sharp(Buffer.from(carSvg(body, hex)))
        .png()
        .toBuffer();
      const bounds = await alphaBounds(data, 64, 32);
      checkBounds(bounds, 64, 32, `${body}:${color}`);
      await writeFile(join(output, sprite), data);
      cars.push({
        body,
        color,
        sprite,
        hash: digest(data),
        alphaBounds: bounds,
      });
    }
  }
  for (const role of roles) {
    const sprite = `${role.toLowerCase()}.png`;
    const art = await renderedSite(role);
    const { data } = art;
    const bounds = await alphaBounds(data, 140, 160);
    checkBounds(bounds, 140, 160, role);
    checkBounds(art.labelRect, 140, 160, `${role} label`);
    await writeFile(join(output, sprite), data);
    sites.push({
      role,
      sprite,
      hash: digest(data),
      sourceHash: art.sourceHash,
      alphaBounds: bounds,
      labelRect: art.labelRect,
    });
  }
  const catalog = { version: 1, cars, sites };
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`Generated 24 car and ${roles.length} civic destination sprites`);
  await verify(catalog);
}

if (process.argv.includes("--check")) {
  await verify(JSON.parse(await readFile(catalogPath, "utf8")));
} else {
  await generate();
}
