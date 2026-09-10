# STC-313 — Demo #1: Music Network, made and published

Everything for this ticket that can be done without a Mac is done. What is
left is a recording session, and this is what to do in it, in order.

**Done means published on `/lab/network` and reachable by a stranger.** A file
on disk is not this issue.

---

## What is already in place

The site side landed first, on
`accounts/stc-313-demo-1-music-network-made-and-published` in
`patcartelli/studio-cartelli`:

| thing | where | state |
|---|---|---|
| The embed | `src/components/lab/LabVideo.astro`, wired into `src/pages/lab/network.astro` under the heading, above the live graph | renders **nothing** while the demo is unpublished |
| Its data | `src/data/lab-demos.ts` | `network` entry written, `published: false` |
| The guard | `npm run check:demos`, in `build` | refuses a build where `published` is true and the file is missing, or where the declared size disagrees with the MP4 |
| Cache rule | `public/_headers` | `/lab/videos/*` revalidates, so re-recording is not hidden behind the CDN |

So publishing is: copy the file in, flip one boolean, fill three strings, push.

**The path is confirmed against the real site**, which STC-242's runbook listed
as the thing most likely to be wrong. It *was* wrong: `publicSrc` produced
`/lab/network/network.mp4` — the slug twice, and a `public/lab/network/`
directory sharing a name with `/lab/network`, which is a live SSR route there.
It is `/lab/videos/<slug>.mp4` now, verified 200 `video/mp4` off a dev server.

---

## The beats

Patrick's beat script v3, from the STC-313 thread, is the authority. Reproduced
here so the recording session does not need a browser tab open on Linear.

**Positioning.** The video argues *I build things like this*; the evidence is a
hiring manager understanding the piece in one silent pass. Structure is
*recognizable seed → esoteric hop*.

**Config:** `/lab/network?period=6month` · genre colouring on · **legend in
frame** · loaded before recording starts.

**Target 50s. Shot for it, not trimmed to it.**

| Time | Beat | Action | Proves |
|---|---|---|---|
| 0:00–0:02 | Cold open | 294 links at rest, coloured, legend visible. Post-settle. Poster frame. | Scale |
| 0:02–0:10 | Find | Type `radiohead` — field dims as you type. Click. | The density has an entrance |
| 0:10–0:20 | Focus | Radiohead's links resolve into three coloured lobes — rock, indie, electronic. Hold. | Density was a decision |
| 0:20–0:30 | Hop | One node in the electronic lobe is the wrong colour. Click it. Focus shifts to Genghis Tron: 18 of 20 neighbours in other families. | The graph shows something you couldn't infer |
| 0:30–0:38 | Read | Hover Genghis Tron ↔ Aphex Twin: `electronic, experimental`. | What a line means |
| 0:38–0:50 | Out | Drag a node from the electronic lobe, springs follow, release, settle. Rest 3s. Cut. | It's live, not a picture |

### Pre-flight, from the same script

1. **Load the 6mo URL first; never click a period button on camera.** They are
   `<a href="?period=…">` navigations — a full page load and a global
   re-settle, which wrecks the take and pollutes the STC-319 fixture.
2. **Genre colouring on, legend in frame.** Without the legend the hop is a
   differently coloured dot.
3. **Rehearse the hop.** Two behaviours unverified: does clicking a node inside
   focus mode re-focus or exit focus? Is Genghis Tron spottable as the odd
   colour at container width? Fallback: a second typed search, `genghis`.
4. **Check the poster frame at embed width** (STC-318), not just the tooltip.
5. **Start recording post-settle** so the take carries no global change event.
6. Real cursor artwork (STC-239); tune the spring on the final drag.
7. **Do not touch the similarity slider** — `similarity` is 0.0 on every link
   outside the 7day window (STC-332). Accepted as-is for this take.

---

## Recording

Keep the take. It is also STC-319's fixture — record it once, well.

- **Cursor excluded at capture.** That is already how the helper records
  (`showsCursor` is off by design); the pointer is drawn at export from
  `events.json`. Nothing to set.
- If the recording looks like it has no cursor, **check which file you
  opened** — a raw `display.mp4` never has one. Only an export does.
- Full display. Pick the display in the app's picker beside Camera (STC-247)
  if more than one is connected.
- Camera off.

### Which display you record on is the one thing you cannot fix afterwards

**Exporting smaller does not make the text bigger.** The output width cancels:
text of `T` points ends up at `T x embedWidth / display.pointWidth` CSS pixels,
so the export size decides file weight and how much survives resampling, and
nothing else (STC-318).

What that means for this take:

| recorded display | 13 pt text in the `/lab` column |
|---|---|
| full 4K desktop, 3840 points | **4.2 px** — unreadable, and no export setting rescues it |
| retina display at 1728 points | **9.3 px** — clears the threshold |

Same export either way; only how many POINTS of screen were recorded differs.
So if the Music Network piece is on a large desktop, either record a smaller
logical display or accept that the text is texture rather than content — and
decide that before pressing record, because it cannot be repaired in the edit.

The app shows the figure live beside the size picker, and warns when it is
below the threshold. Worth a glance at it on the first take rather than the
third.

---

## Export size

Pick it in the app — **Export size**, the select under the preview. On a
3840×2160 capture it offers:

| option | what it means |
|---|---|
| `Capture size · 3840×2160` | no rescale, the default |
| `Embed 1× · 1232×694` | the `/lab` column exactly |
| **`Embed 2× · 2464×1386`** | **use this** — crisp on a retina display, never upscaled |

The presets come from the site's real measurement rather than a round number:
`/lab`'s container is `max-width: 1280px` with `24px` padding either side above
840 px, so a demo is **1232 CSS px** at its widest.

Height follows the capture's aspect and both dimensions are evened, because
H.264's 4:2:0 cannot express an odd one. An option wider than the capture is
shown disabled with "— larger than the capture" rather than hidden.

A full 4K export is both heavier than a portfolio page wants and larger than
anything will ever display, which is the whole reason to choose.

### Then look at it at that size

**Shown at** + the **Viewer's eye** checkbox, in the row below. That draws the
preview at the embed width for real — 1232 CSS pixels on screen, not a smaller
render stretched back to the player column. It is the only way to judge STC-318
before exporting rather than after.

> **This used to be a hand edit of `project.json`, and it no longer is.**
> STC-335 shipped the picker on 2026-09-09 (#116). The old instruction carried
> a hazard worth remembering if you ever meet a document the UI cannot express:
> editing `project.json` while the take is OPEN loses the edit, because the next
> trim persists the in-memory project straight over it.

---

## Publishing

1. **Site folder…** in the app → `<studio-cartelli>/public/lab/videos`.
   The folder exists on the branch above.
2. Slug stays `network`.
3. **Share to site.** The file lands as `network.mp4` and the snippet goes to
   the clipboard. Re-publishing replaces it, deliberately — that is what makes
   the demo re-recordable without a page edit.
4. In the site repo, paste the snippet over the `network` entry in
   `src/data/lab-demos.ts` and fill the blanks it leaves visibly unfilled:
   - `{poster}` — see below, or delete the line to ship without one
   - `{label}` — what a screen-reader user is told instead of the video
   - `{caption}` — what a viewer reads under it
   The entry already carries drafts of the last two; keep or replace them.
5. `npm run check:demos`. It will tell you if the file is missing or if the
   dimensions you typed do not match what you actually encoded.
6. `npm run build && npm test`, then push and merge.
7. Load `/lab/network` and watch it as a stranger would.

### The poster frame

Nothing produces one automatically. Scrub the preview to the cold-open frame
and use **Save frame** (STC-298), which writes a PNG beside the take. A
2464-wide PNG is heavy for a page, so convert it — macOS has this built in, no
install:

```sh
sips -s format jpeg -s formatOptions 80 frame.png --out network.jpg
```

Drop it next to the video in `public/lab/videos/`. If you skip it, remove the
`poster:` line — the check refuses a poster that is declared and absent.

---

## The README slot

`README.md` still says `> Demo: *[the phase-3 recording goes here — see
STC-302]*`. The beat script nominates **0:06–0:20** for the GIF — the last
keystrokes through the collapse into lobes, because the collapse alone has no
*before*.

From the exported MP4, on the Mac:

```sh
ffmpeg -ss 6 -t 14 -i export-<take>.mp4 \
  -vf "fps=12,scale=960:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
  -loop 0 docs/demo-network.gif
```

Then replace the placeholder line with:

```markdown
![The artist network: searching, focusing, and dragging a node](docs/demo-network.gif)
```

Check the file size before committing. If it is over a few MB, drop `fps` to 10
or `scale` to 800 — a README GIF nobody waits for is worse than none.

---

## What closes the ticket

- [ ] `/lab/network` shows the video above the live piece, on the real site
- [ ] It plays for someone who is not signed in to anything
- [ ] The take is kept — it is STC-319's fixture
- [ ] The README slot is filled

Not required, and deliberately so: auto-zoom. This ships hand-framed, trim
only. `zoom-1` is a derived, overridable sidecar, so turning it on later
re-frames this exact take without a re-shoot (STC-324).
