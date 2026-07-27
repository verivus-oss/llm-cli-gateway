#!/usr/bin/env bash
# Scheduled provider CLI drift check.
#
# Complements gateway-autoupgrade.timer, which upgrades the GATEWAY package
# from npm. This watches the other direction: the seven provider CLIs the
# gateway drives, which move underneath their declared contracts on their own
# schedule (grok in particular) and, until now, were only ever checked when
# somebody ran pre-release.sh.
#
# This has to run on a host with the provider binaries installed. GitHub-hosted
# CI structurally cannot do it: a stock runner has none of the seven.
#
# Modes (GATEWAY_DRIFT_MODE, default report):
#   report   detect and log only; never edits the repo.
#   apply    additionally run the rebaseliner's safe auto-apply (version
#            targets). Flag REMOVALS are never auto-applied: `flags` is the
#            argv emit allowlist and a removal needs a coordinated three-file
#            edit, so those are always reported for a human.
#
# Exit codes: 0 clean, 2 rebaselinable drift, 3 drift needing a human, 1 error.
set -euo pipefail

REPO="${GATEWAY_DRIFT_REPO:-/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway}"
MODE="${GATEWAY_DRIFT_MODE:-report}"
LOCK_FILE="${GATEWAY_DRIFT_LOCK:-${TMPDIR:-/tmp}/gateway-provider-drift.lock}"

log() { printf '%s %s\n' "$(date -Is)" "$*"; }
die() { local code=$1; shift; log "ERROR: $*" >&2; exit "$code"; }

[ -d "$REPO" ] || die 1 "repo not found: $REPO"
cd "$REPO"

# Single flock, same discipline as host-upgrade.sh, so a long probe cannot
# overlap the next timer firing.
exec 9>"$LOCK_FILE"
flock -n 9 || die 0 "another provider-drift run holds the lock ($LOCK_FILE); skipping"

# The rebaseliner COMPARES against dist/ (compiled contracts) but WRITES to
# src/. A stale dist therefore compares against stale targets and either misses
# real drift or re-reports drift that --apply already fixed in src. Always
# build, rather than only when dist is absent: a scheduled job that silently
# reports nothing because of a stale build is worse than one that costs a
# rebuild it did not strictly need.
log "building so dist/ matches src/ before comparing"
npm run build >/dev/null 2>&1 || die 1 "build failed"

log "checking provider CLI versions and contract surfaces (mode=$MODE)"

# ONE invocation, in --json mode, and capture its status immediately.
#
# Two things went wrong reaching this shape. Running the rebaseliner a second
# time to ask what it wrote re-probed all seven CLIs AND ran after the apply,
# so it saw an already-clean tree and always reported zero. And putting that
# second call before `STATUS=$?` meant STATUS captured the wrong command, so
# every run reported "no drift" while actively applying one.
set +e
if [ "$MODE" = "apply" ]; then
  JSON="$(node scripts/rebaseline-provider-contracts.mjs --json --apply 2>/dev/null)"
else
  JSON="$(node scripts/rebaseline-provider-contracts.mjs --json 2>/dev/null)"
fi
STATUS=$?
set -e

# Render the human log and the written-count from that single JSON document.
render() {
  printf '%s' "$JSON" | node -e '
    let s = "";
    process.stdin.on("data", d => (s += d)).on("end", () => {
      let j;
      try { j = JSON.parse(s); } catch { console.log("COUNT unknown"); return; }
      for (const u of j.versionUpdates ?? []) {
        console.log(`LINE ${j.applied ? "rebaselined" : "would rebaseline"} ${u.cli}: ${u.from} -> ${u.to}`);
      }
      for (const a of j.additiveFlagDrift ?? []) {
        console.log(`LINE ${a.cli}: installed binary advertises flag(s) the contract does not know: ${a.flags.join(" ")}`);
      }
      for (const r of j.removedFlagDrift ?? []) {
        console.log(`LINE ${r.cli}: contract declares flag(s) the installed binary NO LONGER advertises: ${r.flags.join(" ")}`);
        console.log("LINE   NOT auto-applied: a removal needs a lock-step edit across upstream-contracts.ts, provider-codegen.ts and index.ts.");
      }
      if (!(j.versionUpdates ?? []).length && !(j.additiveFlagDrift ?? []).length && !(j.removedFlagDrift ?? []).length) {
        console.log("LINE no drift: installed CLIs match their contracts");
      }
      console.log(`COUNT ${(j.changesWritten ?? []).length}`);
    });
  '
}

RENDERED="$(render)"
WROTE_COUNT="$(printf '%s\n' "$RENDERED" | sed -n 's/^COUNT //p')"
[ -n "$WROTE_COUNT" ] || WROTE_COUNT=unknown
OUTPUT="$(printf '%s\n' "$RENDERED" | sed -n 's/^LINE //p')"

printf '%s\n' "$OUTPUT" | while IFS= read -r line; do log "  $line"; done

# Report what was ACTUALLY written, not what the exit code implies. Only
# version targets are auto-applied, so additive-only drift also exits 2 while
# writing nothing; saying "rebaselined" there would make the timer log lie.
# The authority is the rebaseliner's own changesWritten, not the git state.
report_applied_changes() {
  [ "$MODE" = "apply" ] || return 0

  if [ "$WROTE_COUNT" = "unknown" ]; then
    # Could not establish what was written. Rebuild anyway: a stale dist/ makes
    # the NEXT run compare against pre-apply contracts and silently re-report,
    # which is the failure this whole job exists to avoid.
    log "could not determine what was auto-applied; rebuilding defensively"
  elif [ "$WROTE_COUNT" = "0" ]; then
    log "nothing was auto-applied (only version targets are; see the lines above for the rest)"
    return 0
  else
    log "auto-applied ${WROTE_COUNT} version rebaseline(s) to src/provider-definitions.ts"
    # Best-effort diffstat for the operator; absence of git is not an error.
    if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
      git --no-pager diff HEAD --stat -- src/provider-definitions.ts 2>/dev/null |
        while IFS= read -r line; do log "  $line"; done
    fi
  fi

  # Rebuild so dist/ reflects the freshly written baseline; otherwise the next
  # run compares against the pre-apply contracts and reports the same drift
  # again. This has to run for BOTH drift exits, not just the needs-a-human
  # one: a pure version apply is the common case.
  npm run build >/dev/null 2>&1 || log "WARNING: rebuild after apply failed; dist/ is now stale"
}

case "$STATUS" in
  0)
    log "no provider contract drift"
    ;;
  2)
    if [ "$MODE" = "apply" ]; then
      log "provider contract drift found; applying what can be applied"
      report_applied_changes
    else
      log "provider contract drift found; re-run with GATEWAY_DRIFT_MODE=apply to rebaseline"
    fi
    ;;
  3)
    log "provider contract drift found that needs a human: see the lines above"
    report_applied_changes
    ;;
  *)
    die 1 "drift check failed with status $STATUS"
    ;;
esac

exit "$STATUS"
