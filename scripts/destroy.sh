#!/usr/bin/env bash
# Tear everything down: the Pulumi stack, its local state, and the k3d cluster.
source "$(dirname "$0")/lib.sh"
for t in k3d pulumi; do need "$t"; done

if pulumi -C "$REPO_ROOT" stack select "$STACK" >/dev/null 2>&1; then
  log "pulumi destroy"
  pulumi -C "$REPO_ROOT" destroy --yes --skip-preview
  pulumi -C "$REPO_ROOT" stack rm "$STACK" --yes
fi

if [[ "${KEEP_CLUSTER:-false}" != "true" ]]; then
  log "Deleting k3d cluster '${CLUSTER_NAME}'"
  k3d cluster delete "$CLUSTER_NAME"
fi
