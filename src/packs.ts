export type Direction = "south" | "east" | "north" | "west";

export const DIRECTIONS: Direction[] = ["south", "east", "north", "west"];

export interface AnimationManifest {
  fps: number;
  loop: boolean;
  /** frame index to restart from when looping — lets an intro (e.g. lying
   * down) play once while only the tail (e.g. breathing) repeats */
  loopFrom?: number;
  /** direction -> ordered frame image paths, relative to the pack folder */
  directions: Partial<Record<Direction, string[]>>;
}

export interface PackManifest {
  name: string;
  /** source frame size in px (square) */
  canvas: number;
  /** integer upscale applied for display */
  scale: number;
  /** px from the bottom of the source canvas to the character's feet */
  groundOffset: number;
  animations: Record<string, AnimationManifest>;
  /** behavior state -> animation name, or list to pick randomly from */
  states: Record<string, string | string[]>;
}

export interface Clip {
  name: string;
  frames: HTMLImageElement[];
  fps: number;
  loop: boolean;
  loopFrom: number;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

export class Pack {
  manifest: PackManifest;
  private clips = new Map<string, Clip>();

  private constructor(manifest: PackManifest) {
    this.manifest = manifest;
  }

  static async load(baseUrl: string): Promise<Pack> {
    const res = await fetch(`${baseUrl}/manifest.json`);
    if (!res.ok) throw new Error(`failed to load pack manifest from ${baseUrl}`);
    const manifest: PackManifest = await res.json();
    const pack = new Pack(manifest);

    const loads: Promise<void>[] = [];
    for (const [animName, anim] of Object.entries(manifest.animations)) {
      for (const [dir, paths] of Object.entries(anim.directions)) {
        if (!paths?.length) continue;
        loads.push(
          Promise.all(paths.map((p) => loadImage(`${baseUrl}/${p}`))).then(
            (frames) => {
              pack.clips.set(`${animName}/${dir}`, {
                name: animName,
                frames,
                fps: anim.fps,
                loop: anim.loop,
                loopFrom: Math.min(anim.loopFrom ?? 0, frames.length - 1),
              });
            },
          ),
        );
      }
    }
    await Promise.all(loads);
    return pack;
  }

  /**
   * Resolve a clip for an animation + direction, falling back to other
   * directions, then to idle, so a missing sheet never crashes the pet.
   */
  clip(animation: string, dir: Direction): Clip | null {
    const dirOrder: Direction[] = [dir, ...DIRECTIONS.filter((d) => d !== dir)];
    for (const name of [animation, "idle"]) {
      for (const d of dirOrder) {
        const c = this.clips.get(`${name}/${d}`);
        if (c) return c;
      }
    }
    return null;
  }

  /** Resolve a behavior state to an animation name via the manifest. */
  animationFor(state: string): string {
    const mapped = this.manifest.states[state] ?? "idle";
    if (Array.isArray(mapped)) {
      return mapped[Math.floor(Math.random() * mapped.length)] ?? "idle";
    }
    return mapped;
  }
}
