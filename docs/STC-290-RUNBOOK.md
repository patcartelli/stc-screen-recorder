# STC-290 — the selection overlay: what to run on the Mac

Written on Linux, where no window server exists, so **nothing about how the overlay
looks or feels has been seen**. The logic under it has: `app/test/selection.test.ts`
runs 44 assertions against the pure state machine with no screen, and the E2E suite
drives the real windows against the stand-in helper. What neither can settle is the
part the ticket calls the whole first impression.

## The decisions taken, and why

| question | decision |
|---|---|
| the ticket says "borderless transparent `NSWindow`" | Electron, one transparent frameless window per display at `screen-saver` level. Every other pixel of UI in this project is Electron and the helper is a headless accessory process; putting a window server dependency in the capture process to gain native event handling was the worse trade |
| where the interaction state lives | the MAIN process, not the windows. A drag that crosses a bezel changes which window is under the pointer mid-gesture, and per-window state would stop the marquee at the edge |
| a region spanning two displays | attributed to the display holding most of it, and clipped to that display. `capture-still` captures one display because "full display is the only capture primitive" is the v1 rule; the readout shows the clipped size, so what it says is what gets captured |
| keeping the overlay out of the pixels | both belts. The windows are hidden AND named in `capture-still`'s new `excludeWindowIds`, because `hide()` and the capture reach the window server by different paths with no ordering between them |

## 0. Build

```
helper/build.sh          # Still.swift and StillDecisions.swift changed
npm run typecheck
npm test                 # selection.test.ts, the still harness, the overlay E2E
npm run app:start
```

The Swift change is small — `excludeWindowIds` on the request, and
`excludingWindows:` on the display filter — but it is a change, so the 13.3 SDK
build matters again.

## 1. The overlay itself — the part only a person can judge

`npm run app:start`, then **Capture still**.

- **It appears at once, over everything.** Over a full-screen app, over another
  app's menu, on every display. If it opens behind something, `screen-saver` level
  or `setVisibleOnAllWorkspaces` did not take.
- **No flash.** The window is shown only after its first paint (`ready-to-show`).
  A white or desktop-coloured flash at open means that ordering broke.
- **The dim reads as a dim**, and the hole reads as a hole. Drag a marquee: the
  region inside is undimmed and the edge is a clean one-pixel line.
- **Drag across the bezel** on a two-display machine. The marquee must follow the
  pointer onto the second display and keep following it back. Then look at the
  readout: it should say the CLIPPED size, and say "clipped to one display".
- **Handles.** Release, then drag each of the eight. Then Shift (keeps the aspect),
  then Option (resizes about the centre). Then Shift while making a fresh drag —
  that one squares it.
- **Arrows** nudge one point, Shift-arrow ten.
- **Space** toggles to window mode. Hover: the window under the pointer gets an
  outline, a fill and a chip naming the app, the title and the pixel size. Hover
  over overlapping windows — the FRONT one must highlight, not the biggest.
- **Escape** from every state leaves nothing on screen.

## 2. The captures

| what to do | what to check |
|---|---|
| region shot | the PNG is the region at the display's backing scale; `shot.json`'s `crop` is in display-local points |
| region shot on the SECOND display | `shot.json`'s `display.id` is that display, and the crop is local to it — not offset by the first display's width |
| window shot | the window's real corners with transparency behind them, no desktop, no shadow |
| **the overlay is not in the pixels** | open `frame.png` and look for the dimming. This is the acceptance criterion that the exclusion list and the hide exist for, and the only way to know is to look |
| Escape | `~/Desktop/stc/` gained no directory |

## 3. The one thing I could not verify at all

`displayId` is Electron's `Display.id`, handed to the helper as a
`CGDirectDisplayID`. On macOS those are the same number, and the code depends on
it. **Check it on a two-display machine**: take a region shot on the second
display and confirm `shot.json`'s `display.id` matches the display you drew on.

If they ever diverge the failure is loud rather than silent — the helper answers
`no-such-display` and the capture fails — so the bad outcome is a refusal, not a
photograph of the wrong screen. But a refusal on every second-display shot would
still be a bug, and this is where it would show.

## 4. Not covered

- **The global hotkey and menu bar** are STC-292. The button is the entry point
  for now; the hotkey will call the same `still:capture` path.
- **Minimised and offscreen windows** are filtered by `SCShareableContent` and the
  helper's `windows` verb before the overlay ever sees them, so the overlay's
  behaviour for them is inherited rather than implemented. Worth one look on
  hardware: minimise a window and confirm it cannot be hovered.
- **A window that closes between hover and Return** is refused by `confirm` and,
  should it slip past, by the helper's `no-such-window`. Both halves are tested;
  neither has been raced on hardware.
