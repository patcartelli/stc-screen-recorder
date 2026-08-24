# Phase 0 spike — FINDINGS

Machine: Apple Silicon (arm64), macOS 27.0 (26A5416b), Chrome 151.0.7922.170.
**Main display at capture time: 6016×3384 backing pixels** (3008×1692 pt @ 2.0), 60.000 Hz.
Camera: Elgato Facecam 4K (USB2). Mic: Elgato Wave:3.

Status: **COMPLETE. Gates 1, 3, 4 PASS. Gate 2 is not evaluable as written — its click reference carries
12–54 ms of BLE HID jitter — but the measurement it was reaching for (camera ↔ mic alignment) PASSES at
+1.8 ms median. Gate 5 exercised: TCC never wedged; one genuine CoreAudio zombie state found.**

**Verdict: the Electron + Swift-helper route is confirmed. Phase 1 can start.** The binding constraint
is capture resolution (§3), not the browser and not the clock.

---

## THE HEADLINE

Two independent things would each have silently broken the product, and both are now pinned down:

1. **`mach_absolute_time()` is not nanoseconds here** (125/3 → 41.667 ns/tick), but
   **`CGEvent.timestamp` *is* nanoseconds** — so the two clocks need *different* handling despite
   both being "time since boot". Mixing them up is a 41.667× error.
2. **H.264 hardware encode falls off a cliff immediately above 3840×2160.** This machine's own
   display is 6016×3384, which cannot be encoded at 60 fps by any codec available.
3. **At 4K the Chromium pipeline is not close to being the bottleneck** — decode runs at 7.9× real
   time and a 10 s export takes 6.5 s, at 95% of native encoder speed. The WebCodecs route is viable;
   the constraint is the capture resolution, not the browser.

---

## 1. Clock model — ANSWERED

```
mach_timebase_info: numer = 125, denom = 3     →  1 mach tick = 41.6666… ns  (24 MHz)

displayTimeNs = SCStreamFrameInfo.displayTime * 125 / 3      ← mach ticks, MUST convert
eventNs       = CGEvent.timestamp                            ← ALREADY nanoseconds, do NOT convert
```

Both land on the **same epoch** (nanoseconds since boot), so once converted they are directly
comparable with no offset term.

### How this was decided (not by eye)

The capture records a concurrent `mach_absolute_time()` at the instant each callback fires, so
`recv − t` must be a small positive delivery latency. Under the wrong unit hypothesis it is absurd:

| hypothesis | median(recv − t) | verdict |
|---|---|---|
| `CGEvent.timestamp` is mach ticks | **−4,157,907,523 ms** | absurd |
| `CGEvent.timestamp` is nanoseconds | **+0.41 ms** | ✅ correct |

Event-tap delivery latency: **p50 0.41 ms, p95 1.15 ms, max 7.09 ms** (950 events, 1 tap re-enable
after a `tapDisabledByTimeout` — the re-enable path works).

### `displayTime` is a *future* timestamp — important

`median(recvMachRaw − displayTimeRaw) = −7.12 ms` (range −13.76 … +3.79 ms). It is **negative**:
SCK hands you the frame ~7 ms *before* the `displayTime` it carries. So `displayTime` is the
**scheduled VBL presentation time** — when the pixels hit the glass — not when the frame was captured
or delivered. That is the right reference for "what the user saw", which is what a cursor overlay
needs, but any code that treats it as a capture instant will be ~7 ms early with ±8 ms of spread.

### `displayTime` is exactly VBL-quantised

Consecutive real frames differ by **400000 ± 2 mach ticks = 16.66667 ms**, i.e. exactly 1/60 s with
±83 ns of jitter. Drift of real frames against a perfect 60 Hz grid anchored at the first frame:

```
first 10 avg  = 0.0000 ms
last  10 avg  = 0.0000 ms
max |drift|   = 0.0004 ms      (400 nanoseconds, over 12 s)
```

**Gate 1's drift half passes by ~40,000×.** There is no clock drift to model. A single constant
offset is sufficient; the remaining unknown is only that constant, which the harness slider measures.

---

## 2. Camera / mic clock — ANSWERED

Both AVFoundation tracks carry presentation timestamps **on the same mach host clock** as `displayTime`
(magnitudes match to the millisecond), so no clock conversion or rebasing is needed — use the raw
values on a common ns timeline.

| track | timescale | PTS vs concurrent mach | meaning |
|---|---|---|---|
| camera | 30000 | **91.48 ms** in the past | USB2 Facecam pipeline latency |
| mic | 48000 | **18.16 ms** in the past | audio buffer latency |

The PTS is stamped at *acquisition*, and the sample arrives that much later — i.e. AVFoundation has
already latency-compensated for you. Session-start anchors (not skew): camera's first frame lands
**+1035.5 ms** after the first screen frame (camera warm-up), mic's **−94.7 ms** before it.

The *timestamps* above are sound. The *audio file* from run 1 was not — see §2a. So gate 2's clock half
is answered and its acoustic confirmation is still outstanding.

---

## 2a. The mic track was broken — and the fix is a correctness issue, not convenience

Run 1's `mic.m4a` was unusable:

```
duration            16.35 s   (recording was 12 s)
per-second mean|x|  0.335 0.333 0.328 0.337 ... 0.343    ← every second identical
peak 1.0, 1.11% of samples clipped
```

A dead-flat full-scale level across 16 s is structureless noise — real room audio always has dynamic
range, if only silence between the spoken cues. There was no clap in the file to find. An automated
clap search over it returned a confident, entirely meaningless answer, which is worth remembering: the
detector had no way to know its input was garbage. It now refuses to report a verdict when
`max/min` per-second level is under 2×.

Two changes, one of which is a correctness argument rather than a bug fix:

1. **`AVCaptureAudioDataOutput.audioSettings` now pins LPCM 48 kHz / 1 ch / 16-bit signed**, instead of
   accepting whatever the device (an Elgato Wave:3) hands over, and the first sample's ASBD is logged
   so a format mismatch is visible immediately rather than as noise.
2. **The mic track is written as LPCM `.wav`, not AAC `.m4a`.** This is not just convenience:
   **AAC encoder priming inserts 1024–2112 samples (21–44 ms at 48 kHz) of delay** at the head of the
   stream. Gate 2's whole tolerance is ±16.7 ms. A compressed mic track cannot measure a budget
   smaller than its own priming delay. **Any A/V alignment measurement must be made against
   uncompressed audio.**

**Also self-inflicted:** the spoken operator cues (`say`) are captured by the mic, so a *global* peak
search finds speech onsets rather than the clap. Onset detection is now windowed to ±250 ms around each
click event, which asks the right question directly — "is there a transient at the moment of the
click?" — instead of hunting for the loudest thing in the file.

### A Bluetooth mic stalls the whole capture

Run 2 hung. `startCapture`'s completion handler never fired; the process sat alive indefinitely with
three 0-byte output files and no error anywhere. The only difference from the working run was the
default audio input:

```
AV camera=Elgato Facecam 4K [USB2] mic=Patrick's AirPods Pro enabled=true
>>> starting capture; recording 12.0s
<nothing, forever>
```

Grabbing a Bluetooth mic with `AVCaptureSession` forces an A2DP→HFP renegotiation that stalls the
media stack, and ScreenCaptureKit's start never completed behind it. Three fixes:

1. **Never select a Bluetooth input.** `AVCaptureDevice.transportType == 'blue'` is now skipped in
   favour of any wired/USB device, with a loud log line. Independent of the hang, **a Bluetooth mic is
   disqualifying for gate 2 on its own**: it adds 150–300 ms of latency and HFP input drops to 16 kHz,
   both far outside a ±16.7 ms budget.
2. **Start ScreenCaptureKit before the AV session**, so an audio device renegotiating cannot block
   screen capture.
3. **Watchdogs.** An 8 s check that logs if `startCapture` never signals, and a hard
   `RECORD_SECONDS + 25` timer that forces shutdown so partial output is written rather than lost.
   A real-time capture path must never have an unbounded wait on a completion handler.

### Killing that process wedged CoreAudio system-wide — the closest thing to a gate 5 zombie state

After force-killing the hung capture (which held the AirPods as its input),
**`AVCaptureDevice.devices(for:.audio)` began hanging indefinitely for every process**, including a
fully-granted one. Run 3 then hung one line *earlier* than run 2 — inside device enumeration, before
capture even started:

```
[..] screen writer ready 3840x2160
<nothing, forever>            <- stuck in AVCaptureDevice.devices(for: .audio)
```

This is a real zombie state: it survives process death, it is not TCC-related, and it needs
intervention (disconnect the Bluetooth device, or `sudo killall coreaudiod`) rather than clearing on
its own. It is the one thing found in this spike that a user could hit and be unable to recover from
without knowing the trick.

*I initially mis-diagnosed this as an artefact of my own diagnosing shell (which does lack camera/mic
grants, and does block on undisplayable TCC prompts — that part was true). The hang reproducing inside
the user's granted terminal disproved that reading. Recorded because the two failure modes look
identical from the outside and the wrong one is the comfortable conclusion.*

**This is a shippable-product risk, not just spike friction.** The user's audio device switching was
left frozen on the Bluetooth device and could not be changed until `coreaudiod` was restarted manually.
A screen recorder that grabs the default input — which will often be AirPods — and is then killed,
crashes, or is force-quit can leave a user's audio unusable with no obvious cause and no in-app remedy.

**Design consequences, all now implemented:**

0. **Release capture devices on the way out.** `SIGINT`/`SIGTERM`/`SIGHUP` handlers now call
   `AVCaptureSession.stopRunning()` before exiting, on a background queue so they still fire when the
   main thread is blocked. Being killed while holding the device is what wedged CoreAudio.

1. **Optional subsystems must not sit on the critical path.** Camera/mic setup now runs off-main with
   an 8 s timeout and is abandoned on stall — screen and events still record, so gate 1 survives a
   wedged audio stack entirely. A `--no-av` flag skips them outright.
2. **Watchdogs must not live on the queue they are guarding.** The first watchdogs were
   `DispatchQueue.main.asyncAfter` timers scheduled *after* the call that blocked the main thread, so
   they could never fire. The hard watchdog is now armed on a background queue as the first statement
   in `run()`, before anything can block.

### GATE 1 — PASS, and the offset is zero

Operator verification in the harness on run 3 (331 real frames, 0 dropped): the interpolated cursor
crosshair sits on the clicked targets **at an offset of 0 ms**, and holds across clicks separated by
7 seconds and most of the screen (#1 at 8%/7%, frame 152 → #4 at 77%/80%, frame 582).

**No fudge factor is required.** Applying

```
displayTimeNs = SCStreamFrameInfo.displayTime * 125 / 3     (mach ticks → ns)
eventNs       = CGEvent.timestamp                           (already ns)
```

places cursor events on screen frames correctly with nothing added. Combined with the measured drift of
**0.0000 ms** (max |drift| across the clip, §1) and reproduction across two runs at different
resolutions, the clock model is settled: **one clock, two unit conventions, no offset, no drift.**

This is the result the spike existed to get, and it is the good outcome — the alignment problem that
would have justified re-architecting does not exist. What remains is engineering.

---

## 3. THE ENCODER CLIFF — the biggest architectural finding

VideoToolbox via `AVAssetWriter`, 600 pre-rendered high-entropy frames, encode-only (no drawing in the
timed loop), 50 Mbps:

| codec | resolution | MP/frame | fps | throughput | 60 fps? |
|---|---|---|---|---|---|
| H.264 | **3840×2160** | 8.3 | **97.5** | **0.81 Gpx/s** | ✅ |
| H.264 | 4480×2520 | 11.3 | 22.3 | 0.25 Gpx/s | ❌ |
| H.264 | 5120×2880 | 14.7 | 16.7 | 0.25 Gpx/s | ❌ |
| H.264 | 6016×3384 | 20.4 | 12.1 | 0.25 Gpx/s | ❌ |
| HEVC | 3840×2160 | 8.3 | 53.0 | 0.44 Gpx/s | ❌ |
| HEVC | 5120×2880 | 14.7 | 30.4 | 0.45 Gpx/s | ❌ |
| HEVC | 6016×3384 | 20.4 | 22.1 | 0.45 Gpx/s | ❌ |

Read the **throughput** column, not the fps column. H.264 does **0.81 Gpx/s at exactly 4K and 0.25
Gpx/s at every size above it** — a 3.2× cliff, then perfectly linear scaling. That flat 0.25 is the
signature of a **software fallback**: Apple's H.264 hardware encoder tops out at 3840×2160.

HEVC holds a constant 0.44–0.45 Gpx/s at all sizes (no cliff — one consistent path), making it **1.8×
faster than H.264 above 4K**, but still nowhere near 60 fps at 6K.

Bitrate is irrelevant: 6016×3384 at 25 Mbps ran at 17.8 fps vs 18.7 at 50 Mbps — **pixel-rate bound,
not bitrate bound.** Run-to-run variance across a long benchmark was significant (6K H.264 measured
18.7 fps in a 3-case run and 12.1 fps in a 7-case run) — thermal throttling is real, so treat these as
upper bounds.

**Consequence:** you cannot record this 6K display natively at 60 fps. Downscaling in
`SCStreamConfiguration.width/height` (a free GPU scale before delivery) back onto the 4K fast path is
the only option that hits 60 fps.

---

## 4. CFR-by-repeat is actively harmful — design change

The first capture, at native 6016×3384, produced:

```
SCK complete frames delivered : 142   (+336 idle)   in 12 s
frames actually encoded       : 57 real + 261 repeat = 318
frames DROPPED at the writer  : 85    ← 60% of all real content, lost
```

The spec's CFR strategy (repeat the last frame on `.idle`/`.blank`) spent **261 of 318 encoder slots —
82% — writing duplicate frames**, while 85 frames of *real* screen content were dropped because the
saturated encoder wasn't ready. On a bottlenecked encoder, CFR-by-repeat evicts exactly the content
you are trying to record.

**Changed to VFR:** write each real frame at its true `displayTime`-derived PTS and leave gaps. This
costs nothing (a player holds the last frame anyway), frees the entire encoder budget for real content,
and removes a second hazard — the repeat path had to retain an SCK pool `CVPixelBuffer` indefinitely,
which starves `queueDepth` and throttles the stream.

CFR belongs at **export** time, not capture time. The harness's encode panel already produces CFR 60 fps
output, which is the correct place for it.

*(This also broke the harness: with VFR, a sample's ordinal is no longer its timeline index. Fixed —
the harness now derives the index from `cts` and resolves a timeline slot to the last sample at or
before it.)*

---

## 4a. Run 3 — the fixes verified, and the clock model reproduced

Same machine, display now 5120×2880, captured at 3840×2160 via the 4K cap:

| | run 1 — native 6016×3384 | run 3 — capped 3840×2160 |
|---|---|---|
| complete frames from SCK | 142 | 331 |
| encoded | 57 real + 261 repeat | **331 real, 0 repeat** |
| **dropped** | **85 (60% of real content)** | **0** |

**Zero dropped frames.** This confirms §3 and §4 together: the drops were encoder saturation above the
4K hardware ceiling, and the CFR repeat-fill was compounding it by spending the budget on duplicates.
Cap at 4K, write VFR, and the problem disappears entirely.

The clock model reproduced across two runs on different display configurations and different capture
resolutions:

| measurement | run 1 (6016×3384) | run 3 (3840×2160) |
|---|---|---|
| `CGEvent.timestamp` verdict | nanoseconds | nanoseconds |
| event-tap delivery latency (p50) | 0.41 ms | 0.22 ms |
| `recvMach − displayTime` (p50) | −7.12 ms | −6.94 ms |
| drift vs 60 Hz grid (max) | 0.0004 ms | 0.0000 ms |
| camera PTS latency | 91.5 ms | 115.8 ms |
| mic PTS latency | 18.2 ms (Wave:3) | 13.5 ms (Wave:3) |

The `displayTime`-is-~7 ms-in-the-future result is stable to 0.2 ms across runs, so it is a property of
the pipeline, not noise. Camera latency varies run to run (91.5 → 115.8 ms) — USB2 webcam pipelines are
not consistent, which is an argument for anchoring on PTS rather than any measured constant.

Mic path verified fixed: `fmt='lpcm' sr=48000 ch=1 bits=16 flags=12`, file duration 12.13 s for a 12 s
recording (the AAC path produced 16.35 s for the same 12 s).

### Gate 2 remains unmeasured — the take, not the clock

Run 4 finally contains a real clap: **0.0 dBFS at 6.4132 s, crest factor 159.5×**, onset localised to
6.4127 s. It maps to **screen frame 404.05** and **camera track 5.2368 s**. But the operator clapped
without clicking at the same instant — the nearest click is **1.97 s away** — so the clap↔click pairing
the gate specifies is not present. Nothing about the clock data is in question; the take is simply
missing the simultaneity.

The analyzer now reports the clap on all three timelines and refuses a verdict when no click is within
250 ms, rather than pairing it with whatever click happens to be closest.

### Gate 2 status: one usable sample, +24.7 ms, inconclusive

Run 5 finally paired a clap with a click. Selecting the loudest transient *coincident with a click*
(rather than the loudest in the file, which was an unpaired clap at −0.3 dBFS) gives:

```
click 5.0394s -> sound onset 5.0642s   Δ = +24.7 ms (1.48 frames)   -6.9 dBFS   SNR 80x   USABLE
click 0.7672s -> sound onset 0.6773s   Δ = -89.9 ms                -30.9 dBFS   SNR  5x   rejected
click 10.9583s -> sound onset 10.9880s Δ = +29.7 ms                -32.4 dBFS   SNR  4x   rejected
```

**One usable sample cannot settle this gate.** Human coordination between a clap and a click is easily
±50 ms, so +24.7 ms is indistinguishable from the operator simply being 25 ms late. Sound travel time
is not a candidate explanation — at ~1 m that is under 3 ms.

Suggestive but not yet claimable: the +29.7 ms rejected sample agrees closely with the +24.7 ms usable
one. If a proper take confirms a systematic **+25–30 ms**, that exceeds the ±16.7 ms gate and means
**mic PTS is under-compensated by roughly 1.5 frames** — a real, correctable constant, and precisely the
kind of thing this gate exists to find. It is equally possible both are human lag.

**The experiment that removes the human:** click a loud mouse hard, several times. The sound *is* the
click, so acoustic event and `CGEvent` are the same physical event with zero coordination error, and
several samples give a distribution rather than an anecdote.

### Gate 2 cannot be evaluated as specified — the reference is the problem

Run 6: ten high-SNR samples, clicking a loud mouse so the sound *is* the click (no human coordination
error). Result:

```
mean Δ = -29.1 ms   sd = 15.8 ms   n = 10       (sound onset MINUS CGEvent timestamp)

cluster A:  -13.5  -15.2  -13.7  -20.1  -12.0     -> mean ~ -15 ms
cluster B:  -54.1  -45.6  -37.1  -36.0  -43.2     -> mean ~ -43 ms
```

Two things matter here. **Every sound precedes its click event**, and the deltas are **bimodal**, not
scattered — two tight clusters ~28 ms apart, not a normal distribution around some value.

The machine has a **BLE mouse** attached (`Services: 0x400020 < HID BLE >`). Bluetooth Low Energy HID
delivers on a connection interval, typically 7.5–30 ms, so the physical press waits for the next
connection event before the HID stack timestamps it. That produces exactly this signature: a delay that
is always positive (event after sound), variable, and **quantised into clusters at multiples of the
connection interval**.

**`CGEvent.timestamp` is not when the user clicked. It is when the input stack received the click** —
12–54 ms later on this wireless mouse, and quantised, not smoothly distributed.

**Therefore gate 2, as written, cannot be evaluated.** It asks whether a clap and a click agree to
within ±16.7 ms, using as its reference a timestamp that is itself uncertain by ±20 ms for reasons that
have nothing to do with audio or video. No amount of care in the mic path can settle a ±16.7 ms question
against a ±20 ms reference. This is not the clock model failing — §1 and gate 1 show the clock model is
exact — it is the gate's chosen reference being unfit for its own tolerance.

**What should replace it — built, in `avcheck.sh`.** Measure **camera ↔ mic directly**, using a clap as a
single physical event that both sensors observe, and no input device at all:

- `cammotion` (Swift, `AVAssetReader`) decodes every camera frame to a 160×90 luma grid and emits
  per-frame motion energy, attributed to the **midpoint** of each frame interval (a half-frame bias
  would be ~8 ms here, half the tolerance).
- `avsync.cjs` locates clap transients in `mic.wav` above a 15× SNR floor, finds the camera motion peak
  within ±300 ms, refines it by parabolic interpolation for sub-frame precision, and reports
  `camera − mic` on the mach timeline.
- It refuses a verdict unless the motion peak is ≥8× the mean motion and at least 2 claps are usable.
  Verified against a clap-free take: it rejected all candidates (prominence 2.7× vs the 8× floor)
  rather than emitting a number.

Both tracks are timestamped by AVFoundation on the mach host clock (§2), so this measures precisely the
thing the product needs — whether camera and mic line up on the recording timeline — with no HID stack
in the loop. Resolution is bounded by the camera interval (~17 ms at 59 fps); a small negative bias is
physical, since motion peaks at maximum hand velocity, at or just before impact.

### The replacement measurement — camera ↔ mic = +1.8 ms, PASS

Run 7: ten claps at 0.0 dBFS (SNR 113×), matched against camera motion peaks. No input device involved.

```
 8 usable claps
 CAMERA − MIC   median  +1.8 ms   (MAD 6.0 ms)      = 0.11 frames @60fps
                mean    -5.9 ms   (sd 17.7 ms, pulled by one outlier)
 one outlier at -45.8 ms — a mis-picked motion peak, excluded by the median
 camera sampling interval 16.6 ms
```

**A/V ALIGNMENT: PASS** — median |Δ| of 1.8 ms against a 16.7 ms tolerance, roughly 9× inside it. The
MAD of 6.0 ms is *smaller than the camera's own 16.6 ms sampling interval*, so the observed spread is
this method's resolution rather than real jitter between the tracks.

This is the result gate 2 was reaching for: **camera and mic land on the same timeline, to within a
fifth of a frame, using nothing but each track's AVFoundation PTS on the mach host clock.** No
per-track offset or rebasing is required in the product.

*One calibration note:* the first attempt at this measurement rejected all ten claps, because the
prominence threshold compared each motion peak to the **global** mean motion. In a scene where the
operator is moving continuously (mean motion 23.3 here vs 3.6 in a still take), a clap simply cannot be
8× the global mean, though it remains an obvious *local* maximum. Switching to local prominence — peak
versus the median motion in a ±300 ms window — recovered 8 of 10. **A detector threshold has to be
scaled to the local context, not to a global statistic of a scene whose activity level varies.**

**This also qualifies gate 1.** The cursor-alignment check was performed on *deliberate, paused* clicks,
where a stationary cursor makes the crosshair position insensitive to the offset. The **drift** half of
gate 1 is solid — it is a numeric result, 0.0000 ms, reproduced across runs. The **constant-offset**
half is confirmed only to the resolution the test can support, and BLE input latency means the true
event-to-physical-action offset is 12–54 ms even though the event-to-frame mapping is exact. For a
cursor overlay this is largely harmless (a paused cursor is in the same place either way), but any
feature that claims "the user clicked *here, then*" inherits it.

### The health-check lesson (four false verdicts, one correct estimator)

Run 3's mic track peaks at **0.058 (−24.7 dBFS)** with a flat envelope (0.026–0.058 across all 12 s).
There is no clap in the file — **because the operator did not perform one on that take.** With audio
output going to headphones, the room was silent and −24.7 dBFS is simply room tone; the Wave:3 was
working correctly. (An earlier draft of this document concluded the mic gain was too low. That was
wrong, and is exactly the kind of plausible-but-unfounded inference the health check below is meant to
prevent.)

The detector nonetheless fitted the noise and produced a confident
"CLAP − CLICK = 242.7 ms, GATE 2: FAIL" — **the second time in this spike that an absent input produced
a precise, meaningless verdict.**

Three times in this spike a confident, precise gate 2 number came out of data that could not support one:

| take | data | verdict produced | reality |
|---|---|---|---|
| run 1 | AAC track, structureless noise | `FAIL, −515.9 ms` | no signal at all |
| run 3 | quiet room, no clap performed | `FAIL, 242.7 ms` | no clap |
| run 4 | real clap, no simultaneous click | *(rejected)* | ✅ caught |
| run 5 | 1 real pair + 2 noise-floor fits | `PASS, mean −11.8 ms` | ✅ caught — the −89.9 ms noise fit was cancelling the two positives; `sd = 67.6 ms` was the tell |

The estimator was correct every time; the **input** was not. And the first health check I added
(per-second mean level ratio ≥ 2×) *rejected the one good take* — a clap is a ~10 ms transient and barely
moves a one-second mean. It now gates on **crest factor** (peak / mean|x|), which separates the cases
cleanly: 3.0× for the broken noise, 6.1× for the quiet take, **159.5× for the real clap**.

The fourth case is the most instructive, because the data was no longer absent — it was *mixed*. Two of
three "measurements" were the detector fitting the noise floor, and averaging them in produced a
confident PASS with the correct sign flipped. The fix was an SNR floor (transient peak ≥ 15× mean|x|),
which drops n from 3 to 1 and turns a false PASS into an honest "inconclusive".

**Recorded as a lesson in its own right: validating that the input contains the signal matters more than
refining the estimator; the validity check needs to be a statistic the signal actually moves; and a
plausible-looking mean over few samples hides more than it shows — the spread is what exposes it.**

---

## 4b. WebCodecs lessons from building the harness (these apply to the product)

The harness crashed the tab repeatedly. The causes are not harness-specific — the product will have a
scrubbing timeline doing exactly this, so they are worth recording.

1. **A `VideoDecoder` must be driven by exactly one in-flight request.** The frame slider was wired
   `oninput -> draw()`, and `draw()` is async. A single slider drag fires dozens of events, each starting
   an overlapping decode against the *same* decoder — resetting it mid-flight and leaking 4K/6K
   `VideoFrame`s until the tab died. Fixed by serialising with a coalescing queue that keeps only the
   most recently requested frame. **Any scrub/seek UI needs this; it is not optional.**
2. **A batched-flush decode loop must not also reset on overshoot.** The seek loop flushed the decoder
   every 8 submitted chunks but tested `if (next > pos) reset()` every iteration. Because outputs only
   appear after a flush, the loop would submit the target, see an empty queue, conclude it had overshot,
   reset, and repeat — **an infinite loop allocating a fresh `VideoDecoder` every spin**, which blanked
   the tab the instant any video loaded. Rewritten to decode forward from the governing keyframe with a
   strictly advancing counter, then flush once. Verified headlessly against a mock decoder: forward,
   backward, repeated and out-of-range seeks all terminate and return the right frame.
3. **`VideoFrame`s must be closed in the output callback, not buffered.** At 6016x3384 one frame is
   ~30 MB, so even a short backlog is hundreds of MB. The seeker now names the frame index it wants
   before decoding and closes every output that is not it — retaining **at most one** frame regardless
   of resolution or GOP length.
4. **Chrome's H.264 decoder appears to share VideoToolbox's ~4K ceiling.** Decoding the native 6016x3384
   capture is where the crashes concentrated — consistent with §3's encoder cliff. The harness now warns
   above 3840x2160 and caps re-encode at 4K rather than allocating a 6K canvas and encoder.
5. **mp4box.js exposes `DataStream` as its own browser global, not as `MP4Box.DataStream`** — the latter
   only exists on the CommonJS export. Calling `new MP4Box.DataStream(...)` threw inside a promise
   executor, which left the promise **never settling**, so `await demux()` hung forever with no error
   anywhere. A throw inside `new Promise(async ...)` is silent unless you catch and `reject` explicitly.
6. **Camera frames do not land on a 60 Hz grid.** The camera ran at ~58.8 fps, so rounding
   `cts` onto 60 Hz produced duplicate indices and broke a binary search that assumed monotonicity.
   Keep the true presentation time separately from any grid index.

---

## 5. Gate results

| # | Gate | Pass condition | Result |
|---|---|---|---|
| 1 | Cursor dot on target, start + end, one offset | ±16.7 ms, no drift | **PASS — offset 0 ms, drift 0.0000 ms** |
| 2 | Camera clap ↔ click | ±1 frame @60 | **NOT EVALUABLE AS SPECIFIED** (click reference carries 12–54 ms BLE jitter). **Replacement measurement PASSES: camera ↔ mic = +1.8 ms median** (§4a) |
| 3 | 4K decode→canvas ≥60 fps | | **PASS — 471.6 fps** (7.9× margin) |
| 4 | 10 s 4K export <30 s | | **PASS — 6.46 s** (4.6× margin), output verified playable |
| 5 | grant → revoke → re-grant | no wedge | **PASS for permissions** — reached recording state every time, all failures fast and specific, no reboot. Two sharp edges + one non-TCC zombie state, all below |

### Why run 1 cannot settle gate 1

Every click landed inside a dropped-frame gap, because the saturated 6K encoder discarded exactly the
frames that mattered:

```
click 1: timeline frame 136 → newest real frame  30  = 1.77 s stale
click 2: timeline frame 314 → newest real frame 271  = 0.72 s stale
click 3: timeline frame 470 → newest real frame 453  = 0.28 s stale
click 4: timeline frame 604 → newest real frame 504  = 1.67 s stale
click 5: timeline frame 631 → newest real frame 504  = 2.12 s stale
```

The video shows content up to 2 s stale at the moments the operator clicked, so the crosshair cannot
line up at *any* offset. This is an encoder-saturation artefact, not a clock error — and it is the
direct consequence of §3 and §4. Re-capture at 3840×2160 settles it. The harness now detects this
condition and says so, rather than leaving the operator adjusting a slider that cannot converge.

### Gates 3 and 4 — measured in Chrome 151, WebCodecs, 3840×2160

```
decode -> canvas   720 frames @ 3840x2160 in 1526.6 ms  ->  471.6 fps    gate 3 needs >= 60   PASS
encode 10 s        600 frames @ 3840x2160 in 6.46 s     ->   92.9 fps    gate 4 needs < 30 s  PASS
output             50,089,567 bytes, 40.1 Mbps, avc1.640034, 600 samples, keyframe every 60
```

Decode throughput is **3.91 Gpx/s** — 7.9× the real-time requirement, with the full clip drawn to a
canvas each frame. Ample headroom for compositing cursor and camera layers on top.

**Cross-check that matters:** Chrome's WebCodecs encoder hit **92.9 fps** where native `AVAssetWriter`
hit **97.5 fps** on the same machine and resolution (§3) — **95% of native**. Chrome is using the same
VideoToolbox hardware path, not a software fallback. So §3's 4K ceiling applies to the browser side
too, and the two measurements corroborate each other.

Export verified through AVFoundation (which is what QuickTime uses):

```
isPlayable = true, status = loaded, duration = 10.0 s
video track 3840x2160, nominalFrameRate 59.99875, 40 Mbps, avc1
frame decoded at t=5 s -> 3840x2160
```

**`prefer-software` was also run, and it fails at 4K60.** Its output is truncated:

```
prefer-hardware   600 samples  10.00 s  47.8 MB  40.1 Mbps   <- complete, gate 4 PASS
prefer-software   116 samples   1.93 s   2.4 MB  10.3 Mbps   <- truncated at 19% of the frames
```

The software encoder could not sustain 4K60 and the muxer finalised with 116 of 600 frames at a quarter
of the requested bitrate. So the hardware path is not merely faster — **it is the only working path at
4K60 in Chrome**, and a `prefer-software` fallback is not a fallback. Consistent with §3: above the
hardware fast path, H.264 at this pixel rate is simply not achievable in software on this machine.

---

## 6. Permissions (gate 5)

All four grants (Screen Recording, Input Monitoring, Camera, Microphone) attach to
**STC Spike Capture** — an ad-hoc-signed `.app` with `LSUIElement` and the usage-description keys,
launched via `open`. Deliberately *not* a bare CLI binary: that would attribute grants to the terminal
via the responsible-process rule, leaving nothing revocable to test and polluting the dev environment.

| step | observed |
|---|---|
| ungranted → `SCShareableContent` | fails in **~10 ms**, `-3801 "user declined TCCs"`. **No hang.** The 4 s timeout guard was never needed |
| `CGPreflightScreenCaptureAccess()` | told the truth in every ungranted case tested — returned `false`, matching the real call. Never lied |
| grant → capture | ✅ worked first try, **no relaunch needed** (contrary to the expected "one odd run") |
| **rebuild the binary** | ⚠️ **silently revoked the Screen Recording grant.** Ad-hoc signature ⇒ cdhash identity; recompiling makes it a different app to TCC. Failure was clean (`-3801`), not a wedge |
| explicit revoke (`tccutil reset`) → re-grant | ✅ worked; all four services (ScreenCapture, ListenEvent, Camera, Microphone) re-prompted and re-granted cleanly. No wedge, no reboot |
| **launch method changes the TCC identity** | ⚠️ **the single most confusing behaviour found.** See below |

### The same binary has two different TCC identities

Five seconds apart, same binary, same machine:

```
./STCSpikeCapture.app/Contents/MacOS/STCSpikeCapture --probe    (from the user's Terminal)
   -> CGPreflightScreenCaptureAccess=true, screenRecording=OK, camera=true, mic=true, eventTap=true

open -a STCSpikeCapture.app                                     (via launchd)
   -> CGPreflightScreenCaptureAccess=false, -3801 "user declined TCCs"
```

**Exec'ing the binary directly makes it inherit the launching terminal's TCC identity** (responsible-process
rule); **`open -a` gives the app its own bundle identity.** A grant approved from one path does not apply
to the other, and `CGPreflightScreenCaptureAccess()` faithfully reports whichever identity the *current*
process is running under — so a preflight can read `true` and `false` for the same binary depending only
on how it was started. This is exactly the "preflight can lie" trap, except the preflight is honest and
the *identity* is what moved.

**Phase 1 implication — and it is good news.** The shipping design is Electron spawning a Swift helper as
a child process. The helper will therefore inherit **Electron's** TCC identity, which is what you want:
**one grant, against the signed app bundle the user actually recognises**, rather than a second opaque
helper appearing in System Settings. But it also means the helper *cannot* be tested standalone from a
terminal and have that prove anything about the shipped app — the terminal's grants are what is being
exercised, not the app's.

**Gate 5 verdict: PASS on its stated criteria.** Every permission path reached the recording state,
every failure was a fast, specific, correctly-reported error rather than a hang, and nothing required a
reboot. Full cycle exercised: grant → `tccutil reset` (revoke) → re-grant, across all four services.

Two sharp edges that phase 1 must design around, and one hazard that is not a permissions problem at all:

1. **Ad-hoc signatures make grants disposable** — every rebuild silently revokes. A stable Developer ID
   certificate is mandatory, or development looks like a permanent permissions bug.
2. **The launch method decides the TCC identity** (see above) — good news for Electron spawning a
   helper, but it means a terminal-tested helper proves nothing about the shipped app.
3. **The CoreAudio wedge (§2a) is the one real zombie state found** — and it is not TCC-related. It
   survived process death and needed `sudo killall coreaudiod` to clear. It was caused by force-killing
   a process that held a Bluetooth audio device.

**Phase 1 implication:** a stable **Developer ID** signature is required, otherwise every rebuild
during development silently drops the user's grants. In dev this looks exactly like a permissions bug.

---

## 7. Toolchain constraint

`swiftc` **5.8** / **MacOSX13.3.sdk** (Command Line Tools, April 2023). No Xcode.app. On macOS 27.

- `SCStreamConfiguration.captureResolution` (macOS 14+) is absent from the 13.3 headers but present on
  the macOS 27 runtime — reachable via KVC (`setValue(3, forKey: "captureResolution")`, verified). The
  explicit `width`/`height` is what actually governs output size anyway.
- Everything else the spike needs is macOS 12.3-era API and compiles clean.
- Anything wanting macOS 14+ SCK API (`SCContentSharingPicker`, HDR, `SCScreenshotManager`) needs a
  real Xcode install.

## 8. Verified encoder settings

`avc1.640034` (High @ L5.2), 3840×2160, GOP exactly 45, CTS strictly monotonic, ~104 KB/frame ≈ 50 Mbps.
**`AVVideoAllowFrameReorderingKey: false` matters** — no B-frames means decode output order equals
input order, which is what lets the harness map a decoded frame back to an index without a PTS sort.

## 9. Surprises

1. The two "time since boot" clocks use **different units** — mach ticks vs real nanoseconds. Any
   reasonable person would assume they match. On Intel (`numer==denom==1`) they do, so this bug is
   invisible outside Apple Silicon.
2. `displayTime` is **~7 ms in the future** — a presentation timestamp, not a capture timestamp.
3. **H.264 hardware encoding stops dead above 4K.** Not a gentle slope: 0.81 → 0.25 Gpx/s in one step.
4. The prescribed CFR-by-repeat strategy **destroyed 60% of the recording** it was meant to regularise.
5. `SCShareableContent` never hung, and `CGPreflightScreenCaptureAccess()` never lied — both contrary
   to the spike brief's warnings.
6. **AAC priming delay (21–44 ms) exceeds gate 2's entire ±16.7 ms budget**, so the brief's own
   `mic.m4a` cannot in principle measure the thing gate 2 asks about. Uncompressed audio is mandatory.
7. The spoken operator cues land in the mic track and defeat naive clap detection — the measurement
   apparatus polluted its own signal.
8. A broken input produced a confident, precise, completely wrong gate 2 verdict. Health-checking the
   input mattered more than refining the detector.
6. A 2023 SDK drives macOS 27 ScreenCaptureKit fine, with KVC as the escape hatch.

## 10. Reproduce

```
scratch/build.sh                     # → STCSpikeCapture.app (NB: invalidates TCC grants)
scratch/grant.sh                     # open the TCC panes
scratch/STCSpikeCapture.app --probe  # permission check, no recording
scratch/run.sh                       # 12 s capture via `open -a` (app's own TCC identity)
scratch/run-direct.sh                # 12 s capture, exec'd directly (inherits the terminal's identity)
scratch/run-direct.sh --no-av        # ... screen + events only; immune to a wedged audio stack
node scratch/analyze.cjs             # clock model, drift, camera/mic anchors — terminal only
node scratch/clap.cjs                # gate 2 as specified: clap vs click (confounded by HID latency)
scratch/avcheck.sh                   # gate 2 REPLACEMENT: camera <-> mic from a clap, no input device
scratch/encbench                     # encoder throughput table (§3)
scratch/gen                          # synthetic 4K60 clip → out-synth/ (gates 3/4, no TCC needed)
scratch/revoke.sh                    # gate 5: revoke all four grants
open scratch/harness.html            # Chrome: visual gate 1/2, and gates 3/4
```
