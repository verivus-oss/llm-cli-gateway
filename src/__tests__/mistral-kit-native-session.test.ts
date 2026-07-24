import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isVibeNativeSessionId,
  isKitNativeSessionId,
  isKitNativeSessionIdForProvider,
} from "../personal-config-types.js";
import { resolveNewestVibeNativeSessionId } from "../mistral-meta-json-parser.js";
import {
  createVibeKitTerminalMetadata,
  parsePersonalKitTerminalMetadata,
} from "../provider-output-metadata.js";

// Mistral Kit M0: the native-session foundation. Dormant groundwork (no live handler wires
// it yet). Vibe mints non-RFC-4122 native UUIDs, so a vibe-scoped broad guard is required;
// the disk resolver reads the newest session_id under a gateway-owned home with an in-tree
// (readInBase) boundary + a dir-first8 integrity check.

// A real vibe id sampled from the host probe: broad 8-4-4-4-12 hex whose version/variant
// nibbles are NOT RFC-4122 (fails the strict guard).
const VIBE_BROAD = "fb3e24bd-ab1e-daf1-7dba-cdd4784f0a9a";
// A strict RFC-4122 v4-ish id (version nibble 4, variant 9) that passes both guards.
const STRICT = "2919c908-b39d-3725-9ef8-c75720b6b9f2";

describe("isVibeNativeSessionId (broad vibe guard)", () => {
  it("accepts a broad non-strict vibe id and a strict id (superset)", () => {
    expect(isVibeNativeSessionId(VIBE_BROAD)).toBe(true);
    expect(isVibeNativeSessionId(STRICT)).toBe(true);
    expect(isVibeNativeSessionId(VIBE_BROAD.toUpperCase())).toBe(true);
  });
  it("rejects the strict guard's own rejections that are non-hex-uuid", () => {
    // The broad id is NOT accepted by the strict guard, proving they differ.
    expect(isKitNativeSessionId(VIBE_BROAD)).toBe(false);
    expect(isVibeNativeSessionId("gw-1234")).toBe(false);
    expect(isVibeNativeSessionId("not-a-uuid")).toBe(false);
    expect(isVibeNativeSessionId("fb3e24bd-ab1e-daf1-7dba-cdd4784f0a9")).toBe(false); // short
    expect(isVibeNativeSessionId(undefined)).toBe(false);
    expect(isVibeNativeSessionId(12345)).toBe(false);
  });
});

describe("isKitNativeSessionIdForProvider (vibe relaxation is scoped)", () => {
  it("mistral uses the broad guard; every other provider stays strict", () => {
    expect(isKitNativeSessionIdForProvider("mistral", VIBE_BROAD)).toBe(true);
    expect(isKitNativeSessionIdForProvider("claude", VIBE_BROAD)).toBe(false);
    expect(isKitNativeSessionIdForProvider("codex", VIBE_BROAD)).toBe(false);
    expect(isKitNativeSessionIdForProvider(undefined, VIBE_BROAD)).toBe(false);
    // A strict id passes for everyone.
    expect(isKitNativeSessionIdForProvider("mistral", STRICT)).toBe(true);
    expect(isKitNativeSessionIdForProvider("claude", STRICT)).toBe(true);
    // A gw- id is rejected even under the broad guard.
    expect(isKitNativeSessionIdForProvider("mistral", "gw-abc")).toBe(false);
  });
});

describe("resolveNewestVibeNativeSessionId (disk resolver)", () => {
  let home: string;
  let sessionRoot: string;
  let counter = 0;

  function makeSession(
    uuid: string,
    opts: { dirFirst8?: string; mtime?: Date; badJson?: boolean; symlinkMeta?: string } = {}
  ): void {
    const first8 = opts.dirFirst8 ?? uuid.slice(0, 8);
    const stamp = String(120000 + counter++).padStart(6, "0");
    const dir = join(sessionRoot, `session_20260724_${stamp}_${first8}`);
    mkdirSync(dir, { recursive: true });
    const metaPath = join(dir, "meta.json");
    if (opts.symlinkMeta) {
      symlinkSync(opts.symlinkMeta, metaPath);
    } else {
      writeFileSync(metaPath, opts.badJson ? "{not json" : JSON.stringify({ session_id: uuid }));
    }
    if (opts.mtime) utimesSync(dir, opts.mtime, opts.mtime);
  }

  beforeEach(() => {
    counter = 0;
    home = mkdtempSync(join(tmpdir(), "vibe-kit-home-"));
    sessionRoot = join(home, ".vibe", "logs", "session");
    mkdirSync(sessionRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns undefined when there is no session store", () => {
    const empty = mkdtempSync(join(tmpdir(), "vibe-kit-empty-"));
    expect(resolveNewestVibeNativeSessionId(empty)).toBeUndefined();
    rmSync(empty, { recursive: true, force: true });
  });

  it("returns undefined when the session dir is empty", () => {
    expect(resolveNewestVibeNativeSessionId(home)).toBeUndefined();
  });

  it("picks the NEWEST session by mtime", () => {
    makeSession(STRICT, { mtime: new Date("2026-07-24T10:00:00Z") });
    makeSession(VIBE_BROAD, { mtime: new Date("2026-07-24T12:00:00Z") }); // newer
    expect(resolveNewestVibeNativeSessionId(home)).toBe(VIBE_BROAD);
  });

  it("honours the dir-first8 integrity check: a mismatched newest is skipped for a valid older one", () => {
    makeSession(STRICT, { mtime: new Date("2026-07-24T10:00:00Z") }); // valid, older
    // Newest dir's basename first8 does NOT match its meta.json session_id first8.
    makeSession(VIBE_BROAD, { dirFirst8: "deadbeef", mtime: new Date("2026-07-24T12:00:00Z") });
    expect(resolveNewestVibeNativeSessionId(home)).toBe(STRICT);
  });

  it("skips a non-vibe-shaped id (e.g. gw-*) and bad JSON", () => {
    makeSession("gw-not-a-uuid", {
      dirFirst8: "gw123456",
      mtime: new Date("2026-07-24T12:00:00Z"),
    });
    makeSession(STRICT, { badJson: true, mtime: new Date("2026-07-24T11:00:00Z") });
    expect(resolveNewestVibeNativeSessionId(home)).toBeUndefined();
  });

  it("rejects an out-of-base meta.json symlink (readInBase boundary)", () => {
    // Point the newest session's meta.json at a file OUTSIDE the session root.
    const outside = mkdtempSync(join(tmpdir(), "vibe-kit-outside-"));
    const outsideMeta = join(outside, "meta.json");
    writeFileSync(outsideMeta, JSON.stringify({ session_id: VIBE_BROAD }));
    makeSession(VIBE_BROAD, {
      symlinkMeta: outsideMeta,
      mtime: new Date("2026-07-24T12:00:00Z"),
    });
    // A valid in-tree older session is present too.
    makeSession(STRICT, { mtime: new Date("2026-07-24T10:00:00Z") });
    // The symlinked (out-of-base) newest is rejected; the in-tree older one wins.
    expect(resolveNewestVibeNativeSessionId(home)).toBe(STRICT);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("createVibeKitTerminalMetadata (disk-capture hook)", () => {
  it("captures the newest vibe id, gated on the broad guard", () => {
    const home = mkdtempSync(join(tmpdir(), "vibe-kit-cap-"));
    const dir = join(
      home,
      ".vibe",
      "logs",
      "session",
      `session_20260724_120000_${VIBE_BROAD.slice(0, 8)}`
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ session_id: VIBE_BROAD }));
    expect(createVibeKitTerminalMetadata(home)).toEqual({
      version: 1,
      nativeSessionId: VIBE_BROAD,
    });
    rmSync(home, { recursive: true, force: true });
  });

  it("fails closed to null when no vibe id is resolvable", () => {
    const home = mkdtempSync(join(tmpdir(), "vibe-kit-cap-empty-"));
    expect(createVibeKitTerminalMetadata(home)).toEqual({ version: 1, nativeSessionId: null });
    rmSync(home, { recursive: true, force: true });
  });
});

describe("parsePersonalKitTerminalMetadata is provider-aware", () => {
  const broadRecord = JSON.stringify({ version: 1, nativeSessionId: VIBE_BROAD });
  const strictRecord = JSON.stringify({ version: 1, nativeSessionId: STRICT });

  it("accepts a broad-id record only under provider=mistral", () => {
    expect(parsePersonalKitTerminalMetadata(broadRecord, "mistral")).toEqual({
      version: 1,
      nativeSessionId: VIBE_BROAD,
    });
    // Default (no provider) and non-mistral stay strict, rejecting the broad id.
    expect(parsePersonalKitTerminalMetadata(broadRecord)).toBeNull();
    expect(parsePersonalKitTerminalMetadata(broadRecord, "claude")).toBeNull();
  });

  it("accepts a strict-id record for any provider (unchanged for claude/codex)", () => {
    expect(parsePersonalKitTerminalMetadata(strictRecord)).toEqual({
      version: 1,
      nativeSessionId: STRICT,
    });
    expect(parsePersonalKitTerminalMetadata(strictRecord, "claude")).toEqual({
      version: 1,
      nativeSessionId: STRICT,
    });
    expect(parsePersonalKitTerminalMetadata(strictRecord, "mistral")).toEqual({
      version: 1,
      nativeSessionId: STRICT,
    });
  });
});
