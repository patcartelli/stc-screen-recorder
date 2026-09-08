import { describe, test, expect } from "vitest";
import {
  thumbnailMenuTemplate, type ThumbMenuId, type ThumbMenuItem,
} from "../src/thumbnail-menu.js";

/**
 * The right-click menu, without a window (STC-296 follow-up).
 *
 * Nothing in Electron reads a `Menu` back once it is popped up, so this is the
 * only place the menu's contents can be checked at all — the same position
 * `tray-menu.test.ts` is in, and the reason both templates are pure.
 */

const ids = (items: ThumbMenuItem[]): ThumbMenuId[] => items.map((i) => i.id);
const byId = (items: ThumbMenuItem[], id: ThumbMenuId) => items.find((i) => i.id === id);

describe("the template", () => {
  test("offers exactly the five actions the ticket names", () => {
    const actions = ids(thumbnailMenuTemplate()).filter((id) => id !== "separator");
    expect(actions).toEqual(["copy", "save-as", "redact", "reveal", "delete"]);
  });

  test("delete is last, and behind a separator", () => {
    const items = thumbnailMenuTemplate();
    expect(items[items.length - 1]?.id).toBe("delete");
    expect(items[items.length - 2]?.type).toBe("separator");
  });

  test("every non-separator item has a label, and no separator has one", () => {
    for (const item of thumbnailMenuTemplate({ redacting: true, busy: true })) {
      if (item.type === "separator") expect(item.label).toBeUndefined();
      else expect(item.label).toBeTruthy();
    }
  });
});

describe("what a dialog-opening item is called", () => {
  test("Save As and Redact carry the ellipsis; Copy and Reveal do not", () => {
    const items = thumbnailMenuTemplate();
    // macOS spells "choosing this opens something" with an ellipsis, and the
    // difference between Copy and Save As is exactly that.
    expect(byId(items, "save-as")?.label).toBe("Save As…");
    expect(byId(items, "redact")?.label).toBe("Redact…");
    expect(byId(items, "copy")?.label).toBe("Copy");
    expect(byId(items, "reveal")?.label).toBe("Reveal in Finder");
  });

  test("the ellipsis is the real character, not three dots", () => {
    // Three periods look identical at a glance and are wrong; this is the kind
    // of thing only an assertion catches.
    for (const item of thumbnailMenuTemplate()) {
      expect(item.label ?? "").not.toContain("...");
    }
  });
});

describe("redact is a toggle, not a checkbox", () => {
  test("reads Redact… when closed and Done Redacting when open", () => {
    expect(byId(thumbnailMenuTemplate(), "redact")?.label).toBe("Redact…");
    expect(byId(thumbnailMenuTemplate({ redacting: true }), "redact")?.label)
      .toBe("Done Redacting");
  });

  test("stays enabled either way — it is how you leave redact mode", () => {
    expect(byId(thumbnailMenuTemplate({ redacting: true }), "redact")?.enabled).toBe(true);
  });
});

describe("busy", () => {
  test("disables the two items that would be refused, and nothing else", () => {
    const busy = thumbnailMenuTemplate({ busy: true });
    expect(byId(busy, "copy")?.enabled).toBe(false);
    expect(byId(busy, "save-as")?.enabled).toBe(false);
    // Reveal, Redact and Delete do not touch the exporter, so a composite in
    // flight is no reason to withhold them.
    expect(byId(busy, "reveal")?.enabled).toBe(true);
    expect(byId(busy, "redact")?.enabled).toBe(true);
    expect(byId(busy, "delete")?.enabled).toBe(true);
  });

  test("idle enables everything", () => {
    for (const item of thumbnailMenuTemplate()) {
      if (item.type !== "separator") expect(item.enabled).toBe(true);
    }
  });
});
