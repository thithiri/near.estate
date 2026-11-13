import type { Choice } from "./frontage-art.js";
import type { BuildingLevel } from "./frontage-layout.js";
import { guestBuildingUrl } from "./guest-illustration.js";

export type StreetPreviewBuilding = {
  plotIndex: number;
  choice: Choice;
  level: BuildingLevel;
  selected?: boolean;
  approvedHash?: string;
  imageUrl?: string;
  imageStatus?: string;
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
    .map(
      (building) =>
        `<div class="design-street-building ${building.selected ? "is-selected" : ""}" ${building.approvedHash ? `data-approved-neighbour="${escapeHtml(building.approvedHash)}"` : ""} style="width:${building.choice.units * 85}px"><div class="design-street-image"><img src="${escapeHtml(building.imageUrl ?? guestBuildingUrl(building.choice, building.level))}" alt="${escapeHtml(building.imageUrl ? "Approved custom facade" : building.choice.name)} on plot ${building.plotIndex + 1}" width="${building.choice.units * 85}" height="190" /></div><span>${building.selected ? "YOUR PLOT" : `PLOT ${building.plotIndex + 1}`} · ${building.choice.units}U</span>${building.imageStatus ? `<small class="owner-neighbour-status">${escapeHtml(building.imageStatus)}</small>` : ""}</div>`,
    )
    .join(
      "",
    )}</div><div class="design-street-sidewalk"></div><div class="design-street-road"></div></div></div>`;
}
