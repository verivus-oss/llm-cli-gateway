import { describe, expect, it } from "vitest";
import { broken, enumOf, mergeFloor, promises } from "./check-interface-floor.mjs";

const withEnum = [
  {
    name: "grok_request",
    inputSchema: {
      properties: {
        effort: { type: "string", enum: ["low", "medium", "high"], description: "Grok effort" },
      },
    },
  },
];
const enumDeleted = [
  {
    name: "grok_request",
    inputSchema: { properties: { effort: { type: "string", description: "Grok effort" } } },
  },
];

describe("the regression this gate exists for", () => {
  it("REPLAY: deleting the effort enum is a breach", () => {
    // Exactly what happened on 2026-08-19. The enum was wrong, so it was
    // deleted, and every existing gate stayed green because none of them reads
    // the tool schema. Correctness improved and the interface got poorer.
    const lost = broken(promises(withEnum), promises(enumDeleted));
    expect(lost).toEqual([
      {
        tool: "grok_request",
        missing: ["effort:enum", "effort=high", "effort=low", "effort=medium"],
      },
    ]);
  });

  it("the design's answer passes: keep telling the caller, stop refusing them", () => {
    // `values` becomes description and autocomplete data and never rejects. A
    // schema that keeps the enum is fine; one that keeps the members only in
    // prose is the compromise, and the gate is explicit that it does not count.
    expect(broken(promises(withEnum), promises(withEnum))).toEqual([]);
  });

  it("removing a PARAMETER is a breach", () => {
    expect(
      broken(promises(withEnum), promises([{ name: "grok_request", inputSchema: {} }]))
    ).toEqual([
      {
        tool: "grok_request",
        missing: [
          "effort",
          "effort:described",
          "effort:enum",
          "effort=high",
          "effort=low",
          "effort=medium",
        ],
      },
    ]);
  });

  it("removing a DESCRIPTION is a breach", () => {
    const undescribed = [
      {
        name: "grok_request",
        inputSchema: {
          properties: { effort: { type: "string", enum: ["low", "medium", "high"] } },
        },
      },
    ];
    expect(broken(promises(withEnum), promises(undescribed))).toEqual([
      { tool: "grok_request", missing: ["effort:described"] },
    ]);
  });

  it("a whole TOOL disappearing is a breach", () => {
    expect(broken(promises(withEnum), {})[0].tool).toBe("grok_request");
  });
});

describe("growth is free", () => {
  it("adding an enum value is not a breach", () => {
    const wider = [
      {
        name: "grok_request",
        inputSchema: {
          properties: {
            effort: {
              type: "string",
              enum: ["low", "medium", "high", "max"],
              description: "Grok effort",
            },
          },
        },
      },
    ];
    expect(broken(promises(withEnum), promises(wider))).toEqual([]);
  });

  it("adding a parameter is not a breach", () => {
    const more = [
      {
        name: "grok_request",
        inputSchema: {
          properties: {
            effort: { type: "string", enum: ["low", "medium", "high"], description: "Grok effort" },
            brandNew: { type: "string" },
          },
        },
      },
    ];
    expect(broken(promises(withEnum), promises(more))).toEqual([]);
  });

  it("rewording a description is not a breach", () => {
    const reworded = [
      {
        name: "grok_request",
        inputSchema: {
          properties: {
            effort: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "totally different",
            },
          },
        },
      },
    ];
    expect(broken(promises(withEnum), promises(reworded))).toEqual([]);
  });

  it("mergeFloor only grows", () => {
    expect(mergeFloor({ a: ["x"] }, { a: ["y"] })).toEqual({ a: ["x", "y"] });
  });
});

describe("enumOf", () => {
  it("reads a plain enum and an anyOf enum alike", () => {
    expect(enumOf({ enum: ["a", "b"] })).toEqual(["a", "b"]);
    expect(enumOf({ anyOf: [{ enum: ["a"] }, { type: "null" }] })).toEqual(["a"]);
    expect(enumOf({ type: "string" })).toEqual([]);
  });
});

describe("the committed floor", () => {
  it("covers every tool the published surface exposes", async () => {
    const { readFileSync } = await import("node:fs");
    const floor = JSON.parse(readFileSync("seed/interface-floor.json", "utf8"));
    const fixture = JSON.parse(readFileSync("site/tools.fixture.json", "utf8"));
    const live = promises(fixture);
    expect(
      Object.keys(floor)
        .filter(k => k !== "__schema")
        .sort()
    ).toEqual(Object.keys(live).sort());
  });

  it("records grok's 29 generated parameters, the surface this exists to protect", async () => {
    const { readFileSync } = await import("node:fs");
    const floor = JSON.parse(readFileSync("seed/interface-floor.json", "utf8"));
    for (const param of ["effort", "bestOfN", "check", "permissionMode", "outputFormat"]) {
      expect(floor.grok_request, param).toContain(param);
    }
    expect(floor.grok_request).toContain("permissionMode:enum");
  });
});
