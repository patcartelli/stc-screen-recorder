import { Menu, nativeImage, Tray } from "electron";
import {
  bgraFromMask, marqueeMask, trayTemplate,
  TRAY_ICON_SIZE, TRAY_ICON_SIZE_2X, TRAY_TOOLTIP,
  type TrayContext, type TrayItemId,
} from "./tray-menu.js";

/**
 * The menu-bar item (STC-292) — Electron only, decisions elsewhere.
 *
 * Everything this file could get wrong is a wiring mistake, and everything it
 * could get wrong ABOUT THE MENU is in `tray-menu.ts` where a test can read it.
 * What is left here is: build the icon, build the menu, keep one Tray alive for
 * the life of the app, and route a click to the caller.
 */

export interface TrayHandle {
  /** Rebuild the menu — after a rebinding, or when a capture starts or ends. */
  update(ctx: TrayContext): void;
  destroy(): void;
}

function icon(): Electron.NativeImage {
  const image = nativeImage.createEmpty();
  for (const [size, scaleFactor] of [[TRAY_ICON_SIZE, 1], [TRAY_ICON_SIZE_2X, 2]] as const) {
    image.addRepresentation({
      scaleFactor, width: size, height: size,
      buffer: Buffer.from(bgraFromMask(marqueeMask(size))),
    });
  }
  // The menu bar paints a template image itself, light or dark to match. Not
  // setting this is how an icon ends up black-on-black in dark mode.
  image.setTemplateImage(true);
  return image;
}

/**
 * Puts the item on the menu bar. `onSelect` is called with the id of whatever
 * was chosen; ids are the pure module's, so a renamed label cannot silently
 * change what a click does.
 */
export function installTray(
  ctx: TrayContext,
  onSelect: (id: TrayItemId) => void,
): TrayHandle {
  const tray = new Tray(icon());
  tray.setToolTip(TRAY_TOOLTIP);

  const build = (c: TrayContext): void => {
    tray.setContextMenu(Menu.buildFromTemplate(trayTemplate(c).map((item) => (
      item.type === "separator"
        ? { type: "separator" as const }
        : {
            label: item.label ?? "",
            enabled: item.enabled !== false,
            // Drawn, not bound: `registerAccelerator: false` keeps Electron
            // from claiming a second, app-menu copy of a key the global
            // shortcut already holds — which would make the same keystroke
            // fire twice whenever this app happened to be frontmost.
            ...(item.accelerator ? { accelerator: item.accelerator, registerAccelerator: false } : {}),
            click: () => onSelect(item.id),
          }
    ))));
  };
  build(ctx);

  // There is no Electron API that reads a Tray back — no enumeration, no menu
  // inspection, no synthetic click — so an E2E cannot otherwise tell "the item
  // is on the menu bar" from "installTray threw and was swallowed". Read-only,
  // and never a source of state: the menu itself is still built from the pure
  // template above.
  (globalThis as Record<string, unknown>).__stcTray = tray;

  return {
    update: (c) => { if (!tray.isDestroyed()) build(c); },
    destroy: () => {
      if (!tray.isDestroyed()) tray.destroy();
      delete (globalThis as Record<string, unknown>).__stcTray;
    },
  };
}
