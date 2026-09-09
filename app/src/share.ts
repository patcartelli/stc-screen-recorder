/**
 * Getting an exported take out of the app and onto the site (STC-242).
 *
 * The last step of the product loop — record → preview → export → **share** —
 * and the smallest one, because the ticket shrank it deliberately once the
 * destination was decided: "no upload, no auth model, no third-party service".
 * The video is an MP4 embedded on a page in the Astro site repo, so sharing is
 * a file copy plus knowing where to put it.
 *
 * Pure and node-free, on the split this repo uses everywhere
 * (`selection.ts`/`overlay-session.ts`, `thumbnail.ts`/`thumbnail-window.ts`,
 * `still-decorate.ts`/`still-render.ts`). Everything decidable is decided here
 * where a test can read it; `main.ts` does the copying and the revealing and
 * decides nothing.
 *
 * ## What this is NOT
 *
 * Not an uploader. `planPublish` names a destination on the local disk and
 * stops. Publishing to the web is `git push` in the site repo, by a person who
 * can look at the diff first — which is the right amount of ceremony for
 * putting a video on your own portfolio, and is why the ticket says a copy is
 * enough for v1.
 */

/**
 * A published file is named from a STABLE SLUG, never from the take.
 *
 * This is the decision the ticket does not state and the one that matters
 * most. The export in the take directory is `export-<take timestamp>.mp4`,
 * which is right there — it names which recording it came from. It is exactly
 * wrong on the site: the page embeds a fixed path, so a timestamped name would
 * mean editing the page every time the demo is re-recorded, and STC-313 says
 * the Music Network take is "re-recordable, which makes it the test article
 * for every phase after this one". A demo that costs a page edit to re-shoot
 * is a demo nobody re-shoots.
 *
 * So the site gets `network.mp4` and keeps getting it. Re-publishing REPLACES,
 * which is the intended behaviour rather than an accident — see `planPublish`
 * for what is done about the fact that it is still an overwrite.
 */
export const DEFAULT_SLUG = "network";

/**
 * What a slug may contain, and why it is this narrow.
 *
 * It becomes a filename AND part of a public URL, so it is lowercase (URLs
 * are), has no spaces or dots (a dot would let a slug carry its own extension
 * and land two of them), and cannot traverse — `..` fails the pattern on the
 * dot alone, but the anchors are what make that true rather than a coincidence
 * of the character class.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function slugIsValid(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/**
 * The names the export writes into the take directory.
 *
 * Here rather than inline in `renderer.ts`, and that is not tidying. The
 * renderer built `export-${name}.mp4` as a template literal and the publish
 * path has to find that exact file afterwards — two copies of one filename
 * rule, in different processes, which is the "one value, two copies" defect
 * CLAUDE.md records fixing four times in a single session. `share.test.ts`
 * greps the renderer to keep it that way.
 */
export function exportMediaName(takeName: string): string {
  return `export-${takeName}.mp4`;
}

/** The manifest beside it (STC-308) — which transform produced the video. */
export function exportManifestName(takeName: string): string {
  return `export-${takeName}.json`;
}

/** Where the published file lands, and under what name. */
export interface PublishTarget {
  /** Absolute path of the exported MP4 inside the take directory. */
  from: string;
  /** Absolute path it is copied to. */
  to: string;
  /** The leaf name at the destination — the stable, slug-derived one. */
  name: string;
}

/**
 * Why a publish cannot proceed.
 *
 * Refusals with reasons rather than defaults, the rule `parseShot` follows:
 * every one of these is a thing the user has to decide, and quietly picking
 * for them is how a video ends up somewhere nobody looks.
 */
export type PublishPlan =
  | ({ kind: "ready" } & PublishTarget)
  | { kind: "no-destination"; message: string }
  | { kind: "no-export"; message: string; expected: string }
  | { kind: "bad-slug"; message: string };

export interface PublishRequest {
  /** The take's directory name, e.g. `2026-09-09_14-22-05`. */
  takeName: string;
  /** The take's absolute directory, where the export was written. */
  takeDir: string;
  /** Whether the exported MP4 is actually there. Main stats it; this decides. */
  exportExists: boolean;
  /** The configured site folder, or null when the user has not chosen one. */
  destination: string | null;
  slug: string;
}

/**
 * Everything a publish needs to know, decided in one place.
 *
 * The order of the checks is deliberate: slug before destination before
 * export, cheapest and most-likely-misconfigured first, so the first run tells
 * you the thing you most need to fix rather than the last one.
 */
export function planPublish(req: PublishRequest): PublishPlan {
  if (!slugIsValid(req.slug)) {
    return {
      kind: "bad-slug",
      message: `"${req.slug}" is not a usable name. Lowercase letters, digits ` +
        "and hyphens only — it becomes both a filename and part of the URL.",
    };
  }
  if (!req.destination) {
    return {
      kind: "no-destination",
      message: "Choose the folder in the site repo that holds the video first.",
    };
  }
  const expected = exportMediaName(req.takeName);
  if (!req.exportExists) {
    return {
      kind: "no-export",
      message: "This take has not been exported yet — export it, then share.",
      expected,
    };
  }
  const name = `${req.slug}.mp4`;
  return {
    kind: "ready",
    from: joinPath(req.takeDir, expected),
    to: joinPath(req.destination, name),
    name,
  };
}

/**
 * Path joining without `node:path`, because this module is in the browser
 * typecheck pass (`tsconfig.browser.json`) — the renderer imports the plan
 * types to render the refusal messages, and a node import here would make the
 * whole module node-only, which is the failure STC-294 hit with
 * `library-items.ts`.
 *
 * macOS only, which the whole app is; a single separator is the whole rule.
 */
function joinPath(dir: string, leaf: string): string {
  return dir.endsWith("/") ? `${dir}${leaf}` : `${dir}/${leaf}`;
}

/**
 * The embed snippet, SETTLED against the real site (STC-313).
 *
 * STC-242 left this provisional and said why: the ticket gates it on "once the
 * site's video component shape is settled", and it could not be settled from a
 * repo with no sight of the site. It has been settled now by reading
 * `patcartelli/studio-cartelli`, and the answer is not the shape anyone
 * expected — **what a viewer pastes is not an HTML tag at all.**
 *
 * The site renders lab demos from a DATA MODULE (`src/data/lab-demos.ts`) that
 * a component reads; a page says `<LabVideo demo={labDemos.network} />` and
 * nothing else. So a `<video …>` tag pasted into `network.astro` would be a
 * second way to put a video on that page, bypassing the build check that
 * refuses a published demo whose file is missing. The snippet is the data
 * entry instead, which is the thing there is actually a blank for.
 *
 * `{poster}` is deliberately a token `embedSnippet` does not know, so it comes
 * through unsubstituted — as do `label` and `caption`, which are prose only a
 * person can write. An obviously unfilled blank is the point: this snippet is
 * a starting point for an edit, not a finished line to drop in.
 *
 * Still a PREFERENCE, so a site that later grows a real component needs no
 * code change here.
 */
export const DEFAULT_EMBED_TEMPLATE =
  "  {slug}: {\n" +
  "    src: '{src}',\n" +
  "    poster: '{poster}',\n" +
  "    width: {width},\n" +
  "    height: {height},\n" +
  "    label: '{label}',\n" +
  "    caption: '{caption}',\n" +
  "    published: true,\n" +
  "  },";

export interface EmbedTokens {
  /** The public path the site will serve the file from. */
  src: string;
  slug: string;
  /**
   * What the export actually encoded — `undefined` when that is not known.
   *
   * Undefined rather than a fallback number, and the snippet keeps `{width}`
   * visibly unsubstituted in that case. A zero here would paste `width="0"`
   * into somebody's page, which is a wrong answer wearing the costume of a
   * real one; an unreplaced token is obviously a blank to fill in.
   */
  width?: number;
  height?: number;
}

/**
 * Token substitution, and deliberately nothing more.
 *
 * `{src}`, `{width}`, `{height}`, `{slug}`. Two things are LEFT ALONE rather
 * than blanked — a token this does not know (a template mentioning `{poster}`
 * before posters exist), and a known token whose value is undefined. Same
 * reason for both: a snippet that is missing something should look missing in
 * the paste, not silently lose an attribute and read as complete.
 */
export function embedSnippet(template: string, tokens: EmbedTokens): string {
  return template.replace(/\{(src|width|height|slug)\}/g, (m, key: string) => {
    const v = tokens[key as keyof EmbedTokens];
    return v === undefined ? m : String(v);
  });
}

/**
 * Where the site will serve the published file from, derived from the slug it
 * was published under, so the snippet cannot name a path the copy did not
 * write.
 *
 * **This was wrong until STC-313 checked it against the real site.** The
 * original assumed the destination was served at `/<slug>/` and produced
 * `/lab/network/network.mp4` — the slug twice, and a `public/lab/network/`
 * directory sharing a name with `/lab/network`, which is a live SSR route on
 * that site. STC-242's runbook named this as the most likely thing to be
 * wrong, and its predicted symptom exactly: a snippet whose `src` 404s while
 * the file sits in the folder the user chose.
 *
 * The destination folder is `<site>/public/lab/videos` and Astro serves
 * `public/` at the root, so the file is at `/lab/videos/<slug>.mp4`. Verified
 * against a dev server: 200, `video/mp4`.
 *
 * `srcBase` is still the override, because the folder is picked by hand and
 * nothing here can check that the user picked the one this names.
 */
export function publicSrc(slug: string, srcBase = "/lab/videos"): string {
  const base = srcBase.endsWith("/") ? srcBase.slice(0, -1) : srcBase;
  return `${base}/${slug}.mp4`;
}
