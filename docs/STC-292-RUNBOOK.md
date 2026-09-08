# STC-292 runbook — global hotkey and menu-bar quick capture

Written on Linux, so the suite proves the app's side of every contract here;
the window server's side, the speaker's side and the eye's side are what this
file is for.

## Confirmed on hardware, 2026-09-08

| | |
|---|---|
| Menu-bar item present, icon legible, inverts in Dark appearance | ✅ §1 |
| The three captures render `⌃⌥⇧⌘1/2/3` as glyphs, not literal text | ✅ §1 |
| ⌘W removes the Dock icon; the menu-bar item stays; the app keeps running | ✅ §2 |
| Open Library brings the icon back and the window to the FRONT | ✅ §2 |
| ⌃⌥⇧⌘3 with another app frontmost: fires, **no overlay**, one shutter sound, a shot on disk | ✅ §3, §5 |
| ⌃⌥⇧⌘1 and ⌃⌥⇧⌘2 — the overlay opens and a capture completes | ✅ §3 |
| **Shutter sound** unticked in the app: silence, and the shot still saves | ✅ §5 |

That is the whole full-display hotkey path, end to end, on a real Mac — the
hotkey reaching a background app, the overlay-less capture, the sound, and the
file. It is the part no automated test in this repo can reach.

## Still unverified

* **Any hotkey during a live recording.** §4.
* **The shutter obeying MACOS's switch** — the app's own is confirmed, the
  system one is not, and only the second proves `com.apple.sound.uiaudio.enabled`
  is actually read. Also zero alert volume. §5 steps 3-4.
* **Rebinding by hand, and the third-party conflict wording.** §6 — step 5 needs
  a second app holding a key and cannot be produced any other way.
* **The permission round trip, SCREEN RECORDING HALF ONLY.** §7. The ticket's
  third acceptance criterion, and the largest thing still open.

**What the 2026-09-08 attempt did and did not settle.** The reset was run
correctly and the app was never prompted — because it was launched from iTerm2,
which holds Screen Recording, and Electron inherited it as a child process. So
the criterion splits, and only one half is contaminated:

| half | state |
|---|---|
| Capture does not need **Accessibility** | ✅ **Settled.** Electron unlisted under Accessibility, ⌃⌥⇧⌘1 gave an overlay and a shot on disk. Where the Screen Recording grant came from cannot change this — a missing Accessibility grant would have failed the capture either way. |
| The app needs **only Screen Recording**, granted to itself | ❌ **Not asked.** Launched from a granted terminal the app never needed a grant of its own, so nothing was measured. §7's `open` launch is what asks it. |

That is the good half of the two: Accessibility is the dependency that would
have been a BUG, and it is ruled out. What is left is the fresh-install story.

Everything below assumes `npm run app:build && npx electron .` (or
`npm run app:start`) on the Mac, with the real helper built — **except §7**,
which must be launched via `open` for exactly the reason above.

---

## 0. What is already settled without a Mac

Do not re-litigate these by hand; they are checked on every `npm test`.

| claim | where |
|---|---|
| The accelerator grammar, the aliases, the canonical order | `app/test/hotkeys.test.ts` |
| ⌘⇧3/4/5/6 and their ⌃ variants are refused, in every spelling | same |
| Media keys are refused because they would need Accessibility | same |
| A duplicate is refused on the LATER action, so the first keeps its key | same |
| Every failure has its own sentence, and "macOS owns it" ≠ "another app owns it" | same |
| The menu's items, order, enabled states and accelerators | `app/test/tray-menu.test.ts` |
| The icon is symmetric, bracket-shaped and inside its inset rect at 16 and 32 px | same |
| Every silence of the shutter is a named decision, not a swallowed failure | `app/test/shutter.test.ts` |
| A rebinding round-trips; `null` stays unbound; a corrupt binding falls back | `app/test/settings.test.ts` |
| The defaults really register; a rebinding releases the old key; a reserved one is not stored; the tray is really installed; a full-display capture opens no overlay | `app/test/hotkeys.e2e.test.ts` |

---

## 1. The menu-bar item — look at it

**Confirmed 2026-09-08: the icon is legible, it inverts in Dark appearance, and
the accelerators render as glyphs.** Re-run this after any change to
`tray-menu.ts` or `tray.ts`.

`npm run app:start`, then look at the right-hand end of the menu bar.

* The icon is four corner brackets, like a selection marquee. **It must be
  legible at a glance and must invert with the menu bar** — check in both Light
  and Dark appearance (System Settings › Appearance), and with a light and a
  dark desktop picture if the menu bar is translucent.
* Click it. Four items and two separators: Capture Region, Capture Window,
  Capture Full Display, ──, Open Library, ──, Quit stc recorder.
* The three captures show `⌃⌥⇧⌘1`, `⌃⌥⇧⌘2`, `⌃⌥⇧⌘3` on their right. **Electron
  renders those glyphs itself** from the accelerator string — if they appear as
  the literal text `Control+Alt+Shift+Command+1`, the template is handing over
  a pre-rendered string and `tray-menu.ts` has regressed.

**A wrong result worth naming:** an icon that is a black square in dark mode
means the template flag was lost (`tray.ts`, `setTemplateImage`). An icon with a
grey halo means colour crept in under zero alpha (`bgraFromMask`).

## 2. The Dock — it should go away

**WATCHED ON HARDWARE 2026-09-08 and it works.** The app appears in both places
at launch, ⌘W removes the Dock icon as designed, and the menu-bar item stays.
Arm 1 below passed on the first try; arm 2 was never needed.

**The GitHub macOS runner disagrees, and it is the runner that is wrong.**
There, `dock.isVisible()` stayed `true` with no window left — twice, once as a
single read and once through a full 10 s poll (runs 34243729730 and
34244375788) — while the window count was zero, the menu-bar item was alive and
the shortcuts were still registered. A real Mac does the opposite, so that is a
property of the runner's session and not of this code. **Do not put the
assertion back into `app/test/hotkeys.e2e.test.ts`**: it would be red forever
for a behaviour that demonstrably works, and the next person would "fix" it by
loosening it until it passed without meaning anything.

The procedure below stays because it is how the claim gets re-checked after any
change to `setDockVisible` or `window-all-closed` — the runner cannot do it.

```
helper/build.sh          # once, if the helper is not already built
npm run app:start
```

1. Launch. There is a Dock icon and a window.
2. **Close the window with ⌘W, and keep watching the Dock for about five
   seconds.** The recorder is necessarily frontmost at this moment — you cannot
   press ⌘W on an app that is not — and that is the point: this is the arm where
   the policy change happens while the app is ACTIVE.
   * **Icon goes** → it works on a real Mac and CI was an artefact. Skip to 4.
   * **Icon stays** → do not stop here; step 3 is what tells you which bug it is.
3. **Now click another app** — Finder, Safari, anything — so the recorder
   resigns active, and watch the Dock again.
   * **Icon goes only now** → macOS declined the change while the app was
     active, and accepted it once it was not. This is the answer, and it is a
     PRODUCT bug: `setDockVisible(false)` has to run when the app resigns
     active as well as when the last window closes. Say so and it gets fixed.
   * **Icon still there** → not the active-application story. Check the
     menu-bar item still opens and the hotkeys still fire (they should — that
     part is proven), then report it: the next step is instrumenting
     `setDockVisible` to say whether it ran and what `app.dock` was, because
     the remaining candidate is that it is never reached or throws.
4. Menu bar → Open Library. The Dock icon comes back with the window, and the
   window comes to the FRONT — not behind whatever you were using.
   **Confirmed 2026-09-08.**
5. Menu bar → Quit. The app ends and the menu-bar item goes.

**An objective reading, if you would rather not judge by eye.** With no window
open:

```
osascript -e 'tell application "System Events" to get background only of process "Electron"'
```

`true` means macOS has the app as an accessory — the Dock icon is gone and the
policy change took. `false` means it did not. The first run raises an Automation
prompt for the terminal; allow it. (`"Electron"` is the process name for a dev
run; a packaged build would be named after the app.)

**Why this matters beyond tidiness.** The Dock icon is half of the menu-bar-first
decision. The other half — no window, still running, hotkeys still bound — is
proven by `app/test/hotkeys.e2e.test.ts` and holds. Nothing about capture breaks
if the icon stays; it just is not the app that was designed.

## 3. The three hotkeys, with the app in the background

Put something else in front — Safari, full screen, ideally on a second display.
Do **not** click the recorder first; the whole point is that it is not frontmost.

| press | expect |
|---|---|
| ⌃⌥⇧⌘1 | the dimming overlay appears on every display, in **region** mode (crosshair). Drag, Return. **Confirmed 2026-09-08.** |
| ⌃⌥⇧⌘2 | the overlay appears in **window** mode — windows highlight as the pointer moves; no crosshair. Click one. **Confirmed 2026-09-08.** |
| ⌃⌥⇧⌘3 | **no overlay at all.** One shutter sound, and a new shot directory. **Confirmed 2026-09-08 with another app frontmost.** |

For each: a new directory under `~/Desktop/stc/` (or `$STC_RECORDINGS_DIR`)
holding `frame.png` and `shot.json`.

**The main window must never come forward.** The overlay takes the keyboard —
it has to, or Escape would be dead — so the app becomes active; what must not
happen is the recorder's own window appearing. If it does, something is calling
`show()`/`focus()` on `win` from the capture path.

If you have a caps-lock hyperkey remap (Karabiner, or macOS's own Modifier Keys
→ Caps Lock → nothing plus a remapper), caps+1/2/3 is the same chord.

**⌘⇧4 must still be macOS's.** Press it after each of the above and confirm
Apple's crosshair, not ours.

## 4. During a recording

Start a recording in the app. While it runs, press each of the three hotkeys.

* Each still is captured and written, and the recording is unaffected — the
  still path uses `SCScreenshotManager` with no stream of its own (STC-289).
* `anchors.json` for the recording still reports zero dropped frames.
* The recording's own display capture does **not** contain the overlay. (STC-290
  hides the overlay windows and names them in `excludeWindowIds`, but that
  applies to the STILL; the recording's stream is a separate filter. If the
  overlay shows up in the recorded video, that is a real finding and belongs on
  a new ticket, not here.)

## 5. The shutter sound

The system's own `Grab.aif`, at the alert volume, through `afplay`.

**Step 1 is confirmed 2026-09-08 — the shutter is audible on a real capture, so
the sound file is where this expects it to be on current macOS.** Steps 2-4, the
ones that prove it OBEYS a setting rather than merely making a noise, are the
part still to do.

There are now TWO switches, and the app's is the one to reach for:

* **Shutter sound**, in the recorder's own window beside Restore defaults. On by
  default. Added because the first person to look for a way to silence it looked
  here and there was nothing — a preference nobody can find is not a preference.
* **macOS's "Play user interface sound effects"**, which still governs. The app's
  switch can only ever SILENCE: ticked, the sound still follows the Mac's setting
  and its alert volume. No combination makes a noise the Mac was told not to make.

1. Both switches on. Press ⌃⌥⇧⌘3. **One shutter, at the same volume as macOS's
   own ⌘⇧3.** ✅ confirmed 2026-09-08.
2. Untick **Shutter sound** in the recorder's window. Press ⌃⌥⇧⌘3 again.
   **Silence, and the shot is still written.** No relaunch — the preference is
   read at each capture, not cached at launch. ✅ confirmed 2026-09-08.
3. Re-tick it, then untick macOS's **Play user interface sound effects**
   (System Settings › Sound). Press ⌃⌥⇧⌘3. **Silence, shot still written** —
   this is the half that proves the system setting is honoured, which the app's
   own switch does not test.
4. Alert volume to zero. Silence, shot still written.
5. Restore both. Sound returns without relaunching the app.

**If it is silent at step 1**, the sound file has moved. Find it —
`ls /System/Library/Components/CoreAudio.component/Contents/*/SystemSounds/system/`
— and add the path to `SHUTTER_SOUND_CANDIDATES` in `app/src/shutter.ts`. A
missing file is reported as `no-sound-file`, never substituted with another noise.

`STC_SHUTTER_SOUND=/path/to/file.aif` overrides it for a one-off check.

## 6. Rebinding, and the conflict report

In the window, the **Capture shortcuts** section.

1. Click a shortcut field. It reads `Press keys…`.
2. Press ⌃⌥⇧F9. The field shows `⌃⌥⇧F9` and the row says **Active**. The old
   binding stops working — press ⌃⌥⇧⌘1 and confirm nothing happens.
3. Quit and relaunch. The rebinding is still there and still fires.
4. Click a field and press **⌘⇧4**. The row says *macOS has already claimed this
   one*, the field keeps its previous binding, and ⌘⇧4 still runs Apple's tool.
5. Click a field and press a binding another app holds — Alfred's, Raycast's,
   CleanShot's, whatever is installed. The row says *Something else on this Mac
   already holds this shortcut.* **This is the one wording that cannot be
   produced without a second app on the machine**, and it is the difference
   between the ticket's "detect and surface conflicts" and silently failing to
   bind.
6. Clear a binding. The row shows `—`, nothing fires, and it is still clear
   after a relaunch.
7. Restore defaults. All three come back and all three fire.

**A wrong result worth naming:** if step 5 says *Active* and the key does
nothing, `globalShortcut.register` returned true for a binding the system then
ate. That is a real finding — Carbon accepting a hotkey it will not deliver —
and the fix is to add it to `SYSTEM_CLAIMED`, not to widen the report.

## 7. The permission story — the acceptance criterion

The one that needs a clean machine, or a reset.

**The bundle id is `com.github.Electron`.** `npm run app:start` is
`electron .` with no packaging step, so macOS attributes every grant to
Electron.app itself, not to anything named after this project. Confirm it
rather than trusting this line:

```
/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' \
  node_modules/electron/dist/Electron.app/Contents/Info.plist
```

**Quit the recorder — and note that closing its window is not quitting it.**
This ticket made the app menu-bar-first, so ⌘W leaves it running with its
menu-bar item and its hotkeys still bound. Use the menu-bar icon (the four
corner brackets) › **Quit stc recorder**, or ⌘Q with a recorder window
frontmost, or Ctrl+C in the terminal running `npm run app:start`.

Then confirm nothing is lingering. A leftover `electron .` holds the display,
so the first capture after the reset fails as `-3805` — which reads as "the
grant did not work" and is not that at all:

```
ps -Ao pid,command | grep '[s]tc-screen-recorder/node_modules/electron'
```

No output means you are clear. A line means it is still up: the first column
is the PID, so `kill <pid>` and run the check again.

Then:

```
tccutil reset ScreenCapture com.github.Electron
tccutil reset Accessibility com.github.Electron
```

**Never run `tccutil reset ScreenCapture` with no bundle id** — that resets
every app on the machine, not this one. And note the id is shared: any other
Electron app run from a checkout on this Mac loses its grant too and will
re-prompt.

**Confirm the reset took before believing anything after it.** Open System
Settings › Privacy & Security › Screen & System Audio Recording; Electron must
be **gone from the list**, not merely switched off. A reset that silently did
nothing leaves every step below asserting the grant it was meant to remove.

### Do NOT launch it from a terminal — that is the trap this section is for

**Observed 2026-09-08: the reset was run correctly and the app was never
prompted.** Not because the reset failed, but because `npm run app:start` makes
Electron a CHILD of the terminal, and iTerm2 already holds Screen Recording —
it has to, since `npm run test:capture` spawns the helper directly and the
helper inherits the launching process's TCC identity (CLAUDE.md). The whole
chain, terminal → node → Electron → `stc-helper`, resolved to iTerm's grant.
No prompt, a working capture, and `com.github.Electron` being reset made no
difference to any of it.

That run tells you nothing about the acceptance criterion. It cannot: the
question is whether the APP needs only Screen Recording, and launched this way
the app never needed a grant of its own at all.

**The tell**, in Privacy & Security › Screen & System Audio Recording: your
terminal is listed and switched on. If it is, anything launched from it is
borrowing that grant.

So launch it the way CLAUDE.md says permission work has to be done — via
`open`, so it is launched by launchd and is its own responsible process, which
is the whole reason `tools/test-host` exists:

```
npm run app:build
open -a "$(pwd)/node_modules/electron/dist/Electron.app" --args "$(pwd)"
```

Safe to launch detached from the checkout: the helper binary is resolved from
`import.meta.url` (`app/src/main.ts`'s `HELPER`) and takes go to
`~/Desktop/stc` (`takesRoot`), so neither depends on the working directory.

Then, **without ever running a recording**:

1. Grant Screen Recording when asked — and being ASKED is itself half the
   result. If no prompt appears, stop: something is still inheriting a grant,
   and every step below is measuring that instead.
2. Do **not** grant Accessibility. Confirm the app is not even listed under
   Privacy & Security › Accessibility.
3. Press ⌃⌥⇧⌘1. The overlay appears, a region is captured, `shot.json` and
   `frame.png` are on disk.

That is the round trip the ticket asks for: install, hit the hotkey, get a
screenshot, with only Screen Recording granted. The event tap that needs
Accessibility belongs to the RECORDER's cursor telemetry and is not touched by
any of this — which is why media keys are refused as bindings
(`hotkeys.ts`, `needs-accessibility`): Electron registers them through a
CGEventTap, and binding one would quietly reintroduce the dependency this
criterion exists to rule out.

### The criterion says "only Screen Recording" and that is not literally true

**Observed 2026-09-08, launched via `open`:** the first prompt is not Screen
Recording at all. It is **Files and Folders › Desktop**, at launch, because
takes live in `~/Desktop/stc` (`takesRoot`) and the app enumerates that folder
for the take library before anything is captured. Desktop is TCC-protected
alongside Documents and Downloads.

Launched from a terminal you never see it — the terminal already has Desktop
access and the app inherits it — which is the same borrowed-grant effect that
hid the Screen Recording question, showing up on a second service.

It is not a bug and nothing here should change to avoid it: `~/Desktop/stc`
over a temp dir is a deliberate decision (CLAUDE.md, "a take is a deliverable,
not scratch"), and a Files and Folders prompt is an ordinary thing for an app
that writes where the user can find its output.

But it does mean the ticket's wording — "install, hit the hotkey, and get a
screenshot with only Screen Recording granted" — is not literally achievable.
The honest version of the criterion is **only Screen Recording among the
grants the CAPTURE needs**: no Accessibility, no Input Monitoring, no
automation. Desktop access is a consequence of where output is written, not of
how capture works. Record the pass in those terms rather than pretending the
prompt did not appear.

**Expect the Screen Recording prompt LATER**, on the first ⌃⌥⇧⌘1 — TCC asks
only when something tries to capture, not at launch. And expect that first
capture to fail even after you allow it: a ScreenCaptureKit grant does not
apply to a running process. Quit properly (menu-bar › Quit, not ⌘W), relaunch
with the same `open` command, and press again. That second press is the one
that must produce a shot.

### The cheaper check, if the reset is not to hand

The criterion's substance is that capture does not DEPEND on Accessibility, and
that can be falsified without resetting anything. Electron is probably already
listed under Privacy & Security › Accessibility from the recorder's event tap —
which is exactly why step 2 above says "without ever running a recording".

Toggle Accessibility **off** for Electron, quit, relaunch, press ⌃⌥⇧⌘1. A shot
on disk means the hotkey path does not need the grant.

This is NOT a substitute for the reset: it leaves the fresh-install half — that
a user who has never recorded is never prompted for Accessibility and never
appears in that list at all — unproven. It rules out the thing that would be a
bug; the reset proves the story the ticket actually asks for.

## 8. What is deliberately not here

* **The post-capture thumbnail animating to the corner.** The ticket names it;
  it is STC-296's, and building the destination here would mean building it
  twice. The shutter sound is the feedback in this slice — chosen deliberately,
  and the reason is that a full-display hotkey capture puts nothing on screen at
  all, so a sound is the only evidence that exists.
* **A Record/Stop item in the menu bar.** Open Library reaches the window, which
  is where recording lives.
