const DURATION_SECONDS = 18;

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  color: string,
): void {
  context.fillStyle = color;
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
}

function drawCar(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
): void {
  roundedRect(context, x - 62, y - 31, 124, 42, 18, "#15243c");
  roundedRect(context, x - 59, y - 34, 118, 38, 16, color);
  context.fillStyle = "#b8efff";
  context.beginPath();
  context.moveTo(x - 29, y - 31);
  context.lineTo(x - 12, y - 54);
  context.lineTo(x + 28, y - 54);
  context.lineTo(x + 46, y - 31);
  context.closePath();
  context.fill();
  for (const wheel of [x - 35, x + 37]) {
    context.fillStyle = "#15243c";
    context.beginPath();
    context.arc(wheel, y + 4, 16, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#f7d15f";
    context.beginPath();
    context.arc(wheel, y + 4, 7, 0, Math.PI * 2);
    context.fill();
  }
  roundedRect(context, x + 52, y - 24, 7, 11, 2, "#fff3bc");
}

function drawFacade(
  context: CanvasRenderingContext2D,
  x: number,
  width: number,
  height: number,
  color: string,
  label: string,
): void {
  if (x + width < -20 || x > 980) return;
  const bottom = 358;
  roundedRect(context, x, bottom - height, width, height, 12, color);
  roundedRect(
    context,
    x + 12,
    bottom - height + 18,
    width - 24,
    37,
    7,
    "#fff3d4",
  );
  context.fillStyle = "#14213d";
  context.textAlign = "center";
  context.font = "bold 21px system-ui";
  context.fillText(label, x + width / 2, bottom - height + 44);
  for (let row = 0; row < Math.max(1, Math.floor((height - 100) / 64)); row++) {
    for (let column = 0; column < 2; column++) {
      roundedRect(
        context,
        x + 20 + column * ((width - 60) / 2 + 18),
        bottom - height + 75 + row * 62,
        (width - 60) / 2,
        38,
        5,
        "#b8e7e8",
      );
    }
  }
  roundedRect(context, x + width / 2 - 17, bottom - 46, 34, 46, 5, "#294963");
}

export function drawCinemaFrame(
  context: CanvasRenderingContext2D,
  elapsed: number,
): void {
  const time = Math.max(0, Math.min(DURATION_SECONDS, elapsed));
  const camera = Math.min(time, 11.5) * 90;
  const sky = context.createLinearGradient(0, 0, 0, 355);
  sky.addColorStop(0, "#172f57");
  sky.addColorStop(1, "#547ba7");
  context.fillStyle = sky;
  context.fillRect(0, 0, 960, 540);
  context.fillStyle = "#fff2c4";
  context.beginPath();
  context.arc(810, 92, 34, 0, Math.PI * 2);
  context.fill();
  for (let star = 0; star < 24; star++) {
    const x = (star * 173 + 41) % 960;
    const y = (star * 71 + 28) % 240;
    context.fillStyle = star % 3 === 0 ? "#f8d77e" : "#d3e9ff";
    context.fillRect(x, y, star % 4 === 0 ? 4 : 2, star % 4 === 0 ? 4 : 2);
  }
  for (let house = -1; house < 12; house++) {
    const x = house * 130 - ((camera * 0.35) % 130);
    roundedRect(context, x, 255 - (house % 3) * 22, 112, 114, 7, "#38577d");
    roundedRect(context, x + 22, 286, 22, 24, 3, "#f5d587");
    roundedRect(context, x + 65, 286, 22, 24, 3, "#f5d587");
  }
  drawFacade(context, 25 - camera, 188, 179, "#e79a7b", "CAFE");
  drawFacade(context, 255 - camera, 190, 230, "#7dc9b5", "SHOPS");
  drawFacade(context, 510 - camera, 196, 201, "#e7bc80", "CINEMA");
  drawFacade(context, 770 - camera, 190, 250, "#9db9e2", "HOMES");
  drawFacade(context, 1060 - camera, 205, 184, "#f0a88b", "BURGER");
  drawFacade(context, 1400 - camera, 228, 287, "#8eacc6", "PARKING");
  context.fillStyle = "#d6c9bc";
  context.fillRect(0, 358, 960, 52);
  context.fillStyle = "#52657c";
  context.fillRect(0, 410, 960, 130);
  context.fillStyle = "#fff1c3";
  for (let lane = -1; lane < 12; lane++)
    context.fillRect(lane * 105 - ((camera * 1.6) % 105), 468, 58, 6);
  for (const parked of [130, 365, 640, 900]) {
    const x = parked - camera;
    if (x > -70 && x < 1_030) {
      roundedRect(context, x - 62, 365, 124, 39, 14, "#d9e9ee");
      context.fillStyle = "#15243c";
      context.font = "bold 17px system-ui";
      context.fillText("FULL", x, 390);
    }
  }
  const arrival = Math.max(0, Math.min(1, (time - 12) / 3));
  const carX = 340 + arrival * 205;
  drawCar(context, carX, 453 - arrival * 40, "#ef715f");
  if (time < 3) {
    roundedRect(context, 220, 30, 520, 76, 18, "#fff4d7");
    context.fillStyle = "#14213d";
    context.font = "bold 39px system-ui";
    context.fillText("THE LAST SPACE", 480, 80);
  } else if (time >= 15) {
    roundedRect(context, 270, 38, 420, 72, 18, "#fff4d7");
    context.fillStyle = "#14213d";
    context.font = "bold 37px system-ui";
    context.fillText("FOUND IT!", 480, 85);
  }
}

export function mountCinemaShort(host: HTMLElement): () => void {
  const canvas = host.querySelector<HTMLCanvasElement>("#cinema-canvas");
  const play = host.querySelector<HTMLButtonElement>("#cinema-play");
  const restart = host.querySelector<HTMLButtonElement>("#cinema-restart");
  const progress = host.querySelector<HTMLProgressElement>("#cinema-progress");
  const timeLabel = host.querySelector<HTMLElement>("#cinema-time");
  const caption = host.querySelector<HTMLElement>("#cinema-caption");
  const context = canvas?.getContext("2d");
  if (
    !canvas ||
    !play ||
    !restart ||
    !progress ||
    !timeLabel ||
    !caption ||
    !context
  )
    throw new Error("Cinema player is incomplete");
  let elapsed = 0;
  let startedAt = 0;
  let playing = false;
  let frameId = 0;
  const render = () => {
    drawCinemaFrame(context, elapsed);
    progress.value = elapsed;
    timeLabel.textContent = `${Math.floor(elapsed)} / ${DURATION_SECONDS}s`;
    caption.textContent =
      elapsed < 6
        ? "Every curb is full. A little red car keeps looking."
        : elapsed < 12
          ? "The car passes the cinema and burger stop."
          : "The parking tower has room. The car finally rests.";
  };
  const pause = () => {
    if (!playing) return;
    elapsed = Math.min(
      DURATION_SECONDS,
      (performance.now() - startedAt) / 1_000,
    );
    playing = false;
    cancelAnimationFrame(frameId);
    play.textContent = elapsed >= DURATION_SECONDS ? "Play again" : "Continue";
    render();
  };
  const tick = () => {
    if (!playing) return;
    elapsed = Math.min(
      DURATION_SECONDS,
      (performance.now() - startedAt) / 1_000,
    );
    render();
    if (elapsed >= DURATION_SECONDS) pause();
    else frameId = requestAnimationFrame(tick);
  };
  const toggle = () => {
    if (playing) return pause();
    if (elapsed >= DURATION_SECONDS) elapsed = 0;
    startedAt = performance.now() - elapsed * 1_000;
    playing = true;
    play.textContent = "Pause";
    frameId = requestAnimationFrame(tick);
  };
  const replay = () => {
    pause();
    elapsed = 0;
    render();
    startedAt = performance.now();
    playing = true;
    play.textContent = "Pause";
    frameId = requestAnimationFrame(tick);
  };
  const onVisibility = () => {
    if (document.hidden) pause();
  };
  play.addEventListener("click", toggle);
  restart.addEventListener("click", replay);
  document.addEventListener("visibilitychange", onVisibility);
  render();
  return () => {
    pause();
    play.removeEventListener("click", toggle);
    restart.removeEventListener("click", replay);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
