/**
 * The floating thumbnail's right-click menu (STC-296 follow-up) — pure, so
 * every label, every ordering and every enabled state is decided where
 * `app/test/thumbnail-menu.test.ts` can look at it.
 *
 * Same reasoning as `tray-menu.ts`, and for the same reason: nothing in
 * Electron reads a `Menu` back once it has been popped up, so a template
 * checked here and handed over verbatim is the only version of this that can
 * be tested at all. What is left for a person is whether the menu appears
 * under the pointer and reads well — which no test could have claimed.
 *
 * ## Delete moves to the Trash, and does NOT confirm
 *
 * `main.ts`'s take deletion puts a modal in front of `shell.trashItem`, and
 * that is right THERE: a recording is minutes of work and the library is a
 * place you browse, where a mis-click is plausible. A shot whose panel is
 * still on screen is two seconds old and the pointer is already on it. A
 * confirm on top of an action the Trash already makes reversible is friction
 * bought with nothing, so this deletes straight away — and to the Trash, never
 * `rm`, so "straight away" is still recoverable.
 *
 * This is also the semantic the swipe-to-discard gesture must share. Two ways
 * to throw a shot away that disagree about where it goes would be the defect,
 * not the second gesture.
 *
 * ## Delete has to cancel the settle, not race it
 *
 * A panel that is still `showing` has a timer that will compositeand export
 * the shot (`thumbnail-window.ts`). Deleting the capture directory without
 * stopping that timer would export a shot the user has just thrown away — or
 * fail halfway through and report an error for a file they deliberately
 * removed. The menu says what was chosen; the caller is responsible for
 * clearing the timer BEFORE it trashes anything.
 */

export type ThumbMenuId =
  | "copy"
  | "save-as"
  | "redact"
  | "reveal"
  | "delete"
  | "separator";

export interface ThumbMenuItem {
  id: ThumbMenuId;
  type?: "separator";
  label?: string;
  enabled?: boolean;
}

export interface ThumbMenuContext {
  /**
   * Redact mode is open right now. The item is a TOGGLE rather than a
   * checkbox: "Redact" while already redacting reads as "start again", which
   * is not what choosing it does.
   */
  redacting?: boolean;
  /**
   * A composite or export is already in flight. Copy and Save As are refused
   * while one is, so they are shown unavailable rather than offered and then
   * declined — the same courtesy `trayTemplate` extends to a capture that
   * would be refused as `overlay-open`.
   */
  busy?: boolean;
}

/**
 * The five actions the ticket names, in the order a macOS menu puts them:
 * the two that produce something, then the one that changes what would be
 * produced, then the one that shows you where it is, then the destructive one
 * — last, and behind a separator, because it is the only item here that
 * cannot be undone by choosing again.
 */
export function thumbnailMenuTemplate(ctx: ThumbMenuContext = {}): ThumbMenuItem[] {
  const busy = ctx.busy === true;
  return [
    { id: "copy", label: "Copy", enabled: !busy },
    // The ellipsis is not decoration: macOS spells "this opens a dialog" that
    // way, and Copy vs Save As differ in exactly that.
    { id: "save-as", label: "Save As…", enabled: !busy },
    { id: "separator", type: "separator" },
    { id: "redact", label: ctx.redacting ? "Done Redacting" : "Redact…", enabled: true },
    { id: "reveal", label: "Reveal in Finder", enabled: true },
    { id: "separator", type: "separator" },
    { id: "delete", label: "Delete", enabled: true },
  ];
}
