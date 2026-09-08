/**
 * Global capture shortcuts (STC-292) — the decisions, with no Electron and no
 * DOM.
 *
 * Same arrangement `selection.ts` has for the overlay: everything that DECIDES
 * — what an accelerator string means, whether it is well formed, whether macOS
 * has already claimed it, what the user's keystroke should be recorded as, and
 * how a registration failure is worded — lives here and is exercised by
 * `app/test/hotkeys.test.ts` without a screen, a keyboard or an app. `main.ts`
 * registers what this plans; it does not repeat the reasoning.
 *
 * ## Why registration cannot be the only check
 *
 * `globalShortcut.register` returns false when the binding is already taken,
 * and that IS the authority — but it can only be consulted by trying, and a
 * user rebinding in preferences deserves to be told "the system owns ⌘⇧4"
 * before anything is attempted, rather than watching a field accept a binding
 * that then silently never fires. So there are two gates: this module refuses
 * what is knowably wrong, and `main.ts` reports what registration then refused
 * anyway. The report distinguishes them, because "you cannot have this" and
 * "something on this machine already has this" are different problems with
 * different fixes.
 *
 * ## Why media keys are refused rather than passed through
 *
 * The ticket's permission requirement is that a still capture must work with
 * only Screen Recording granted. Electron registers ordinary accelerators
 * through Carbon's `RegisterEventHotKey`, which needs no Accessibility grant;
 * media keys (Play, Volume, Brightness…) go through a CGEventTap instead,
 * which does. A binding that quietly demands a second permission would fail
 * exactly the acceptance criterion this ticket exists for, so it is refused at
 * the point where the user can still choose something else.
 */

export type CaptureAction = "region" | "window" | "display";

/** Order matters: it is the order preferences lists, and the order duplicate
 * detection resolves in — the first action to claim an accelerator keeps it. */
export const CAPTURE_ACTIONS: readonly CaptureAction[] = ["region", "window", "display"];

export const ACTION_LABELS: Record<CaptureAction, string> = {
  region: "Capture Region",
  window: "Capture Window",
  display: "Capture Full Display",
};

/** `null` is a deliberately unbound action, which is not a failure. */
export type Shortcuts = Record<CaptureAction, string | null>;

/**
 * All four modifiers at once — what a caps-lock "hyperkey" remap sends.
 *
 * Chosen as the default because it is the one combination nothing else on a
 * Mac can plausibly hold: the ticket's requirement is only that the defaults
 * not collide with ⌘⇧3/4/5/6, and every two-modifier combination that clears
 * those is still cheap for some other app to have taken first.
 */
export const HYPER = "Control+Alt+Shift+Command";

export const DEFAULT_SHORTCUTS: Shortcuts = {
  region: `${HYPER}+1`,
  window: `${HYPER}+2`,
  display: `${HYPER}+3`,
};

// ── the accelerator grammar ─────────────────────────────────────────────────

/** Canonical order, so two spellings of one binding compare equal. */
const MODIFIER_ORDER = ["Control", "Alt", "Shift", "Command"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

const MODIFIER_ALIASES: Record<string, Modifier> = {
  command: "Command", cmd: "Command", meta: "Command", super: "Command",
  commandorcontrol: "Command", cmdorctrl: "Command",
  control: "Control", ctrl: "Control",
  alt: "Alt", option: "Alt", opt: "Alt",
  shift: "Shift",
};

/** Named keys Electron accepts that this app is willing to bind. */
const NAMED_KEYS: Record<string, string> = {
  space: "Space", tab: "Tab", backspace: "Backspace", delete: "Delete",
  insert: "Insert", return: "Return", enter: "Return",
  up: "Up", down: "Down", left: "Left", right: "Right",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  escape: "Escape", esc: "Escape", plus: "Plus",
};

/** Punctuation Electron takes literally. */
const PUNCTUATION = new Set(["-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "`"]);

/**
 * Keys Electron can only register through a CGEventTap, which needs an
 * Accessibility grant. Refused by name so the refusal can say why.
 */
const MEDIA_KEYS = new Set([
  "medianexttrack", "mediaprevioustrack", "mediastop", "mediaplaypause",
  "volumeup", "volumedown", "volumemute",
]);

export type ShortcutProblem =
  | "empty"
  | "no-modifier"
  | "no-key"
  | "too-many-keys"
  | "unknown-token"
  | "needs-accessibility"
  | "reserved"
  | "duplicate"
  /** Set by main.ts, never by this module: `globalShortcut.register` said no. */
  | "unavailable";

export type ParsedAccelerator =
  | { ok: true; accelerator: string }
  | { ok: false; problem: Exclude<ShortcutProblem, "duplicate" | "unavailable">; token?: string };

/**
 * Bindings macOS owns.
 *
 * Deliberately SHORT and deliberately not exhaustive — a full map of every
 * system binding would be wrong within one macOS release and would read as
 * authoritative. This is the set worth refusing before the user has pressed
 * anything else: the screenshot family the ticket names, plus the three
 * switchers whose loss would be immediately confusing. Everything else is left
 * to `globalShortcut.register`, which is the real authority and is reported.
 */
export const SYSTEM_CLAIMED: readonly string[] = [
  // Screenshots and their clipboard variants.
  "Command+Shift+3", "Command+Shift+4", "Command+Shift+5", "Command+Shift+6",
  "Control+Command+Shift+3", "Control+Command+Shift+4",
  "Control+Command+Shift+5", "Control+Command+Shift+6",
  // Spotlight, the character/emoji viewer, the app switcher, quit.
  "Command+Space", "Control+Space", "Alt+Command+Space",
  "Control+Command+Space",
  "Command+Tab", "Shift+Command+Tab",
  "Command+Q",
];

/**
 * Normalised at load, not written normalised.
 *
 * The list above reads in Apple's own order (⌘⇧4), which is NOT this module's
 * canonical order (Control, Alt, Shift, Command) — so written as literals the
 * entries matched nothing and every system binding was quietly accepted. Caught
 * by `hotkeys.test.ts` on its first run. Normalising here means the list can be
 * written however it reads best and still be compared against the one form
 * `parseAccelerator` produces.
 */
const claimed = new Set(SYSTEM_CLAIMED.map((a) => {
  const n = normalise(a);
  // A typo in the list would otherwise be an entry that silently never matches
  // — the same failure, one level up.
  if (!n.ok) throw new Error(`SYSTEM_CLAIMED entry is not an accelerator: ${a}`);
  return n.accelerator;
}));

/**
 * `"cmd+shift+A"` → `"Shift+Command+A"`, or the reason it is not a binding.
 *
 * Case-insensitive and alias-tolerant on the way in, canonical on the way out,
 * so a stored preference, a keystroke recorded in the UI and a default all
 * compare as strings.
 */
export function parseAccelerator(input: string): ParsedAccelerator {
  const n = normalise(input);
  if (!n.ok) return n;
  if (claimed.has(n.accelerator)) return { ok: false, problem: "reserved" };
  return n;
}

/** The grammar alone, with no reserved check — which is what builds the
 * reserved set itself, and could not consult it without recursing. */
function normalise(input: string): ParsedAccelerator {
  const raw = String(input ?? "").trim();
  if (raw === "") return { ok: false, problem: "empty" };

  const mods = new Set<Modifier>();
  const keys: string[] = [];
  for (const part of raw.split("+")) {
    const token = part.trim();
    if (token === "") return { ok: false, problem: "unknown-token", token: part };
    const lower = token.toLowerCase();
    const mod = MODIFIER_ALIASES[lower];
    if (mod) { mods.add(mod); continue; }
    if (MEDIA_KEYS.has(lower)) return { ok: false, problem: "needs-accessibility", token };
    const key = canonicalKey(token);
    if (!key) return { ok: false, problem: "unknown-token", token };
    keys.push(key);
  }

  if (keys.length === 0) return { ok: false, problem: "no-key" };
  if (keys.length > 1) return { ok: false, problem: "too-many-keys", token: keys.join("+") };
  // A bare key registered globally would swallow that key for every app on the
  // machine — never what someone means, and not something to let them discover.
  if (mods.size === 0) return { ok: false, problem: "no-modifier" };

  return { ok: true, accelerator: [...MODIFIER_ORDER.filter((m) => mods.has(m)), keys[0]].join("+") };
}

function canonicalKey(token: string): string | undefined {
  const lower = token.toLowerCase();
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower];
  if (/^f([1-9]|1\d|2[0-4])$/.test(lower)) return "F" + lower.slice(1);
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase();
  if (/^[0-9]$/.test(token)) return token;
  if (token.length === 1 && PUNCTUATION.has(token)) return token;
  return undefined;
}

// ── planning a whole set ────────────────────────────────────────────────────

export interface ShortcutPlan {
  action: CaptureAction;
  /** The normalised accelerator when it is bindable; otherwise what was asked
   * for, verbatim, so the UI can show the user their own text back. */
  accelerator: string | null;
  /** `undefined` means bindable. */
  problem?: ShortcutProblem;
  /** The offending token, when there is one worth naming. */
  token?: string;
}

/**
 * What each action would bind to, before anything is registered.
 *
 * Duplicates are resolved in `CAPTURE_ACTIONS` order rather than rejected on
 * both sides: two actions on one key can only fire one of them, and silently
 * letting the pair through would give the user a binding whose behaviour
 * depends on registration order.
 */
export function planShortcuts(s: Shortcuts): ShortcutPlan[] {
  const taken = new Set<string>();
  return CAPTURE_ACTIONS.map((action): ShortcutPlan => {
    const wanted = s[action];
    if (wanted == null || wanted === "") return { action, accelerator: null };
    const parsed = parseAccelerator(wanted);
    if (!parsed.ok) {
      return { action, accelerator: wanted, problem: parsed.problem, ...(parsed.token ? { token: parsed.token } : {}) };
    }
    if (taken.has(parsed.accelerator)) {
      return { action, accelerator: parsed.accelerator, problem: "duplicate" };
    }
    taken.add(parsed.accelerator);
    return { action, accelerator: parsed.accelerator };
  });
}

/** A plan plus what registration actually did with it. */
export interface ShortcutReport extends ShortcutPlan {
  registered: boolean;
}

/**
 * The one sentence preferences shows under a binding, or `undefined` when
 * there is nothing to say.
 *
 * Here rather than in the renderer so the wording is testable and so a new
 * problem cannot be added without something failing to describe it — the
 * exhaustive switch is the check.
 */
export function explainShortcut(r: ShortcutReport): string | undefined {
  if (r.registered) return undefined;
  switch (r.problem) {
    case undefined:
    case "empty":
      return r.accelerator == null ? undefined : "Not registered.";
    case "no-modifier":
      return "Add a modifier — a bare key would be taken from every app on the machine.";
    case "no-key":
      return "Modifiers alone are not a shortcut; add a key.";
    case "too-many-keys":
      return `Only one key, plus modifiers — not “${r.token ?? ""}”.`;
    case "unknown-token":
      return `“${r.token ?? ""}” is not a key this can bind.`;
    case "needs-accessibility":
      return "Media keys need an Accessibility grant, which capture does not otherwise require.";
    case "reserved":
      return "macOS has already claimed this one.";
    case "duplicate":
      return "Another capture action already uses this.";
    case "unavailable":
      return "Something else on this Mac already holds this shortcut.";
  }
}

// ── recording a keystroke, and showing one ──────────────────────────────────

/** What the UI hands over: a `KeyboardEvent` reduced to what matters. */
export interface KeyStroke {
  /** `KeyboardEvent.code` — layout-independent, unlike `key`, which on macOS
   * turns ⌥⇧1 into an unrelated glyph. */
  code: string;
  metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean;
}

const CODE_KEYS: Record<string, string> = {
  Space: "Space", Tab: "Tab", Backspace: "Backspace", Delete: "Delete",
  Enter: "Return", NumpadEnter: "Return", Escape: "Escape",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".",
  Slash: "/", Backquote: "`",
};

/**
 * A keystroke → an accelerator string, or `null` when the user has only
 * pressed modifiers so far (which is not an error — it is the middle of
 * pressing a chord, and the field should keep waiting).
 *
 * Returns the accelerator UNVALIDATED: `parseAccelerator` still gets the last
 * word, so a recorded ⌘⇧4 is refused by exactly the same rule as one typed in.
 */
export function acceleratorFromKeyStroke(e: KeyStroke): string | null {
  const key = keyFromCode(e.code);
  if (key === undefined) return null;
  const mods: Modifier[] = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Command");
  return [...MODIFIER_ORDER.filter((m) => mods.includes(m)), key].join("+");
}

function keyFromCode(code: string): string | undefined {
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1];
  const fn = /^F([1-9]|1\d|2[0-4])$/.exec(code);
  if (fn) return code;
  return undefined;
}

const SYMBOLS: Record<string, string> = {
  Control: "⌃", Alt: "⌥", Shift: "⇧", Command: "⌘",
  Space: "Space", Return: "↩", Tab: "⇥", Escape: "⎋", Delete: "⌫",
  Backspace: "⌫", Up: "↑", Down: "↓", Left: "←", Right: "→",
};

/** `"Control+Alt+Shift+Command+1"` → `"⌃⌥⇧⌘1"`, for the UI and the menu bar. */
export function formatAccelerator(accelerator: string | null): string {
  if (!accelerator) return "—";
  return accelerator.split("+").map((t) => SYMBOLS[t] ?? t).join("");
}
