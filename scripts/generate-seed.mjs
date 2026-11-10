import { writeFileSync } from "node:fs";

const roads = [
  ["main", "Main Street"],
  ["market", "Market Street"],
  ["river", "River Street"],
  ["central", "Central Avenue"],
  ["harbor", "Harbor Avenue"],
];
const streetMap = new Map(
  roads.map(([id, name]) => [id, { id, name, length: 12, connections: [] }]),
);
function connect(a, at, b, toAt, kind = "Intersection") {
  streetMap.get(a).connections.push({
    at,
    toRoadId: b,
    toAt,
    toSide: "North",
    facing: "Right",
    kind,
  });
  streetMap.get(b).connections.push({
    at: toAt,
    toRoadId: a,
    toAt: at,
    toSide: "North",
    facing: "Right",
    kind,
  });
}
for (const [road, at] of [
  ["main", 2],
  ["market", 4],
  ["river", 6],
]) {
  connect(road, 2, "central", at);
  connect(road, 5, "harbor", at);
}
connect("main", 0, "market", 0, "End");
connect("market", 7, "river", 7, "End");

const types = ["Retail", "Cafe", "Restaurant", "Office", "Homes"];
const plots = roads.flatMap(([roadId], roadNumber) =>
  ["North", "South"].flatMap((side) =>
    Array.from({ length: 8 }, (_, index) => ({
      id: `plot-${roadId}-${side === "North" ? "n" : "s"}-${index}`,
      roadId,
      side,
      index,
      corner: index === 0 || index === 7,
      initialType: types[(roadNumber + index) % types.length],
      initialVariant: (index % 2) + 1,
    })),
  ),
);

const npcSites = [
  [
    "npc-main-tower",
    "main",
    "North",
    8,
    "ParkingTower",
    "Main Parking Tower",
    32,
  ],
  [
    "npc-market-tower",
    "market",
    "South",
    8,
    "ParkingTower",
    "Market Parking Tower",
    32,
  ],
  [
    "npc-river-tower",
    "river",
    "North",
    8,
    "ParkingTower",
    "River Parking Tower",
    32,
  ],
  [
    "npc-central-garage",
    "central",
    "North",
    8,
    "RepairGarage",
    "City Garage",
    0,
  ],
  ["npc-harbor-cinema", "harbor", "North", 8, "Cinema", "Harbor Cinema", 0],
  [
    "npc-market-burgers",
    "market",
    "North",
    9,
    "BurgerStop",
    "Near & Far Burgers",
    0,
  ],
  [
    "npc-central-course",
    "central",
    "South",
    9,
    "PracticeCourse",
    "Practice Course",
    0,
  ],
].map(([id, roadId, side, frontageIndex, role, name, capacity]) => ({
  id,
  roadId,
  side,
  frontageIndex,
  role,
  name,
  capacity,
}));

writeFileSync(
  new URL("../contracts/estate/seed.json", import.meta.url),
  JSON.stringify(
    { version: 1, streets: [...streetMap.values()], plots, npcSites },
    null,
    2,
  ) + "\n",
);
