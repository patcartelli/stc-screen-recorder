import type { LibraryActionId, LibraryItem, LibraryList } from "./library-items.js";

/**
 * The library grid. Draws what the adapter hands it and decides nothing
 * (STC-294).
 *
 * ## Why this is its own file
 *
 * The ticket's fourth acceptance criterion is *"no view component branches on
 * kind outside the adapter"*, and `app/test/library-seam.test.ts` enforces it by
 * grepping. Grepping `renderer.ts` for `.kind` does not work: that file already
 * has an unrelated one — a capture RESULT's shot kind (`display-crop` /
 * `window`) in the status line — and a guard that fires on legitimate code is a
 * guard someone turns off within a day. So the library's view is a module of
 * its own, which must never mention kind at all, and the grep is exact.
 *
 * That is not a trick to satisfy a test. It is the criterion's own logic: if
 * the view can be written without knowing what kinds exist, the seam really is
 * in one place, and the way to be sure is to put the view somewhere the word
 * cannot appear.
 *
 * ## What it therefore may not do
 *
 * No "if this is a still". The badge is text the adapter wrote, the summary is
 * a string it composed, the buttons are a list it chose, and the filter chips
 * are data it supplied. When something here needs a fact this module cannot
 * see, the instruction from the ticket is to widen `LibraryItem` deliberately —
 * never to reach for the kind at the call site.
 */

/** Everything the view needs done for it. Each is the shared UI's one door. */
export interface LibraryCallbacks {
  /** A tile's button was pressed. Dispatched by action id — never by kind. */
  act(id: LibraryActionId, item: LibraryItem): void | Promise<void>;
  /** A rename was committed with a non-empty, changed value. */
  rename(item: LibraryItem, label: string): void | Promise<void>;
  /** A filter chip was chosen. */
  setFilter(id: string): void | Promise<void>;
  /**
   * Put a picture in this tile.
   *
   * Called only for items whose thumbnail the adapter said exists or can be
   * made; the view neither knows nor asks which kinds those are. Failure is
   * the caller's to swallow — a thumbnail that cannot be drawn must cost the
   * tile its picture and nothing else.
   */
  paintThumbnail(item: LibraryItem, img: HTMLImageElement): void | Promise<void>;
}

/**
 * Tiles are painted when they scroll into view, never all at once.
 *
 * The acceptance criterion is *"a library containing 500 mixed takes scrolls at
 * 60 fps with decorated thumbnails cached"*, and painting on render would mean
 * 500 IPC reads and — for anything not yet cached — 500 full-size decodes and
 * decoration passes before the first frame. `loading="lazy"` does not help,
 * because the work here is not fetching an `<img src>`; it is producing the
 * picture in the first place.
 *
 * One observer per render pass, disconnected by the next one, so a tile that
 * has scrolled away with work still queued cannot paint into a grid that no
 * longer contains it.
 */
let painting: IntersectionObserver | undefined;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};

function filterBar(list: LibraryList, cb: LibraryCallbacks): HTMLElement {
  const bar = el("div", "libfilters");
  for (const f of list.filters) {
    const chip = el("button", "chip", f.label);
    // `aria-pressed` rather than a class alone: the chips are a single-choice
    // control and a screen reader has no other way to learn which one is on.
    chip.setAttribute("aria-pressed", String(f.id === list.filter));
    if (f.id === list.filter) chip.classList.add("on");
    chip.dataset.filter = f.id;
    chip.addEventListener("click", () => void cb.setFilter(f.id));
    bar.append(chip);
  }
  return bar;
}

/**
 * The picture, or the space where one would be.
 *
 * A tile whose thumbnail has not arrived keeps its box at the same size, so
 * the grid does not reflow as pictures land — 500 tiles reflowing one at a
 * time is the jank the ticket's 60 fps criterion is about, and it costs
 * nothing to avoid by reserving the space up front.
 */
function thumb(item: LibraryItem, cb: LibraryCallbacks): HTMLElement {
  const box = el("div", "libthumb");
  if (item.thumbnail.source === "none") {
    box.classList.add("empty");
    return box;
  }
  const img = el("img");
  img.alt = "";
  img.decoding = "async";
  box.append(img);
  // Deferred until the tile is actually on screen — see `painting`.
  painting?.observe(box);
  box.dataset.paint = "pending";
  paintQueue.set(box, () => Promise.resolve(cb.paintThumbnail(item, img)).catch(() => {
    box.classList.add("empty");
    img.remove();
  }));
  return box;
}

/** What each pending tile should do once it is visible. Cleared with the observer. */
const paintQueue = new WeakMap<HTMLElement, () => Promise<void>>();

function titleFor(item: LibraryItem): HTMLElement {
  const title = el("div", "libtitle");
  // Show the label when there is one, but keep the timestamp visible: it is
  // how the take is identified on disk and in every path the app hands out.
  title.textContent = item.label ? item.label : item.id;
  title.title = item.dir;
  if (item.label) title.append(el("span", "stamp", ` ${item.id}`));
  return title;
}

function renameInto(title: HTMLElement, item: LibraryItem, cb: LibraryCallbacks): void {
  const input = el("input", "labelinput");
  input.type = "text";
  input.value = item.label ?? "";
  input.placeholder = "Name this take";
  input.maxLength = 120;
  let done = false;
  const commit = () => {
    if (done) return;                 // blur fires again after Enter replaces it
    done = true;
    const v = input.value.trim();
    input.replaceWith(title);
    if (v && v !== item.label) void cb.rename(item, v);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { done = true; input.replaceWith(title); }
  });
  input.addEventListener("blur", commit);
  title.replaceWith(input);
  input.focus();
  input.select();
}

function tile(item: LibraryItem, cb: LibraryCallbacks): HTMLElement {
  const card = el("div", "libtile");
  card.dataset.id = item.id;
  // The badge is TEXT, so the tile is drawn the same way whatever it holds.
  // A class derived from it lets CSS colour the two apart without this file
  // knowing there are two.
  const badge = el("span", "libbadge", item.badge);
  badge.dataset.badge = item.badge;

  const title = titleFor(item);
  const body = el("div", "libbody");
  body.append(badge, title, el("div", "meta", item.summary));
  for (const note of item.notes) body.append(el("div", "meta", note));

  const actions = el("div", "libactions");
  for (const a of item.actions) {
    const btn = el("button", a.id === "delete" ? "delete" : undefined, a.label);
    btn.dataset.action = a.id;
    btn.addEventListener("click", () => {
      // Rename is the one action the VIEW owns, because it is an edit in
      // place: everything else is a message to the main process.
      if (a.id === "rename") renameInto(title, item, cb);
      else void cb.act(a.id, item);
    });
    actions.append(btn);
  }

  card.append(thumb(item, cb), body, actions);
  return card;
}

/**
 * Draw the whole library into `host`, replacing whatever was there.
 *
 * Broken takes are shown, not hidden: a take that silently disappears from the
 * list is indistinguishable from one that was deleted. They sit below the grid
 * and outside the filter, because a directory that could not be read has no
 * kind to be filtered by — the one place "which kind is this?" genuinely has
 * no answer, and the view handles it by not asking.
 */
export function renderLibrary(host: HTMLElement, list: LibraryList,
                              cb: LibraryCallbacks): void {
  painting?.disconnect();
  // `rootMargin` paints a screenful ahead, so a tile is ready by the time it
  // arrives rather than popping in after it. IntersectionObserver is absent
  // under some test runners; falling back to painting immediately keeps the
  // pictures correct and only gives up the laziness.
  painting = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries, obs) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const box = e.target as HTMLElement;
          obs.unobserve(box);
          const run = paintQueue.get(box);
          if (run) { box.dataset.paint = "done"; void run(); }
        }
      }, { rootMargin: "200px" })
    : undefined;

  host.textContent = "";
  host.append(filterBar(list, cb));

  if (!list.items.length && !list.invalid.length) {
    const empty = el("div", "libempty", list.filter === "all"
      ? "Nothing here yet."
      : "Nothing of this kind yet.");
    empty.id = "empty";
    host.append(empty);
    return;
  }

  const grid = el("div", "libgrid");
  grid.id = "libgrid";
  for (const item of list.items) grid.append(tile(item, cb));
  host.append(grid);
  // No observer (no IntersectionObserver in this environment): paint the lot,
  // rather than leaving every tile blank forever.
  if (!painting) {
    for (const box of grid.querySelectorAll<HTMLElement>(".libthumb")) {
      const run = paintQueue.get(box);
      if (run) { box.dataset.paint = "done"; void run(); }
    }
  }

  for (const b of list.invalid) {
    host.append(el("div", "broken", `${b.name} — ${b.reason}`));
  }
}
