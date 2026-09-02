import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const bytes = (p: string) => readFileSync(join(root, p));

/**
 * fixtures/pip is fixtures/basic plus a camera track, and
 * app/test/camera-toggle.e2e.test.ts DEPENDS on that: it previews both at the
 * same t and requires every pixel outside the PiP rectangle to be identical,
 * so that any difference inside it IS the PiP. That premise lived only in a
 * comment, and STC-239 broke it — cursor-shape events were added to basic's
 * events.json alone, the basic take showed an I-beam at 2 s where the pip take
 * showed the arrow, and the E2E test failed on CI with "fixtures have drifted"
 * after a two-minute Electron run. Cheaper to say it here, in milliseconds.
 */
describe("fixtures/pip is fixtures/basic plus a camera track", () => {
  test.each(["events.json", "frames.json", "display.mp4"])("%s is byte-identical between the two", (f) => {
    expect(bytes(`fixtures/pip/${f}`).equals(bytes(`fixtures/basic/${f}`)),
      `fixtures/basic/${f} and fixtures/pip/${f} differ — edit both, or the camera-toggle E2E ` +
      "test's outside-the-PiP comparison compares two different takes").toBe(true);
  });
});
