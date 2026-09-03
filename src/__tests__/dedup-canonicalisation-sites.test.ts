/**
 * Every path that both builds devin argv and computes a dedup key must use the
 * canonicalised form.
 *
 * A cross-LLM review found the canonicalisation applied at one of four such
 * paths. The three that missed it hash a gateway-minted export path containing
 * the correlation id, so two identical requests never dedup. The helper existed,
 * was correct, and was called once.
 *
 * Naming the sites in a list here would repeat the defect: the list would be
 * complete on the day it was written. The set is derived from the source, so a
 * fifth path fails this without anyone remembering it exists.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(process.cwd(), "src/index.ts"), "utf8");

/** A prepare that hands its caller a canonicalised argv to use for dedup. */
const PREPARES_WITH_DEDUP_ARGS = [...SOURCE.matchAll(/export function (prepare\w+Request)\(/g)]
  .map(m => m[1])
  .filter(name => {
    const body = functionBody(name);
    return body !== null && /\n\s+dedupArgs:/.test(body);
  });

/**
 * Wrappers that return such a prep unchanged, so their callers inherit the
 * obligation. Derived rather than listed: a wrapper qualifies when it calls one
 * of the prepares above and computes no dedup key itself.
 */
const PREP_WRAPPERS = [...SOURCE.matchAll(/function (prepare\w+)\(/g)]
  .map(m => m[1])
  .filter(name => {
    if (PREPARES_WITH_DEDUP_ARGS.includes(name)) return false;
    const body = functionBody(name);
    if (body === null) return false;
    return PREPARES_WITH_DEDUP_ARGS.some(p => body.includes(`${p}(`)) && !computesDedupKey(body);
  });

function functionBody(name: string): string | null {
  const at = SOURCE.search(new RegExp(`(?:export )?(?:async )?function ${name}\\(`));
  if (at < 0) return null;
  const end = SOURCE.indexOf("\n}", at);
  return end < 0 ? SOURCE.slice(at) : SOURCE.slice(at, end);
}

function computesDedupKey(body: string): boolean {
  return /sessionBoundDedupArgs\(|awaitJobOrDefer\(|\.startJob\(/.test(body);
}

/** Every function that obtains a dedup-bearing prep, by either route. */
function sitesObtainingSuchAPrep(): { name: string; body: string }[] {
  const producers = [...PREPARES_WITH_DEDUP_ARGS, ...PREP_WRAPPERS];
  const names = [...SOURCE.matchAll(/(?:export )?(?:async )?function (\w+)\(/g)].map(m => m[1]);
  const sites: { name: string; body: string }[] = [];
  for (const name of names) {
    if (producers.includes(name)) continue;
    const body = functionBody(name);
    if (body === null) continue;
    if (!producers.some(p => body.includes(`${p}(`))) continue;
    sites.push({ name, body });
  }
  return sites;
}

describe("dedup canonicalisation is applied wherever it is owed", () => {
  it("finds the prepares that produce a canonicalised argv, so an empty set cannot pass", () => {
    // Guards the guard. Were this empty every assertion below would hold
    // vacuously, which is how a derived set reports coverage it does not have.
    expect(PREPARES_WITH_DEDUP_ARGS).toContain("prepareDevinRequest");
  });

  it("finds the wrappers that pass such a prep through to their callers", () => {
    expect(PREP_WRAPPERS).toContain("prepareRoutedCli");
  });

  it("finds more than one site, because one site was the defect", () => {
    expect(sitesObtainingSuchAPrep().length).toBeGreaterThan(1);
  });

  it("uses dedupArgs at every site that also computes a dedup key", () => {
    const offenders = sitesObtainingSuchAPrep()
      .filter(site => computesDedupKey(site.body))
      .filter(site => !site.body.includes("dedupArgs"))
      .map(site => site.name)
      .sort();
    expect(offenders).toEqual([]);
  });

  it("never reaches a dedup key through the raw prepared argv at those sites", () => {
    // The specific shape of the original defect: the canonicalised argv exists
    // on the prep and the site passes `args` past it anyway.
    const raw = sitesObtainingSuchAPrep()
      .filter(site => computesDedupKey(site.body))
      .filter(site => /sessionBoundDedupArgs\(\s*args\s*,/.test(site.body))
      .map(site => site.name)
      .sort();
    expect(raw).toEqual([]);
  });
});
