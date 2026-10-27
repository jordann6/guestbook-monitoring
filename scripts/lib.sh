#!/usr/bin/env bash
# Shared helpers for the deploy/verify/destroy scripts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-guestbook}"
STACK="${STACK:-dev}"
export APP_NS="guestbook"
export MON_NS="monitoring"

# Local file backend inside the repo (gitignored): no Pulumi Cloud account needed.
export PULUMI_BACKEND_URL="${PULUMI_BACKEND_URL:-file://${REPO_ROOT}/.pulumi-state}"
# The state is encrypted with this passphrase. Empty is allowed for a throwaway
# local demo; set your own to keep the Grafana password encrypted at rest.
export PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE-}"
export PULUMI_SKIP_UPDATE_CHECK=true

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required tool '$1' not found on PATH" >&2
    exit 1
  }
}

log() { printf '\n==> %s\n' "$*"; }

select_stack() {
  mkdir -p "${REPO_ROOT}/.pulumi-state"
  pulumi -C "$REPO_ROOT" stack select "$STACK" --create >/dev/null
}

# Scope every kubectl call to the k3d cluster, never whatever context is current.
kc() { kubectl --context "k3d-${CLUSTER_NAME}" "$@"; }
