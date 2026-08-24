import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCursorSim, CHECKPOINT_INTERVAL } from "../src/cursor.js";
import type { SessionEvent } from "../src/types.js";
import { tickOf } from "../src/time.js";

const fixtureEvents: SessionEvent[] = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "fixtures", "basic", "events.json"), "utf8"),
).events;

const mv = (t: number, x: number, y: number): SessionEvent => ({ t, kind: "move", x, y });

describe("cursor sim — state is a function of tick n, nothing else", () => {
  test("no events: cursor is not visible", () => {
    const sim = createCursorSim([]);
    expect(sim.stateAt(0).visible).toBe(false);
    expect(sim.stateAt(500).visible).toBe(false);
  });

  test("tick 0 starts at the first event's position with zero velocity", () => {
    const sim = createCursorSim([mv(50_000_000, 100, 200)]);
    const s = sim.stateAt(0);
    expect(s.visible).toBe(true);
    expect(s.x).toBe(100);
    expect(s.y).toBe(200);
    expect(s.vx).toBe(0);
    expect(s.vy).toBe(0);
  });

  test("converges onto a static target and stays there", () => {
    const sim = createCursorSim([mv(0, 0, 0), mv(100_000_000, 300, 150)]);
    const s = sim.stateAt(240); // 2 s
    expect(Math.abs(s.x - 300)).toBeLessThan(0.5);
    expect(Math.abs(s.y - 150)).toBeLessThan(0.5);
  });

  test("teleport is smoothed: no single-tick jump anywhere in the fixture", () => {
    const sim = createCursorSim(fixtureEvents);
    const last = tickOf(5_000_000_000);
    let prev = sim.stateAt(0);
    let maxStep = 0;
    for (let n = 1; n <= last; n++) {
      const s = sim.stateAt(n);
      maxStep = Math.max(maxStep, Math.hypot(s.x - prev.x, s.y - prev.y));
      prev = s;
    }
    // fixture teleports ~420 px at t=3s; raw would be a >400 px single-tick jump
    expect(maxStep).toBeLessThan(60);
  });

  test("pressed follows down/up events at the tick's time", () => {
    const events: SessionEvent[] = [
      mv(0, 10, 10),
      { t: 1_000_000_000, kind: "down", x: 10, y: 10, button: 0 },
      { t: 2_000_000_000, kind: "up", x: 10, y: 10, button: 0 },
    ];
    const sim = createCursorSim(events);
    expect(sim.stateAt(119).pressed).toBe(false);
    expect(sim.stateAt(120).pressed).toBe(true);
    expect(sim.stateAt(239).pressed).toBe(true);
    expect(sim.stateAt(240).pressed).toBe(false);
  });
});

describe("cursor sim — stateAt(n) identical by stepping or seeking (bit-exact)", () => {
  test("seek equals sequential stepping at every tick of the fixture", () => {
    const stepped = createCursorSim(fixtureEvents);
    const seeker = createCursorSim(fixtureEvents);
    const last = tickOf(5_000_000_000);
    const sequential: number[][] = [];
    for (let n = 0; n <= last; n++) {
      const s = stepped.stateAt(n);
      sequential.push([s.x, s.y, s.vx, s.vy]);
    }
    // out-of-order access: far seek first, then backwards, then random-ish
    const probe = [last, 0, Math.floor(last / 2), 7, last - 1, 311, 42];
    for (const n of probe) {
      const s = seeker.stateAt(n);
      expect([s.x, s.y, s.vx, s.vy]).toEqual(sequential[n]);
    }
  });

  test("seeking far past a checkpoint boundary then re-reading an earlier tick is exact", () => {
    const events = [mv(0, 0, 0), mv(1_000_000_000, 500, 300), mv(3_000_000_000, 50, 20)];
    const a = createCursorSim(events);
    const b = createCursorSim(events);
    const far = CHECKPOINT_INTERVAL * 2 + 17;
    const mid = CHECKPOINT_INTERVAL + 3;
    b.stateAt(far); // force checkpointed seek path
    const sMid = b.stateAt(mid);
    const ref = a.stateAt(mid); // fresh sim, forward-only
    expect(sMid.x).toBe(ref.x);
    expect(sMid.y).toBe(ref.y);
    expect(sMid.vx).toBe(ref.vx);
    expect(sMid.vy).toBe(ref.vy);
  });

  test("two independent sims agree bit-exactly on the fixture at sampled ticks", () => {
    const a = createCursorSim(fixtureEvents);
    const b = createCursorSim(fixtureEvents);
    for (let n = 0; n <= 600; n += 37) {
      const sa = a.stateAt(n), sb = b.stateAt(n);
      expect(sa).toEqual(sb);
    }
  });
});
