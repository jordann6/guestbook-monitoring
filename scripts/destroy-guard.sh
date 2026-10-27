#!/usr/bin/env bash
#
# destroy-guard.sh: fail when a Pulumi preview deletes or replaces a stateful
# or blast-radius resource, unless the change was explicitly approved.
#
# Ported from the Terraform version in platform-guardrails. The failure it
# prevents is the same: an update that applies cleanly and takes the data, or
# the whole namespace, with it because nobody read the preview.
#
# Usage:
#   pulumi preview --json > preview.json
#   scripts/destroy-guard.sh preview.json
#
# Environment:
#   DESTROY_APPROVED=true   Bypass the gate (CI sets this only when the PR carries
#                           the 'destroy-approved' label).

set -euo pipefail

PREVIEW_JSON="${1:-}"
if [[ -z "$PREVIEW_JSON" || ! -f "$PREVIEW_JSON" ]]; then
  echo "usage: $0 <preview.json>" >&2
  exit 2
fi
command -v jq >/dev/null 2>&1 || { echo "destroy-guard: jq is required" >&2; exit 2; }
# Fail closed: an empty or truncated preview would otherwise match nothing and pass.
jq -e '.steps | type == "array"' "$PREVIEW_JSON" >/dev/null 2>&1 || {
  echo "destroy-guard: $PREVIEW_JSON is not a Pulumi preview (no .steps array)" >&2
  exit 2
}

# Matched against "<type>::<name>" from each step's URN.
#   Namespace        deleting it deletes everything inside it
#   helm Release     Prometheus and Grafana, plus all scraped history
#   redis-leader     the only copy of the guestbook messages
#   grafana-admin    rotating it logs everyone out and breaks saved credentials
PROTECTED='^(kubernetes:core/v1:Namespace::.*|kubernetes:helm\.sh/v3:Release::.*|kubernetes:apps/v1:Deployment::redis-leader|kubernetes:core/v1:Secret::grafana-admin)$'

HITS=$(jq -r '
  .steps[]
  | select(.op == "delete" or .op == "replace" or .op == "delete-replaced" or .op == "create-replacement")
  | (.urn | split("::")) as $u
  | "\(.op)\t\($u[2] | split("$") | last)::\($u[3])"
' "$PREVIEW_JSON" | sort -u | awk -F'\t' -v re="$PROTECTED" '$2 ~ re')

if [[ -z "$HITS" ]]; then
  echo "destroy-guard: no protected resource is deleted or replaced"
  exit 0
fi

echo "destroy-guard: this preview deletes or replaces protected resources:"
sed 's/^/  /' <<<"$HITS"
if [[ "${DESTROY_APPROVED:-false}" == "true" ]]; then
  echo "destroy-guard: DESTROY_APPROVED=true, allowing"
  exit 0
fi
echo "destroy-guard: blocked. Add the 'destroy-approved' label to the PR if this is intended."
exit 1
