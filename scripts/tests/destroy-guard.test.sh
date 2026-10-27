#!/usr/bin/env bash
# Fixture tests for destroy-guard.sh. Run: scripts/tests/destroy-guard.test.sh
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
GUARD="$DIR/../destroy-guard.sh"
FAILED=0
expect() {
  local want="$1" desc="$2"; shift 2
  "$@" >/dev/null 2>&1; local got=$?
  if [[ "$got" -eq "$want" ]]; then echo "ok    $desc"; else echo "FAIL  $desc (exit $got, want $want)"; FAILED=1; fi
}
expect 0 "safe preview passes (ConfigMap replace is not protected)" "$GUARD" "$DIR/fixtures/safe.json"
expect 1 "redis-leader replace + namespace delete is blocked"       "$GUARD" "$DIR/fixtures/destructive.json"
expect 0 "DESTROY_APPROVED=true lets it through" env DESTROY_APPROVED=true "$GUARD" "$DIR/fixtures/destructive.json"
expect 2 "missing file is a usage error"                            "$GUARD" "$DIR/fixtures/nope.json"
expect 2 "preview without steps fails closed"                       "$GUARD" "$DIR/fixtures/invalid.json"
exit "$FAILED"
