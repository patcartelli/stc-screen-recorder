import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * The camera-shutter sound (STC-292).
 *
 * A capture started from a global hotkey has no window and, for a full-display
 * shot, no overlay either: without a sound the user has no evidence anything
 * happened at all. macOS's own screenshot makes exactly one noise, and the
 * ticket's requirement is that this one behaves the same way — which means
 * honouring the setting that governs it rather than inventing a preference.
 *
 * ## Whose setting
 *
 * There is no per-app screenshot-sound switch on macOS; the shutter follows
 * "Play user interface sound effects" (`com.apple.sound.uiaudio.enabled` in
 * NSGlobalDomain) and plays at the alert volume
 * (`com.apple.sound.beep.volume`). Both are read from `defaults` at each
 * capture rather than cached: the user may have just turned it off, and
 * "honours the setting" is worth a 20 ms subprocess on a path that already
 * cost a screen capture.
 *
 * ## Why a subprocess at all
 *
 * Electron's only built-in noise is `shell.beep()`, which is the alert bell,
 * not the shutter. `afplay` is the shortest route to the system's own sound
 * file with no native module and no bundled audio asset — and the sound file
 * is the system's, so a macOS that moves it results in silence rather than in
 * a substitute noise the user did not choose.
 *
 * Every wait here is bounded and every failure is silent-but-named: a sound is
 * never worth failing a capture over, and a capture that succeeded must not
 * report an error because the speaker did not cooperate.
 */

/**
 * Where macOS keeps the screen-capture sound.
 *
 * A list rather than a constant because it has moved between releases, and the
 * failure mode of guessing wrong is silence — which is indistinguishable from
 * the user having turned the sound off, and therefore worth being able to see
 * in the outcome.
 */
export const SHUTTER_SOUND_CANDIDATES: readonly string[] = [
  "/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/Grab.aif",
  "/System/Library/Components/CoreAudio.component/Contents/Resources/SystemSounds/system/Grab.aif",
  "/System/Library/Sounds/Grab.aiff",
];

/** How long `afplay` may live. The sound is ~0.3 s; anything still running at
 * this point is wedged, and a wedged one per capture would accumulate. */
export const SHUTTER_PLAY_MS = 5_000;

/** How long a `defaults read` may take before its answer is treated as absent. */
export const SHUTTER_DEFAULTS_MS = 1_000;

export type ShutterOutcome =
  | "played"
  | "off"            // the user turned UI sound effects off
  | "silent"         // alert volume is zero
  | "no-sound-file"  // this macOS does not keep the sound where we look
  | "suppressed"     // STC_NO_SHUTTER, for tests and for a headless CI
  | "failed";

export interface ShutterDecision {
  play: boolean;
  outcome: ShutterOutcome;
  /** 0..1, or undefined to let `afplay` use its own default. */
  volume?: number;
}

/**
 * Pure: the two `defaults` answers → whether to make a noise and how loud.
 *
 * An ABSENT key means the user has never changed the setting, which on macOS
 * means the default — sound effects on. Treating "no answer" as "off" would
 * silently disable the feature on a clean install, which is the machine the
 * ticket's acceptance criterion describes.
 */
export function decideShutter(o: {
  uiAudio?: string | undefined;
  alertVolume?: string | undefined;
  suppressed?: boolean;
}): ShutterDecision {
  if (o.suppressed) return { play: false, outcome: "suppressed" };
  const enabled = o.uiAudio === undefined ? true : o.uiAudio.trim() !== "0";
  if (!enabled) return { play: false, outcome: "off" };
  const raw = o.alertVolume === undefined ? undefined : Number(o.alertVolume.trim());
  if (raw !== undefined && Number.isFinite(raw)) {
    if (raw <= 0) return { play: false, outcome: "silent" };
    return { play: true, outcome: "played", volume: Math.min(1, raw) };
  }
  return { play: true, outcome: "played" };
}

/** Pure: the first candidate that is actually on this machine. */
export function pickShutterSound(
  exists: (path: string) => boolean,
  candidates: readonly string[] = SHUTTER_SOUND_CANDIDATES,
): string | undefined {
  return candidates.find(exists);
}

/** Pure: the `afplay` argument list. Volume is omitted when unknown. */
export function shutterArgs(file: string, volume?: number): string[] {
  return volume === undefined ? [file] : ["-v", String(volume), file];
}

export interface ShutterDeps {
  env: Record<string, string | undefined>;
  /**
   * Injected rather than read from `process` so the whole decision runs on any
   * machine. A `skipIf(platform !== "darwin")` would leave the interesting
   * half of this file unrun on a Linux checkout — a skip that reads as covered
   * and rots, which this repo has paid for before.
   */
  platform: string;
  exists: (path: string) => boolean;
  /** `defaults read -g <key>`, or undefined when the key is not set. */
  readDefault: (key: string) => Promise<string | undefined>;
  /** Runs the player. `bin` is the executable, `args` the sound file and its
   * volume — kept as two arguments so a test can assert on both. */
  play: (bin: string, args: string[]) => Promise<void>;
}

const defaultDeps: ShutterDeps = {
  env: process.env,
  platform: process.platform,
  exists: existsSync,
  readDefault: (key) => run("defaults", ["read", "-g", key], SHUTTER_DEFAULTS_MS)
    .then((s) => s.trim() === "" ? undefined : s)
    .catch(() => undefined),
  play: (bin, args) => run(bin, args, SHUTTER_PLAY_MS).then(() => undefined),
};

function run(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, killSignal: "SIGKILL" }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout));
    });
  });
}

/**
 * Makes the noise, or says why it did not. Never rejects.
 *
 * Callers do not await this on the capture's critical path — the shot is
 * already on disk by the time it is called — but it resolves rather than
 * detaching so a test can assert on the outcome instead of on a sleep.
 */
export async function playShutter(deps: Partial<ShutterDeps> = {}): Promise<ShutterOutcome> {
  const d: ShutterDeps = { ...defaultDeps, ...deps };
  const suppressed = d.env.STC_NO_SHUTTER === "1" || d.platform !== "darwin";
  const [uiAudio, alertVolume] = suppressed
    ? [undefined, undefined]
    : await Promise.all([
        d.readDefault("com.apple.sound.uiaudio.enabled"),
        d.readDefault("com.apple.sound.beep.volume"),
      ]);
  const decision = decideShutter({ uiAudio, alertVolume, suppressed });
  if (!decision.play) return decision.outcome;

  const file = d.env.STC_SHUTTER_SOUND ?? pickShutterSound(d.exists);
  if (!file || !d.exists(file)) return "no-sound-file";
  try {
    await d.play("/usr/bin/afplay", shutterArgs(file, decision.volume));
    return "played";
  } catch {
    return "failed";
  }
}
