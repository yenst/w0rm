import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Pack } from "./packs";
import { SpriteRenderer } from "./renderer";
import { Behavior } from "./behavior";
import { PACK_STORAGE_KEY, setupTray } from "./tray";

const DEFAULT_PACK = "worm";
const PACK_NAME = localStorage.getItem(PACK_STORAGE_KEY) ?? DEFAULT_PACK;
const PACK_URL = `/packs/${PACK_NAME}`;
const DRAG_THRESHOLD_PX = 5;
const DOUBLE_TAP_MS = 350;

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

  // click = pet, double click = acknowledge a waving alert, move past
  // threshold = manual drag that follows the cursor until pointerup (pointer
  // capture keeps events flowing while we move the window underneath the
  // cursor)
  let lastTapAt = -Infinity;
  canvas.addEventListener("pointerdown", (down) => {
    let dragging = false;
    const startX = down.screenX;
    const startY = down.screenY;
    const grab = behavior.grabInfo();
    canvas.setPointerCapture(down.pointerId);

    const onMove = (move: PointerEvent) => {
      const dx = move.screenX - startX;
      const dy = move.screenY - startY;
      if (!dragging && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
        dragging = true;
        behavior.startDrag();
      }
      if (dragging) {
        behavior.dragTo(
          grab.x + dx * grab.scaleFactor,
          grab.y + dy * grab.scaleFactor,
        );
      }
    };
    const onUp = () => {
      cleanup();
      if (dragging) {
        void behavior.drop();
        return;
      }
      const now = performance.now();
      if (now - lastTapAt <= DOUBLE_TAP_MS) {
        lastTapAt = -Infinity;
        behavior.acknowledge();
      } else {
        lastTapAt = now;
        behavior.tap();
      }
    };
    const cleanup = () => {
      canvas.releasePointerCapture(down.pointerId);
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
