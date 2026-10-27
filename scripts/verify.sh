#!/usr/bin/env bash
# Prove the exercise end to end:
#   1. the Guestbook works (write a message through the frontend, read it back from a replica)
#   2. Prometheus has both Guestbook ServiceMonitors as healthy targets
#   3. request, error, Redis and pod CPU/memory series all return data
#   4. Grafana accepts the stack's admin credentials and has the dashboard
source "$(dirname "$0")/lib.sh"
for t in kubectl pulumi curl jq; do need "$t"; done
select_stack

out() { pulumi -C "$REPO_ROOT" stack output "$@"; }
FRONTEND_URL="$(out frontendUrl)"
GRAFANA_URL="$(out grafanaUrl)"
GRAFANA_USER="$(out grafanaUser)"
GRAFANA_PASSWORD="$(out grafanaPassword --show-secrets)"

FAILED=0
pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=1; }

log "Guestbook: write through the frontend, read back"
MSG="verify-$(date +%s)"
curl -fsS "${FRONTEND_URL}/guestbook.php?cmd=set&key=messages&value=${MSG}" >/dev/null
if curl -fsS "${FRONTEND_URL}/guestbook.php?cmd=get&key=messages" | grep -q "$MSG"; then
  pass "message '${MSG}' stored and read back"
else
  fail "message not read back from the frontend"
fi
# Ask the replica, not the leader: the leader counts a replica as connected
# even while every sync attempt fails (see README, "What broke").
REPLICA_POD="$(kc -n "$APP_NS" get pod -l app=redis-replica -o name | head -1)"
LINK=$(kc -n "$APP_NS" exec "$REPLICA_POD" -c replica -- redis-cli info replication 2>/dev/null | tr -d '\r' | awk -F: '/^master_link_status/{print $2}')
[[ "$LINK" == "up" ]] && pass "redis replica link to leader is up" || fail "redis replica master_link_status=${LINK:-unknown}"
if kc -n "$APP_NS" exec "$REPLICA_POD" -c replica -- redis-cli lrange messages 0 -1 2>/dev/null | grep -q "$MSG" ||
   kc -n "$APP_NS" exec "$REPLICA_POD" -c replica -- redis-cli get messages 2>/dev/null | grep -q "$MSG"; then
  pass "message replicated to the replica"
else
  fail "message not found on the replica"
fi

log "Port-forwarding Prometheus on :9090"
kc -n "$MON_NS" port-forward svc/kps-prometheus 9090:9090 >/dev/null 2>&1 &
PF_PID=$!
trap 'kill $PF_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do curl -fs localhost:9090/-/ready >/dev/null 2>&1 && break; sleep 1; done

query() { curl -fsS --get localhost:9090/api/v1/query --data-urlencode "query=$1" | jq -r '.data.result[0].value[1] // "none"'; }

log "Prometheus scrape targets (waiting up to 3m: on a fresh cluster Prometheus is still loading its config)"
for _ in $(seq 1 36); do
  TARGETS=$(curl -fsS localhost:9090/api/v1/targets?state=active |
    jq -r '.data.activeTargets[] | select(.labels.namespace=="guestbook") | "\(.scrapePool) \(.labels.pod) \(.health)"')
  UP=$(grep -c ' up$' <<<"$TARGETS" || true)
  [[ "$UP" -ge 5 ]] && break
  sleep 5
done
sed 's/^/        /' <<<"$TARGETS"
grep -q 'guestbook-frontend.* up$' <<<"$TARGETS" && pass "frontend (Envoy) targets up" || fail "frontend targets not up"
grep -q 'guestbook-redis.* up$' <<<"$TARGETS" && pass "redis exporter targets up" || fail "redis targets not up"
[[ "$UP" -eq 5 ]] && pass "5/5 Guestbook targets healthy (3 frontend, leader, replica)" || fail "expected 5 healthy targets, got ${UP}"

# Traffic starts only once the targets are UP and is spread over ~40s (several
# 15s scrapes). On a fresh cluster a single burst can land before Prometheus
# has a first sample of the new series, and rate() then has nothing to compare.
log "Generating traffic for ~40s: normal requests, forced 503s (Envoy fault header), 404s"
END=$((SECONDS + 40)); i=0
while ((SECONDS < END)); do
  i=$((i + 1))
  curl -s -o /dev/null "${FRONTEND_URL}/guestbook.php?cmd=get&key=messages"
  ((i % 10 == 0)) && curl -s -o /dev/null -H 'x-envoy-fault-abort-request: 503' "${FRONTEND_URL}/"
  ((i % 20 == 0)) && curl -s -o /dev/null "${FRONTEND_URL}/no-such-page"
  sleep 0.1
done
log "Waiting one scrape interval so the last traffic lands, then querying"
sleep 20
check() {
  local name="$1" expr="$2" v
  v=$(query "$expr")
  if [[ "$v" != "none" ]] && awk "BEGIN{exit !($v > 0)}"; then pass "$name = $v"; else fail "$name returned $v  ($expr)"; fi
}
ING='envoy_http_conn_manager_prefix="ingress_http",namespace="guestbook"'
check "frontend requests (total)"   "sum(envoy_http_downstream_rq_total{$ING})"
check "frontend request rate req/s (1m)" "sum(rate(envoy_http_downstream_rq_total{$ING}[1m]))"
check "frontend 5xx responses"      "sum(envoy_http_downstream_rq_xx{$ING,envoy_response_code_class=\"5\"})"
check "frontend 4xx responses"      "sum(envoy_http_downstream_rq_xx{$ING,envoy_response_code_class=\"4\"})"
check "redis commands processed"    "sum(redis_commands_processed_total{namespace=\"guestbook\"})"
check "redis replica link up"       "min(redis_master_link_up{namespace=\"guestbook\"})"
check "pod CPU cores (cAdvisor)"    "sum(rate(container_cpu_usage_seconds_total{namespace=\"guestbook\",container!=\"\"}[2m]))"
check "pod memory bytes (cAdvisor)" "sum(container_memory_working_set_bytes{namespace=\"guestbook\",container!=\"\"})"

log "Grafana at ${GRAFANA_URL}"
if curl -fsS -u "${GRAFANA_USER}:${GRAFANA_PASSWORD}" "${GRAFANA_URL}/api/user" >/dev/null; then
  pass "login as ${GRAFANA_USER} with the stack-output password"
else
  fail "Grafana rejected the stack-output credentials"
fi
# The dashboard sidecar reloads a few seconds after the ConfigMap changes; retry.
DASH=""
for _ in $(seq 1 36); do
  DASH=$(curl -fsS -u "${GRAFANA_USER}:${GRAFANA_PASSWORD}" "${GRAFANA_URL}/api/dashboards/uid/guestbook-overview" 2>/dev/null | jq -r '.dashboard.title // empty' || true)
  [[ -n "$DASH" ]] && break
  sleep 5
done
[[ -n "$DASH" ]] && pass "dashboard '${DASH}' provisioned at ${GRAFANA_URL}/d/guestbook-overview" || fail "dashboard not found"

echo
if [[ "$FAILED" -eq 0 ]]; then echo "verify: all checks passed"; else echo "verify: FAILED"; exit 1; fi
