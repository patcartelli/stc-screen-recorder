# STC-289 — still capture in the helper: what to run on the Mac

Written on a Linux session that cannot run `swiftc`. Since then CI (macos-15, SDK 15) has
**compiled the helper and passed the whole no-grant suite** — the still harness, the
`capture-still`/`windows` IPC cases against the real binary, the bounds chain. What remains
unverified is exactly two things: the build against the Mac's **13.3 SDK** (CI cannot see the
13.3 headers, and `ScreenshotAPI` exists for that gap), and everything that needs a Screen
Recording grant (section 2) or an eye (section 3).

Three decisions were taken before writing, and each is the answer to a question the ticket left
open:

| question | decision |
|---|---|
| `SCScreenshotManager` is 14+ and the helper builds against the 13.3 SDK | reached through the Objective-C runtime (`ScreenshotAPI` in `helper/src/Still.swift`), the `captureResolution` KVC trick one step further. Builds on this Mac today and on CI's SDK 15 |
| "return the frame as a CVPixelBuffer/IOSurface over the existing IPC" — the IPC is JSON lines on a pipe | `frame.png` beside `shot.json` in the request's `dir`, as the shot-1 schema already says; the reply carries the document and a per-step timing split |
| the shot-1 schema lived on the unmerged review branch | cherry-picked (`87dc2c4`) onto this branch; nothing else from that branch |

## 0. Build

```
helper/build.sh
npm run typecheck
npm test            # still-decisions harness (no grant), ipc capture-still/windows cases, still-bounds
```

Swift 6.1 against SDK 15 accepted all of it, including `ScreenshotAPI.CaptureImageIMP` (a
`@convention(c)` function type whose last parameter is an `@escaping @convention(block)` closure)
and `cls as AnyObject`. `swiftc` 5.8 against 13.3 is the older compiler; if it objects, those two
are still the places to look, and `objc_msgSend` via `dlsym` with the same cast is the fallback.

## 1. The pure half — no grant needed

```
npx vitest run helper/test/still-decisions.test.ts
```

The Swift harness asserts request parsing, crop clamping, cursor localisation across three
displays (right of main, above main, mixed heights) and shape classification, then prints four
`shot.json` documents. The TypeScript side validates every one against
`schema/shot-1.schema.json` and `parseShot`, and round-trips it. This is the writer half of
STC-301 gate 5 and runs on every `npm test`.

## 2. The real thing — needs a Screen Recording grant for the TERMINAL, and macOS 14+

The helper is spawned directly, so it inherits the launching process's TCC identity (the
STC-249 note applies: STCTestHost being granted says nothing about the terminal).

```
npx vitest run --config vitest.grant.config.ts helper/test/still.grant.test.ts
```

What it proves, in order, and what a failure at each step means:

| test | proves | if it fails |
|---|---|---|
| probe (inside each test) | the runtime call works at all | `still-unsupported` → the class or selector name is wrong for this OS, or the OS is pre-14. `no-displays` → no grant for this terminal. Either is a SKIP-GRANT, and says which |
| full display | frame.png is the display's PIXEL size (not the 4K-capped recording size), shot.json loads, timing split printed | a size mismatch means `sourceRect`/`width`/`height` semantics differ from what was assumed — read the `[still] timing` line and the `display` block in shot.json |
| region | crop → frame of crop × backingScale | same as above, for `sourceRect` in display-local points |
| bad display id / off-display crop | refused, never the first display | — |
| window | `windows` lists something titled; the capture comes back with an alpha channel (PNG colour type 6), `frame.alpha: true`, decoration `window-only` | `alphaWarning` in the reply means the window capture was opaque — check that `ignoreShadows` and `nonOpaque` in the timing block are 1 (the KVC took), and whether `captureImage` honours BGRA; `captureSampleBuffer` is the next thing to try |
| still during a recording | STC-301 gate 6, helper half: `dropped: 0`, `nonMonotonic: 0`, frames keep growing | a disturbed stream is the design's own failure mode and blocks the ticket |

## 3. What only a human can check

Open `frame.png` from a full-display shot taken with the pointer in the middle of the screen:

- **no pointer in the pixels** (`showsCursor = false`); shot.json's `cursor` block has its
  position and shape instead. Move the pointer to another display and take another: the
  `cursor` key must be ABSENT, not zeroed.
- **cursor shape**: over a text field expect `ibeam`, over a link `pointingHand`, elsewhere
  `arrow`. The classifier is STC-309's (`CursorShape.swift`), so its probe's verdict applies here
  too: if it is always `arrow`, `NSCursor.currentSystem` is blind from a background process on a
  non-main thread; the position is still right, and the shape falls back honestly.
- **window shot**: open `frame.png` in Preview — the corners outside the window's rounded shape
  must be transparent (checkerboard), with no desktop and no shadow. A shadow in the pixels
  means `ignoreShadowsSingleWindow` did not take.
- **latency**: the `[still] timing` line. The target is well under 200 ms from verb to buffer;
  `captureMs - contentMs` is the screenshot itself, `contentMs` is `SCShareableContent`
  enumeration (which is not the ticket's number but IS what the user waits), `writeMs -
  captureMs` the PNG encode. If content enumeration dominates, caching the display list against
  the display watcher is the next optimisation.

## 4. Not covered here

- **HDR/EDR displays** (acceptance list): no knob is set for them; a still of an HDR display
  should come back SDR-tone-mapped as screenshots do. Untested.
- **Mixed scale factors**: `localizeCursor` is in points, so scale never enters the position;
  the harness covers three display layouts. The pixel size uses each display's own
  `backingScale`. Not yet seen on hardware.
- **The app** has no button for this yet (STC-292/296 own the entry point). From the client,
  `HelperClient.request("capture-still", { dir, kind, crop, windowId })` works today.
