import {
  Assets,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  Texture,
} from "pixi.js";
import rawCatalog from "./world-sprites.json";
import guestCatalog from "./guest-illustrations.json";

const cars = new Map(
  rawCatalog.cars.map((entry) => [`${entry.body}:${entry.color}`, entry]),
);
const sites = new Map(rawCatalog.sites.map((entry) => [entry.role, entry]));
const illustratedCars = new Map(
  guestCatalog.cars.map((entry) => [
    `${entry.body}:${entry.color}`,
    entry.sprite,
  ]),
);

function assetUrl(filename: string): string {
  return `${import.meta.env.BASE_URL}world/${filename}`;
}

export function carSpriteFile(body: string, color: string): string {
  const illustrated = illustratedCars.get(`${body}:${color}`);
  if (illustrated) return illustrated;
  const car = cars.get(`${body}:${color}`);
  if (!car) throw new Error(`Missing car sprite: ${body} ${color}`);
  return car.sprite;
}

export function siteSpriteFile(role: string): string {
  const site = sites.get(role);
  if (!site) throw new Error(`Missing civic sprite: ${role}`);
  return site.sprite;
}

function loadInto(sprite: Sprite, fallback: Graphics, url: string): void {
  void Assets.load<Texture>(url)
    .then((texture) => {
      if (sprite.destroyed) return;
      sprite.texture = texture;
      fallback.visible = false;
    })
    .catch((error: unknown) => {
      console.warn("World sprite unavailable", error);
    });
}

export function createCarSprite(
  x: number,
  y: number,
  body: string,
  color: string,
  burgerDecal = false,
): Container {
  const group = new Container();
  group.position.set(x, y);
  const fallback = new Graphics()
    .roundRect(-27, -8, 54, 19, 7)
    .fill(0x9eabb4)
    .stroke({ color: 0x1e2d49, width: 1 })
    .circle(-17, 11, 4)
    .fill(0x1e2d49)
    .circle(17, 11, 4)
    .fill(0x1e2d49);
  const sprite = new Sprite(Texture.EMPTY);
  sprite.anchor.set(0.5);
  sprite.scale.set(0.25);
  group.addChild(fallback, sprite);
  if (burgerDecal) {
    const decal = new Graphics()
      .roundRect(-7, -6, 14, 6, 3)
      .fill(0xf5bd50)
      .roundRect(-6, -1, 12, 3, 1)
      .fill(0x68b273)
      .roundRect(-7, 3, 14, 4, 2)
      .fill(0xe7a759);
    group.addChild(decal);
  }
  loadInto(sprite, fallback, assetUrl(carSpriteFile(body, color)));
  return group;
}

export function createNpcFacade(
  name: string,
  role: string,
  x: number,
): Container {
  const site = sites.get(role);
  if (!site) throw new Error(`Missing civic sprite: ${role}`);
  const group = new Container();
  group.position.set(x + 15, 30);
  group.hitArea = new Rectangle(0, 0, 140, 160);
  const fallback = new Graphics()
    .roundRect(7, 60, 126, 98, 4)
    .fill(0xd7e2e0)
    .stroke({ color: 0x1e2d49, width: 1 });
  const sprite = new Sprite(Texture.EMPTY);
  sprite.scale.set(0.25);
  const text = new Text({
    text: name,
    style: {
      fontFamily: "Arial, sans-serif",
      fontWeight: "bold",
      fontSize: Math.min(8, site.labelRect.width / (name.length * 0.62)),
      fill: "#1e2d49",
      align: "center",
    },
  });
  text.anchor.set(0.5);
  text.position.set(
    site.labelRect.x + site.labelRect.width / 2,
    site.labelRect.y + site.labelRect.height / 2,
  );
  group.addChild(fallback, sprite, text);
  loadInto(sprite, fallback, assetUrl(site.sprite));
  return group;
}
