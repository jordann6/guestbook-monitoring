#!/usr/bin/env bash
# Create a local k3d cluster (if missing) and deploy everything with Pulumi.
source "$(dirname "$0")/lib.sh"
for t in k3d kubectl pulumi npm docker; do need "$t"; done

if ! k3d cluster list -o json | grep -q "\"name\": *\"${CLUSTER_NAME}\""; then
  log "Creating k3d cluster '${CLUSTER_NAME}' (NodePorts 30080 frontend, 30300 Grafana mapped to localhost)"
  k3d cluster create "$CLUSTER_NAME" --agents 1 \
    -p "30080:30080@server:0" -p "30300:30300@server:0" --wait
fi

log "Installing npm dependencies"
npm --prefix "$REPO_ROOT" ci --no-audit --no-fund

select_stack
pulumi -C "$REPO_ROOT" config set kubernetes:context "k3d-${CLUSTER_NAME}"

log "pulumi up"
pulumi -C "$REPO_ROOT" up --yes --skip-preview "$@"

log "Stack outputs"
pulumi -C "$REPO_ROOT" stack output
echo
echo "Grafana password: pulumi stack output grafanaPassword --show-secrets"
echo "  (run with PULUMI_BACKEND_URL=file://${REPO_ROOT}/.pulumi-state, or use scripts/verify.sh)"
