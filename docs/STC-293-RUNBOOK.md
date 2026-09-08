# STC-293 runbook — getting a still out of the app

What to run on the Mac, in order, and what each result must show.

Written on Linux, so **every line of Swift in `StillEncode.swift` is unrun** and
the whole of the pasteboard is unobserved. CI's macOS runner compiles it and
runs the encoder for real (`helper/test/still-encode.test.ts`), which leaves
three things only a person at the Mac can settle:

1. the pasteboard actually carrying three representations,
2. what Slack, Mail, Figma, Keynote and Preview each *choose* from it,
3. whether a P3 capture round-trips **without a visible shift** — the acceptance
   criterion is about what an eye sees, and no assertion in this repo is.

---

## 0. Build and check the encoder compiles at all

```
helper/build.sh
npm run typecheck
npm test
```

`npm test` includes `still-encode.test.ts`, which drives the real binary and
reads back the encoded bytes: PNG colour type 6 for a transparent shot and 2
for an opaque one, `iCCP` present on a Display P3 export, `ffd8ff` for JPEG,
an `ftyp` box with an HEIF brand for HEIC.

**If the HEIC test prints `ENVIRONMENT:` it did not run.** That is deliberate —
HEIC goes through the HEVC encoder, which is the paravirtualized passthrough
STC-259 measured blocking past 15 s on first touch — but it means HEIC is
unverified on that run and you have to look at step 3 to know it works.

Also watch for `premultiplied` in the reply. It should be `false`: `.last`
(unpremultiplied) is the layout a canvas produces and the one the encoder asks
for first. `true` means CoreGraphics refused it and the fallback carried the
export. That is not a failure — the file is correct either way — but it is the
one thing in this path a Linux machine could not check, so if it is `true`
say so, because every comment claiming otherwise is then wrong.

## 1. The pasteboard

```
npm run test:capture -- helper/test/still-clipboard.grant.test.ts
```

Must show `PNGf`, `TIFF` and `furl` on the system pasteboard, read back with
`osascript`, not from the helper's own reply.

This file is in the grant suite and does **not** need a Screen Recording grant.
It needs a real logged-in session, because `NSPasteboard.general` talks to the
pasteboard server and a runner is exactly where that stops being reliable.

## 2. Files a person can look at

```
node scripts/export-still-one.mjs ~/Desktop/stc/<a window shot>
```

Composites in a browser and encodes through the **real helper**, in all three
formats at both scales. Six files beside the shot.

Open each one. What to look for:

- **A white or dark halo at the window's rounded corner** in the PNG or HEIC.
  That is a premultiply bug, not a shadow, and it is the specific thing the
  `.last` / `.premultipliedLast` fallback could get wrong. View the transparent
  ones over a **dark** background — a halo against white is invisible.
- **The `-1x` files are exactly half the size** of their siblings, and still
  sharp rather than soft. This is the one deliberate resample in the whole
  still path; if it looks mushy the layout scaling is drawing the capture
  through two resamples instead of one.
- **The JPEG has no transparency and no black.** A window shot flattened by the
  encoder rather than by the app is the failure the ticket names explicitly.

## 3. The app, end to end — the acceptance list

```
npm run app:start
```

Capture a **window** (not a region: four of the five decoration modes need a
window's own alpha). The still panel opens under the buttons.

### 3a. Copy → paste

With **PNG** and a transparent mode (`window-only` or `window-shadow`), press
**Copy**, then paste into each of:

| destination | must show |
|---|---|
| Slack | the image inline, at full resolution, transparent where the shot is |
| Mail | the image inline, not a paperclip attachment |
| Figma | a placed image with transparency |
| Preview | New from Clipboard gives a document with an alpha channel |
| Keynote | placed on a slide, transparent over the slide background |

The status line names what the pasteboard took — `png + tiff + fileURL`. If a
destination gets the wrong thing, that list is the first place to look: the
order in `StillEncode.copy` is the preference, and a receiver takes the first
type it recognises.

Also drag from Slack's file picker / drop into Finder: the **fileURL** is what
makes that give a real file.

### 3b. The JPEG fork

Still in a transparent mode, switch the format to **JPEG** and press Save.

**It must ask before writing anything.** A panel appears offering "Flatten onto
\<colour\>" and "Use PNG instead". Nothing has been encoded at this point.

- Choose a colour → the saved JPEG has that colour behind the window, not black.
- Choose PNG → the format control switches and the transparency survives.
- Cancel → no file appears.

A JPEG that simply appears with a black background is the failure this whole
fork exists to prevent.

### 3c. The filename template and the destination

Press **Change…**, pick a folder. Every subsequent Save goes there silently —
"the default path being no interaction at all". **Beside the shot** puts it
back.

Then edit `~/Library/Application Support/<app>/settings.json` and set

```json
"template": "{app} {title} {date} {time} {counter} {width}x{height} {mode}"
```

Save twice without moving anything. Both files must exist, be valid, and differ
— the second gets a `-2` suffix. That is the acceptance list's "a template
containing every token produces a valid, collision-free filename".

### 3d. P3

On a **P3 display** (any recent Mac laptop or Studio Display), capture
something with saturated colour — a photo, a colour picker, a Figma swatch.
Save as PNG at native scale.

Open the saved PNG and the original side by side, full screen, on that display.
**They must look the same.** A washed-out export is a missing or wrong profile;
an oversaturated one is a P3 buffer tagged sRGB.

Confirm the tag independently:

```
sips -g space -g profile <the saved file>
mdls -name kCGImagePropertyProfileName <the saved file>
```

### 3e. Metadata

Set `"stripMetadata": true`, save, then:

```
exiftool <the saved file>          # or: mdls <the saved file>
```

No `DateTimeOriginal`, no `DateTime`. **The colour profile must still be
there** — it is not metadata, it is what makes the numbers mean colours, and
stripping it would undo 3d.

## 4. The preview's frame grab still works

Open a **recording**, press Copy frame and Save frame (⌘⇧C / ⌘⇧S). These used
to have their own encoder and their own clipboard call; they now go through
`still:export` like everything else. They must behave as before, and the copy
must now also carry a file URL.

---

## What is still open after this runbook

- **The five presets' values.** STC-288 says they can only be chosen by making
  real figures; this ticket did not change them.
- **HEIC on the user's Mac**, if CI reported `ENVIRONMENT:` and step 2 was
  skipped.
- **A file-promise proper.** The ticket says "file URL promise"; this puts a
  real file's URL on the pasteboard instead, because
  `NSFilePromiseProvider` needs a live provider to answer the receiver and the
  helper has gone idle by then. If a destination is ever found that wants a
  genuine promise, that is a new ticket and it needs a process that stays alive.
