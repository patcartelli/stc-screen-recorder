# Phase 1 — end-to-end vertical slice

**Goal:** record → composite → export, once, at low fidelity. Ugly is fine. The spike proved each
component in isolation; this proves them *composed*: display capture + cursor events → deterministic
transform → CFR MP4 with cursor overlay.

Full findings: [docs/PHASE-0-FINDINGS.md](docs/PHASE-0-FINDINGS.md).

## Settled by phase 0 — do not relitigate

| decision | why |
|---|---|
| Capture at **≤3840×2160**, H.264 | above 4K, hardware encode drops 0.81 → 0.25 Gpx/s (software fallback); nothing reaches 60 fps |
| **VFR at capture, CFR at export** | repeat-fill during capture spent 82% of a loaded encoder on duplicates and dropped 60% of real frames |
| `displayTimeNs = displayTime × 125/3` | mach ticks are 41.667 ns here, not 1 ns |
| `CGEvent.timestamp` used **as-is** | already nanoseconds, same epoch. Verified: offset 0 ms, drift 0.0000 ms |
| camera/mic PTS used **as-is** | same mach host clock; camera↔mic measured at +1.8 ms median |
| `prefer-hardware` only | `prefer-software` truncated at 19% of frames at 4K60 — not a fallback |
| **Developer ID signing** | ad-hoc signing silently revokes TCC grants on every rebuild |
| Never take the default audio input blind | grabbing a Bluetooth mic stalled capture; killing that process wedged CoreAudio system-wide |
| **Frame selection at time `t`**: greatest PTS ≤ `t`; hold, never interpolate | preview may not use "latest decoded frame" — that picks a different source frame than export whenever the VFR grid and CFR grid are out of phase (which is continuously, at ~58.8 fps camera vs 60 Hz export) |
| **Simulation step: 120 Hz** (`dt = 1/120 s`); 60 fps export samples every other tick | all times are integer nanoseconds or integer sim ticks inside the transform — no float seconds |
| **Cursor/animation state is a function of sim tick `n`, not render call count** | easing runs `stepSim(state, dt=1/120)` from tick 0; `stateAt(n)` must be identical whether reached by stepping or seeking. No `performance.now()` or frame-delta inside the transform |

## Architecture

```
Electron (UI, compositing, export via WebCodecs)
    │  JSON lines over stdin/stdout
    │    stdout: lossy/non-blocking stats   stdin + fd3: reliable request/response
    ▼
Swift helper (long-running)  ──►  session dir: display.mp4,
  ScreenCaptureKit + CGEventTap           events.json, anchors.json
```

**The non-negotiable this architecture exists for:** `render(project, events, t) → FrameState` is a
pure function — no access to wall clock, decoder scheduling, live helper stats, or current display state.
Preview and export are two *sinks* that call it with different `t` sequences. One implementation; sinks
may not fork the transform.

The helper is a **long-running, controllable process**, not the spike's 12-second one-shot. It is
spawned as a child of Electron, which means it inherits Electron's TCC identity — one grant, against the
signed bundle the user recognises.

## Risks in scope for phase 1

| risk | approach |
|---|---|
| **Thermal throttle / frame drops** | emit periodic `stats` (frames, drops, queue depth, encoder fps) on the lossy non-blocking channel so throttling is *observable*, not inferred. Thermal fade was already visible in phase 0: 18.7 → 12.1 fps across a longer benchmark |
| **Display hot-swap** | `CGDisplayRegisterReconfigurationCallback`; on change, emit a `display-reconfigured` event and **stop the recording cleanly**. Rebuild-and-continue is a phase 2 concern — `AVAssetWriter` cannot change output dimensions mid-file without corruption |

**Deferred to phase 2:** mid-recording display rebuild, camera/mic capture, system audio
(`capturesAudio`), N-minute segmentation, device-loss recovery, and the fault-injection soak harness.
Phase 1 stops cleanly on any of these; it does not attempt to survive them.

## Signing

`helper/build.sh` auto-detects a code-signing identity and falls back to ad-hoc with a loud warning.
Override with `SIGN_ID="..." ./build.sh`.

**This machine currently has no signing certificate** — both keychains are empty, `security
find-identity -v -p codesigning` reports 0. An Apple Developer Program membership is not the same as an
installed certificate; Xcode normally creates one, and there is no Xcode here.

Two separate needs, and they want different certificates:

| need | certificate | why |
|---|---|---|
| **Dev loop, now** | self-signed "Code Signing" cert in the login keychain | gives a *stable* identity so TCC grants survive rebuilds. Costs nothing, burns no Developer ID slot |
| **Distribution, later** | Developer ID Application + notarisation | required for other machines to run it without Gatekeeper prompts |

Only the first is blocking. Without Xcode, both are made through Keychain Access → Certificate
Assistant; the Developer ID route additionally needs a CSR uploaded at developer.apple.com (and can only
be issued by the Account Holder, max 5 per team).

**To verify the stable-identity claim rather than assume it** (the whole point of phase 0): two
experiments — (a) rebuild helper only, re-sign helper, re-sign bundle, re-run preflight; (b) rebuild the
whole bundle, re-run preflight. They can have different answers. Also: after creating the cert via
Certificate Assistant, set its trust to "Code Signing" in Keychain Access before running
`security find-identity` — the default trust settings will not produce a usable identity.

## Increments

0. **Transform contract** — write `events.json` / `anchors.json` / `project` schemas (versioned;
   `project` holds PiP geometry, cursor style, output fps — the edit document, even if it's 3 fields
   for now); hand-author a 5-second fixture session (no capture). Implement `render(project, events, t)` against the fixture with two sinks: canvas
   preview and WebCodecs encode. Gate: for 200 sampled `t` values across the fixture, the pre-encode RGBA
   buffer produced by each sink is byte-identical — preview hash = export hash, and two independent exports
   produce matching pre-encode hashes. The encoded MP4 files need not be byte-identical (container
   timestamps and encoder state are not contractually deterministic); the gate lives before the encoder.
1. **Helper control plane** — long-running process, JSON-line protocol, display/device watchers, no capture. *(in progress)*
2. **Capture ported in** — ScreenCaptureKit display capture + CGEventTap only; single-file `display.mp4`;
   `events.json` written per the increment-0 schema; periodic stats. No camera, mic, system audio, or
   segmentation.
3. **Electron shell** — spawn/supervise the helper, start/stop UI, live stats display.
4. **Composite + export** — wire a real session dir through `render(project, events, t)`; demux
   `display.mp4` via mp4box.js, composite cursor overlay, encode CFR MP4. Sink behind the transform —
   not a port of the spike harness's decode loop. No camera PiP. Gate: pre-encode hash of a 60 s real
   recording matches across two independent exports.
5. **Smoke test** — manual 5-minute recording; verify no dropped frames at thermal steady-state, clean
   stop on display change, export produces a watchable file.

## Non-goals for phase 1

Polish, editing UI, multi-take management, HDR/P3, uploads, anything cross-platform.

**Explicitly deferred to phase 2:** camera PiP, microphone, system audio, display hot-swap rebuild
(phase 1 stops cleanly instead), N-minute segmentation, device-loss recovery, and the full
fault-injection soak harness.
