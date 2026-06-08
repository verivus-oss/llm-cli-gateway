#!/usr/bin/env bash
#
# host-upgrade.sh — keep this host's llm-cli-gateway global npm install on the
# latest public release, with versioned staging and atomic apply.
#
# Design (mirrors sqry's host-upgrade pattern — see sqry's
# docs/ops/2026-06-02-sqry-host-upgrade-recommendation.md):
#   * Live install: npm global prefix (default /opt/nodejs/current).
#   * `stage` installs into $VERSIONS_DIR/<ver>/ via `npm install --prefix`
#     without touching the live global install.
#   * `apply` runs `npm install -g llm-cli-gateway@<ver>` and smoke-tests the
#     live binary; on failure it rolls back to the previous version.
#   * No daemon restart: MCP clients spawn stdio servers per session and pick
#     up the new binary on their next launch.
#   * A single flock guards stage/apply so the timer cannot collide with a
#     manual run.
#
# Subcommands:
#   status            Show live / staged / npm-latest versions.
#   check             Print whether an upgrade is available.
#   stage [--tag X.Y.Z]
#                     Install into $VERSIONS_DIR/<ver>/ and mark upgrade-ready.
#   apply [--tag X.Y.Z]
#                     Promote <ver> to the live global install (default: staged).
#   auto              stage + apply the latest release iff newer than current.
#                     Honors GATEWAY_AUTOUPGRADE_MODE (apply|notify; default apply).
#                     This is what the systemd timer runs.
#   rollback          Reinstall the recorded previous version.
#
# Exit codes: 0 ok / no-op; 2 usage; 3 network/resolve; 4 verify; 5 apply-failed
# (rolled back); 6 lock busy.

set -euo pipefail

PACKAGE="${GATEWAY_PACKAGE:-llm-cli-gateway}"
BIN="${GATEWAY_BIN:-/opt/nodejs/current/bin/llm-cli-gateway}"
NPM_PREFIX="${GATEWAY_NPM_PREFIX:-/opt/nodejs/current}"
PREFIX="${GATEWAY_PREFIX:-$HOME/.local/share/llm-cli-gateway}"
VERSIONS_DIR="$PREFIX/versions"
STATE_DIR="$PREFIX/state"
LOCK_FILE="$PREFIX/.upgrade.lock"
MODE="${GATEWAY_AUTOUPGRADE_MODE:-apply}"
SMOKE_TIMEOUT="${GATEWAY_SMOKE_TIMEOUT:-30}"

log()  { printf '[gateway-host-upgrade] %s\n' "$*" >&2; }
die()  { local code="$1"; shift; log "ERROR: $*"; exit "$code"; }
need() { command -v "$1" >/dev/null 2>&1 || die 2 "required command not found: $1"; }

normalize_ver() {
  local v="$1"
  v="${v#v}"
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || return 1
  echo "$v"
}

valid_ver() { normalize_ver "$1" >/dev/null; }

ver_gt() {
  local a b
  a="$(normalize_ver "$1")" || return 1
  b="$(normalize_ver "$2")" || return 1
  [[ "$a" != "$b" ]] && [[ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -1)" == "$a" ]]
}

ensure_dirs() { mkdir -p "$VERSIONS_DIR" "$STATE_DIR"; }

current_version() {
  need node
  if [[ -x "$BIN" ]]; then
    "$BIN" --version 2>/dev/null && return 0
  fi
  local pkg="$NPM_PREFIX/lib/node_modules/$PACKAGE/package.json"
  [[ -f "$pkg" ]] || return 1
  node -p "require('$pkg').version"
}

latest_version() {
  need npm
  local v
  v="$(npm view "$PACKAGE" version 2>/dev/null)" || die 3 "could not resolve latest $PACKAGE version from npm (offline / rate-limited?)"
  normalize_ver "$v" || die 3 "resolved version is malformed: '$v'"
}

staged_binary() {
  local ver="$1"
  echo "$VERSIONS_DIR/$ver/node_modules/.bin/$PACKAGE"
}

verify_staged_dir() {
  local ver="$1" staged
  staged="$(staged_binary "$ver")"
  [[ -x "$staged" ]] || return 1
  local got
  got="$("$staged" --version 2>/dev/null)" || return 1
  [[ "$(normalize_ver "$got")" == "$ver" ]]
}

stage() {
  need npm
  ensure_dirs
  local ver="$1"
  local dest="$VERSIONS_DIR/$ver"
  if verify_staged_dir "$ver" 2>/dev/null; then
    log "already staged + verified: $dest"
    echo "$ver" > "$STATE_DIR/upgrade_ready"
    return 0
  fi
  log "staging $PACKAGE@$ver into $dest"
  rm -rf "$dest"
  npm install --prefix "$dest" --omit=dev "${PACKAGE}@${ver}" >/dev/null \
    || die 3 "npm stage failed for ${PACKAGE}@${ver}"
  verify_staged_dir "$ver" || die 4 "staged install failed verification for $ver"
  echo "$ver" > "$STATE_DIR/upgrade_ready"
  log "staged + verified: $dest"
}

smoke_live() {
  local want="$1" got
  got="$(timeout "$SMOKE_TIMEOUT" "$BIN" --version 2>/dev/null)" || {
    log "smoke: $BIN --version failed"
    return 1
  }
  got="$(normalize_ver "$got")" || return 1
  [[ "$got" == "$want" ]] || {
    log "smoke: live binary is $got, expected $want"
    return 1
  }
  log "smoke OK: live $PACKAGE on $want"
}

apply_global() {
  local ver="$1"
  need npm
  npm install -g --prefix "$NPM_PREFIX" --omit=dev "${PACKAGE}@${ver}" >/dev/null \
    || return 1
  smoke_live "$ver"
}

apply() {
  ensure_dirs
  local ver="$1" prev
  verify_staged_dir "$ver" || die 2 "apply: $ver is not staged at $VERSIONS_DIR/$ver"
  prev="$(current_version 2>/dev/null || true)"
  [[ -n "$prev" ]] && prev="$(normalize_ver "$prev")" && echo "$prev" > "$STATE_DIR/previous"
  if apply_global "$ver"; then
    echo "$ver" > "$STATE_DIR/current"
    rm -f "$STATE_DIR/upgrade_ready"
    log "APPLIED $ver (restart MCP client sessions to pick up the new gateway)"
    return 0
  fi
  log "apply $ver FAILED — rolling back"
  if [[ -n "$prev" ]]; then
    if apply_global "$prev"; then
      echo "$prev" > "$STATE_DIR/current"
      log "rolled back to $prev"
    else
      log "rollback to $prev failed; manual intervention needed"
    fi
  else
    log "no previous version recorded; manual intervention needed"
  fi
  return 5
}

auto() {
  ensure_dirs
  local cur lat
  cur="$(current_version 2>/dev/null || echo 0.0.0)"
  cur="$(normalize_ver "$cur")"
  lat="$(latest_version)"
  if ! ver_gt "$lat" "$cur"; then
    log "up to date: current=$cur latest=$lat"
    return 0
  fi
  log "upgrade available: $cur -> $lat (mode=$MODE)"
  stage "$lat"
  if [[ "$MODE" == "notify" ]]; then
    log "MODE=notify: staged $lat; not applying. Run 'gateway-host-upgrade apply' to switch."
    return 0
  fi
  apply "$lat"
}

status() {
  ensure_dirs
  local cur lat staged
  cur="$(current_version 2>/dev/null || echo '?')"
  lat="$(latest_version 2>/dev/null || echo '(network?)')"
  printf 'live binary      : %s\n' "$BIN"
  printf 'npm global prefix: %s\n' "$NPM_PREFIX"
  printf 'installed        : %s\n' "$cur"
  printf 'npm latest       : %s\n' "$lat"
  [[ -f "$STATE_DIR/upgrade_ready" ]] \
    && printf 'upgrade staged   : %s (run: apply)\n' "$(cat "$STATE_DIR/upgrade_ready")"
  [[ -f "$STATE_DIR/previous" ]] \
    && printf 'previous         : %s\n' "$(cat "$STATE_DIR/previous")"
  if [[ "$cur" != "$lat" && "$lat" != '(network?)' ]]; then
    printf 'STATUS           : UPGRADE AVAILABLE -> %s\n' "$lat"
    printf 'NOTE             : running MCP sessions keep the old gateway until restarted\n'
  else
    printf 'STATUS           : current\n'
  fi
}

rollback() {
  local prev
  prev="$(cat "$STATE_DIR/previous" 2>/dev/null || true)"
  [[ -n "$prev" ]] || die 2 "no recorded previous version to roll back to"
  valid_ver "$prev" || die 2 "recorded previous version is invalid: $prev"
  stage "$prev"
  apply "$prev"
}

with_lock() {
  ensure_dirs
  exec 9>"$LOCK_FILE"
  flock -n 9 || die 6 "another gateway-host-upgrade run holds the lock ($LOCK_FILE)"
  "$@"
}

cmd="${1:-status}"; shift || true
tag=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) tag="${2#v}"; shift 2 ;;
    *) die 2 "unknown arg: $1" ;;
  esac
done
[[ -n "$tag" ]] && { valid_ver "$tag" || die 2 "bad --tag '$tag'"; }

case "$cmd" in
  status)
    status
    ;;
  check)
    cur="$(current_version 2>/dev/null || echo 0.0.0)"
    cur="$(normalize_ver "$cur")"
    lat="$(latest_version)"
    if ver_gt "$lat" "$cur"; then
      echo "upgrade available: $cur -> $lat"
    else
      echo "up to date: $cur"
    fi
    ;;
  stage)
    with_lock stage "${tag:-$(latest_version)}"
    ;;
  apply)
    with_lock apply "${tag:-$(cat "$STATE_DIR/upgrade_ready" 2>/dev/null || die 2 'nothing staged; pass --tag')}"
    ;;
  auto)
    with_lock auto
    ;;
  rollback)
    with_lock rollback
    ;;
  help|-h|--help)
    sed -n '2,35p' "$0"
    ;;
  *)
    die 2 "unknown subcommand: $cmd (try: status check stage apply auto rollback)"
    ;;
esac