import { mkdtempSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..", "..");

/**
 * A complete, committed session fixture, copied into a temp recordings folder.
 *
 * These tests used to reach into ~/Desktop/stc for whatever real recording
 * happened to be there. That made the suite depend on the developer's Desktop —
 * it broke the moment those takes were deleted, and CI could never run it at
 * all. The gates still default to a real take, which is where 4K and real
 * capture behaviour get exercised; the E2E tests only need a valid session to
 * verify wiring, and a 90-frame 640x360 fixture does that in a fraction of the
 * time.
 */
export function makeTakeFolder(takeName = "2026-08-24_10-00-00"): { dir: string; takeDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "stc-takes-"));
  const takeDir = join(dir, takeName);
  mkdirSync(takeDir, { recursive: true });
  for (const f of ["anchors.json", "events.json", "display.mp4"]) {
    cpSync(join(root, "fixtures", "basic", f), join(takeDir, f));
  }
  return { dir, takeDir };
}
