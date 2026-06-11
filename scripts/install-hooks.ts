#!/usr/bin/env bun
/**
 * Installs Claude Code hooks that signal w0rm about session state.
 *
 * Adds hooks to ~/.claude/settings.json:
 *   Notification      -> needs_input  (Claude is waiting for permission/input)
 *   UserPromptSubmit  -> working      (a prompt was submitted)
 *   Stop              -> done         (Claude finished responding)
 *   SessionEnd        -> idle         (session closed)
 *
 * Idempotent: skips events that already have a w0rm hook. Writes a backup
 * to settings.json.bak before modifying.
 */
import { homedir } from "os";
import { join } from "path";

const PORT = process.env.W0RM_PORT ?? "6767";
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

const post = (state: string) =>
  `curl -s -m 1 -X POST -H 'Content-Type: application/json' -d '{"state":"${state}"}' http://127.0.0.1:${PORT}/state >/dev/null 2>&1 || true`;

const EVENTS: Record<string, string> = {
  Notification: "needs_input",
  UserPromptSubmit: "working",
  Stop: "done",
  SessionEnd: "idle",
};

const MARKER = `127.0.0.1:${PORT}/state`;

async function main() {
  const file = Bun.file(SETTINGS_PATH);
  const settings = (await file.exists()) ? await file.json() : {};

  settings.hooks ??= {};
  let changed = false;

  for (const [event, state] of Object.entries(EVENTS)) {
    const entries: any[] = (settings.hooks[event] ??= []);
    const already = entries.some((e) =>
      (e.hooks ?? []).some((h: any) => h.command?.includes(MARKER)),
    );
    if (already) {
      console.log(`✓ ${event} hook already installed`);
      continue;
    }
    entries.push({
      hooks: [{ type: "command", command: post(state) }],
    });
    console.log(`+ ${event} -> ${state}`);
    changed = true;
  }

  if (!changed) {
    console.log("nothing to do");
    return;
  }

  if (await file.exists()) {
    await Bun.write(SETTINGS_PATH + ".bak", await file.text());
  }
  await Bun.write(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  console.log(`\nwrote ${SETTINGS_PATH} (backup: settings.json.bak)`);
}

main();
