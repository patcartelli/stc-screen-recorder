import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { writeFile, readdir, mkdir, copyFile, stat } from "node:fs/promises";
import { join, resolve, sep, basename } from "node:path";

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

/**
 * Destination names a duplicate has claimed but not yet finished writing
 * (STC-345).
 *
 * `newTakeDir`'s uniqueness check reads the filesystem, and that read and the
 * eventual `mkdir` are two different moments — a second duplicate racing in
 * the gap (a quick double-click, or Duplicate pressed on two different tiles
 * inside the same second) sees the same, still-stale listing and computes the
 * SAME destination. `mkdir(..., {recursive:true})` does not throw when the
 * directory already exists, so both calls would go on to copy into it — two
 * unrelated shots' files interleaving in one directory, silently, since the
 * result still parses as SOME shot. Same race this repo has already paid for
 * twice (`still-io.ts`'s exported filenames, STC-296's stacking claim), and
 * the fix is the same shape: claim the name in-process before anything async,
 * release it in a `finally`. Module-level rather than per-call because the
 * whole point is to be visible to the OTHER concurrent call.
 */
const duplicating = new Set<string>();

/**
 * Copy a take's directory to a fresh one, minus its cached thumbnail
 * (STC-345's fix; the duplicate action itself is STC-294's).
 *
 * The whole directory otherwise: the copy's decoration is about to diverge
 * from the original, so carrying its cached picture over would show the OLD
 * decoration under the NEW document until something happened to redraw it —
 * a cache that lies is worse than one that is cold.
 *
 * `thumbnailFile` is a parameter rather than an import so this module stays
 * what it already is, a plain node module with no dependency on the library's
 * item contract; the caller already knows the name.
 */
export async function duplicateTake(env: NodeJS.ProcessEnv, dir: string,
                                    thumbnailFile: string): Promise<string> {
  const root = takesRoot(env);
  const existing = existsSync(root) ? await readdir(root) : [];
  const dest = newTakeDir(env, new Date(), [...existing, ...duplicating]);
  const name = basename(dest);
  duplicating.add(name);
  try {
    await mkdir(dest, { recursive: true });
    for (const entry of await readdir(dir)) {
      if (entry === thumbnailFile) continue;
      const from = join(dir, entry);
      if (!(await stat(from)).isFile()) continue;
      await copyFile(from, join(dest, entry));
    }
    return dest;
  } finally {
    duplicating.delete(name);
  }
}
