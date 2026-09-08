/**
 * The menu-bar item's contents and its icon (STC-292) — pure, so the whole
 * thing is decided somewhere `app/test/tray-menu.test.ts` can look at it.
 *
 * There is no Electron API that reads a `Tray` back: once an item is on the
 * menu bar, nothing in a test can enumerate it, read its menu or click it. So
 * the template and the icon are built here, checked here, and handed to
 * `tray.ts`, which does nothing but hand them to Electron. What is left for a
 * human on the runbook is that the item is VISIBLE and legible in both menu-bar
 * appearances — which is exactly the part a test could never have claimed.
 */

import {
  ACTION_LABELS, CAPTURE_ACTIONS,
  type CaptureAction, type Shortcuts,
} from "./hotkeys.js";

export type TrayItemId = `capture:${CaptureAction}` | "library" | "quit" | "separator";

export interface TrayItem {
  id: TrayItemId;
  type?: "separator";
  label?: string;
  /**
   * The Electron accelerator, VERBATIM — not the ⌃⌥⇧⌘ rendering.
   *
   * A tray menu draws an accelerator and never fires it (the global shortcut
   * is what fires, registered separately), and Electron does the glyph
   * substitution itself. Handing it pre-rendered symbols would put a string it
   * cannot parse where it expects a binding.
   */
  accelerator?: string;
  enabled?: boolean;
}

export interface TrayContext {
  shortcuts: Shortcuts;
  /** A capture is already in flight (the overlay is up). Pressing another one
   * would be refused as `overlay-open`, so it is shown as unavailable instead
   * of offered and then declined. */
  busy?: boolean;
}

export const TRAY_TOOLTIP = "stc recorder";

/**
 * The three captures, then the way back to a window, then quit.
 *
 * Quit is not optional decoration: with the Dock icon hidden while no window
 * is open, this menu is the only way to end the app, and an app a user cannot
 * quit is worse than one with no menu-bar item at all.
 */
export function trayTemplate(ctx: TrayContext): TrayItem[] {
  const items: TrayItem[] = CAPTURE_ACTIONS.map((action) => {
    const accelerator = ctx.shortcuts[action];
    return {
      id: `capture:${action}` as TrayItemId,
      label: ACTION_LABELS[action],
      enabled: !ctx.busy,
      // Only when there is one: an item showing "—" where a shortcut would be
      // reads as a broken binding rather than as one nobody has set.
      ...(accelerator ? { accelerator } : {}),
    };
  });
  items.push({ id: "separator", type: "separator" });
  items.push({ id: "library", label: "Open Library" });
  items.push({ id: "separator", type: "separator" });
  items.push({ id: "quit", label: "Quit stc recorder" });
  return items;
}

// ── the icon ────────────────────────────────────────────────────────────────

/**
 * The glyph: a selection marquee's four corner brackets.
 *
 * Drawn from geometry rather than shipped as a PNG, for two reasons. A binary
 * asset is the one thing in this repo a reviewer cannot read in the diff, and
 * a menu-bar icon is small enough that being one pixel off is the whole
 * difference between crisp and smudged — so the shape is a function of the
 * size, and `tray-menu.test.ts` checks the properties that make it legible
 * (symmetric, on the frame, corners only) at both scales.
 *
 * Returns one byte of alpha per pixel, row-major. A macOS template image is
 * pure alpha: the system paints it black or white to match the menu bar, which
 * is why no colour is chosen here.
 */
export function marqueeMask(size: number): Uint8Array {
  const mask = new Uint8Array(size * size);
  const inset = Math.round(size / 8);
  const arm = Math.round(size / 4);
  const thick = Math.max(1, Math.round(size / 16));
  const lo = inset;
  const hi = size - 1 - inset;

  const set = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    mask[y * size + x] = 255;
  };
  // Each corner is a horizontal arm and a vertical arm of `thick` lines,
  // grown INWARD from the frame so the bracket never leaves the rect.
  for (const [cx, dx] of [[lo, 1], [hi, -1]] as const) {
    for (const [cy, dy] of [[lo, 1], [hi, -1]] as const) {
      for (let t = 0; t < thick; t++) {
        for (let i = 0; i < arm; i++) {
          set(cx + dx * i, cy + dy * t);
          set(cx + dx * t, cy + dy * i);
        }
      }
    }
  }
  return mask;
}

/**
 * A mask → the BGRA buffer `nativeImage.createFromBitmap` takes.
 *
 * Premultiplied, and black: a template image's colour is ignored, but a buffer
 * with colour where alpha is zero is the classic way to get a grey halo out of
 * anything that later ignores the template flag.
 */
export function bgraFromMask(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length * 4);
  for (let i = 0; i < mask.length; i++) out[i * 4 + 3] = mask[i]!;
  return out;
}

/** 1x and 2x, the two representations a menu bar asks for. */
export const TRAY_ICON_SIZE = 16;
export const TRAY_ICON_SIZE_2X = 32;
