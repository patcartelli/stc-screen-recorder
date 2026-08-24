import { describe, test, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { takesRoot, newTakeDir } from "../src/takes.js";

describe("where recordings go", () => {
  test("defaults to ~/Desktop/stc — durable and visible, not scratch", () => {
    expect(takesRoot({})).toBe(join(homedir(), "Desktop", "stc"));
  });

  test("never defaults into a temp directory that the OS sweeps", () => {
    // /var/folders/.../T is purged on boot and swept after ~3 days. A take is a
    // deliverable, not scratch, and must not live somewhere it can vanish.
    expect(takesRoot({})).not.toMatch(/\/var\/folders|\/tmp|[/\\]T$/);
  });

  test("STC_RECORDINGS_DIR overrides it, so tests need not litter the Desktop", () => {
    expect(takesRoot({ STC_RECORDINGS_DIR: "/somewhere/else" })).toBe("/somewhere/else");
  });

  test("take directories are timestamped, sortable and collision-free", () => {
    const at = new Date("2026-08-24T15:11:32");
    expect(newTakeDir({}, at)).toBe(join(homedir(), "Desktop", "stc", "2026-08-24_15-11-32"));
    // a second take in the same second must not reuse the directory
    const a = newTakeDir({ STC_RECORDINGS_DIR: "/r" }, at);
    const b = newTakeDir({ STC_RECORDINGS_DIR: "/r" }, at, ["2026-08-24_15-11-32"]);
    expect(b).not.toBe(a);
    expect(b).toMatch(/2026-08-24_15-11-32-2$/);
  });
});
