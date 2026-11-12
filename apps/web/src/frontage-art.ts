import type { FrontageUnits } from "./parcel-layout.js";
import {
  frontageMediaLayout,
  FACADE_SIDE_GAP,
  type BuildingLevel,
} from "./frontage-layout.js";

export type Choice = {
  id: string;
  name: string;
  description: string;
  units: FrontageUnits;
  wall: string;
  trim: string;
  roof: string;
  billboard?: boolean;
};
export const choices: Choice[] = [
  {
    id: "news-kiosk",
    name: "News kiosk",
    description: "Flat canopy, open counter",
    units: 1,
    wall: "#f3ba68",
    trim: "#bb5345",
    roof: "#793f42",
  },
  {
    id: "coffee-pod",
    name: "Coffee pod",
    description: "Curved roof, round windows",
    units: 1,
    wall: "#9dc3b0",
    trim: "#407d80",
    roof: "#315f65",
  },
  {
    id: "townhouse",
    name: "Townhouse",
    description: "Tall gable, planted stoop",
    units: 1,
    wall: "#f3cfbd",
    trim: "#994f56",
    roof: "#754250",
  },
  {
    id: "flower-stall",
    name: "Flower stall",
    description: "Scalloped canopy, flower boxes",
    units: 1,
    wall: "#f7dca8",
    trim: "#a55c80",
    roof: "#814968",
  },
  {
    id: "bike-repair",
    name: "Bike repair",
    description: "Sawtooth roof, workshop door",
    units: 1,
    wall: "#d6b7a7",
    trim: "#59677b",
    roof: "#465365",
  },
  {
    id: "corner-shop",
    name: "Corner shop",
    description: "Striped awning, corner door",
    units: 2,
    wall: "#f0d996",
    trim: "#e27a58",
    roof: "#9e5357",
  },
  {
    id: "diner",
    name: "Diner",
    description: "Rounded enamel roof, booths",
    units: 2,
    wall: "#e9aa94",
    trim: "#cf684f",
    roof: "#774650",
    billboard: true,
  },
  {
    id: "glass-studio",
    name: "Glass studio",
    description: "Slanted roof, wide windows",
    units: 2,
    wall: "#a7d3d6",
    trim: "#4b8398",
    roof: "#35596c",
  },
  {
    id: "bookshop",
    name: "Bookshop",
    description: "Twin gables, recessed windows",
    units: 2,
    wall: "#c9a993",
    trim: "#77556a",
    roof: "#674b5b",
  },
  {
    id: "arcade",
    name: "Arcade",
    description: "Stepped marquee, glowing bays",
    units: 2,
    wall: "#9585bf",
    trim: "#503a8c",
    roof: "#413573",
    billboard: true,
  },
  {
    id: "market-hall",
    name: "Market hall",
    description: "Three bays, lantern roof",
    units: 3,
    wall: "#edc883",
    trim: "#ba7050",
    roof: "#80535a",
  },
  {
    id: "garden-bistro",
    name: "Garden bistro",
    description: "Terrace and pergola",
    units: 3,
    wall: "#b9cfa2",
    trim: "#5e896e",
    roof: "#426b60",
  },
  {
    id: "office-campus",
    name: "Office campus",
    description: "Stepped glass volumes",
    units: 3,
    wall: "#8abac7",
    trim: "#37748b",
    roof: "#28596e",
  },
  {
    id: "food-hall",
    name: "Food hall",
    description: "Layered terrace, open stalls",
    units: 3,
    wall: "#e7bc90",
    trim: "#a9554c",
    roof: "#77473e",
  },
  {
    id: "craft-works",
    name: "Craft works",
    description: "Industrial roof, brick chimney",
    units: 3,
    wall: "#caa68e",
    trim: "#775b59",
    roof: "#674e51",
  },
];
let ctx: CanvasRenderingContext2D;
function rect(x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}
function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width = 1,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}
function roundRect(
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fill();
}
function polygon(points: Array<[number, number]>, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  points.forEach(([x, y], index) =>
    index ? ctx.lineTo(x, y) : ctx.moveTo(x, y),
  );
  ctx.closePath();
  ctx.fill();
}
function windowRect(
  x: number,
  y: number,
  w: number,
  h: number,
  trim: string,
): void {
  roundRect(x - 2, y - 2, w + 4, h + 4, 2, trim);
  rect(x, y, w, h, "#b8e1e5");
  rect(x, y, w, h * 0.33, "#d9f3ef");
  line(x + w / 2, y, x + w / 2, y + h, "#f4f4df", 2);
}

function drawBuilding(
  choice: Choice,
  x: number,
  base: number,
  logoImage: ImageBitmap | null,
  selectedBuilding: boolean,
  level: BuildingLevel,
): void {
  const width = choice.units * 85;
  const w = width - FACADE_SIDE_GAP * 2;
  const left = x + FACADE_SIDE_GAP;
  const layout = frontageMediaLayout(choice, level, x, base);
  const height = layout.facade.height;
  const top = layout.facade.y;
  const { wall, trim, roof, id } = choice;
  if (id === "coffee-pod" || id === "diner") {
    roundRect(left, top, w, height, id === "coffee-pod" ? 18 : 26, wall);
    roundRect(left, top, w, 18, 12, roof);
  } else if (id === "townhouse") {
    rect(left, top + 24, w, height - 24, wall);
    polygon(
      [
        [left - 3, top + 25],
        [left + w / 2, top],
        [left + w + 3, top + 25],
      ],
      roof,
    );
  } else if (id === "market-hall") {
    rect(left, top + 22, w, height - 22, wall);
    for (let bay = 0; bay < 3; bay++)
      polygon(
        [
          [left + (bay * w) / 3 - 2, top + 24],
          [left + ((bay + 0.5) * w) / 3, top],
          [left + ((bay + 1) * w) / 3 + 2, top + 24],
        ],
        roof,
      );
  } else if (id === "garden-bistro") {
    rect(left, top + 26, w, height - 26, wall);
    roundRect(left - 6, top + 16, w + 12, 15, 3, roof);
    for (let i = 0; i < 6; i++)
      rect(left + (i * (w + 8)) / 5, top + 4, 4, 16, trim);
    for (let i = 0; i < 5; i++)
      roundRect(left + 8 + i * 43, top + 2, 20, 13, 8, "#62976e");
  } else if (id === "office-campus") {
    rect(left, top + 29, w * 0.31, height - 29, "#70a8b7");
    rect(left + w * 0.31, top, w * 0.38, height, wall);
    rect(left + w * 0.69, top + 18, w * 0.31, height - 18, "#70a8b7");
    rect(left + w * 0.31, top, w * 0.38, 7, roof);
  } else if (id === "glass-studio") {
    rect(left, top + 10, w, height - 10, wall);
    polygon(
      [
        [left - 3, top + 12],
        [left + w + 2, top],
        [left + w + 2, top + 10],
      ],
      roof,
    );
  } else if (id === "bike-repair" || id === "craft-works") {
    rect(left, top + 22, w, height - 22, wall);
    const teeth = id === "bike-repair" ? 2 : 4;
    for (let i = 0; i < teeth; i++)
      polygon(
        [
          [left + (i * w) / teeth, top + 22],
          [left + ((i + 0.65) * w) / teeth, top],
          [left + ((i + 1) * w) / teeth, top + 22],
        ],
        roof,
      );
    if (id === "craft-works") rect(left + w - 25, top + 2, 14, 34, trim);
  } else if (id === "bookshop") {
    rect(left, top + 25, w, height - 25, wall);
    for (let i = 0; i < 2; i++)
      polygon(
        [
          [left + (i * w) / 2 - 3, top + 26],
          [left + ((i + 0.5) * w) / 2, top],
          [left + ((i + 1) * w) / 2 + 3, top + 26],
        ],
        roof,
      );
  } else if (id === "arcade") {
    rect(left, top + 15, w, height - 15, wall);
    rect(left - 6, top + 16, w + 12, 15, roof);
    rect(left + 18, top + 3, w - 36, 15, trim);
    for (let i = 0; i < 5; i++)
      roundRect(left + 13 + i * 28, top + 17, 5, 5, 3, "#fbd879");
  } else if (id === "food-hall") {
    rect(left, top + 25, w, height - 25, wall);
    rect(left - 6, top + 24, w + 12, 11, roof);
    rect(left + 22, top + 6, w - 44, 19, trim);
    for (let i = 0; i < 6; i++)
      rect(left + (i * w) / 6, top + 35, w / 12, 7, i % 2 ? "#fff4d2" : trim);
  } else if (id === "flower-stall") {
    rect(left, top + 12, w, height - 12, wall);
    rect(left - 4, top + 8, w + 8, 10, roof);
    for (let i = 0; i < 4; i++)
      roundRect(
        left + i * 14 - 1,
        top + 14,
        12,
        9,
        6,
        i % 2 ? "#fff5df" : trim,
      );
  } else {
    rect(left, top + 12, w, height - 12, wall);
    rect(left - 4, top + 6, w + 8, 12, roof);
  }
  rect(left, base - 4, w, 4, trim);
  const { sign, logo, name, billboard } = layout;
  for (let row = 0; row < level - 1; row++) {
    const floorY = sign.y - 18 - row * 28;
    if (floorY < top + 22) continue;
    if (
      billboard &&
      floorY < billboard.y + billboard.height &&
      floorY + 14 > billboard.y
    )
      continue;
    const count = choice.units === 1 ? 1 : choice.units === 2 ? 3 : 5;
    const gap = choice.units === 1 ? 0 : 8;
    const windowWidth =
      choice.units === 1 ? 18 : (w - 16 - gap * (count - 1)) / count;
    for (let column = 0; column < count; column++)
      windowRect(
        left +
          (choice.units === 1
            ? (w - 18) / 2
            : 8 + column * (windowWidth + gap)),
        floorY,
        windowWidth,
        13,
        trim,
      );
    rect(left + 4, floorY + 17, w - 8, 2, trim);
  }
  if (billboard) {
    roundRect(
      billboard.x - 2,
      billboard.y - 2,
      billboard.width + 4,
      billboard.height + 4,
      3,
      roof,
    );
    roundRect(
      billboard.x,
      billboard.y,
      billboard.width,
      billboard.height,
      2,
      "#fff4d4",
    );
    ctx.fillStyle = trim;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `bold ${choice.units === 2 ? 7 : 9}px Arial`;
    ctx.fillText(
      "AD SPACE",
      billboard.x + billboard.width / 2,
      billboard.y + billboard.height / 2,
      billboard.width - 5,
    );
  }
  roundRect(sign.x, sign.y, sign.width, sign.height, 3, "#fff8e8");
  ctx.strokeStyle = trim;
  ctx.lineWidth = 2;
  ctx.strokeRect(sign.x + 0.5, sign.y + 0.5, sign.width - 1, sign.height - 1);
  const mark = logo.width;
  const mx = logo.x,
    my = logo.y;
  roundRect(logo.x, logo.y, logo.width, logo.height, 3, trim);
  if (logoImage && selectedBuilding) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(mx + 1, my + 1, mark - 2, mark - 2, 2);
    ctx.clip();
    const fitted = Math.min(
      (mark - 2) / logoImage.width,
      (mark - 2) / logoImage.height,
    );
    const imageWidth = logoImage.width * fitted;
    const imageHeight = logoImage.height * fitted;
    ctx.drawImage(
      logoImage,
      mx + (mark - imageWidth) / 2,
      my + (mark - imageHeight) / 2,
      imageWidth,
      imageHeight,
    );
    ctx.restore();
  } else {
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${choice.units === 1 ? 8 : 10}px Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      choice.name
        .split(" ")
        .map((word) => word[0])
        .join("")
        .slice(0, 2),
      mx + mark / 2,
      my + mark / 2 + 1,
    );
  }
  if (name) {
    ctx.fillStyle = "#365361";
    ctx.font = `bold ${choice.units === 2 ? 8 : 10}px Arial`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(
      choice.name.toUpperCase(),
      name.x,
      name.y + name.height / 2,
      name.width,
    );
  }
  const glassY = sign.y + sign.height + 9;
  const glassH = Math.max(18, base - glassY - 12);
  if (id === "office-campus" || id === "glass-studio") {
    const count = choice.units === 3 ? 6 : 4;
    for (let n = 0; n < count; n++)
      windowRect(
        left + 7 + (n * (w - 20)) / count,
        glassY + 3,
        (w - 31) / count,
        glassH - 4,
        trim,
      );
  } else if (id === "market-hall" || id === "garden-bistro") {
    for (let n = 0; n < 3; n++)
      windowRect(
        left + 10 + (n * w) / 3,
        glassY + 3,
        w / 3 - 23,
        glassH - 3,
        trim,
      );
  } else if (id === "townhouse") {
    windowRect(left + 8, glassY, w - 16, Math.max(14, glassH - 17), trim);
    rect(left + w / 2 - 8, base - 27, 16, 23, roof);
  } else {
    const count = choice.units === 1 ? 1 : 3;
    for (let n = 0; n < count; n++)
      windowRect(
        left + 7 + (n * (w - 14)) / count,
        glassY + 3,
        (w - 25) / count,
        glassH - 4,
        trim,
      );
  }
  if (id === "corner-shop" || id === "news-kiosk" || id === "food-hall") {
    for (let n = 0; n < Math.ceil(w / 15); n++)
      rect(left + n * 15, glassY - 3, 8, 6, n % 2 ? "#fff8e8" : trim);
  }
  if (id === "garden-bistro" || id === "townhouse" || id === "flower-stall") {
    roundRect(left + 2, base - 10, 14, 9, 4, "#65916b");
    roundRect(left + w - 16, base - 10, 14, 9, 4, "#65916b");
  }
}

export function paintBuilding(
  target: CanvasRenderingContext2D,
  choice: Choice,
  x: number,
  base: number,
  logoImage: ImageBitmap | null = null,
  selectedBuilding = true,
  level: BuildingLevel = 2,
): void {
  ctx = target;
  drawBuilding(choice, x, base, logoImage, selectedBuilding, level);
}
