import {
  getCurrentWindow,
  primaryMonitor,
  availableMonitors,
  PhysicalPosition,
  type Monitor,
} from "@tauri-apps/api/window";
import type { Direction, Pack } from "./packs";
import type { SpriteRenderer } from "./renderer";

export type ClaudeState = "needs_input" | "working" | "done" | null;

export type Mood =
  | "idle"
  | "sit"
  | "groom"
  | "yawn"
  | "sleep"
  | "walk"
  | "run"
  | "alert"
  | "working"
  | "celebrate"
  | "pet"
  | "dragged"
  | "falling";

const GRAVITY = 3800; // physical px/s^2
const WALK_SPEED = 42; // logical px/s
const RUN_SPEED = 120;
const SLEEP_AFTER_MS = 120_000;
const CELEBRATE_SECONDS = 5;
const EDGE_MARGIN = 8; // logical px

/** weighted autonomous moods: [mood, weight, minSeconds, maxSeconds] */
const AUTONOMOUS: [Mood, number, number, number][] = [
  ["walk", 45, 0, 0], // duration comes from distance
  ["idle", 35, 3, 8],
  ["sit", 8, 4, 8],
  ["groom", 6, 0, 0], // duration = two clip cycles
  ["yawn", 3, 0, 0], // ends when the clip finishes
  ["run", 3, 0, 0],
];

/** rare moods — never picked twice in a row; always return to walk/idle first */
const SPECIALS: Mood[] = ["sit", "groom", "yawn", "run"];

/** minimum seconds between two special moods */
const SPECIAL_COOLDOWN_S = 30;

export class Behavior {
  mood: Mood = "idle";
  private moodTimer = 5;
  private claude: ClaudeState = null;
  private dir: Direction = "south";
  private x = 0;
  private y = 0;
  private targetX = 0;
  private vy = 0;
  private monitor: Monitor | null = null;
  private lastInteraction = Date.now();
  private lastSpecialAt = 0;
  private alertCalmed = false;
  private win = getCurrentWindow();
  private winSize = 184; // physical px, set in init
  private posInFlight = false;
  private dropTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private pack: Pack,
    private renderer: SpriteRenderer,
  ) {}

  async init(): Promise<void> {
    const m = this.pack.manifest;
    this.monitor = (await primaryMonitor()) ?? null;
    const scaleFactor = this.monitor?.scaleFactor ?? 1;
    this.winSize = m.canvas * m.scale * scaleFactor;

    if (this.monitor) {
      this.x =
        this.monitor.position.x +
        this.monitor.size.width / 2 -
        this.winSize / 2;
      this.y = this.groundY();
      await this.pushPosition();
    }
    this.enter("idle");
  }

  /** physical y for the pet's resting line — one pet-height above the screen bottom */
  private groundY(): number {
    if (!this.monitor) return 0;
    const m = this.pack.manifest;
    const scaleFactor = this.monitor.scaleFactor ?? 1;
    return (
      this.monitor.position.y +
      this.monitor.size.height -
      this.winSize +
      m.groundOffset * m.scale * scaleFactor -
      this.winSize / 2
    );
  }

  private bounds(): { min: number; max: number } {
    if (!this.monitor) return { min: 0, max: 1000 };
    const scaleFactor = this.monitor.scaleFactor ?? 1;
    const margin = EDGE_MARGIN * scaleFactor;
    return {
      min: this.monitor.position.x + margin,
      max:
        this.monitor.position.x +
        this.monitor.size.width -
        this.winSize -
        margin,
    };
  }

  private enter(mood: Mood): void {
    this.mood = mood;
    const anim = this.pack.animationFor(mood);

    switch (mood) {
      case "walk":
      case "run": {
        const { min, max } = this.bounds();
        const minDist = 120 * (this.monitor?.scaleFactor ?? 1);
        // pick a destination a meaningful distance away (a few attempts, then accept)
        for (let i = 0; i < 8; i++) {
          this.targetX = min + Math.random() * (max - min);
          if (Math.abs(this.targetX - this.x) >= minDist) break;
        }
        this.dir = this.targetX > this.x ? "east" : "west";
        this.moodTimer = 60; // safety cap; normally ends on arrival
        break;
      }
      case "idle":
      case "sit": {
        const spec = AUTONOMOUS.find(([m]) => m === mood);
        this.moodTimer = spec
          ? spec[2] + Math.random() * (spec[3] - spec[2])
          : 5;
        // mostly face the user, sometimes keep walking direction
        if (Math.random() < 0.7) this.dir = "south";
        break;
      }
      case "groom":
        this.moodTimer = 4; // refined to two clip cycles after play() below
        break;
      case "yawn":
      case "pet":
        this.moodTimer = 30; // ends when clip finishes
        break;
      case "sleep":
        this.moodTimer = Infinity;
        break;
      case "alert":
      case "working":
        this.dir = "south";
        this.moodTimer = Infinity;
        break;
      case "celebrate":
        this.dir = "south";
        this.moodTimer = CELEBRATE_SECONDS;
        break;
      case "dragged":
        this.moodTimer = Infinity;
        break;
      case "falling":
        this.moodTimer = Infinity;
        break;
    }

    this.renderer.play(anim, this.dir, true);
    if (mood === "groom") {
      this.moodTimer = (this.renderer.clipDuration() ?? 2) * 2;
    }
    if (mood === "alert") {
      // jump a few times to get attention, then settle (see update())
      this.alertCalmed = false;
      this.moodTimer = (this.renderer.clipDuration() ?? 1) * 3;
    }
  }

  private pickAutonomous(): void {
    if (this.claude === "needs_input") return this.enter("alert");
    if (this.claude === "working") return this.enter("working");

    if (Date.now() - this.lastInteraction > SLEEP_AFTER_MS) {
      if (this.mood !== "sleep") this.enter("sleep");
      return;
    }

    // specials are rare: never twice in a row, and respect a cooldown
    const allowSpecials =
      !SPECIALS.includes(this.mood) &&
      (Date.now() - this.lastSpecialAt) / 1000 > SPECIAL_COOLDOWN_S;

    const pool = AUTONOMOUS.filter(
      ([m]) =>
        (allowSpecials || m === "walk" || m === "idle") &&
        // avoid repeating the same stationary mood back to back
        !(m === this.mood && m !== "walk"),
    );

    const total = pool.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    let picked: Mood = "idle";
    for (const [mood, weight] of pool) {
      r -= weight;
      if (r <= 0) {
        picked = mood;
        break;
      }
    }
    if (SPECIALS.includes(picked)) this.lastSpecialAt = Date.now();
    this.enter(picked);
  }

  update(dt: number): void {
    this.moodTimer -= dt;

    switch (this.mood) {
      case "walk":
      case "run": {
        const scaleFactor = this.monitor?.scaleFactor ?? 1;
        const speed =
          (this.mood === "run" ? RUN_SPEED : WALK_SPEED) * scaleFactor;
        const step = speed * dt * (this.dir === "east" ? 1 : -1);
        this.x += step;
        const arrived =
          (this.dir === "east" && this.x >= this.targetX) ||
          (this.dir === "west" && this.x <= this.targetX);
        const { min, max } = this.bounds();
        this.x = Math.min(Math.max(this.x, min), max);
        void this.pushPosition();
        if (arrived || this.moodTimer <= 0) this.pickAutonomous();
        break;
      }
      case "falling": {
        this.vy += GRAVITY * dt;
        this.y += this.vy * dt;
        const ground = this.groundY();
        if (this.y >= ground) {
          this.y = ground;
          this.vy = 0;
          this.enter("idle");
        }
        void this.pushPosition();
        break;
      }
      case "yawn":
      case "pet":
        if (this.renderer.finished || this.moodTimer <= 0) {
          this.pickAutonomous();
        }
        break;
      case "alert":
        // after the attention jumps, sit and wait instead of jumping forever
        if (!this.alertCalmed && this.moodTimer <= 0) {
          this.alertCalmed = true;
          this.renderer.play(this.pack.animationFor("sit"), "south");
        }
        break; // cleared by a click or the next claude-state event
      case "dragged":
      case "sleep":
      case "working":
        break; // waits for an external event
      default:
        if (this.moodTimer <= 0) this.pickAutonomous();
    }
  }

  private async pushPosition(): Promise<void> {
    if (this.posInFlight) return;
    this.posInFlight = true;
    try {
      await this.win.setPosition(
        new PhysicalPosition(Math.round(this.x), Math.round(this.y)),
      );
    } finally {
      this.posInFlight = false;
    }
  }

  // ---- external events ----------------------------------------------------

  setClaudeState(state: Exclude<ClaudeState, null> | "idle"): void {
    if (state === "idle") {
      this.claude = null;
      if (["alert", "working", "celebrate"].includes(this.mood)) {
        this.pickAutonomous();
      }
      return;
    }
    if (state === "done") {
      // only celebrate a finished task the pet actually saw start —
      // otherwise every Stop event in any session triggers a party
      const wasBusy =
        this.claude === "working" ||
        this.mood === "working" ||
        this.mood === "alert";
      this.claude = null;
      if (wasBusy) this.enter("celebrate");
      else if (["alert", "working", "celebrate"].includes(this.mood)) {
        this.pickAutonomous();
      }
      return;
    }
    this.claude = state;
    this.enter(state === "needs_input" ? "alert" : "working");
  }

  /** quick click on the cat */
  tap(): void {
    this.lastInteraction = Date.now();
    if (this.mood === "alert") {
      // acknowledged: calm down until the next event
      this.claude = null;
      this.enter("pet");
      return;
    }
    if (this.mood !== "dragged" && this.mood !== "falling") {
      this.enter("pet");
    }
  }

  /** native window drag started */
  startDrag(): void {
    this.lastInteraction = Date.now();
    this.enter("dragged");
  }

  /** window moved (only meaningful while dragged) */
  onWindowMoved(pos: { x: number; y: number }): void {
    if (this.mood !== "dragged") return;
    this.x = pos.x;
    this.y = pos.y;
    if (this.dropTimer) clearTimeout(this.dropTimer);
    this.dropTimer = setTimeout(() => void this.drop(), 250);
  }

  private async drop(): Promise<void> {
    if (this.mood !== "dragged") return;
    // figure out which monitor the cat was dropped on
    const monitors = await availableMonitors();
    const found = monitors.find(
      (m) =>
        this.x >= m.position.x &&
        this.x < m.position.x + m.size.width &&
        this.y >= m.position.y - m.size.height && // allow above-screen drops
        this.y < m.position.y + m.size.height,
    );
    if (found) this.monitor = found;
    this.vy = 0;
    if (this.y < this.groundY() - 2) {
      this.enter("falling");
    } else {
      this.y = this.groundY();
      void this.pushPosition();
      this.enter("idle");
    }
  }
}
