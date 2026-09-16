# STC-382 — the recording / still workflow

STC-382 holds a question and deliberately prescribes no answer: *"this ticket
exists to hold the question, not to prescribe an answer."* There are no
acceptance criteria. So this document is the point of view, not a build.

**The model in §1 is Patrick's, stated 2026-09-15**, and §2's decisions are his
answers to the open questions a first draft of this study raised. They are
recorded as settled, not as options. The code reading in §3 and the
recommendation in §4 are mine; §5 records a further decision he made on 2026-09-15.

Everything about the code below was read on Linux; §8 says what only a Mac can
settle. File references are to `master` at the time of writing.

---

## 1. The model

Two capture types, and then **how many subjects** are in frame.

| | **Still** — *to show something* | **Video** — *to demonstrate something* |
|---|---|---|
| **Full screen**<br>several subjects, or you don't know yet | context shot, annotated afterwards | a workflow that spans apps — browser → Obsidian → terminal. Rare |
| **Window**<br>exactly one | one app, pre-framed for annotation | a demo of a specific app. The common case |
| **Area**<br>one detail | hyper-focus on a detail | a clip to a developer showing what's broken — as small as a crop around a dropdown |

The axis is **not "how focused."** That was the first draft's reading and it is
wrong in a way that matters: the full-screen video case is *"the workflow spans
apps"*, which is not unfocused — it is **multi-subject**. Full screen means
several things, or you cannot enumerate them in advance. Window means exactly
one. Area means one detail, or a deliberate composition of two tiled windows.

That reading also explains why full-screen video is rare: you only reach for it
when you can't name your subjects up front.

**Every still is destined for annotation, a deck, or a case study.** That is the
whole still column, and it is why stills have decoration presets, redaction and
annotation while video has none — an asymmetry the first draft flagged as odd
and which the model explains rather than excuses. See §7 for whether video
should acquire any of it.

---

## 2. What the model settles

A first draft raised three tensions. All three are now decided.

**Area-scoped video is real, and its purpose is narrow.** Not a generic "demo a
UI element" — a clip sent to a developer to show that something needs fixing, at
the scale of a single dropdown. This is a genuinely different destination from
every other cell, and it is the one purpose in the matrix that is *disposable*:
sent once, not kept. See §7 for the one implication that has not been decided.

**A window resize ending the take is fine, and not a defect.** `windowId` scope
stops the recording when the window resizes past half a point (STC-370,
confirmed on hardware). The draft flagged this as a hidden fragility cost of
picking a tighter scope. It is not a concern in practice — nobody resizes the
window they are demonstrating. **Do not "fix" this**, and do not add a warning
about it; the behaviour is correct and the risk is theoretical.

**Area video and auto-zoom do not collide, because they are not combined.** The
draft noted that "crop to a detail" and auto-zoom (STC-325/326/330) answer the
same goal by different means. They do — but the resolution is behavioural rather
than architectural: when the scope is already an area, you would not also zoom.
The crop *is* the framing. Auto-zoom belongs to the wider takes — a full-screen
or window demo where one moment needs emphasis. Two tools, two regimes, no
overlap in practice.

So the only structural question left is the one the ticket actually opened
with: how the two capture types and the scope axis are presented.

---

## 3. Where today's code departs from the model

The model says scope is **one shared axis** across both capture types. The code
does not implement it that way, in four places.

### A. There are two scope vocabularies

Recordings have a sticky noun picker (Screen / Window / Area) plus a source
control. Stills have three *verbs* — `region` / `window` / `display`, one hotkey
and one menu item each (`hotkeys.ts:39-64`, `tray-menu.ts:58`).

So the Scope picker does not merely *fail to apply* to stills, as the ticket
describes. It is a second, differently-shaped answer to a question stills
already answer. Under the model these should be one vocabulary.

### B. "Screen" resolves to two different displays

A recording's Screen scope uses `settings.displayId` — the sticky picker,
absent meaning the helper's first (`main.ts:345-349`, STC-247). A full-display
still uses `screen.getDisplayNearestPoint(getCursorScreenPoint())` — the display
under the pointer, no overlay (`main.ts:586-590`, STC-292).

Both rules are individually right for what they serve. Together, one word means
two things. **They coincide on a one-display Mac**, which is why nobody has met
it — and a divergence that only appears on a second display is exactly the shape
STC-247 exists because of.

Stated precisely: the two rules are not currently shown side by side, because
the still's display rule is reachable only from the hotkey and the menu bar.
They *would* be the moment one control governed both.

### C. The two types have opposite completion models

A **still is finish-and-forget**: on disk before anything is shown, and the
panel settles itself on the timeout and saves or copies (`main.ts:497-512`).
Doing nothing is a complete, successful use — STC-296 by design.

A **recording is start-a-document**: nothing opens when a take ends. The editor
is reached only from the library's Open action (`renderer.ts:1016` →
`main.ts:820`); the sole post-take gesture is a `reveal()` on the
helper-initiated stop path (`renderer.ts:667`).

This is *correct* — it follows from "show something" versus "demonstrate
something." But it means the two actions are not peers, and the equal-weight
button row says they are.

### D. Doors are asymmetric, three to one

A still can be taken from the button, three global hotkeys, or the menu bar. A
recording can only be started from the Record button — no hotkey, no menu-bar
item. (CLAUDE.md records the far side of this from STC-375: no hotkey can *stop*
a take either, which is why `#record` stays reachable inside the collapsed pill.)

*Minor, same family:* `<h2 id="lib-heading">Recordings</h2>` (`index.html:354`)
is static — nothing in `app/src/` writes to it — above a grid that has held both
kinds since STC-294.

---

## 4. Recommendation

The model treats scope as one axis. The recommendation is to make the interface
say that, in this order.

1. **One scope vocabulary, across both types.** Full screen / Window / Area
   means the same thing whichever capture type you are about to use. This
   resolves §3A, and it is the change the model most directly asks for.
2. **Differentiate the two capture types' weight.** They are not peers (§3C):
   one ends a task, one begins a document. `#record` is already the only tinted
   control in the row (`index.html:100`) — finish that thought rather than start
   it. This is the part that wants an eye before it is committed to.
3. **Fold in the heading** while nearby — same defect, one control over.

### What NOT to do, and why

**Do not give the two types a shared sticky scope *value*.** This is the
distinction the whole recommendation turns on, and it is easy to collapse:

- A shared **vocabulary** is right — one set of words, one meaning. The model
  says so.
- A shared **memory** is wrong. Framing is a setup decision made once for a
  session, and a fresh decision nearly every time for a screenshot. A still that
  reused the sticky window would make every screenshot as modal as a recording,
  and would force §3B's two "Screen" rules into a single control.

So: one axis, one label, one set of words — and the still keeps asking.

---

## 5. The doors, and where scope comes from

Added 2026-09-15, after Patrick compared this against **CleanShot X's**
menu-bar dropdown.

### What CleanShot does

Its capture group is one flat list with no divider between the stills and the
video — Capture Area (⇧⌘4), Capture Fullscreen (⇧⌘3), Capture Window,
Scrolling Capture, Self-Timer, Capture Text (OCR), **Record Screen** — under an
All-In-One entry (⇧⌘5) at the top.

Two things in that structure matter here.

**Stills bake scope into the verb; video does not.** Capture Area / Fullscreen /
Window each carry their own hotkey. "Record Screen" has no scope in its name and
no hotkey at all — one entry that asks afterwards.

**All-In-One is their answer to this ticket's own third option** ("should they be
presented as two distinct modes rather than two buttons in one row"). Their
answer is *neither exclusively*: specific verbs for when you know what you want,
plus one unified entry for when you do not.

### The rule that falls out

**The door decides whether scope is asked or assumed.**

- **Main window** — the scope control is visible and sticky, sitting right
  there. Record just goes.
- **Menu bar or hotkey** — there is no window in front of you, so scope has to
  come from somewhere: baked into the verb (the stills, today) or asked at
  invocation (video).

This is stronger than §3D, which only observed that the doors are asymmetric
three-to-one. The asymmetry is not the defect; the defect is that video has no
door at all from the menu bar or a hotkey. Giving it one that ASKS closes the
gap without pretending the two capture types are the same shape.

### Decided

**The menu bar and hotkey path gets ONE "Record Screen" entry, and it asks.**
Patrick's framing, 2026-09-15: a recording is worth an interruption in a way a
screenshot is not — *"I'm okay with it being a little less instant and having an
interruption to say, okay cool, you want to record video? How do you want to
record it?"*

Rejected, with reasons, so they are not re-proposed:

- **Three scoped video verbs** (Record Screen / Window / Area, each hotkeyed)
  would make the vocabulary perfectly symmetric — and gives six hotkeys and no
  pause before committing to a take. Symmetry is not the goal; §3C says the two
  types are not peers.
- **One entry using the sticky scope, starting immediately** gives the menu bar
  no clue what scope you are about to get. A recording that begins in the wrong
  frame is expensive in a way a wrong screenshot is not.
- **All-In-One is not adopted now.** It is a real option and worth revisiting,
  but it is a larger build and the ticket's question is answerable without it.

The build is **STC-388**, not this study — a menu-bar "Record Screen" item and a
bindable hotkey for it, where the structural work is that `CAPTURE_ACTIONS`,
`Shortcuts` and `planShortcuts` must admit a non-still action, not the menu row
itself. Whether a Record hotkey toggles or needs a separate Stop is decided
there: today **no hotkey can stop a recording** (STC-375).

### CleanShot's hotkey defaults are not available to us

It binds ⇧⌘3 / ⇧⌘4 / ⇧⌘5, and `hotkeys.ts`'s `SYSTEM_CLAIMED`
(`hotkeys.ts:127-131`) refuses all of those in every spelling — STC-292's
decision. CleanShot can take them because it *replaces* macOS's own screenshot
tool; this app does not. The hyperkey row (⌃⌥⇧⌘1/2/3) exists for exactly that
reason, and any video binding comes from there rather than from CleanShot's.

### Why the omission was invisible

`trayTemplate` is `CAPTURE_ACTIONS.map(...)` (`tray-menu.ts:53`), and
`CAPTURE_ACTIONS` is `["region", "window", "display"]` — stills, by
construction. Nothing was ever *left out* of the menu; the menu simply **is**
the stills list. Adding video means it stops being a map over that constant,
which is the small structural change the build will start with.

---

## 6. The Scope-and-stills question, answered

Asked directly and deferred to this writeup, so it is answered here.

**The Scope picker's sticky pick should not govern a still capture, and should
not seed one yet.**

- *Governing* it is refused on the model: sticky framing suits a session, not a
  one-shot (§4).
- *Seeding* it — pre-selecting the stored window in the overlay, which the user
  then confirms — is refused only on **timing**, not merit. It turns
  `ScopeSettings.windowLabel` from what its own comment calls *"cosmetic only —
  never sent to the helper"* into a live claim that the window still exists, on
  the very picker STC-380 was repairing.

  **STC-380 landed 2026-09-16 (#158), so that blocker is cleared and seeding is
  the unblocked next step.** One caveat worth carrying rather than dropping:
  STC-380's own Swift geometry (`isFullyVisible`, the occlusion and off-screen
  subtraction) was written on Linux and **has never run against a real
  `SCShareableContent` list** — so the picker is repaired in code, not yet on
  hardware. Seeding leans on exactly that geometry being right, which makes
  `docs/STC-380-RUNBOOK.md` a sensible precondition rather than a formality.
- What remains is the vocabulary fix in §4: Scope keeps meaning what it already
  means, and the interface stops implying otherwise.

---

## 7. Open, and deliberately not decided

**Decoration for video.** Stills have background/padding/shadow presets
(STC-291), redaction (STC-297) and annotation (STC-295) because they are
destined for a deck or a case study (§1). Some of that plausibly transfers —
a demo clip embedded in a case study has the same framing problem a screenshot
does. **Flagged as a possible future direction, not thought through**, and not
scoped here. Redaction in particular is a different problem in motion than at
rest and should not be assumed to carry over.

**Whether a bug-report clip wants a still's completion model.** This falls out
of §2's area-video purpose and has not been decided. That clip is *disposable* —
sent to a developer once, not kept — which is the one video purpose whose
lifetime looks like a still's rather than a recording's. Today every take lands
in the library and waits to be opened (§3C). Whether the disposable case wants a
quicker way out is a real question, but it is **an observation, not a proposal**,
and nothing here depends on answering it.

---

## 8. What needs a Mac

Read off code on Linux. A Mac is the only instrument for:

- Whether differentiating the two capture types' weight (§4.2) reads as clearer
  or as inconsistent.
- Whether the scope row looks orphaned once it is regrouped.
- Whether §3B is ever *felt*. It needs two displays and a pointer on the
  non-primary one, and the prediction is that a full-display hotkey shot and a
  Screen-scope recording disagree about which display they mean. **Untested —
  nobody has run it.**

None of these gate the vocabulary fix in §4.1, which is why it is first.
