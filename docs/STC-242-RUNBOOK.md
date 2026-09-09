# STC-242 runbook — getting an exported take onto the site

Written on Linux, so **nothing about the folder picker or Finder has been
seen**. The copy, the refusals, the naming and the snippet all run here under
`xvfb-run` and are covered by tests; the two things that need a Mac are the
native dialog and `showItemInFolder` actually selecting the file.

## What shipped

The last step of the loop — record → preview → export → **share**. Three
buttons under the preview:

* **Site folder…** — pick the folder in the site repo that holds the video.
  Chosen once, sticky, and stored where only the main process can set it.
* **Share to site** — copy this take's export into that folder as
  `<slug>.mp4`, and put the embed snippet on the clipboard.
* **Show published** — reveal the published file in Finder.

No upload, no auth, no third-party host. The ticket cut all of that once the
destination was decided; publishing to the web is `git push` in the site repo,
by a person who can look at the diff first.

## The one decision worth knowing

**The published file is named from a slug, not from the take.**

The export inside the take directory is `export-2026-09-09_14-22-05.mp4`, which
correctly names the recording it came from. On the site that is exactly wrong:
the page embeds a fixed path, so a timestamped name means editing the page every
time the demo is re-recorded — and STC-313 makes a point of the Music Network
take being *"re-recordable, which makes it the test article for every phase
after this one"*. A demo that costs a page edit to re-shoot is a demo nobody
re-shoots.

So the site gets `network.mp4` and keeps getting it. **Re-publishing replaces
the file**, which is the intended behaviour rather than an oversight. What is
owed in exchange is honesty about it: the status line says *Replaced* rather
than *Wrote* when something was already there. There is deliberately no
confirmation dialog — the folder was chosen by hand and the name comes from a
slug the user typed, so replacing that exact file is the whole operation, and a
prompt on every republish would be friction charged for doing what was asked.

The safety net is the site repo's own version control, which is a better one
than a modal: `git diff` shows the video changed, and `git checkout` puts the
old one back.

## Where to point it

The slug and the folder together decide both the file and the URL:

| slug | destination folder | the page then embeds |
|---|---|---|
| `network` | `<site>/public/lab/videos` | `/lab/videos/network.mp4` |

**This table was wrong until STC-313 checked it against the real site**, and
the way it was wrong is worth keeping. `publicSrc` assumed the destination was
served at `/lab/<slug>/` and produced `/lab/network/network.mp4` — the slug
twice, and a `public/lab/network/` directory sharing a name with `/lab/network`,
which is a live SSR route on that site. This document had already named it as
the most likely thing to be wrong and predicted the symptom exactly: a snippet
whose `src` 404s while the file sits in precisely the folder you chose.

Nothing found it for six days because **the copy and the snippet are decided
apart**. The copy lands wherever the picker points, so it was always correct;
only the path the page would ask for was wrong, and nothing in this repo can
see the page. The check that settles it is loading the URL.

The assumption still lives in exactly one function (`publicSrc` in
`app/src/share.ts`) and still takes an override, so a different layout changes
one line. **If your site serves videos from somewhere else, this is the number
to change** — and the snippet is what will be wrong first.

## The snippet is settled now, and it is not an HTML tag

The ticket made the embed snippet the optional half, gated on *"once the site's
video component shape is settled"*. STC-313 settled it by reading the site, and
the answer is not the shape this document expected.

The site renders lab demos from a **data module** (`src/data/lab-demos.ts`)
that a component reads. A page says `<LabVideo demo={labDemos.network} />` and
nothing else, so there is no `<video>` tag anywhere to paste one next to —
and pasting one would be a second way to put a video on that page, bypassing
the site's own build check that a published demo's file exists. What there is
actually a blank for is the data entry:

```jsonc
  network: {
    src: '/lab/videos/network.mp4',
    poster: '{poster}',
    width: 2464,
    height: 1386,
    label: '{label}',
    caption: '{caption}',
    published: true,
  },
```

`{poster}`, `{label}` and `{caption}` come through unsubstituted on purpose.
The first is a file the app does not produce; the other two are prose about
what the viewer is looking at, and a template that invented them would paste
plausible-looking wrong copy onto a portfolio page. That is the same failure as
`width="0"` one layer up: a wrong answer in a right answer's clothes.

It is still a **preference**, so a site that grows a different shape later
needs no code change here.

An unknown token is left unsubstituted rather than blanked, and so is a known
one whose value isn't available — an export with no readable manifest pastes
`width: {width}`, not `width: 0`. A zero reserves a collapsed box on the page;
a visible `{width}` is obviously a blank to fill in.

---

## What to check on the Mac

### 1. The folder picker

1. Open a take, press **Site folder…**.
2. Pick the folder in your site checkout. Confirm the status line names it.
3. Quit and relaunch, open a take: the folder should still be set. It is
   sticky, like the still destination and the display picker.

### 2. A real publish

1. Export a take (the existing **Export** button) and wait for *Done*.
2. Press **Share to site**. Expect *Wrote network.mp4. Snippet copied.*
3. Look in the folder: `network.mp4` is there, and it is the exported video —
   **play it**, don't just look at the size.
4. Paste somewhere. You should get the `<video>` snippet with real pixel
   dimensions, matching what the export bar reported.

### 3. The replace path — the one worth doing deliberately

1. Publish once. Publish again.
2. The second run must say **Replaced**, not *Wrote*.
3. `git status` in the site repo should show the video modified. That is the
   safety net doing its job; confirm you can `git checkout` it back.

### 4. Show published

1. Press **Show published**. Finder should open with the file **selected**,
   not merely the folder opened.
2. With nothing published yet, it should say so rather than opening a Finder
   window on an empty folder.

### 5. The refusals

Each of these has a sentence of its own; check the wording reads like something
a person would act on:

| do this | expect |
|---|---|
| Share a take you have not exported | *This take has not been exported yet — export it, then share.* |
| Clear the site folder (delete it from `settings.json`) and share | *Choose the folder in the site repo that holds the video first.* |
| Hand-edit `settings.json` to `"slug": "My Demo"` | Falls back to `network` — it does **not** quietly become `my-demo` |

That last one is a decision, not a bug: repairing a slug would publish to a path
you never chose and never saw, while the page embedding the old one broke
silently.

## What no test here can settle

* Whether the native folder picker defaults somewhere sensible on the second
  use (it is passed the stored path; unverified against a real dialog).
* Whether `showItemInFolder` selects the file rather than just revealing the
  directory. On macOS it should; on Linux the whole call is a no-op, so this
  is genuinely unobserved.
* **Whether the `/lab/<slug>/` assumption matches the real site.** This is the
  most likely thing to be wrong, and it will show up as a snippet whose `src`
  404s while the file itself is sitting in the right folder.

## Not here, and why

* **No upload.** Out of scope by the ticket, in as many words.
* **No "copy embed snippet" button of its own** — the snippet is copied by the
  publish itself, since wanting the file without the snippet is not a case
  worth a second button. If the clipboard write fails the status line says so
  and the publish still counts, because the file is the deliverable.
* **The manifest is not copied.** `export-<take>.json` records which transform
  encoded the video (STC-308) and belongs with the take, not on the site — the
  page has no use for it and it would be one more file to explain in a diff.
