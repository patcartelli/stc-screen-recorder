# STC-315 runbook — refusing a take with no cursor telemetry

What to run on the Mac, in order, and what each result must show.

The change: `CGEvent.tapCreate` returning nil is an **error on the `start`
request** (`event-tap-unavailable`) instead of a warning over a video-only
take. Nothing in this repo can produce the real nil — it comes from TCC — so
everything below is either a fault injector standing in for it, or the one
section that needs the grant genuinely revoked.

## What no test here can settle

1. Whether the app's sentence reads as *"nothing was recorded"* rather than
   *"grant this and try again"*. It is asserted as a string; whether a person
   pressing Record understands that there is no take is an eye's judgement.
2. ~~Whether macOS raises its own Input Monitoring prompt on the first
   `start`.~~ **ANSWERED 2026-09-09, on hardware: IT PROMPTS.** After
   `tccutil reset ListenEvent`, a `npm run test:capture` run raised macOS's own
   Input Monitoring dialog and the run failed. So the first refusal a user ever
   sees usually has a dialog beside it, and the app's message now leads with
   that instead of sending them to System Settings.
   **It also surfaced something the ticket never considered:** that prompt says
   *"receive keystrokes from any application"*. This app's tap mask is
   mouse-only and has never recorded a keypress (STC-327 exists because nothing
   here captures keyboard input), but macOS's dialog is generic and cannot say
   so — a person reading it for a screen recorder has every reason to Deny. The
   message names the discrepancy now.
   **Still open, and §4 is the only way to close it:** whether the granted
   process needs RESTARTING before capture works. Input Monitoring commonly
   does, and nothing has observed it for THIS app — the run above granted the
   *terminal* (the identity a directly-spawned helper inherits), not Electron.
   The message says "quit and reopen" because that is sufficient either way;
   if a restart turns out to be unnecessary the sentence can be shortened.
3. Whether `tccutil reset ListenEvent` actually revokes for the identity the
   helper inherits. PHASE-0 §6: a bare CLI binary inherits the LAUNCHING
   process's TCC identity, so for `npm run test:capture` the subject is the
   terminal, not the helper.

## 0. Before anything: the new grant

Since this change, **every capture test needs Input Monitoring** as well as
Screen Recording — not only the cursor ones — because the helper now refuses
any take it cannot record the cursor for.

    System Settings › Privacy & Security › Input Monitoring

Add the process that will run the tests: the **terminal** for
`npm run test:capture`, or `STCTestHost.app` for anything launched from
`tools/test-host`. If it is missing, every grant test reports

    SKIP-GRANT: this environment has no Input Monitoring grant

which is `_start-outcome.ts` naming the right pane — a message that did not
exist before this ticket and is the reason it was added.

## 1. The refusal, injected (no TCC change)

    helper/build.sh
    npm run test:capture -- helper/test/event-tap-required.grant.test.ts

Two tests, and the second is the one that means anything:

- **the refusal** — `STC_CAPTURE_FAULT=no-event-tap` makes `makeEventTap()`
  return nil. `start` must answer `error` / `event-tap-unavailable` **once**,
  on fd3, and the take directory must **not exist** afterwards.
- **the control** — the same binary, same directory shape, no fault: a take
  starts, stops, and leaves an `events.json`. Without this, the first test
  passes on any machine that cannot start a take for any reason at all.

If the control reports SKIP-GRANT or DISPLAY-BUSY, read which: a leftover
`electron .` holding the display is `-3805` and is not a permission problem
(`ps -Ao pid,command | grep -i '[s]tc-screen-recorder\|[E]lectron'`).

## 2. Every other capture test still passes

    npm run test:capture

The point of running the whole thing: the refusal sits in `begin()`, on the
path every take takes. A mistake there does not fail one test, it fails all of
them — and the ordering (after `SCShareableContent`, before `setupWriter()`) is
exactly what keeps `no-displays` the first answer on a machine with no Screen
Recording grant, which several tests still assert.

## 3. The real thing — revoking Input Monitoring

This is the section the injector cannot replace, and it is the one that
answers open question 2 above.

    tccutil reset ListenEvent          # ALL apps; there is no per-app form
                                       # that works reliably for this service

Then, **from a terminal that still holds Screen Recording**:

    echo '{"cmd":"start","dir":"/tmp/stc-tap-check","seq":1}' | helper/build/stc-helper

Expect on fd3 — or on stdout, since a bare terminal run has no fd3 and both
channels fall back to it:

    {"ev":"error","seq":1,"code":"event-tap-unavailable","detail":"cursor input could not be recorded ..."}

and `/tmp/stc-tap-check` must **not exist**.

**A permission dialog appeared** when this was run on 2026-09-09 — that is open
question 2, answered, and the app's message was rewritten around it. Note
whether it happens again on a fresh reset: a one-off would mean the message is
built on a single observation.

Then re-grant Input Monitoring to the terminal and confirm the same command
answers `started`. A refusal that survives the grant is the failure worth
finding here.

## 4. What the user sees

    npm run app:start

Launched this way the app is a child of the terminal and resolves to the
terminal's grants (CLAUDE.md's own trap, met and documented in STC-292's
runbook). That is **fine for the wording** and useless for the permission round
trip — for that, use a bundle launched with `open`.

With Input Monitoring revoked, press **Record**. Expect no take, and an alert
that says, in this order:

1. **Nothing was recorded — the take did not start.**
2. why: the cursor is drawn afterwards from what the tap records, so a take
   without it would have no cursor at all
3. that macOS may have just asked, and that its "keystrokes" wording does not
   describe what this app records
4. what to do: allow it, or tick the recorder under Input Monitoring — then
   quit and reopen

**This section carries the LAST open question and it is not the wording.** Run
it from a bundle launched with `open`, not `npm run app:start`: launched that
way the app is a child of the terminal and resolves to the terminal's grants,
so it proves nothing about Electron's (STC-292's runbook records the same trap,
met by the runbook written to test permissions). Then answer two things:

- Does the prompt appear for the APP, as it does for the terminal?
- **After allowing it, does Record work immediately, or does the app have to be
  quit and reopened first?** The message currently says quit and reopen because
  that is sufficient either way. If a restart is unnecessary, shorten it.

Look at it and answer one question: does someone who pressed Record understand
that there is no file? If the first thing they reach for is the take library to
check, the sentence is wrong however accurate it is.

Also check the button says **Record**, not Stop, and that pressing it again
after granting works without restarting the app. A refusal is not a wedge.

## 5. Not in scope, and deliberately

A tap **disabled mid-take** (`tapDisabledByTimeout` — a starved run loop) is
still re-enabled and counted, so it costs a gap in the track rather than the
take. That is a different question from this ticket's, it is recorded in
`docs/BRIEF.md`'s Cursor row, and nothing in the suite can starve a run loop on
demand — which is why it was not settled by guessing here.
