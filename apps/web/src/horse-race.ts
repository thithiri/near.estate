export const HORSE_RACE_SECONDS = 32;

export const HORSES = [
  { name: "Copper Comet", coat: "#b76a4b", cloth: "#ef8270" },
  { name: "Blue Ribbon", coat: "#6a504b", cloth: "#69b9e9" },
  { name: "Golden Mile", coat: "#d39b56", cloth: "#f6c85f" },
  { name: "Green Flash", coat: "#594b45", cloth: "#73d9a6" },
] as const;

export function horseRaceOrder(raceNumber: number): number[] {
  if (!Number.isSafeInteger(raceNumber) || raceNumber < 0)
    throw new Error("Invalid race number");
  const winner = raceNumber % HORSES.length;
  return [winner, (winner + 2) % 4, (winner + 1) % 4, (winner + 3) % 4];
}

export function horseProgress(
  raceNumber: number,
  horse: number,
  elapsed: number,
): number {
  const order = horseRaceOrder(raceNumber);
  const place = order.indexOf(horse);
  if (place < 0) throw new Error("Unknown horse");
  const t = Math.max(0, Math.min(1, elapsed / HORSE_RACE_SECONDS));
  const finish = [1, 0.94, 0.89, 0.84][place]!;
  const earlyLead =
    Math.sin(t * Math.PI * 2 + horse * 1.9) * 0.045 * Math.sin(t * Math.PI);
  return Math.max(0, Math.min(1, t * finish + earlyLead));
}

function rounded(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fill: string,
): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

function drawHorse(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  index: number,
  phase: number,
): void {
  const horse = HORSES[index];
  if (!horse) throw new Error("Unknown horse");
  const bob = Math.sin(phase) * 4;
  ctx.save();
  ctx.translate(x, y + bob);
  ctx.strokeStyle = "#26394b";
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  for (const [dx, sway] of [
    [-27, 1],
    [-8, -1],
    [20, -1],
    [35, 1],
  ] as Array<[number, number]>) {
    ctx.beginPath();
    ctx.moveTo(dx, 8);
    ctx.lineTo(dx + Math.sin(phase) * 7 * sway, 32);
    ctx.stroke();
  }
  ctx.fillStyle = horse.coat;
  ctx.beginPath();
  ctx.ellipse(0, -3, 48, 25, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(26, -17);
  ctx.lineTo(48, -38);
  ctx.lineTo(64, -34);
  ctx.lineTo(63, -12);
  ctx.lineTo(39, -7);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#23374b";
  ctx.beginPath();
  ctx.arc(56, -25, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#26394b";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(-39, -8);
  ctx.lineTo(-61, -31 + Math.sin(phase) * 7);
  ctx.stroke();
  rounded(ctx, -22, -25, 42, 24, 8, horse.cloth);
  ctx.fillStyle = "#26394b";
  ctx.font = "bold 17px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(String(index + 1), 0, -7);
  ctx.fillStyle = "#f9e5cb";
  ctx.beginPath();
  ctx.arc(-5, -46, 9, 0, Math.PI * 2);
  ctx.fill();
  rounded(ctx, -15, -61, 21, 10, 5, horse.cloth);
  ctx.restore();
}

export function drawHorseRaceFrame(
  ctx: CanvasRenderingContext2D,
  raceNumber: number,
  elapsed: number,
  art?: { track: HTMLImageElement; runners: HTMLImageElement },
): void {
  const width = 960;
  const height = 540;
  if (art?.track.complete && art.track.naturalWidth > 0) {
    ctx.drawImage(art.track, 0, 0, width, height);
  } else {
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, "#a5d7e5");
    sky.addColorStop(0.55, "#e2eee1");
    sky.addColorStop(1, "#dcb992");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#76a891";
    ctx.fillRect(0, 146, width, 102);
    for (let lane = 0; lane < 4; lane++) {
      const top = 213 + lane * 78;
      ctx.fillStyle = lane % 2 === 0 ? "#d8b78f" : "#d1a97e";
      ctx.fillRect(0, top, width, 78);
      ctx.fillStyle = "#fff7e8";
      ctx.fillRect(0, top, width, 2);
    }
  }
  for (let lane = 0; lane < 4; lane++) {
    rounded(ctx, 12, 232 + lane * 78, 30, 28, 8, "#fff8eb");
    ctx.fillStyle = "#26394b";
    ctx.font = "bold 18px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(String(lane + 1), 27, 253 + lane * 78);
  }
  ctx.fillStyle = "#fff8eb";
  ctx.fillRect(824, 215, 16, 325);
  for (let square = 0; square < 20; square++) {
    ctx.fillStyle = square % 2 ? "#1e2d49" : "#fff8eb";
    ctx.fillRect(824, 215 + square * 17, 16, 17);
  }
  for (let horse = 0; horse < 4; horse++) {
    const progress = horseProgress(raceNumber, horse, elapsed);
    const x = 80 + progress * 760;
    const y = 252 + horse * 78;
    if (art?.runners.complete && art.runners.naturalWidth > 0) {
      const quarter = art.runners.naturalWidth / 4;
      ctx.drawImage(
        art.runners,
        horse * quarter,
        155,
        quarter,
        410,
        x - 62,
        y - 55 + Math.sin(elapsed * 12 + horse) * 2,
        124,
        90,
      );
    } else drawHorse(ctx, x, y, horse, elapsed * 12 + horse);
  }
  if (elapsed >= HORSE_RACE_SECONDS) {
    const winner = HORSES[horseRaceOrder(raceNumber)[0]!];
    if (!winner) throw new Error("Race winner is missing");
    rounded(ctx, 282, 153, 397, 51, 14, "#fff8eb");
    ctx.fillStyle = "#1e2d49";
    ctx.textAlign = "center";
    ctx.font = "bold 25px system-ui";
    ctx.fillText(`${winner.name.toUpperCase()} WINS`, 480, 186);
  }
}

export function mountHorseRace(
  host: HTMLElement,
  onFinish?: (raceNumber: number, winner: number) => void,
): () => void {
  const canvas = host.querySelector<HTMLCanvasElement>("#horse-race-canvas");
  const watch = host.querySelector<HTMLButtonElement>("#horse-race-watch");
  const status = host.querySelector<HTMLElement>("#horse-race-status");
  const context = canvas?.getContext("2d");
  if (!canvas || !watch || !status || !context)
    throw new Error("Horse course player is incomplete");
  let raceNumber = 0;
  let elapsed = 0;
  let startedAt = 0;
  let frame = 0;
  let playing = false;
  let disposed = false;
  const art = {
    track: new Image(),
    runners: new Image(),
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const markState = (state: "ready" | "running" | "finished") => {
    host.dataset.horseRaceNumber = String(raceNumber);
    host.dataset.horseRaceState = state;
  };
  const render = () => {
    if (disposed) return;
    drawHorseRaceFrame(context, raceNumber, elapsed, art);
    status.textContent =
      elapsed >= HORSE_RACE_SECONDS
        ? `${HORSES[horseRaceOrder(raceNumber)[0]!]!.name} wins. Free spectator race; no coins changed.`
        : playing
          ? `Race in progress · ${Math.floor(elapsed)} of ${HORSE_RACE_SECONDS} seconds.`
          : "Choose Watch race to follow four horses to the finish.";
  };
  const tick = () => {
    if (!playing) return;
    elapsed = Math.min(
      HORSE_RACE_SECONDS,
      (performance.now() - startedAt) / 1_000,
    );
    render();
    if (elapsed === HORSE_RACE_SECONDS) {
      playing = false;
      watch.textContent = "Watch another race";
      markState("finished");
      onFinish?.(raceNumber, horseRaceOrder(raceNumber)[0]!);
    } else frame = requestAnimationFrame(tick);
  };
  const start = () => {
    if (playing) return;
    if (elapsed >= HORSE_RACE_SECONDS) {
      raceNumber++;
      elapsed = 0;
      markState("ready");
      watch.textContent = "Watch race";
      render();
      return;
    }
    if (reduced) {
      elapsed = HORSE_RACE_SECONDS;
      watch.textContent = "Watch another race";
      markState("finished");
      render();
      onFinish?.(raceNumber, horseRaceOrder(raceNumber)[0]!);
      return;
    }
    startedAt = performance.now() - elapsed * 1_000;
    playing = !reduced;
    markState("running");
    watch.textContent = "Pause race";
    render();
    if (playing) frame = requestAnimationFrame(tick);
  };
  const pause = () => {
    if (!playing) return;
    elapsed = Math.min(
      HORSE_RACE_SECONDS,
      (performance.now() - startedAt) / 1_000,
    );
    playing = false;
    cancelAnimationFrame(frame);
    watch.textContent = "Continue race";
    render();
  };
  const toggle = () => (playing ? pause() : start());
  watch.addEventListener("click", toggle);
  document.addEventListener("visibilitychange", pause);
  art.track.addEventListener("load", render, { once: true });
  art.runners.addEventListener("load", render, { once: true });
  art.track.src = `${import.meta.env.BASE_URL}activities/horse-track-v1.webp`;
  art.runners.src = `${import.meta.env.BASE_URL}activities/horse-runners-v1.webp`;
  markState("ready");
  render();
  return () => {
    disposed = true;
    pause();
    watch.removeEventListener("click", toggle);
    document.removeEventListener("visibilitychange", pause);
  };
}
