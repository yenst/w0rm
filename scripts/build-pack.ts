#!/usr/bin/env bun
/**
 * Builds a sprite pack from a PixelLab character download.
 *
 * Usage:
 *   bun scripts/build-pack.ts <character-uuid> <pack-name>   # downloads zip
 *   bun scripts/build-pack.ts <path-to-zip>   <pack-name>    # local zip
 *
 * Output: public/packs/<pack-name>/{manifest.json, <anim>/<dir>/frame_NNN.png}
 */
import { mkdir, rm, cp } from "fs/promises";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { $ } from "bun";
import { PNG } from "pngjs";

const ROOT = join(dirname(import.meta.path), "..");

/** v3 custom animations get folder names derived from their action description —
 * collapse them to the short names the state map uses */
const ALIASES: [RegExp, string][] = [
  [/^sleeping/, "sleep"],
  [/celebration|excited/, "celebrate"],
  [/kneading|working/, "working"],
];

const alias = (name: string) =>
  ALIASES.find(([re]) => re.test(name))?.[1] ?? name;

/** per-animation playback defaults; anything unlisted gets fps 8, loop true */
const PLAYBACK: Record<
  string,
  { fps: number; loop: boolean; loopFrom?: number }
> = {
  idle: { fps: 6, loop: true },
  walking: { fps: 10, loop: true },
  running: { fps: 14, loop: true },
  jumping: { fps: 10, loop: true },
  licking: { fps: 8, loop: true },
  sitting_down: { fps: 8, loop: false }, // hold the seated pose at the end
  yawning: { fps: 8, loop: false },
  // v3 clips start with the standing reference frame and an intro motion;
  // play that once, then loop only the tail
  sleep: { fps: 4, loop: true, loopFrom: 4 },
  celebrate: { fps: 10, loop: true, loopFrom: 1 },
  working: { fps: 8, loop: true, loopFrom: 1 },
};

/** behavior state -> animation name (missing animations fall back to idle at runtime) */
const STATES: Record<string, string | string[]> = {
  idle: "idle",
  walk: "walking",
  run: "running",
  sit: "sitting_down",
  groom: "licking",
  yawn: "yawning",
  sleep: "sleep",
  alert: "jumping",
  working: "working",
  celebrate: "celebrate",
  pet: "licking",
  dragged: "idle",
  falling: "jumping",
};

async function main() {
  const [source, packName] = process.argv.slice(2);
  if (!source || !packName) {
    console.error("usage: bun scripts/build-pack.ts <uuid|zip> <pack-name>");
    process.exit(1);
  }

  const work = `/tmp/w0rm-pack-${packName}`;
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  let zipPath = source;
  if (/^[0-9a-f-]{36}$/.test(source)) {
    zipPath = join(work, "character.zip");
    const url = `https://api.pixellab.ai/mcp/characters/${source}/download`;
    console.log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`download failed: HTTP ${res.status} — ${await res.text()}`);
      process.exit(1);
    }
    await Bun.write(zipPath, res);
  }

  await $`unzip -o -q ${zipPath} -d ${work}/extracted`;
  const meta = await Bun.file(`${work}/extracted/metadata.json`).json();

  const state = meta.states[0];
  const folder: string = state.folder;
  const size: number = state.character.size.width;
  const animations: Record<string, Record<string, string[]>> =
    state.frames.animations;

  const outDir = join(ROOT, "public", "packs", packName);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const manifestAnimations: Record<string, unknown> = {};
  for (const [srcName, dirs] of Object.entries(animations)) {
    const animName = alias(srcName);
    const playback = PLAYBACK[animName] ?? { fps: 8, loop: true };
    const directions: Record<string, string[]> = {};
    for (const [dir, paths] of Object.entries(dirs)) {
      directions[dir] = paths.map(
        (p) => `${animName}/${dir}/${p.split("/").pop()}`,
      );
      const destDir = join(outDir, animName, dir);
      await mkdir(destDir, { recursive: true });
      for (const p of paths) {
        const file = p.split("/").pop()!;
        await cp(join(work, "extracted", folder, "animations", srcName, dir, file), join(destDir, file));
      }
    }
    manifestAnimations[animName] = { ...playback, directions };
    console.log(
      `+ ${animName}: ${Object.keys(directions).length} directions${animName !== srcName ? ` (from ${srcName})` : ""}`,
    );
  }

  // measure transparent rows below the sprite's feet on grounded animations
  // so the window can be positioned flush with the screen bottom
  let groundOffset = 0;
  const grounded = ["walking", "idle"].flatMap((anim) => {
    const dirs = (manifestAnimations[anim] as any)?.directions ?? {};
    return Object.values(dirs as Record<string, string[]>).map((f) => f[0]);
  });
  if (grounded.length) {
    const empties = grounded.map((rel) => {
      const png = PNG.sync.read(readFileSync(join(outDir, rel)));
      let empty = 0;
      outer: for (let y = png.height - 1; y >= 0; y--) {
        for (let x = 0; x < png.width; x++) {
          if (png.data[(y * png.width + x) * 4 + 3] > 8) break outer;
        }
        empty++;
      }
      return empty;
    });
    groundOffset = Math.min(...empties);
  }

  const manifest = {
    name: packName,
    canvas: size,
    scale: size <= 128 ? 2 : 1,
    groundOffset,
    animations: manifestAnimations,
    states: STATES,
  };
  await Bun.write(
    join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );

  // keep the pack index (used by the tray skin menu) up to date
  const indexPath = join(ROOT, "public", "packs", "index.json");
  const index = (await Bun.file(indexPath).exists())
    ? await Bun.file(indexPath).json()
    : { packs: [] };
  if (!index.packs.includes(packName)) {
    index.packs.push(packName);
    index.packs.sort();
    await Bun.write(indexPath, JSON.stringify(index, null, 2) + "\n");
  }
  console.log(`\nwrote ${outDir}/manifest.json (canvas ${size}px)`);
}

main();
