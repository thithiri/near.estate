import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "apps/web/public/world");
const catalogPath = join(root, "apps/web/src/world-sprites.json");
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
const ink = "#1e2d49";
const cream = "#fff8eb";
const window = "#bce7ec";
const road = "#66768a";

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

function siteSvg(role) {
  let art = "";
  let labelRect;
  if (role === "ParkingTower") {
    art += rect(13, 11, 114, 147, "#c9d9db", 2);
    art += rect(8, 7, 124, 8, "#537e87", 1);
    for (const y of [43, 73, 103, 133]) {
      art += rect(20, y, 100, 19, road, 2);
      for (const x of [46, 72, 98])
        art += line(x, y + 1, x, y + 18, cream, 1.5);
    }
    art += rect(25, 20, 90, 16, cream, 2);
    labelRect = { x: 25, y: 20, width: 90, height: 16 };
  } else if (role === "RepairGarage") {
    art += rect(10, 66, 120, 92, "#d9e7e7", 2);
    art += path("M7 67 L32 50 L58 67 L85 50 L132 67 Z", "#69B9E9");
    art += rect(20, 95, 100, 63, "#7c9fae", 2);
    for (const y of [111, 127, 143]) art += line(22, y, 118, y, cream, 2);
    art += rect(25, 76, 90, 15, cream, 2);
    labelRect = { x: 25, y: 76, width: 90, height: 15 };
  } else if (role === "Cinema") {
    art += rect(16, 48, 108, 110, "#9187ba", 4);
    art += path("M14 54 L70 28 L126 54 Z", "#c0b4d4");
    art += rect(4, 82, 132, 20, "#F6C85F", 3);
    for (const x of [11, 129]) art += circle(x, 92, 2, cream, "none", 0);
    art += rect(37, 111, 66, 47, "#30455b", 3);
    art += line(70, 112, 70, 157, cream, 1.5);
    art += circle(70, 63, 12, "#f3e8dc");
    for (const [x, y] of [
      [65, 58],
      [75, 58],
      [65, 68],
      [75, 68],
    ])
      art += circle(x, y, 2.3, ink, "none", 0);
    labelRect = { x: 18, y: 84, width: 104, height: 15 };
  } else if (role === "BurgerStop") {
    art += rect(8, 91, 124, 67, "#f3c49f", 6);
    art += path("M17 94 C20 65 120 65 123 94 Z", "#F6C85F");
    art += path("M16 93 Q70 99 124 93 L124 99 Q70 105 16 99 Z", "#73D9A6");
    art += rect(18, 110, 104, 18, cream, 3);
    art += rect(20, 132, 35, 21, window, 3);
    art += rect(64, 130, 20, 28, "#624d45", 2);
    art += rect(93, 132, 29, 21, window, 3);
    labelRect = { x: 18, y: 110, width: 104, height: 18 };
  } else if (role === "PracticeCourse") {
    art += rect(5, 99, 12, 59, "#e9e5d7", 1);
    art += rect(123, 99, 12, 59, "#e9e5d7", 1);
    art += path("M5 100 L70 67 L135 100 L135 111 L70 79 L5 111 Z", "#EF8270");
    art += rect(28, 94, 84, 18, cream, 2);
    for (const x of [25, 113]) {
      art += line(x, 115, x, 154, ink, 2);
      art += path(`M${x} 116 L${x + 15} 121 L${x} 127 Z`, "#F6C85F");
    }
    labelRect = { x: 28, y: 94, width: 84, height: 18 };
  } else if (role === "HorseCourse") {
    art += rect(9, 90, 122, 68, "#f0dcc2", 3);
    art += path("M5 86 L19 57 L70 35 L121 57 L135 86 Z", "#2f6f65");
    art += path("M12 82 L25 61 L70 43 L115 61 L128 82 Z", "#4a9a86");
    for (const x of [24, 43, 97, 116]) {
      art += line(x, 86, x, 158, "#a87859", 2);
      art += rect(x - 2, 108, 5, 4, "#e9b85b", 1);
    }
    art += path(
      "M46 158 L46 121 Q46 100 70 100 Q94 100 94 121 L94 158 Z",
      "#31585b",
    );
    art += path(
      "M53 158 L53 122 Q53 108 70 108 Q87 108 87 122 L87 158 Z",
      "#abc8b4",
    );
    art += rect(21, 90, 98, 20, cream, 3);
    art += line(11, 139, 45, 139, "#fff8eb", 2);
    art += line(95, 139, 129, 139, "#fff8eb", 2);
    art += line(13, 148, 44, 148, "#a87859", 2);
    art += line(96, 148, 127, 148, "#a87859", 2);
    art += path(
      "M60 56 Q58 68 60 74 Q70 83 80 74 Q82 68 80 56",
      "none",
      "#e9b85b",
      4,
    );
    art += circle(61, 58, 1.4, cream, "none", 0);
    art += circle(79, 58, 1.4, cream, "none", 0);
    art += line(20, 57, 20, 41, ink, 1.5);
    art += path("M20 42 L34 46 L20 51 Z", "#ef8270");
    art += line(120, 57, 120, 41, ink, 1.5);
    art += path("M120 42 L106 46 L120 51 Z", "#f6c85f");
    labelRect = { x: 24, y: 92, width: 92, height: 16 };
  } else throw new Error(`Unknown NPC role ${role}`);
  return { image: svg(140, 160, art), labelRect };
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

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
    const art = siteSvg(role);
    const data = await sharp(Buffer.from(art.image)).png().toBuffer();
    const bounds = await alphaBounds(data, 140, 160);
    checkBounds(bounds, 140, 160, role);
    checkBounds(art.labelRect, 140, 160, `${role} label`);
    await writeFile(join(output, sprite), data);
    sites.push({
      role,
      sprite,
      hash: digest(data),
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
