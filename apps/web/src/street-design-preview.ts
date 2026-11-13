import type { Choice } from "./frontage-art.js";
import type { BuildingLevel } from "./frontage-layout.js";
import { frontageMediaLayout } from "./frontage-layout.js";
import { guestBuildingUrl } from "./guest-illustration.js";

export type StreetPreviewBuilding = {
  plotIndex: number;
  choice: Choice;
  level: BuildingLevel;
  selected?: boolean;
  approvedHash?: string;
  imageUrl?: string;
  imageStatus?: string;
  name?: string;
  logoUrl?: string;
  billboardUrl?: string;
  rule?: string;
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

export function streetDesignPreviewMarkup(
  roadName: string,
  side: string,
  buildings: StreetPreviewBuilding[],
): string {
  const ordered = [...buildings].sort((a, b) => a.plotIndex - b.plotIndex);
  return `<div class="design-street-context"><p><strong>On ${escapeHtml(roadName)} · ${escapeHtml(side)} curb</strong> <span>Actual plot widths and neighbouring designs</span></p><div class="design-street-scroll"><div class="design-street-row">${ordered
    .map((building) => {
      const layout = frontageMediaLayout(building.choice, building.level);
      const name = building.name ?? building.choice.name;
      const initials = name
        .split(/\s+/)
        .map((word) => word[0] ?? "")
        .join("")
        .slice(0, 2)
        .toUpperCase();
      const rectStyle = (rect: {
        x: number;
        y: number;
        width: number;
        height: number;
      }) =>
        `left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px`;
      const sign = `<div class="design-preview-sign" style="${rectStyle(layout.sign)}"><span class="design-preview-logo" style="${rectStyle({ ...layout.logo, x: layout.logo.x - layout.sign.x, y: layout.logo.y - layout.sign.y })}">${building.logoUrl ? `<img src="${escapeHtml(building.logoUrl)}" alt="" />` : escapeHtml(initials)}</span>${layout.name ? `<span class="design-preview-name" style="${rectStyle({ ...layout.name, x: layout.name.x - layout.sign.x, y: layout.name.y - layout.sign.y })}">${escapeHtml(name)}</span>` : ""}</div>`;
      const billboard =
        building.billboardUrl && layout.billboard
          ? `<img class="design-preview-billboard" src="${escapeHtml(building.billboardUrl)}" alt="Approved billboard" style="${rectStyle(layout.billboard)}" />`
          : "";
      const rule = building.rule ?? "FREE";
      const stalls = Array.from(
        { length: building.choice.units },
        () =>
          `<div class="design-preview-stall"><span>${escapeHtml(rule)}</span></div>`,
      ).join("");
      return `<div class="design-street-building ${building.selected ? "is-selected" : ""}" ${building.approvedHash ? `data-approved-neighbour="${escapeHtml(building.approvedHash)}"` : ""} style="width:${building.choice.units * 85}px"><div class="design-street-image"><img class="design-preview-facade" src="${escapeHtml(building.imageUrl ?? guestBuildingUrl(building.choice, building.level))}" alt="${escapeHtml(building.imageUrl ? "Approved custom facade" : building.choice.name)} on plot ${building.plotIndex + 1}" width="${building.choice.units * 85}" height="190" />${sign}${billboard}</div><span>${building.selected ? "YOUR PLOT" : `PLOT ${building.plotIndex + 1}`} · ${building.choice.units}U · LV ${building.level}</span>${building.imageStatus ? `<small class="owner-neighbour-status">${escapeHtml(building.imageStatus)}</small>` : ""}<div class="design-street-sidewalk"></div><div class="design-preview-stalls">${stalls}</div></div>`;
    })
    .join("")}</div><div class="design-street-road"></div></div></div>`;
}
