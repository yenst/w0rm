# w0rm

A pixel-art desktop companion that lives on your screen — like the old Office
paperclip, but it's a black ragdoll cat with a white moustache. It wanders along
the bottom of your screen, sleeps when you're away, and signals when Claude Code
needs your input.

Sprites are generated with [PixelLab](https://pixellab.ai).

## Stack

- [Tauri v2](https://tauri.app) — transparent, always-on-top, frameless window
- TypeScript + canvas for sprite rendering and the behavior engine
- A tiny Rust HTTP server (`127.0.0.1:6767`) that receives Claude Code state

## Dev

```sh
bun install
bun start      # dev mode: live app with hot reload, no bundling
bun package    # release build: produces .app + .dmg
```

## Claude Code integration

Install the hooks (adds entries to `~/.claude/settings.json`):

```sh
bun scripts/install-hooks.ts
```

| Claude event       | Pet reaction            |
| ------------------ | ----------------------- |
| `Notification`     | alert jump — needs you  |
| `UserPromptSubmit` | kneading paws (working) |
| `Stop`             | celebration bounce      |
| `SessionEnd`       | back to lounging        |

Test manually:

```sh
curl -X POST -d '{"state":"needs_input"}' http://127.0.0.1:6767/state
```

## Sprite packs

A pack lives in `public/packs/<name>/` with a `manifest.json` describing
animations (frame paths per direction, fps, looping) and a `states` map from
behavior states to animations. Regenerate or add packs with
`scripts/build-pack.ts`:

```sh
bun scripts/build-pack.ts <pixellab-character-uuid> <pack-name>
```

The default cat is PixelLab character `21601c09-f7f0-4ac6-b651-5b0cbb9c731c`
(quadruped cat template, side view, 4 directions, 64px on a 92px canvas).
New animations can be added to it with PixelLab's `animate_character` (template
or v3 custom), then rebuild the pack with the command above.
