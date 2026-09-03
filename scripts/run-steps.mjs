/**
 * Run every step and report every result.
 *
 * The scheduler is separated from the step list and from the CLI so it can be
 * driven with synthetic steps in a test. The property that matters is the one
 * the `&&` chain did not have: A FAILING STEP MUST NOT PREVENT AN INDEPENDENT
 * STEP FROM RUNNING. That is not a preference, it is the defect this replaces.
 *
 * Three outcomes, and the third is the honest one the chain could not express:
 *   pass     ran, exit 0
 *   fail     ran, non-zero
 *   skipped  did NOT run, because something it needs failed. Never counted as
 *            a pass. "Not run" and "fine" are different answers.
 */

/** A step whose dependency failed, and the transitive closure of that. */
function blockedBy(step, resultOf) {
  for (const need of step.needs ?? []) {
    const result = resultOf.get(need);
    if (!result) return need; // never ran, so neither does this
    if (result.status !== "pass") return need;
  }
  return null;
}

/**
 * @param {Array<object>} steps
 * @param {(step: object) => Promise<{code: number, output: string}>} execute
 * @param {{concurrency?: number, onResult?: (r: object) => void, failFast?: boolean}} options
 */
export async function runSteps(steps, execute, options = {}) {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const onResult = options.onResult ?? (() => {});
  const resultOf = new Map();
  const results = [];

  const record = result => {
    resultOf.set(result.name, result);
    results.push(result);
    onResult(result);
    return result;
  };

  const pending = [...steps];
  let stop = false;

  while (pending.length > 0) {
    // Everything whose dependencies have all PASSED, in declaration order.
    const ready = [];
    const blocked = [];
    for (const step of pending) {
      const unmet = (step.needs ?? []).filter(n => !resultOf.has(n));
      if (unmet.length > 0) {
        blocked.push(step);
        continue;
      }
      const blocker = blockedBy(step, resultOf);
      if (blocker) {
        record({ name: step.name, status: "skipped", blockedBy: blocker, ms: 0, output: "" });
        continue;
      }
      ready.push(step);
    }
    pending.length = 0;
    pending.push(...blocked);

    if (ready.length === 0) {
      // Nothing runnable and nothing resolvable: a cycle, or a `needs` naming a
      // step that is not in the list. Report rather than spin.
      for (const step of pending) {
        record({
          name: step.name,
          status: "skipped",
          blockedBy: (step.needs ?? []).find(n => !resultOf.has(n)) ?? "unknown",
          ms: 0,
          output: "",
        });
      }
      break;
    }

    // `heavy` runs alone: this host turns an unmutated tree red under two
    // concurrent full suites, so a scheduler that ran them together would
    // manufacture failures and report them as findings.
    const wave = ready[0].heavy ? [ready[0]] : ready.filter(s => !s.heavy);
    const deferred = ready.filter(s => !wave.includes(s));
    pending.unshift(...deferred);

    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, wave.length) }, async () => {
      while (cursor < wave.length) {
        if (stop) return;
        const step = wave[cursor++];
        const startedAt = Date.now();
        const { code, output } = await execute(step);
        const result = record({
          name: step.name,
          status: code === 0 ? "pass" : "fail",
          code,
          ms: Date.now() - startedAt,
          output,
        });
        if (result.status === "fail" && options.failFast) stop = true;
      }
    });
    await Promise.all(workers);
    if (stop) break;
  }

  // Anything never reached under --fail-fast is reported, not dropped.
  for (const step of steps) {
    if (!resultOf.has(step.name)) {
      record({ name: step.name, status: "skipped", blockedBy: "--fail-fast", ms: 0, output: "" });
    }
  }

  return results;
}

export function summarise(results) {
  const count = status => results.filter(r => r.status === status).length;
  return {
    pass: count("pass"),
    fail: count("fail"),
    skipped: count("skipped"),
    total: results.length,
  };
}
