const PLOT_PITCH = 170;

export type TextureCandidate = {
  x: number;
  width?: number;
  urls: readonly string[];
};

export function selectNearTextureViews(
  candidates: readonly TextureCandidate[],
  cameraLeft: number,
  visibleWidth: number,
  textureBudget: number,
): Set<number> {
  const cameraRight = cameraLeft + visibleWidth;
  const nearLeft = cameraLeft - visibleWidth;
  const nearRight = cameraRight + visibleWidth;
  const indices = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(
      ({ candidate }) =>
        candidate.x + (candidate.width ?? PLOT_PITCH) >= nearLeft &&
        candidate.x <= nearRight,
    )
    .sort((a, b) => {
      const distance = (candidate: TextureCandidate) =>
        candidate.x > cameraRight
          ? candidate.x - cameraRight
          : candidate.x + (candidate.width ?? PLOT_PITCH) < cameraLeft
            ? cameraLeft - candidate.x - (candidate.width ?? PLOT_PITCH)
            : 0;
      const center = (candidate: TextureCandidate) =>
        Math.abs(
          candidate.x +
            (candidate.width ?? PLOT_PITCH) / 2 -
            (cameraLeft + visibleWidth / 2),
        );
      return (
        distance(a.candidate) - distance(b.candidate) ||
        center(a.candidate) - center(b.candidate) ||
        a.index - b.index
      );
    });
  const selected = new Set<number>();
  const urls = new Set<string>();
  for (const { candidate, index } of indices) {
    const added = new Set(candidate.urls.filter((url) => !urls.has(url)));
    if (urls.size + added.size > textureBudget) continue;
    selected.add(index);
    for (const url of added) urls.add(url);
  }
  return selected;
}
