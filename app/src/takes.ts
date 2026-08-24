import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where recordings live.
 *
 * Deliberately NOT os.tmpdir(): on macOS that is /var/folders/.../T, which the
 * system purges on boot and sweeps for files untouched for ~3 days. A take is
 * the thing the user made — it is a deliverable, not scratch, and must not sit
 * somewhere it can silently disappear.
 */
export function takesRoot(env: NodeJS.ProcessEnv): string {
  return env.STC_RECORDINGS_DIR || join(homedir(), "Desktop", "stc");
}

function stamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}_` +
         `${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}`;
}

/**
 * Timestamped so takes sort chronologically by name. `existing` guards the
 * one-second collision: two takes started in the same second must not share a
 * directory, or the second would overwrite the first's display.mp4.
 */
export function newTakeDir(env: NodeJS.ProcessEnv, at: Date = new Date(),
                           existing: string[] = []): string {
  const root = takesRoot(env);
  const base = stamp(at);
  let name = base;
  for (let n = 2; existing.includes(name); n++) name = `${base}-${n}`;
  return join(root, name);
}
