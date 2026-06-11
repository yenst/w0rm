import type { Clip, Direction, Pack } from "./packs";

export class SpriteRenderer {
  private ctx: CanvasRenderingContext2D;
  private clip: Clip | null = null;
  private frame = 0;
  private elapsed = 0;
  /** set when a non-looping clip has played through */
  finished = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private pack: Pack,
  ) {
    const size = pack.manifest.canvas;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
  }

  /** seconds for one full cycle of the current clip */
  clipDuration(): number | null {
    return this.clip ? this.clip.frames.length / this.clip.fps : null;
  }

  play(animation: string, dir: Direction, restart = false): void {
    const next = this.pack.clip(animation, dir);
    if (!next) return;
    if (next === this.clip && !restart) return;
    this.clip = next;
    this.frame = 0;
    this.elapsed = 0;
    this.finished = false;
  }

  update(dt: number): void {
    if (!this.clip || this.finished) return;
    this.elapsed += dt;
    const frameTime = 1 / this.clip.fps;
    while (this.elapsed >= frameTime) {
      this.elapsed -= frameTime;
      this.frame += 1;
      if (this.frame >= this.clip.frames.length) {
        if (this.clip.loop) {
          this.frame = this.clip.loopFrom;
        } else {
          this.frame = this.clip.frames.length - 1;
          this.finished = true;
        }
      }
    }
  }

  draw(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const img = this.clip?.frames[this.frame];
    if (img) this.ctx.drawImage(img, 0, 0);
  }
}
