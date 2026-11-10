import type { ChainMediaSlot } from "@estate/shared";

export function visibleMediaHash(
  slot: ChainMediaSlot,
  eligible: boolean,
  layoutRevision: number,
): string | undefined {
  if (
    !eligible ||
    !slot.active ||
    slot.active.approved_layout_revision !== layoutRevision
  )
    return undefined;
  return slot.active.content.asset_hash;
}

export function visibleMediaLink(
  slot: ChainMediaSlot,
  eligible: boolean,
  layoutRevision: number,
): string | undefined {
  if (!visibleMediaHash(slot, eligible, layoutRevision)) return undefined;
  const link = slot.active?.content.link;
  if (!link) return undefined;
  try {
    const url = new URL(link);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
