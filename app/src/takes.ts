import { homedir } from "node:os";
import { writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * Is `dir` a real directory INSIDE the recordings root?
 *
 * `dir.startsWith(root)` is not that test, and was used for it in five places.
 * It has two holes, both reachable from a renderer-supplied string:
 *
 * - `<root>/../../../../tmp/evil` starts with the root and `join` resolves it
 *   to `/tmp/evil`. On the read paths that leaks a file; on `still:export`,
 *   which CREATES directories and writes an image, it plants one.
 * - `<root>-other` starts with the root too, and is a different folder
 *   entirely.
 *
 * Resolving first closes the traversal, and comparing against a
 * separator-terminated prefix closes the sibling. The root ITSELF is refused:
 * every caller wants a take inside it, never the folder holding them all.
 */
export function insideTakesRoot(env: NodeJS.ProcessEnv, dir: string): boolean {
  if (typeof dir !== "string" || dir.length === 0) return false;
  const root = resolve(takesRoot(env));
  const target = resolve(dir);
  return target !== root && (target + sep).startsWith(root + sep);
}

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

export const MAX_LABEL_LENGTH = 120;

/**
 * Names a take without renaming its directory.
 *
 * The directory name is a timestamp, and it is both the take's identity and the
 * sort key. Renaming it would scramble chronological order, break any open
 * preview, and invalidate paths already handed out for exports — so the label
 * lives beside the recording instead.
 */
export async function setTakeLabel(env: NodeJS.ProcessEnv, dir: string, label: string): Promise<void> {
  const root = takesRoot(env);
  if (!dir.startsWith(root)) throw new Error("refusing to label a directory outside the recordings folder");
  const trimmed = label.trim();
  if (!trimmed) throw new Error("a label cannot be empty");
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new Error(`label is too long (max ${MAX_LABEL_LENGTH} characters)`);
  }
  await writeFile(join(dir, "take.json"), JSON.stringify({ version: 1, label: trimmed }, null, 2));
}
