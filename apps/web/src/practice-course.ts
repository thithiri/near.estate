const COURSE_LENGTH = 1_200;
const CHECKPOINTS = [300, 650, 1_000] as const;
const CONES = [
  { distance: 260, lane: 1 },
  { distance: 520, lane: 0 },
  { distance: 790, lane: 2 },
  { distance: 1_045, lane: 1 },
] as const;
const TIER_SPEED = [0, 72, 88, 104] as const;
const CONE_PENALTY_SECONDS = 1.5;

export interface PracticeRun {
  tier: 1 | 2 | 3;
  distance: number;
  elapsed: number;
  lane: 0 | 1 | 2;
  checkpoints: number;
  coneHits: number;
  finished: boolean;
  nextCone: number;
}

export function createPracticeRun(tier: 1 | 2 | 3): PracticeRun {
  return {
    tier,
    distance: 0,
    elapsed: 0,
    lane: 1,
    checkpoints: 0,
    coneHits: 0,
    finished: false,
    nextCone: 0,
  };
}

export function steerPracticeRun(run: PracticeRun, direction: -1 | 1): void {
  run.lane = Math.max(0, Math.min(2, run.lane + direction)) as 0 | 1 | 2;
}

export function advancePracticeRun(
  run: PracticeRun,
  seconds: number,
  accelerating: boolean,
): void {
  if (run.finished || !Number.isFinite(seconds) || seconds <= 0) return;
  const previous = run.distance;
  if (!accelerating) {
    run.elapsed += seconds;
    return;
  }
  const speed = TIER_SPEED[run.tier];
  const travelSeconds = Math.min(seconds, (COURSE_LENGTH - previous) / speed);
  run.elapsed += travelSeconds;
  run.distance = Math.min(COURSE_LENGTH, previous + speed * travelSeconds);
  while (
    run.nextCone < CONES.length &&
    CONES[run.nextCone]!.distance <= run.distance
  ) {
    const cone = CONES[run.nextCone]!;
    if (cone.distance > previous && cone.lane === run.lane) {
      run.coneHits++;
      run.elapsed += CONE_PENALTY_SECONDS;
    }
    run.nextCone++;
  }
  run.checkpoints = CHECKPOINTS.filter(
    (distance) => distance <= run.distance,
  ).length;
  run.finished = run.distance >= COURSE_LENGTH;
}

function readBest(key: string): number | null {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function saveBest(key: string, seconds: number): void {
  try {
    localStorage.setItem(key, seconds.toFixed(2));
  } catch {
    // Practice remains playable when browser storage is unavailable.
  }
}

function drawCourse(
  context: CanvasRenderingContext2D,
  run: PracticeRun,
  color: string,
): void {
  const canvas = context.canvas;
  context.fillStyle = "#97d5a5";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#52657c";
  context.fillRect(74, 0, 332, canvas.height);
  context.fillStyle = "#e9f1df";
  context.fillRect(70, 0, 5, canvas.height);
  context.fillRect(406, 0, 5, canvas.height);
  for (let divider = 1; divider < 3; divider++) {
    const x = 74 + (332 * divider) / 3;
    for (let dash = -1; dash < 10; dash++) {
      const y = dash * 82 + ((run.distance * 2) % 82);
      context.fillRect(x - 2, y, 4, 40);
    }
  }
  for (const [index, distance] of CHECKPOINTS.entries()) {
    const y = 510 - (distance - run.distance) * 2;
    if (y < -30 || y > 640) continue;
    context.fillStyle = "#fbd25a";
    context.fillRect(75, y, 330, 7);
    context.fillStyle = "#14213d";
    context.font = "bold 15px system-ui";
    context.fillText(`CHECKPOINT ${index + 1}`, 82, y - 9);
  }
  const finishY = 510 - (COURSE_LENGTH - run.distance) * 2;
  if (finishY >= -20 && finishY <= 640) {
    for (let tile = 0; tile < 12; tile++) {
      context.fillStyle = tile % 2 ? "#fff9ed" : "#14213d";
      context.fillRect(75 + tile * 27.5, finishY, 27.5, 12);
    }
  }
  for (const cone of CONES) {
    const y = 510 - (cone.distance - run.distance) * 2;
    if (y < -30 || y > 640) continue;
    const x = 74 + (332 * (cone.lane + 0.5)) / 3;
    context.fillStyle = "#f47747";
    context.beginPath();
    context.moveTo(x, y - 18);
    context.lineTo(x - 15, y + 15);
    context.lineTo(x + 15, y + 15);
    context.closePath();
    context.fill();
    context.fillStyle = "#fff9ed";
    context.fillRect(x - 9, y + 2, 18, 5);
  }
  const carX = 74 + (332 * (run.lane + 0.5)) / 3;
  context.fillStyle = "#14213d";
  context.beginPath();
  context.roundRect(carX - 31, 459, 62, 103, 14);
  context.fill();
  context.fillStyle = color;
  context.beginPath();
  context.roundRect(carX - 27, 463, 54, 95, 11);
  context.fill();
  context.fillStyle = "#b9eaf1";
  context.beginPath();
  context.roundRect(carX - 21, 482, 42, 24, 7);
  context.fill();
  context.fillStyle = "#14213d";
  context.font = "bold 17px system-ui";
  context.fillText("PRACTICE", 16, 34);
}

export function mountPracticeCourse(
  host: HTMLElement,
  options: { tier: 1 | 2 | 3; color: string; profileId: string },
): () => void {
  const canvas = host.querySelector<HTMLCanvasElement>("#practice-canvas");
  const start = host.querySelector<HTMLButtonElement>("#practice-start");
  const throttle = host.querySelector<HTMLButtonElement>("#practice-throttle");
  const left = host.querySelector<HTMLButtonElement>("#practice-left");
  const right = host.querySelector<HTMLButtonElement>("#practice-right");
  const status = host.querySelector<HTMLElement>("#practice-status");
  const context = canvas?.getContext("2d");
  if (!canvas || !start || !throttle || !left || !right || !status || !context)
    throw new Error("Practice course is incomplete");
  const key = `near-estate-practice-best-v1:${options.profileId}`;
  let best = readBest(key);
  let run = createPracticeRun(options.tier);
  let running = false;
  let accelerating = false;
  let frameId = 0;
  let lastFrame = 0;
  const carColor =
    (
      {
        Red: "#ef715f",
        Blue: "#75b8dd",
        Yellow: "#f5cc4c",
        Green: "#69bd8c",
      } as Record<string, string>
    )[options.color] ?? "#ef715f";
  const refresh = () => {
    drawCourse(context, run, carColor);
    status.textContent = `${run.checkpoints}/3 checkpoints · ${run.distance.toFixed(0)}/${COURSE_LENGTH} m · ${run.elapsed.toFixed(2)}s${run.coneHits ? ` · ${run.coneHits} cone penalties` : ""}${best === null ? "" : ` · Best ${best.toFixed(2)}s`}${run.finished ? " · Finished!" : ""}`;
    start.textContent = running
      ? "Restart run"
      : run.finished
        ? "Race again"
        : "Start run";
  };
  const tick = (now: number) => {
    if (!running) return;
    advancePracticeRun(run, (now - lastFrame) / 1_000, accelerating);
    lastFrame = now;
    if (run.finished) {
      running = false;
      accelerating = false;
      if (best === null || run.elapsed < best) {
        best = run.elapsed;
        saveBest(key, best);
      }
    }
    refresh();
    if (running) frameId = requestAnimationFrame(tick);
  };
  const begin = () => {
    cancelAnimationFrame(frameId);
    run = createPracticeRun(options.tier);
    running = true;
    accelerating = false;
    lastFrame = performance.now();
    refresh();
    frameId = requestAnimationFrame(tick);
  };
  const stopThrottle = () => {
    accelerating = false;
  };
  const onVisibility = () => {
    if (!document.hidden || !running) return;
    running = false;
    accelerating = false;
    cancelAnimationFrame(frameId);
    run = createPracticeRun(options.tier);
    refresh();
    status.textContent = "Run reset after leaving the tab. Start a new run.";
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowUp" || event.key.toLowerCase() === "w") {
      accelerating = true;
      event.preventDefault();
    } else if (
      !event.repeat &&
      (event.key === "ArrowLeft" || event.key.toLowerCase() === "a")
    ) {
      steerPracticeRun(run, -1);
      refresh();
      event.preventDefault();
    } else if (
      !event.repeat &&
      (event.key === "ArrowRight" || event.key.toLowerCase() === "d")
    ) {
      steerPracticeRun(run, 1);
      refresh();
      event.preventDefault();
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === "ArrowUp" || event.key.toLowerCase() === "w")
      stopThrottle();
  };
  start.addEventListener("click", begin);
  throttle.addEventListener("pointerdown", () => {
    accelerating = true;
  });
  throttle.addEventListener("pointerup", stopThrottle);
  throttle.addEventListener("pointercancel", stopThrottle);
  throttle.addEventListener("pointerleave", stopThrottle);
  left.addEventListener("click", () => {
    steerPracticeRun(run, -1);
    refresh();
  });
  right.addEventListener("click", () => {
    steerPracticeRun(run, 1);
    refresh();
  });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", stopThrottle);
  document.addEventListener("visibilitychange", onVisibility);
  refresh();
  return () => {
    running = false;
    cancelAnimationFrame(frameId);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", stopThrottle);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
