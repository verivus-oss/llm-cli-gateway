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

set +e
if [ "$MODE" = "apply" ]; then
  OUTPUT="$(node scripts/rebaseline-provider-contracts.mjs --apply 2>&1)"
else
  OUTPUT="$(node scripts/rebaseline-provider-contracts.mjs 2>&1)"
fi
STATUS=$?
set -e

printf '%s\n' "$OUTPUT" | while IFS= read -r line; do log "  $line"; done

case "$STATUS" in
  0)
    log "no provider contract drift"
    ;;
  2)
    if [ "$MODE" = "apply" ]; then
      log "provider contract drift found and rebaselined"
    else
      log "provider contract drift found; re-run with GATEWAY_DRIFT_MODE=apply to rebaseline"
    fi
    ;;
  3)
    log "provider contract drift found that needs a human: see the lines above"
    if [ "$MODE" = "apply" ]; then
      # Surface any auto-applied edits, so an unexplained dirty tree never
      # appears without a trail pointing here.
      if ! git diff --quiet -- src/provider-definitions.ts 2>/dev/null; then
        log "auto-applied version rebaseline left uncommitted changes in src/provider-definitions.ts"
        git --no-pager diff --stat -- src/provider-definitions.ts 2>/dev/null |
          while IFS= read -r line; do log "  $line"; done
        # Rebuild so dist/ reflects the freshly written baseline; otherwise the
        # next run compares against the pre-apply contracts and reports the
        # same drift again.
        npm run build >/dev/null 2>&1 || log "WARNING: rebuild after apply failed; dist/ is now stale"
      fi
    fi
    ;;
  *)
    die 1 "drift check failed with status $STATUS"
    ;;
esac

exit "$STATUS"
