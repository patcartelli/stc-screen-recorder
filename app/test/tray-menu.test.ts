import { describe, test, expect } from "vitest";
import {
  TRAY_ICON_SIZE, TRAY_ICON_SIZE_2X, bgraFromMask, marqueeMask, trayTemplate,
} from "../src/tray-menu.js";
import { CAPTURE_ACTIONS, DEFAULT_SHORTCUTS, HYPER } from "../src/hotkeys.js";

/**
 * The menu-bar item's contents and icon (STC-292).
 *
 * There is no Electron API that reads a `Tray` back — no enumeration, no menu
 * inspection, no synthetic click — so everything checkable about the menu bar
 * has to be checkable BEFORE it reaches Electron. That is the whole reason
 * `tray-menu.ts` is separate from `tray.ts`. What is left for the runbook is
 * whether the item is visible and legible in both menu-bar appearances.
 */

describe("the menu", () => {
  const ids = (ctx: Parameters<typeof trayTemplate>[0]) =>
    trayTemplate(ctx).map((i) => i.id);

  test("every capture action is offered, in the order preferences lists them", () => {
    expect(ids({ shortcuts: DEFAULT_SHORTCUTS }).slice(0, 3))
      .toEqual(CAPTURE_ACTIONS.map((a) => `capture:${a}`));
  });

  test("there is a way back to a window and a way to quit", () => {
    // Not decoration: with the Dock icon hidden while no window is open, this
    // menu is the only way to reopen the app and the only way to end it.
    const id = ids({ shortcuts: DEFAULT_SHORTCUTS });
    expect(id).toContain("library");
    expect(id).toContain("quit");
  });

  test("a bound action shows its accelerator VERBATIM, not pre-rendered", () => {
    // Electron does the ⌃⌥⇧⌘ substitution itself; handing it glyphs would put
    // a string it cannot parse where it expects a binding.
    const [region] = trayTemplate({ shortcuts: DEFAULT_SHORTCUTS });
    expect(region!.accelerator).toBe(`${HYPER}+1`);
  });

  test("an unbound action shows no accelerator at all", () => {
    // An item showing "—" where a shortcut would be reads as a broken binding
    // rather than as one nobody has set.
    const [region] = trayTemplate({ shortcuts: { ...DEFAULT_SHORTCUTS, region: null } });
    expect(region!.accelerator).toBeUndefined();
  });

  test("a capture in flight disables the captures and nothing else", () => {
    const busy = trayTemplate({ shortcuts: DEFAULT_SHORTCUTS, busy: true });
    const captures = busy.filter((i) => i.id.startsWith("capture:"));
    expect(captures.map((i) => i.enabled)).toEqual([false, false, false]);
    expect(busy.find((i) => i.id === "library")!.enabled).not.toBe(false);
    expect(busy.find((i) => i.id === "quit")!.enabled).not.toBe(false);
  });

  test("every item that is not a separator has a label", () => {
    for (const item of trayTemplate({ shortcuts: DEFAULT_SHORTCUTS })) {
      if (item.type === "separator") continue;
      expect(item.label, item.id).toBeTruthy();
    }
  });
});

describe("the icon", () => {
  const at = (m: Uint8Array, size: number, x: number, y: number) => m[y * size + x];

  for (const size of [TRAY_ICON_SIZE, TRAY_ICON_SIZE_2X]) {
    describe(`${size}px`, () => {
      const mask = marqueeMask(size);

      test("is the right length and only ever fully on or fully off", () => {
        expect(mask.length).toBe(size * size);
        expect(new Set(mask)).toEqual(new Set([0, 255]));
      });

      test("is symmetric both ways", () => {
        // An asymmetric menu-bar glyph reads as a rendering bug at 16px.
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            expect(at(mask, size, x, y), `${x},${y} horizontally`)
              .toBe(at(mask, size, size - 1 - x, y));
            expect(at(mask, size, x, y), `${x},${y} vertically`)
              .toBe(at(mask, size, x, size - 1 - y));
          }
        }
      });

      test("draws corner brackets: corners set, edge midpoints clear", () => {
        // The positive discriminator. "Some pixels are set" would pass for a
        // solid square, a dot, or a frame — none of which is this glyph.
        const inset = Math.round(size / 8);
        expect(at(mask, size, inset, inset)).toBe(255);
        expect(at(mask, size, size - 1 - inset, inset)).toBe(255);
        expect(at(mask, size, inset, size - 1 - inset)).toBe(255);
        expect(at(mask, size, size - 1 - inset, size - 1 - inset)).toBe(255);
        // A full frame would have these set; a bracket glyph does not.
        expect(at(mask, size, size >> 1, inset)).toBe(0);
        expect(at(mask, size, inset, size >> 1)).toBe(0);
        // And nothing in the middle at all.
        expect(at(mask, size, size >> 1, size >> 1)).toBe(0);
      });

      test("never leaves the inset rect, so nothing is clipped by the menu bar", () => {
        const inset = Math.round(size / 8);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            if (!at(mask, size, x, y)) continue;
            expect(x >= inset && x <= size - 1 - inset, `${x},${y}`).toBe(true);
            expect(y >= inset && y <= size - 1 - inset, `${x},${y}`).toBe(true);
          }
        }
      });
    });
  }

  test("the bitmap is pure alpha and black — a template image carries no colour", () => {
    // Colour under zero alpha is the classic way to get a grey halo out of
    // anything that later ignores the template flag.
    const mask = marqueeMask(TRAY_ICON_SIZE);
    const bgra = bgraFromMask(mask);
    expect(bgra.length).toBe(mask.length * 4);
    for (let i = 0; i < mask.length; i++) {
      expect(bgra[i * 4]).toBe(0);
      expect(bgra[i * 4 + 1]).toBe(0);
      expect(bgra[i * 4 + 2]).toBe(0);
      expect(bgra[i * 4 + 3]).toBe(mask[i]);
    }
  });
});
