import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "apps/web/public/presets");
const catalogPath = join(root, "apps/web/src/preset-catalog.json");
const types = ["Retail", "Cafe", "Restaurant", "Office", "Homes"];
const heights = [70, 100, 130, 160];
const ink = "#1e2d49";
const retailPlaster = "#e8bb8d";
const marketStone = "#c9aa88";
const cafeStucco = "#cce6bb";
const dinerEnamel = "#ffd1a8";
const bistroStucco = "#dba985";
const officeConcrete = "#9fb8c6";
const homePlaster = "#dec899";
const pale = "#fff8eb";
const glass = "#bce7ec";
const glassDeep = "#7cb8c5";
const brick = "#dda992";
const timber = "#9b6b4b";
const concrete = "#d1d6d4";
const dark = "#41556a";

const rect = (x, y, w, h, fill, radius = 0, stroke = ink, sw = 1.5) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const poly = (points, fill, stroke = ink, sw = 1.5) =>
  `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`;
const line = (x1, y1, x2, y2, stroke = ink, sw = 1.5) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`;
const circle = (cx, cy, r, fill, stroke = ink, sw = 1.5) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const maskRect = (x, y, w, h, r = 0) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="#ffffff"/>`;
const maskPoly = (points) => `<polygon points="${points}" fill="#ffffff"/>`;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="640" viewBox="0 0 140 160">${body}</svg>`;

function upperWindows(x, width, top, level, columns, fill = glass) {
  const parts = [];
  for (let floor = 0; floor < level - 1; floor++) {
    const y = top + 25 + floor * 27;
    for (let column = 0; column < columns; column++) {
      const cell = width / columns;
      parts.push(rect(x + cell * column + 8, y, cell - 16, 15, fill, 2));
    }
  }
  return parts.join("");
}

function storefront(x, width) {
  return (
    rect(x + 7, 132, width * 0.32, 21, glass, 2) +
    rect(x + width * 0.64, 132, width * 0.27, 21, glass, 2) +
    rect(x + width * 0.42, 130, width * 0.17, 28, dark, 2)
  );
}

function design(type, variant, level) {
  const top = 160 - heights[level - 1] + 4;
  let base = "";
  let mask = "";
  let logoRect;
  let billboardRect;
  let nameRect;

  if (type === "Retail" && variant === 1) {
    base += rect(10, top + 8, 50, 150 - top, brick, 1);
    base += rect(52, top + 26, 80, 132 - top, retailPlaster, 1);
    base += upperWindows(12, 47, top, level, 2);
    for (const y of [top + 49, top + 76, top + 103]) {
      if (y < 127) base += line(14, y, 51, y, "#bd796c", 1);
    }
    base += storefront(53, 78);
    base += rect(7, top + 6, 58, 7, pale, 1);
    base += rect(50, top + 24, 84, 8, pale, 1);
    base += rect(54, 130, 77, 7, "#df735f", 1);
    for (let stripe = 0; stripe < 6; stripe++)
      base += rect(55 + stripe * 13, 130, 7, 7, pale, 0, "none", 0);
    base += line(54, 137, 131, 137, ink, 1.5);
    mask += maskRect(9, top + 7, 53, 4);
    mask += maskRect(53, top + 27, 79, 5);
    mask += maskRect(53, 125, 79, 7);
    logoRect = { x: 22, y: top + 17, width: 20, height: 20 };
    billboardRect = { x: 76, y: top + 37, width: 48, height: 24 };
    nameRect = { x: 56, y: top + 26, width: 74, height: 10 };
  } else if (type === "Retail" && variant === 2) {
    base += rect(8, top + 23, 124, 135 - top, marketStone, 1);
    base += poly(
      `8,${top + 24} 27,${top + 6} 43,${top + 24} 62,${top + 6} 78,${top + 24} 97,${top + 6} 132,${top + 24}`,
      pale,
    );
    for (const [left, peak, right] of [
      [8, 27, 43],
      [43, 62, 78],
      [78, 97, 132],
    ])
      base += poly(
        `${left},${top + 24} ${peak},${top + 6} ${right},${top + 24}`,
        "#d5a478",
        ink,
        1,
      );
    base += upperWindows(10, 120, top, level, 4, glassDeep);
    base += storefront(10, 120);
    base += rect(14, 123, 112, 5, "#476879", 1);
    for (let bay = 0; bay < 4; bay++)
      base += line(16 + bay * 29, 130, 16 + bay * 29, 151, "#476879", 2);
    mask += maskPoly(
      `10,${top + 22} 27,${top + 8} 43,${top + 22} 62,${top + 8} 78,${top + 22} 97,${top + 8} 130,${top + 22} 130,${top + 27} 10,${top + 27}`,
    );
    mask += maskRect(12, 124, 116, 6);
    logoRect = { x: 17, y: top + 30, width: 20, height: 20 };
    billboardRect = { x: 76, y: top + 31, width: 48, height: 24 };
    nameRect = { x: 43, y: 112, width: 90, height: 11 };
  } else if (type === "Cafe" && variant === 1) {
    base += rect(13, top + 27, 114, 131 - top, "#8fcfd0", 1);
    base += poly(`11,${top + 28} 70,${top + 4} 129,${top + 28}`, glassDeep);
    for (const x of [34, 52, 88, 106])
      base += line(x, top + 19, x, top + 28, pale, 1.5);
    base += upperWindows(15, 110, top, level, 4, glass);
    base += line(70, top + 5, 70, 158, ink, 2);
    base += line(15, top + 28, 125, top + 28, ink, 2);
    for (const x of [17, 112]) {
      base += rect(x, 143, 12, 12, "#a77858", 2);
      base += circle(x + 6, 139, 7, "#4f9e76", "none", 0);
    }
    base += rect(58, 127, 24, 31, dark, 1);
    base += rect(21, 131, 29, 20, pale, 2);
    base += rect(90, 131, 29, 20, pale, 2);
    for (const x of [34, 103]) {
      base += line(x, 150, x, 137, "#397a5f", 2);
      base += line(x, 146, x - 6, 140, "#397a5f", 2);
      base += line(x, 143, x + 6, 138, "#397a5f", 2);
      base += circle(x - 6, 140, 3, "#68a979", "none", 0);
      base += circle(x + 6, 138, 3, "#68a979", "none", 0);
    }
    mask += maskPoly(
      `11,${top + 28} 70,${top + 4} 129,${top + 28} 129,${top + 33} 70,${top + 9} 11,${top + 33}`,
    );
    mask += maskRect(18, top + 30, 4, 128 - top);
    mask += maskRect(119, top + 30, 4, 128 - top);
    logoRect = { x: 24, y: top + 35, width: 20, height: 20 };
    billboardRect = { x: 76, y: top + 35, width: 48, height: 24 };
    nameRect = { x: 43, y: 113, width: 54, height: 12 };
  } else if (type === "Cafe" && variant === 2) {
    base += rect(11, top + 22, 118, 136 - top, cafeStucco, 1);
    base += rect(5, top + 13, 130, 12, timber, 2);
    base += rect(17, top + 24, 8, 134 - top, timber, 1);
    base += rect(115, top + 24, 8, 134 - top, timber, 1);
    base += upperWindows(26, 88, top, level, 3);
    base += rect(31, 129, 27, 24, glass, 3);
    base += rect(62, 128, 21, 30, dark, 2);
    base += rect(87, 129, 27, 24, glass, 3);
    for (let slat = 0; slat < 5; slat++)
      base += line(16 + slat * 27, top + 14, 25 + slat * 27, top + 24, pale, 2);
    for (const x of [40, 70, 100]) {
      base += line(x, top + 25, x, top + 34, timber, 1);
      base += circle(x, top + 36, 3, "#f4c65e", timber, 1);
    }
    base += rect(24, 149, 11, 7, "#8b644b", 1);
    base += circle(29, 146, 6, "#578c67", "none", 0);
    base += rect(105, 149, 11, 7, "#8b644b", 1);
    base += circle(110, 146, 6, "#578c67", "none", 0);
    mask += maskRect(5, top + 13, 130, 5, 1);
    mask += maskRect(15, top + 20, 5, 118 - top);
    mask += maskRect(120, top + 20, 5, 118 - top);
    logoRect = { x: 28, y: top + 29, width: 20, height: 20 };
    billboardRect = { x: 77, y: top + 29, width: 48, height: 24 };
    nameRect = { x: 43, y: 115, width: 54, height: 12 };
  } else if (type === "Restaurant" && variant === 1) {
    base += rect(8, top + 28, 124, 130 - top, dinerEnamel, 7);
    base += `<path d="M8 ${top + 31} Q10 ${top + 6} 39 ${top + 5} H101 Q130 ${top + 6} 132 ${top + 31} Z" fill="${brick}" stroke="${ink}" stroke-width="1.5"/>`;
    for (const x of [29, 47, 65, 83, 101, 119])
      base += circle(x, top + 12, 2, "#ffe1a0", "none", 0);
    base += upperWindows(10, 120, top + 10, level, 3);
    base += line(12, 123, 128, 123, glassDeep, 4);
    base += rect(13, 119, 114, 5, "#c86261", 1);
    base += circle(32, 140, 12, glass);
    base += circle(108, 140, 12, glass);
    base += line(21, 140, 43, 140, "#5b91a2", 1);
    base += line(97, 140, 119, 140, "#5b91a2", 1);
    base += rect(63, 130, 14, 28, dark, 7);
    mask += `<path d="M8 ${top + 31} Q10 ${top + 6} 39 ${top + 5} H101 Q130 ${top + 6} 132 ${top + 31} L132 ${top + 35} H8 Z" fill="#ffffff"/>`;
    mask += maskRect(12, 121, 116, 4, 2);
    logoRect = { x: 18, y: top + 34, width: 20, height: 20 };
    billboardRect = { x: 77, y: top + 34, width: 48, height: 24 };
    nameRect = { x: 40, y: top + 15, width: 60, height: 12 };
  } else if (type === "Restaurant" && variant === 2) {
    base += rect(8, top + 19, 52, 139 - top, bistroStucco, 2);
    base += rect(80, top + 19, 52, 139 - top, bistroStucco, 2);
    base += rect(7, top + 11, 126, 11, timber, 1);
    base += line(59, top + 22, 70, top + 33, ink, 2);
    base += line(70, top + 33, 81, top + 22, ink, 2);
    base += line(59, top + 22, 59, top + 37, ink, 2);
    base += line(81, top + 22, 81, top + 37, ink, 2);
    base += `<path d="M59 ${top + 37} Q70 ${top + 48} 81 ${top + 37}" fill="none" stroke="${timber}" stroke-width="2"/>`;
    base += upperWindows(9, 51, top, level, 2);
    base += upperWindows(81, 51, top, level, 2);
    base += rect(15, 132, 35, 20, glass, 5);
    base += rect(90, 132, 35, 20, glass, 5);
    for (const x of [22, 38, 102, 118]) base += line(x, 134, x, 149, pale, 1.5);
    base += circle(70, 136, 4, "#d99b6c", timber, 1);
    base += line(70, 140, 70, 156, timber, 2);
    base += line(60, 157, 80, 157, timber, 2);
    mask += maskRect(8, top + 12, 124, 6);
    logoRect = { x: 93, y: top + 27, width: 20, height: 20 };
    billboardRect = { x: 10, y: top + 27, width: 48, height: 24 };
    nameRect = { x: 38, y: top + 12, width: 64, height: 10 };
  } else if (type === "Office" && variant === 1) {
    base += rect(34, top + 4, 72, 154 - top, officeConcrete, 1);
    base += rect(40, top + 11, 60, 119 - top, glassDeep, 1);
    base += rect(34, top + 4, 8, 151 - top, "#435f74", 1);
    base += rect(98, top + 4, 8, 151 - top, "#435f74", 1);
    for (let floor = 0; floor < level + 1; floor++) {
      const y = top + 18 + floor * 27;
      if (y > 126) break;
      for (let column = 0; column < 3; column++)
        base += rect(44 + column * 17, y, 13, 16, glass, 1, ink, 1);
    }
    base += rect(56, 130, 28, 28, dark, 1);
    base += line(70, 131, 70, 157, pale, 1);
    base += line(39, 126, 101, 126, "#2e4c63", 3);
    mask += maskRect(36, top + 6, 68, 4);
    mask += maskRect(35, top + 10, 5, 146 - top);
    mask += maskRect(100, top + 10, 5, 146 - top);
    logoRect = { x: 41, y: top + 14, width: 20, height: 20 };
    billboardRect = { x: 50, y: top + 39, width: 48, height: 24 };
    nameRect = { x: 41, y: 115, width: 58, height: 12 };
  } else if (type === "Office" && variant === 2) {
    base += rect(28, top + 42, 84, 116 - top, officeConcrete, 1);
    base += rect(8, top + 9, 124, 42, glassDeep, 2);
    base += rect(8, top + 9, 124, 6, "#34566b", 1);
    base += rect(17, top + 16, 106, 26, glass, 1);
    for (let column = 0; column < 5; column++)
      base += line(
        18 + column * 26,
        top + 16,
        18 + column * 26,
        top + 43,
        ink,
        1,
      );
    base += rect(46, 131, 23, 27, dark, 1);
    base += rect(73, 131, 23, 27, dark, 1);
    base += line(13, top + 51, 127, top + 51, ink, 2);
    base += rect(28, top + 52, 9, 106 - top, "#4f6c7d", 1);
    base += rect(103, top + 52, 9, 106 - top, "#4f6c7d", 1);
    mask += maskRect(8, top + 9, 124, 5, 2);
    mask += maskRect(26, top + 49, 88, 5);
    logoRect = { x: 23, y: top + 16, width: 20, height: 20 };
    billboardRect = { x: 75, y: top + 17, width: 48, height: 24 };
    nameRect = { x: 42, y: top + 19, width: 32, height: 10 };
  } else if (type === "Homes" && variant === 1) {
    base += rect(7, top + 32, 43, 126 - top, brick, 1);
    base += rect(45, top + 17, 51, 141 - top, homePlaster, 1);
    base += rect(91, top + 4, 42, 154 - top, concrete, 1);
    for (const [x, y] of [
      [17, top + 42],
      [53, top + 29],
      [100, top + 16],
    ]) {
      for (let floor = 0; floor < level; floor++) {
        const wy = y + floor * 25;
        if (wy > 123) break;
        base += rect(x, wy, 15, 15, glass, 2);
        base += line(x - 2, wy + 17, x + 17, wy + 17, "#5a7280", 2);
      }
    }
    for (const [x, y, width] of [
      [10, top + 35, 38],
      [48, top + 20, 45],
      [94, top + 7, 36],
    ]) {
      base += line(x, y, x + width, y, pale, 2);
    }
    base += rect(20, 132, 15, 26, dark, 2);
    base += rect(63, 132, 15, 26, dark, 2);
    base += rect(105, 132, 15, 26, dark, 2);
    mask += maskRect(7, top + 32, 43, 5);
    mask += maskRect(45, top + 17, 51, 5);
    mask += maskRect(91, top + 4, 42, 5);
    logoRect = { x: 103, y: top + 14, width: 20, height: 20 };
    billboardRect = { x: 46, y: top + 29, width: 48, height: 24 };
    nameRect = { x: 12, y: 116, width: 36, height: 12 };
  } else if (type === "Homes" && variant === 2) {
    base += rect(39, top + 27, 63, 131 - top, homePlaster, 1);
    base += poly(`36,${top + 28} 70,${top + 5} 105,${top + 28}`, brick);
    base += circle(70, top + 21, 5, pale, timber, 1);
    base += rect(97, top + 17, 9, 21, concrete, 1);
    for (let floor = 0; floor < level + 1; floor++) {
      const y = top + 39 + floor * 25;
      if (y > 122) break;
      base += rect(48, y, 13, 15, glass, 2);
      base += rect(79, y, 13, 15, glass, 2);
      base += line(46, y + 18, 63, y + 18, timber, 2);
      base += line(77, y + 18, 94, y + 18, timber, 2);
    }
    base += rect(64, 131, 15, 27, dark, 2);
    base += rect(43, 151, 15, 6, "#6c986e", 2);
    base += rect(84, 151, 15, 6, "#6c986e", 2);
    mask += maskPoly(
      `36,${top + 28} 70,${top + 5} 105,${top + 28} 105,${top + 33} 70,${top + 10} 36,${top + 33}`,
    );
    mask += maskRect(39, 125, 63, 5);
    logoRect = { x: 49, y: top + 34, width: 20, height: 20 };
    billboardRect = null;
    nameRect = { x: 42, y: 113, width: 57, height: 12 };
  } else {
    throw new Error(`Unknown preset ${type} ${variant}`);
  }

  // Upper levels earn a recognizable architectural feature in addition to height.
  // Keep these details away from the separate logo and billboard rectangles.
  if (level >= 3) {
    if (type === "Retail" && variant === 1) {
      base += rect(14, top + 3, 42, 5, "#c87566", 1);
      for (const x of [21, 33, 45])
        base += rect(x, top + 3, 4, 5, pale, 0, "none", 0);
    } else if (type === "Retail") {
      for (const x of [27, 62, 97])
        base += circle(x, top + 17, 3, glass, ink, 1);
    } else if (type === "Cafe" && variant === 1) {
      for (const x of [45, 70, 95])
        base += line(x, top + 17, x, top + 27, "#e7faf0", 1.5);
      for (const x of [17, 123]) {
        base += line(x, top + 62, x, top + 105, "#39845f", 2);
        for (const y of [top + 71, top + 85, top + 99])
          base += circle(x + (x < 70 ? 3 : -3), y, 4, "#5caa75", "none", 0);
      }
    } else if (type === "Cafe") {
      for (const x of [20, 120]) {
        base += line(x, top + 48, x, top + 66, "#426b57", 2);
        base += circle(x - 3, top + 60, 4, "#5eaa70", "none", 0);
        base += circle(x + 3, top + 64, 4, "#5eaa70", "none", 0);
      }
    } else if (type === "Restaurant" && variant === 1) {
      base += rect(60, top + 1, 20, 6, "#b9655a", 2);
      base += line(64, top + 4, 76, top + 4, pale, 1);
      base += rect(16, 110, 108, 8, "#c86261", 1);
      for (let stripe = 0; stripe < 7; stripe++)
        base += rect(20 + stripe * 15, 110, 7, 8, pale, 0, "none", 0);
    } else if (type === "Restaurant") {
      base += line(59, top + 73, 81, top + 73, timber, 3);
      for (const x of [61, 70, 79])
        base += line(x, top + 64, x, top + 72, pale, 1.5);
    } else if (type === "Office" && variant === 1) {
      base += rect(29, top + 2, 82, 6, "#435f74", 1);
      base += line(70, top - 2, 70, top + 4, "#435f74", 2);
      base += circle(70, top - 2, 2, "#ffce62", "none", 0);
    } else if (type === "Office") {
      base += rect(57, top + 2, 26, 7, "#45677a", 1);
      base += line(63, top + 5, 77, top + 5, pale, 1);
    } else if (type === "Homes" && variant === 1) {
      base += line(51, top + 70, 91, top + 70, timber, 2);
      for (const x of [55, 67, 79, 88])
        base += line(x, top + 61, x, top + 69, timber, 1);
    } else if (type === "Homes") {
      for (const x of [52, 83]) {
        base += rect(x - 5, top + 63, 18, 4, "#6d9c6f", 1);
        base += circle(x, top + 61, 3, "#72b47a", "none", 0);
      }
    }
  }

  base += rect(
    logoRect.x,
    logoRect.y,
    logoRect.width,
    logoRect.height,
    pale,
    10,
    ink,
    1.2,
  );
  if (billboardRect) {
    base += rect(
      billboardRect.x,
      billboardRect.y,
      billboardRect.width,
      billboardRect.height,
      pale,
      2,
      ink,
      1.2,
    );
  }
  return {
    base: svg(base),
    mask: svg(mask),
    logoRect,
    billboardRect,
    nameRect,
  };
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function alphaBounds(png) {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== 560 || info.height !== 640 || info.channels !== 4)
    throw new Error("preset sprite must be 560×640 RGBA");
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
  if (maxX < 0) throw new Error("preset sprite has no visible pixels");
  return {
    x: minX / 4,
    y: minY / 4,
    width: (maxX + 1 - minX) / 4,
    height: (maxY + 1 - minY) / 4,
  };
}

function validateRect(rect, level, label) {
  if (!rect) return;
  const minY = 160 - heights[level - 1];
  if (
    rect.x < 0 ||
    rect.y < minY ||
    rect.x + rect.width > 140 ||
    rect.y + rect.height > 160
  )
    throw new Error(`${label} exceeds level ${level} envelope`);
}

async function checkCatalog() {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  if (
    catalog.version !== 1 ||
    !Array.isArray(catalog.facades) ||
    catalog.facades.length !== 40
  )
    throw new Error("preset catalog must contain 40 facades");
  const expectedKeys = new Set(
    types.flatMap((type) =>
      [1, 2].flatMap((variant) =>
        [1, 2, 3, 4].map((level) => `${type}-${variant}-${level}`),
      ),
    ),
  );
  const keys = new Set();
  for (const entry of catalog.facades) {
    const key = `${entry.buildingType}-${entry.variant}-${entry.level}`;
    if (!expectedKeys.has(key)) throw new Error(`unexpected preset ${key}`);
    if (keys.has(key)) throw new Error(`duplicate preset ${key}`);
    keys.add(key);
    for (const [field, hashField] of [
      ["sprite", "spriteHash"],
      ["paletteMask", "paletteMaskHash"],
      ["thumbnail", "thumbnailHash"],
    ]) {
      const data = await readFile(join(output, entry[field]));
      if (digest(data) !== entry[hashField])
        throw new Error(`hash mismatch for ${key} ${field}`);
      if (field === "sprite") {
        const bounds = await alphaBounds(data);
        if (JSON.stringify(bounds) !== JSON.stringify(entry.alphaBounds))
          throw new Error(`alpha bounds mismatch for ${key}`);
      } else if (field === "paletteMask") {
        validateRect(await alphaBounds(data), entry.level, `${key} mask`);
      } else {
        const metadata = await sharp(data).metadata();
        if (metadata.width !== 140 || metadata.height !== 160)
          throw new Error(`thumbnail must be 140×160 for ${key}`);
      }
    }
    validateRect(entry.alphaBounds, entry.level, `${key} sprite`);
    validateRect(entry.logoRect, entry.level, `${key} logo`);
    validateRect(entry.billboardRect, entry.level, `${key} billboard`);
    validateRect(entry.nameRect, entry.level, `${key} name`);
  }
  if (keys.size !== expectedKeys.size)
    throw new Error("preset catalog is missing a required type/variant/level");
  console.log(`Validated ${catalog.facades.length} transparent facade presets`);
}

async function generate() {
  await mkdir(output, { recursive: true });
  const facades = [];
  for (const buildingType of types) {
    for (const variant of [1, 2]) {
      for (const level of [1, 2, 3, 4]) {
        const key = `${buildingType.toLowerCase()}-${variant}-l${level}`;
        const art = design(buildingType, variant, level);
        const sprite = await sharp(Buffer.from(art.base)).png().toBuffer();
        const paletteMask = await sharp(Buffer.from(art.mask)).png().toBuffer();
        const thumbnail = await sharp(sprite).resize(140, 160).png().toBuffer();
        const bounds = await alphaBounds(sprite);
        validateRect(bounds, level, `${key} sprite`);
        validateRect(art.logoRect, level, `${key} logo`);
        validateRect(art.billboardRect, level, `${key} billboard`);
        validateRect(art.nameRect, level, `${key} name`);
        const files = {
          sprite: `${key}.png`,
          paletteMask: `${key}-mask.png`,
          thumbnail: `${key}-thumb.png`,
        };
        await Promise.all([
          writeFile(join(output, files.sprite), sprite),
          writeFile(join(output, files.paletteMask), paletteMask),
          writeFile(join(output, files.thumbnail), thumbnail),
        ]);
        facades.push({
          buildingType,
          variant,
          level,
          ...files,
          spriteHash: digest(sprite),
          paletteMaskHash: digest(paletteMask),
          thumbnailHash: digest(thumbnail),
          alphaBounds: bounds,
          logoRect: art.logoRect,
          billboardRect: art.billboardRect,
          nameRect: art.nameRect,
        });
      }
    }
  }
  await writeFile(
    catalogPath,
    `${JSON.stringify({ version: 1, facades }, null, 2)}\n`,
  );
  console.log(`Generated ${facades.length} facade presets and palette masks`);
  await checkCatalog();
}

if (process.argv.includes("--check")) await checkCatalog();
else await generate();
