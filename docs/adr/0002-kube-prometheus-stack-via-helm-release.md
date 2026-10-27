# ADR-0002: kube-prometheus-stack via a Pulumi Helm Release

- **Status:** accepted
- **Date:** 2026-10-27

## Context

The exercise allows Helm charts or raw resources. Prometheus needs the
operator CRDs (ServiceMonitor), RBAC for cAdvisor and kubelet scraping, and
Grafana needs a datasource and dashboard provisioning. Writing that by hand is
hundreds of lines that duplicate a well-maintained chart.

## Decision

Install `kube-prometheus-stack` (pinned chart version) with
`kubernetes.helm.v3.Release`, and declare the Guestbook ServiceMonitors and
the dashboard ConfigMap as Pulumi resources that depend on the release.

## Alternatives rejected

| Option | Why not |
| ------ | ------- |
| Raw Prometheus and Grafana Deployments | No operator, so annotation-based scraping only, plus hand-written RBAC and provisioning. More code, less standard. |
| `kubernetes.helm.v4.Chart` | Renders every chart object into Pulumi state (hundreds of resources). Better visibility, slower previews, and CRD ordering to manage. Release keeps the chart as one unit Helm owns. |
| Separate prometheus and grafana charts | Two charts to keep version-compatible; kube-prometheus-stack already wires the datasource and default dashboards. |

## Consequences

- The policy pack sees the Release as one resource, not the objects it renders, so the Grafana Service and node-exporter (which legitimately uses host access) are not checked by the container rules. The release-level rules (pinned version, no plaintext admin password) still apply.
- On k3s, the controller-manager, scheduler, etcd and kube-proxy scrape jobs are disabled: k3s runs them inside one binary, and the targets would sit DOWN.
- Revisit with helm.v4.Chart if per-object policy checks on chart output become a requirement.
