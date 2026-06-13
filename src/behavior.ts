import {
  getCurrentWindow,
  primaryMonitor,
  availableMonitors,
  cursorPosition,
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
  | "falling"
  | "stalk"
  | "windup"
  | "pounce"
  | "swat";

const GRAVITY = 3800; // physical px/s^2
const WALK_SPEED = 55; // logical px/s
const RUN_SPEED = 180;
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
];

/** rare moods — never picked twice in a row; always return to walk/idle first */
const SPECIALS: Mood[] = ["sit", "groom", "yawn"];

/** minimum seconds between two special moods */
const SPECIAL_COOLDOWN_S = 30;

// cursor chase tuning (logical px unless noted)
const CHASE_COOLDOWN_S = 120; // min time between hunts
const STALK_SPEED = 30;
const POUNCE_SECONDS = 0.45; // time to reach the cursor mid-leap
const POUNCE_RANGE = 170; // close enough to wind up
const CHASE_TRIGGER_NEAR = 120;
const CHASE_TRIGGER_FAR = 700;

export class Behavior {
  mood: Mood = "idle";
  private moodTimer = 5;
  private claude: ClaudeState = null;
  private dir: Direction = "south";
  private x = 0;
  private y = 0;
  private targetX = 0;
  private vx = 0;
  private vy = 0;
  // cursor velocity tracking while dragged, for throw momentum
  private dragVx = 0;
  private dragVy = 0;
  private lastDragX = 0;
  private lastDragY = 0;
  private lastDragT = 0;
  private monitor: Monitor | null = null;
  private lastInteraction = Date.now();
  private lastSpecialAt = 0;
  private recoverTimer = 3;
  private fallTime = 0;
  private cursor: { x: number; y: number } | null = null;
  private cursorPoll = 0;
  private chasePoll = 0;
  private chaseCooldownUntil = 0;
  // recent cursor samples for shake detection
  private cursorTrail: { x: number; y: number; t: number }[] = [];
  private wiggleCooldownUntil = 0;
  private win = getCurrentWindow();
  private winSize = 184; // physical px, set in init
  private posInFlight = false;
  private posInFlightSince = 0;

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

  /** lowest y the window may reach — stays clear of the menu bar / notch,
   * where macOS hides borderless windows */
  private ceilingY(): number {
    if (!this.monitor) return 0;
    const sf = this.monitor.scaleFactor ?? 1;
    return this.monitor.position.y + 44 * sf;
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
        this.fallTime = 0;
        this.moodTimer = Infinity;
        break;
      case "stalk": {
        const cx = this.x + this.winSize / 2;
        this.dir = (this.cursor?.x ?? cx) > cx ? "east" : "west";
        this.moodTimer = 20; // give up eventually
        break;
      }
      case "windup":
        this.moodTimer = 1.4; // refined to the clip length after play()
        break;
      case "pounce": {
        const sf = this.monitor?.scaleFactor ?? 1;
        const targetX = (this.cursor?.x ?? this.x) - this.winSize / 2;
        this.vx = (targetX - this.x) / POUNCE_SECONDS;
        this.vy = -850 * sf;
        this.moodTimer = 5;
        break;
      }
      case "swat":
        this.moodTimer = 30; // ends when the clip finishes
        break;
    }

    this.renderer.play(anim, this.dir, true);
    if (mood === "groom") {
      this.moodTimer = (this.renderer.clipDuration() ?? 2) * 2;
    }
    if (mood === "windup") {
      this.moodTimer = this.renderer.clipDuration() ?? 1.4;
    }
  }

  private async pollCursor(): Promise<void> {
    try {
      const p = await cursorPosition();
      this.cursor = { x: p.x, y: p.y };
      const now = Date.now();
      this.cursorTrail.push({ x: p.x, y: p.y, t: now });
      this.cursorTrail = this.cursorTrail.filter((s) => now - s.t < 2000);
      this.detectWiggle();
    } catch {
      this.cursor = null;
    }
  }

  /** vigorous cursor shaking = irresistible prey. A shake is lots of
   * movement that goes nowhere: long path, small net displacement. */
  private detectWiggle(): void {
    const trail = this.cursorTrail;
    if (trail.length < 8) return;
    const now = Date.now();
    if (now - trail[0].t < 1000) return; // need ~1s of history

    let pathLen = 0;
    for (let i = 1; i < trail.length; i++) {
      pathLen += Math.hypot(
        trail[i].x - trail[i - 1].x,
        trail[i].y - trail[i - 1].y,
      );
    }
    const first = trail[0];
    const last = trail[trail.length - 1];
    const netDisp = Math.hypot(last.x - first.x, last.y - first.y);

    const sf = this.monitor?.scaleFactor ?? 1;
    if (pathLen < 500 * sf) return; // not energetic enough
    if (netDisp > pathLen / 4) return; // just moving somewhere, not shaking

    this.cursorTrail = [];
    if (now < this.wiggleCooldownUntil) return;
    if (this.claude !== null) return;
    if (!["idle", "walk", "sit", "groom", "yawn"].includes(this.mood)) return;
    // a deliberate tease beats the regular hunt cooldown
    this.wiggleCooldownUntil = now + 15_000;
    this.enter("stalk");
  }

  /** occasionally decide the cursor is prey */
  private maybeStartChase(): void {
    if (this.mood !== "idle" && this.mood !== "walk") return;
    if (this.claude !== null) return;
    if (Date.now() < this.chaseCooldownUntil) return;
    if (!this.cursor || !this.monitor) return;
    const sf = this.monitor.scaleFactor ?? 1;
    const dx = this.cursor.x - (this.x + this.winSize / 2);
    const dy = this.cursor.y - (this.y + this.winSize / 2);
    if (Math.abs(dy) > 260 * sf) return; // cursor too high above the floor
    const adx = Math.abs(dx);
    if (adx < CHASE_TRIGGER_NEAR * sf || adx > CHASE_TRIGGER_FAR * sf) return;
    if (Math.random() > 0.12) return; // ~once in a while when you linger low
    this.enter("stalk");
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

  /** snap back to a safe on-screen spot */
  private rescue(): void {
    const { min, max } = this.bounds();
    this.x = Math.min(Math.max(this.x, min), max);
    this.y = this.groundY();
    this.vx = 0;
    this.vy = 0;
    void this.pushPosition();
    this.enter("idle");
  }

  update(dt: number): void {
    this.moodTimer -= dt;

    // watch the cursor closely (shake detection needs ~10Hz sampling)
    this.cursorPoll -= dt;
    if (this.cursorPoll <= 0) {
      this.cursorPoll = 0.1;
      void this.pollCursor();
    }
    this.chasePoll -= dt;
    if (this.chasePoll <= 0) {
      this.chasePoll = 0.35;
      this.maybeStartChase();
    }

    // safety net: if the window somehow ends up outside the visible screen
    // area (wild throw, monitor change), bring the cat back
    this.recoverTimer -= dt;
    if (this.recoverTimer <= 0) {
      this.recoverTimer = 3;
      if (this.mood !== "dragged" && this.mood !== "falling" && this.monitor) {
        const { min, max } = this.bounds();
        const offX = this.x < min - this.winSize || this.x > max + this.winSize;
        const offY =
          this.y > this.groundY() + this.winSize ||
          this.y < this.monitor.position.y - 3 * this.winSize;
        if (offX || offY) this.rescue();
      }
    }

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
        // a throw can never lose the cat: cap tumble time
        this.fallTime += dt;
        if (this.fallTime > 6) {
          this.rescue();
          break;
        }
        this.vy += GRAVITY * dt;
        this.x += this.vx * dt;
        this.y += this.vy * dt;

        // bounce off the screen edges
        const { min, max } = this.bounds();
        if (this.x <= min) {
          this.x = min;
          this.vx = Math.abs(this.vx) * 0.6;
        } else if (this.x >= max) {
          this.x = max;
          this.vx = -Math.abs(this.vx) * 0.6;
        }

        // bounce off the menu bar / notch line instead of vanishing into it
        const ceiling = this.ceilingY();
        if (this.y <= ceiling && this.vy < 0) {
          this.y = ceiling;
          this.vy = Math.abs(this.vy) * 0.5;
        }

        // bounce on the ground, losing energy each time
        const ground = this.groundY();
        if (this.y >= ground && this.vy > 0) {
          this.y = ground;
          this.vy = -this.vy * 0.45;
          this.vx *= 0.7;
          if (Math.abs(this.vy) < 160) {
            this.vx = 0;
            this.vy = 0;
            this.y = ground;
            this.enter("idle");
          }
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
      case "stalk": {
        const sf = this.monitor?.scaleFactor ?? 1;
        const cx = this.x + this.winSize / 2;
        const dx = (this.cursor?.x ?? cx) - cx;
        const dy = Math.abs(
          (this.cursor?.y ?? this.y) - (this.y + this.winSize / 2),
        );
        // prey escaped (or we got bored)
        if (
          !this.cursor ||
          Math.abs(dx) > 900 * sf ||
          dy > 400 * sf ||
          this.moodTimer <= 0
        ) {
          this.chaseCooldownUntil = Date.now() + 30_000;
          this.enter("idle");
          break;
        }
        if (Math.abs(dx) <= POUNCE_RANGE * sf) {
          this.enter("windup");
          break;
        }
        const newDir = dx > 0 ? "east" : "west";
        if (newDir !== this.dir) {
          this.dir = newDir;
          this.renderer.play(this.pack.animationFor("stalk"), this.dir);
        }
        const { min, max } = this.bounds();
        this.x += STALK_SPEED * sf * dt * (dx > 0 ? 1 : -1);
        this.x = Math.min(Math.max(this.x, min), max);
        void this.pushPosition();
        break;
      }
      case "windup":
        if (this.renderer.finished || this.moodTimer <= 0) {
          this.enter("pounce");
        }
        break;
      case "pounce": {
        const sf = this.monitor?.scaleFactor ?? 1;
        this.vy += GRAVITY * dt;
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        const { min, max } = this.bounds();
        this.x = Math.min(Math.max(this.x, min), max);
        const ground = this.groundY();
        if ((this.y >= ground && this.vy > 0) || this.moodTimer <= 0) {
          this.y = ground;
          this.vx = 0;
          this.vy = 0;
          this.chaseCooldownUntil =
            Date.now() + (CHASE_COOLDOWN_S + Math.random() * 60) * 1000;
          const caught =
            this.cursor &&
            Math.abs(this.cursor.x - (this.x + this.winSize / 2)) <
              220 * sf;
          this.enter(caught ? "swat" : "idle");
        }
        void this.pushPosition();
        break;
      }
      case "swat":
        if (this.renderer.finished || this.moodTimer <= 0) {
          this.enter("idle");
        }
        break;
      case "alert": // waves its sign until clicked or the next claude-state event
      case "dragged":
      case "sleep":
      case "working":
        break; // waits for an external event
      default:
        if (this.moodTimer <= 0) this.pickAutonomous();
    }
  }

  private async pushPosition(): Promise<void> {
    // drop frames while a move is in flight, but never let a lost IPC reply
    // wedge the flag shut — that would freeze the window while the sprite
    // keeps animating (running in place)
    const now = performance.now();
    if (this.posInFlight && now - this.posInFlightSince < 300) return;
    this.posInFlight = true;
    this.posInFlightSince = now;
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

  /** quick click on the cat — a pet; an alert wave resumes afterwards */
  tap(): void {
    this.lastInteraction = Date.now();
    if (this.mood !== "dragged" && this.mood !== "falling") {
      this.enter("pet");
    }
  }

  /** double click — acknowledge the wave and idle until the next event */
  acknowledge(): void {
    this.lastInteraction = Date.now();
    if (this.claude === "needs_input") {
      this.claude = null;
      // react to the poke, then settle into the autonomous loop
      this.enter("pet");
    }
  }

  /** manual drag started — the pet follows the cursor until drop() */
  startDrag(): void {
    this.lastInteraction = Date.now();
    this.dragVx = 0;
    this.dragVy = 0;
    this.lastDragX = this.x;
    this.lastDragY = this.y;
    this.lastDragT = performance.now();
    this.enter("dragged");
  }

  /** current physical position and display scale, for the drag handler */
  grabInfo(): { x: number; y: number; scaleFactor: number } {
    return {
      x: this.x,
      y: this.y,
      scaleFactor: this.monitor?.scaleFactor ?? 1,
    };
  }

  /** follow the cursor while dragged (physical px), tracking velocity */
  dragTo(x: number, y: number): void {
    if (this.mood !== "dragged") return;
    const now = performance.now();
    const dt = (now - this.lastDragT) / 1000;
    if (dt > 0 && dt < 0.2) {
      // exponential smoothing keeps the release velocity from being noise
      this.dragVx = this.dragVx * 0.7 + ((x - this.lastDragX) / dt) * 0.3;
      this.dragVy = this.dragVy * 0.7 + ((y - this.lastDragY) / dt) * 0.3;
    }
    this.lastDragX = x;
    this.lastDragY = y;
    this.lastDragT = now;
    this.x = x;
    this.y = Math.max(y, this.ceilingY());
    void this.pushPosition();
  }

  /** pointer released — fly with the throw momentum, or settle */
  async drop(): Promise<void> {
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

    const MAX_THROW = 3500; // physical px/s
    this.vx = Math.max(-MAX_THROW, Math.min(MAX_THROW, this.dragVx));
    this.vy = Math.max(-MAX_THROW, Math.min(MAX_THROW, this.dragVy));

    const thrown = Math.hypot(this.vx, this.vy) > 80;
    if (thrown || this.y < this.groundY() - 2) {
      this.enter("falling");
    } else {
      this.vx = 0;
      this.vy = 0;
      this.y = this.groundY();
      void this.pushPosition();
      this.enter("idle");
    }
  }
}
