# STC-247 — multi-display capture: what to run on the Mac, with a second display

Written on a Linux session with no `swiftc` and no second display, so the Swift
below is compiled first by CI and every hardware claim is unverified until the
steps here are run. The ticket is a VERIFICATION ticket: `displayId` existed in
the `start` command from phase 1 and had never been exercised.

## What changed to make it verifiable

- **The helper refuses a `displayId` it cannot find** (`display-not-found`,
  naming the ids it can see) instead of quietly recording whichever display
  SCK listed first. `chooseDisplay` in `CaptureDecisions.swift`, tested in the
  decisions harness; `capture.test.ts` and `multi-display.grant.test.ts` drive
  the real binary.
- **`devices` now reports each display's `name` and global `originX`/`originY`**
  beside its id and sizes. The origin is the number `anchors.display` carries
  and every event coordinate is relative to.
- **The app has a display picker** next to the camera toggle: Automatic (the
  helper's first, as before) or a named display. Stored in settings like the
  camera flag; refreshed when the helper comes up and on an idle display
  change; a stored display that is gone shows as "(not connected)" rather than
  being dropped, because `start` would then be refused and the user should see
  why first. `app/test/display-picker.e2e.test.ts` drives it against the
  helper stand-in.

## 0. Build and the no-hardware checks

```
git pull && helper/build.sh && tools/test-host/build.sh
npm run typecheck && npm test
```

`npm test` runs the decisions harness (`chooseDisplay`), the `devices` shape
check, the bogus-`displayId` refusal, the settings tests and the picker E2E.
None of them need a second display.

## 1. With the second display connected: what the helper sees

```
(echo '{"cmd":"devices","seq":1}'; sleep 2) | helper/build/stc-helper 3>&1 | jq 'select(.ev=="devices") | .displays'
```

Expect two entries. Note each one's `id`, `main`, `name`, `originX`/`originY`.
The non-main display's origin is where it sits in the global point space
(often `1800,0` or a negative x if it is arranged to the left). Paste this into
the ticket; the ids are what the rest of the runbook refers to.

## 2. The grant test (the automated half of increment "correct display")

```
npx vitest run --config vitest.grant.config.ts helper/test/multi-display.grant.test.ts
```

Keep the mouse on the **non-main** display during the 3 s take. It asserts the
take's `anchors.display` names the requested id with that display's origin and
point size, and that a bogus id is refused with `display-not-found`. It
REFUSES (not skips) with `SKIP-DISPLAYS:` on a one-display machine. It prints
how many pointer events fell outside the target display; with the mouse kept
on it, expect 0.

## 3. From the app: record, preview, export, WATCH

```
npm run app:start
```

1. The picker next to Camera should list both displays, the main one marked.
2. Pick the **external** display. Record ~15 s while moving the mouse on that
   display, hovering a text field and a link there, and clicking once.
3. Stop. The library row's event count should be in the hundreds.
4. Preview the take: the picture must be the EXTERNAL display's content, and
   the cursor must sit where the pointer was on it. A cursor offset by a whole
   display width is the origin being wrong; a cursor that is correct but the
   picture is the main display is the id being ignored.
5. Export (or `node scripts/export-one.mjs <take> 15`) and watch the same
   things in the file.

Then the same take with **Automatic** selected: it must record whatever the
helper lists first, which on most machines is the main display — note in the
ticket which one it was, since SCK does not promise the order.

## 4. Reconfiguration during a take (the callback and `stop.reason`)

Two arms, and both are worth recording because the second is the one P7 of
`docs/review-2026-09-02.md` calls "correct and annoying":

1. **Captured display disconnected.** Record on the external display, unplug
   it mid-take. Expect: the app alerts "Display configuration changed — the
   recording was stopped", the take ends by itself, `anchors.stop.reason` is
   `display-reconfigured`, and `display.mp4` plays up to the unplug.
2. **Unrelated display disconnected.** Record on the MAIN display, unplug the
   external one mid-take. Expect the SAME outcome today — the helper stops on
   any change, by design, because removing a display can move the captured
   display's global origin and shift every later event. Record that it did.
   The fix (an origin timeline in anchors, a schema change) is its own
   ticket, not this one.

```
jq '.stop' ~/Desktop/stc/<take>/anchors.json
```

## 5. Close out

Paste the `devices` listing, the grant test's stderr line, and the four
outcomes (picked display previewed/exported; Automatic; both unplug arms)
into STC-247. CLAUDE.md's row → done with the date and what was watched.
