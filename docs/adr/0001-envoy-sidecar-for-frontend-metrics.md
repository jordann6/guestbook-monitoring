# ADR-0001: Envoy sidecar for frontend metrics

- **Status:** accepted
- **Date:** 2026-10-27

## Context

The Guestbook frontend is the upstream `pulumi/guestbook-php-redis` image:
Apache 2.4 with PHP 5.6. It exposes no metrics endpoint. The exercise asks for
request metrics, and the stretch dashboard asks for an error rate, which needs
requests broken down by status code. The frontend image should stay unmodified
so the example is still recognizable.

## Decision

Run Envoy as a sidecar in each frontend pod. The Service targets Envoy on
:8080, Envoy proxies to Apache on 127.0.0.1:80, and a dedicated metrics
listener on :9901 serves only `/stats/prometheus`. The Envoy admin API is
bound to localhost.

## Alternatives rejected

| Option | Why not |
| ------ | ------- |
| apache_exporter (mod_status) | Total requests and worker state only. No status codes, so no real error rate. Also needs mod_status enabled inside an image this repo does not own. |
| nginx + nginx-prometheus-exporter | `stub_status` has the same gap: connections and totals, no status-code breakdown without a third-party module. |
| Rebuild the frontend with a Prometheus client | Changes the app under test, and PHP 5.6 client libraries are unmaintained. |
| Service mesh (Istio, Linkerd) | Gives the same metrics, plus a control plane far larger than the app. |

## Consequences

- Real request rate, 4xx/5xx breakdown and a latency histogram per pod, with no app changes.
- One extra container per frontend pod (25m CPU / 32Mi requested).
- The Envoy admin API is powerful (`/quitquitquit`, `/runtime_modify`), so it is never exposed directly. The metrics listener allows one path.
- A header-driven fault filter is enabled so the error-rate panel can be demonstrated. It does nothing without the header, and should be removed outside a demo.
- Revisit if the frontend is rewritten with native instrumentation, or if a mesh is introduced for other reasons.
