import { describe, test, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { HelperClient, HelperError } from "../src/helper-client.js";

const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");
// helper binary is built once by vitest.global-setup.ts

const live: HelperClient[] = [];
afterEach(async () => { for (const c of live.splice(0)) c.kill(); });

function client(opts: { statsIntervalMs?: number } = {}) {
  const c = HelperClient.spawn(BIN, opts);
  live.push(c);
  return c;
}
const session = () => mkdtempSync(join(tmpdir(), "stc-app-"));

describe("HelperClient — reliable request/response", () => {
  test("waits for ready before accepting requests", async () => {
    const c = client();
    const ready = await c.ready();
    expect(ready.protocol).toBe(1);
    expect(typeof ready.pid).toBe("number");
  });

  test("a request resolves with its own response", async () => {
    const c = client();
    await c.ready();
    const r = await c.request("status");
    expect(r.ev).toBe("status");
    expect(r.state).toBe("idle");
  });

  test("concurrent requests do not cross-talk", async () => {
    const c = client();
    await c.ready();
    const [a, b, d] = await Promise.all([
      c.request("status"), c.request("devices"), c.request("status"),
    ]);
    expect(a.ev).toBe("status");
    expect(b.ev).toBe("devices");
    expect(d.ev).toBe("status");
    // each response carried a distinct seq
    expect(new Set([a.seq, b.seq, d.seq]).size).toBe(3);
  });

  test("an error response rejects with the helper's own code", async () => {
    const c = client();
    await c.ready();
    await expect(c.request("nonsense")).rejects.toThrow(HelperError);
    await c.request("nonsense").catch((e: HelperError) => {
      expect(e.code).toBe("unknown-command");
    });
  });

  test("a request that outlives its timeout rejects rather than hanging", async () => {
    const c = client();
    await c.ready();
    await expect(c.request("status", {}, { timeoutMs: 1 })).rejects.toThrow(/timed out/i);
  });

  test("pending requests reject when the helper dies", async () => {
    const c = client();
    await c.ready();
    // Killed synchronously in the same tick the request is written, so the
    // helper cannot possibly answer first. A timer here would race: an
    // ungranted `start` fails in ~10 ms and would win.
    const pending = c.request("start", { dir: session() });
    c.kill();
    await expect(pending).rejects.toThrow(/exited|died|closed/i);
  });
});

describe("HelperClient — unsolicited traffic", () => {
  test("stats surface as events, never as responses", async () => {
    const c = client({ statsIntervalMs: 20 });
    await c.ready();
    const stats: any[] = [];
    c.on("stats", (s) => stats.push(s));
    const r = await c.request("status");
    expect(r.ev).toBe("status");          // a stat must not resolve this
    await new Promise((res) => setTimeout(res, 300));
    expect(stats.length).toBeGreaterThan(0);
    expect(stats.every((s) => s.ev === "stats")).toBe(true);
  });

  test("stats carry helper state so an idle helper is still observably alive", async () => {
    const c = client({ statsIntervalMs: 20 });
    await c.ready();
    const s = await new Promise<any>((res) => c.on("stats", res));
    expect(s.state).toBe("idle");
  });
});

describe("HelperClient — lifecycle", () => {
  test("quit shuts the helper down and reports exit", async () => {
    const c = client();
    await c.ready();
    const exited = c.waitForExit();
    await c.request("quit").catch(() => {});   // helper may exit before answering
    const { code } = await exited;
    expect(code).toBe(0);
  });

  test("exit is observable even when nobody asked for it", async () => {
    const c = client();
    await c.ready();
    const exited = c.waitForExit();
    c.kill();
    await expect(exited).resolves.toBeDefined();
  });
});
