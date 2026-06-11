import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Pack } from "./packs";
import { SpriteRenderer } from "./renderer";
import { Behavior } from "./behavior";
import { PACK_STORAGE_KEY, setupTray } from "./tray";

const DEFAULT_PACK = "ragdoll-cat";
const PACK_NAME = localStorage.getItem(PACK_STORAGE_KEY) ?? DEFAULT_PACK;
const PACK_URL = `/packs/${PACK_NAME}`;
const DRAG_THRESHOLD_PX = 5;

async function boot() {
  const canvas = document.getElementById("pet") as HTMLCanvasElement;
  const pack = await Pack.load(PACK_URL);
  const win = getCurrentWindow();

  const logical = pack.manifest.canvas * pack.manifest.scale;
  await win.setSize(new LogicalSize(logical, logical));

  const renderer = new SpriteRenderer(canvas, pack);
  const behavior = new Behavior(pack, renderer);
  await behavior.init();
  await setupTray(PACK_NAME);

  await listen<string>("claude-state", (e) => {
    behavior.setClaudeState(e.payload as Parameters<typeof behavior.setClaudeState>[0]);
  });

  await win.onMoved(({ payload }) => behavior.onWindowMoved(payload));

  // click = pet, move past threshold = native window drag
  canvas.addEventListener("pointerdown", (down) => {
    let dragging = false;
    const startX = down.screenX;
    const startY = down.screenY;

    const onMove = (move: PointerEvent) => {
      if (dragging) return;
      const dist = Math.hypot(move.screenX - startX, move.screenY - startY);
      if (dist >= DRAG_THRESHOLD_PX) {
        dragging = true;
        cleanup();
        behavior.startDrag();
        void win.startDragging();
      }
    };
    const onUp = () => {
      cleanup();
      if (!dragging) behavior.tap();
    };
    const cleanup = () => {
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
  });

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    behavior.update(dt);
    renderer.update(dt);
    renderer.draw();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

boot().catch((err) => {
  console.error("w0rm failed to boot:", err);
});
