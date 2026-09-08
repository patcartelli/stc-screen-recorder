import { describe, test, expect } from "vitest";
import {
  SHUTTER_SOUND_CANDIDATES, decideShutter, pickShutterSound, playShutter, shutterArgs,
  type ShutterDeps,
} from "../src/shutter.js";

/**
 * The camera-shutter sound (STC-292).
 *
 * A hotkey capture of a whole display puts nothing on screen at all, so the
 * sound is the ONLY evidence the user gets — which makes "when is it silent"
 * the thing worth testing. Whether it is audible on a real Mac, and whether it
 * follows the setting the user actually flips in System Settings, is the
 * runbook's; what is settled here is that every silence is a DECISION with a
 * name, rather than a swallowed failure.
 */

const deps = (o: Partial<ShutterDeps> = {}): Partial<ShutterDeps> => ({
  env: {},
  platform: "darwin",
  exists: () => true,
  readDefault: async () => undefined,
  play: async () => {},
  ...o,
});

describe("deciding", () => {
  test("an unset key means the macOS default, which is ON", () => {
    // Treating "no answer" as "off" would silently disable the sound on a
    // clean install — the very machine the acceptance criterion describes.
    expect(decideShutter({})).toMatchObject({ play: true });
  });

  test("the user's UI-sound setting is honoured, and named when it is off", () => {
    expect(decideShutter({ uiAudio: "0" })).toEqual({ play: false, outcome: "off" });
    expect(decideShutter({ uiAudio: "1" })).toMatchObject({ play: true });
    expect(decideShutter({ uiAudio: " 0\n" })).toEqual({ play: false, outcome: "off" });
  });

  test("the alert volume becomes the playback volume", () => {
    expect(decideShutter({ alertVolume: "0.5" })).toEqual({ play: true, outcome: "played", volume: 0.5 });
    // Clamped: `afplay -v` above 1 amplifies, which the alert volume never means.
    expect(decideShutter({ alertVolume: "3" })).toMatchObject({ volume: 1 });
  });

  test("a zero alert volume is silence with a name, not a zero-volume play", () => {
    expect(decideShutter({ alertVolume: "0" })).toEqual({ play: false, outcome: "silent" });
  });

  test("an unparseable volume falls back to afplay's own default rather than to silence", () => {
    expect(decideShutter({ alertVolume: "banana" })).toEqual({ play: true, outcome: "played" });
  });

  test("suppression wins over everything and says so", () => {
    expect(decideShutter({ suppressed: true, uiAudio: "1", alertVolume: "1" }))
      .toEqual({ play: false, outcome: "suppressed" });
  });
});

describe("the sound file", () => {
  test("the first candidate that exists is the one used", () => {
    const second = SHUTTER_SOUND_CANDIDATES[1]!;
    expect(pickShutterSound((p) => p === second)).toBe(second);
  });

  test("a macOS that keeps it nowhere we look yields undefined, not a guess", () => {
    expect(pickShutterSound(() => false)).toBeUndefined();
  });

  test("the volume is omitted when it is unknown, rather than invented", () => {
    expect(shutterArgs("/x.aif")).toEqual(["/x.aif"]);
    expect(shutterArgs("/x.aif", 0.25)).toEqual(["-v", "0.25", "/x.aif"]);
  });
});

describe("playing", () => {
  test("plays the system sound at the alert volume", async () => {
    const calls: Array<[string, string[]]> = [];
    const outcome = await playShutter(deps({
      env: { STC_SHUTTER_SOUND: "/tmp/grab.aif" },
      readDefault: async (k) => k.endsWith("beep.volume") ? "0.5" : "1",
      play: async (bin, args) => { calls.push([bin, args]); },
    }));
    expect(outcome).toBe("played");
    expect(calls).toEqual([["/usr/bin/afplay", ["-v", "0.5", "/tmp/grab.aif"]]]);
  });

  test("plays nothing, and says why, when the user turned the sound off", async () => {
    let played = false;
    const outcome = await playShutter(deps({
      env: { STC_SHUTTER_SOUND: "/tmp/grab.aif" },
      readDefault: async (k) => k.endsWith("uiaudio.enabled") ? "0" : "1",
      play: async () => { played = true; },
    }));
    expect(outcome).toBe("off");
    expect(played).toBe(false);
  });

  test("a missing sound file is reported, not treated as success", async () => {
    const outcome = await playShutter(deps({ exists: () => false }));
    expect(outcome).toBe("no-sound-file");
  });

  test("a player that fails never rejects — a capture is not lost to a speaker", async () => {
    const outcome = await playShutter(deps({
      env: { STC_SHUTTER_SOUND: "/tmp/grab.aif" },
      play: async () => { throw new Error("afplay: no audio device"); },
    }));
    expect(outcome).toBe("failed");
  });

  test("STC_NO_SHUTTER suppresses it without consulting anything", async () => {
    // The E2E suite and CI set this. It must short-circuit BEFORE `defaults`,
    // or a headless runner pays for two subprocesses per capture to be told no.
    let asked = 0;
    const outcome = await playShutter(deps({
      env: { STC_NO_SHUTTER: "1" },
      readDefault: async () => { asked++; return "1"; },
    }));
    expect(outcome).toBe("suppressed");
    expect(asked).toBe(0);
  });

  test("off macOS it is suppressed rather than attempted", async () => {
    // `defaults` and `afplay` are macOS binaries; this is what keeps a Linux
    // developer machine from a spawn failure per capture. Driven through the
    // injected platform so this runs on macOS too, rather than being a skip
    // that reads as covered on whichever machine is not looking.
    let asked = 0;
    expect(await playShutter(deps({
      platform: "linux",
      readDefault: async () => { asked++; return "1"; },
    }))).toBe("suppressed");
    expect(asked).toBe(0);
  });
});
