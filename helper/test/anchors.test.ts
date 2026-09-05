import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { runSwiftHarness } from "./_swift-harness.js";

// CJS/ESM interop: ajv v8 ships CJS; vitest may or may not unwrap the default.
const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");

function extractJSON(out: string, marker: string): unknown {
  const line = out.split("\n").find((l) => l.startsWith(marker));
  if (!line) throw new Error(`harness output did not contain a ${marker} line:\n${out}`);
  return JSON.parse(line.slice(marker.length));
}

describe("anchors document", () => {
  test("Swift anchors assertions all pass, and both documents validate against anchors-2", async () => {
    const out = await runSwiftHarness({
      label: "anchors",
      sources: [
        "helper/src/AnchorsDoc.swift",
        "helper/test/anchors/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");

    // The member-by-member checks in anchors/main.swift can drift from the
    // schema silently — they assert the fields they know to look for, not
    // that the document is otherwise valid. Before this, the only thing that
    // ever ran anchorsDocument(...) output through the anchors-2 schema was
    // camera-capture.grant.test.ts, which needs a Camera grant and is
    // excluded from `npm test` — so drift here was caught by nothing that
    // actually runs in CI (the exact gap STC-262 already named). This
    // recompiles the harness anyway to get "ALL PASS" above, so emitting the
    // built documents as JSON and validating them here is nearly free.
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(
      JSON.parse(readFileSync(join(root, "schema/anchors-2.schema.json"), "utf8")),
    );

    const noCamera = extractJSON(out, "JSON-NO-CAMERA:");
    expect(validate(noCamera), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect((noCamera as { camera?: unknown }).camera, "a display-only take must not carry a camera block at all").toBeUndefined();

    const requestedNoFrames = extractJSON(out, "JSON-CAMERA-REQUESTED-NO-FRAMES:");
    expect(validate(requestedNoFrames), JSON.stringify(validate.errors, null, 2)).toBe(true);

    const withCamera = extractJSON(out, "JSON-WITH-CAMERA:");
    expect(validate(withCamera), JSON.stringify(validate.errors, null, 2)).toBe(true);

    // STC-311: the documents a SHUTDOWN produces. Every case above stops for
    // reason "user", so the schema was only ever exercised on reasons it
    // already allowed — and the helper writes four families it did not.
    // `stop-reasons.test.ts` holds the schema to what the Swift can emit;
    // this validates whole documents actually built with those reasons.
    for (const marker of ["JSON-STOP-QUIT:", "JSON-STOP-STDIN-CLOSED:", "JSON-STOP-SIGNAL-15:",
                          "JSON-STOP-STOPPED-DURING-START:", "JSON-STOP-SIGNAL-TIMEOUT:"]) {
      const d = extractJSON(out, marker);
      expect(validate(d), `${marker} ${JSON.stringify(validate.errors, null, 2)}`).toBe(true);
    }
  });
}, 60_000);
