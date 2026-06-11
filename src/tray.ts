import { TrayIcon } from "@tauri-apps/api/tray";
import { CheckMenuItem, Menu, MenuItem, Submenu } from "@tauri-apps/api/menu";
import { defaultWindowIcon } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

export const PACK_STORAGE_KEY = "w0rm.pack";

async function availablePacks(): Promise<string[]> {
  try {
    const res = await fetch("/packs/index.json");
    const { packs } = await res.json();
    return packs;
  } catch {
    return [];
  }
}

export async function setupTray(currentPack: string): Promise<void> {
  const win = getCurrentWindow();
  const packs = await availablePacks();

  const skinItems = await Promise.all(
    packs.map((name) =>
      CheckMenuItem.new({
        id: `skin:${name}`,
        text: name,
        checked: name === currentPack,
        action: () => {
          localStorage.setItem(PACK_STORAGE_KEY, name);
          location.reload();
        },
      }),
    ),
  );

  const menu = await Menu.new({
    items: [
      await MenuItem.new({
        id: "toggle",
        text: "Show/Hide",
        action: async () => {
          (await win.isVisible()) ? await win.hide() : await win.show();
        },
      }),
      await Submenu.new({ id: "skins", text: "Skin", items: skinItems }),
      await MenuItem.new({
        id: "quit",
        text: "Quit w0rm",
        action: () => void invoke("quit"),
      }),
    ],
  });

  // page reloads (skin switch, vite HMR) re-run setup — replace, don't duplicate
  await TrayIcon.removeById("w0rm-tray").catch(() => {});
  await TrayIcon.new({
    id: "w0rm-tray",
    icon: (await defaultWindowIcon()) ?? undefined,
    menu,
    showMenuOnLeftClick: true,
    tooltip: "w0rm",
  });
}
