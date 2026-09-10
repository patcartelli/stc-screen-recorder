/**
 * Every project document version this build can read — the ONE list (STC-318).
 *
 * ## Why this is its own module with no imports
 *
 * The list has to be readable from BOTH the transform and the Electron main
 * process, and `trim.ts` cannot be: it reaches `transform-version.ts` and so
 * `cursor-art.ts`, which is DOM-typed. Importing `trim.ts` into `main.ts`
 * makes `tsconfig.node.json` fail with `Cannot find name 'CanvasGradient'` —
 * the no-DOM guard working exactly as designed, and the reason this is four
 * lines in a file of its own rather than an export added to a bigger one.
 *
 * ## What it is fixing
 *
 * There were TWO hand-rolled chains: one in `parseProject` and one in
 * `main.ts`'s `preview:writeProject` gate. The second carried a comment
 * claiming it "cannot share a constant with the transform's" — untrue, and it
 * also recorded that the pair had already drifted once, when project-2 was
 * minted: main rejected every document the renderer wrote and `project.json`
 * silently never appeared.
 *
 * It drifted again the same way. `project-4` shipped, `main.ts` still stopped
 * at 3, and for a day a take with a non-default zoom could not be saved AT
 * ALL. Nothing could see it — the unit tests never cross that process line,
 * and every document the E2E tests happened to write was a v3.
 *
 * `project-version-seam.test.ts` refuses a third copy.
 */
export const PROJECT_VERSIONS = [1, 2, 3, 4, 5] as const;

export type ProjectVersion = (typeof PROJECT_VERSIONS)[number];

export function isProjectVersion(v: unknown): v is ProjectVersion {
  return (PROJECT_VERSIONS as readonly unknown[]).includes(v);
}
