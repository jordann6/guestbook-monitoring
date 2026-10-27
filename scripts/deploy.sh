#!/usr/bin/env bash
# Create a local k3d cluster (if missing) and deploy everything with Pulumi,
# through the same gates as CI: policy-gated preview, destroy-guard, then a
# policy-gated apply. Any failed gate stops the script before anything changes.
source "$(dirname "$0")/lib.sh"
for t in k3d kubectl pulumi npm docker jq; do need "$t"; done

if ! k3d cluster list -o json | grep -q "\"name\": *\"${CLUSTER_NAME}\""; then
  log "Creating k3d cluster '${CLUSTER_NAME}' (NodePorts 30080 frontend, 30300 Grafana mapped to localhost)"
  k3d cluster create "$CLUSTER_NAME" --agents 1 \
    -p "30080:30080@server:0" -p "30300:30300@server:0" --wait
fi

log "Installing npm dependencies (program and policy pack)"
npm --prefix "$REPO_ROOT" ci --no-audit --no-fund
npm --prefix "$REPO_ROOT/policy" ci --no-audit --no-fund

log "Building policy pack"
npm --prefix "$REPO_ROOT/policy" run build

select_stack
pulumi -C "$REPO_ROOT" config set kubernetes:context "k3d-${CLUSTER_NAME}"

POLICY_PACK="${REPO_ROOT}/policy"
PREVIEW_JSON="${REPO_ROOT}/preview.json"
trap 'rm -f "$PREVIEW_JSON"' EXIT

log "Policy-gated preview"
pulumi -C "$REPO_ROOT" preview --policy-pack "$POLICY_PACK"

log "destroy-guard"
pulumi -C "$REPO_ROOT" preview --json --policy-pack "$POLICY_PACK" >"$PREVIEW_JSON"
"${REPO_ROOT}/scripts/destroy-guard.sh" "$PREVIEW_JSON"

log "pulumi up (policy-gated)"
pulumi -C "$REPO_ROOT" up --yes --skip-preview --policy-pack "$POLICY_PACK" "$@"

log "Stack outputs"
pulumi -C "$REPO_ROOT" stack output
echo
echo "Grafana password: pulumi stack output grafanaPassword --show-secrets"
echo "  (run with PULUMI_BACKEND_URL=file://${REPO_ROOT}/.pulumi-state, or use scripts/verify.sh)"
