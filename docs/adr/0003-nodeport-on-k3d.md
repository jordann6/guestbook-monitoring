# ADR-0003: NodePort by default, LoadBalancer behind a flag

- **Status:** accepted
- **Date:** 2026-10-27

## Context

The exercise asks for Grafana on a LoadBalancer or NodePort and for the
Grafana URL as a stack output. The target here is a local k3d cluster, which
has no cloud load balancer controller. A reviewer may run it on a cloud
cluster instead.

## Decision

Default to NodePort (frontend 30080, Grafana 30300). k3d maps both node ports
to localhost, so the stack outputs are usable URLs immediately. Setting
`useLoadBalancer: true` switches both Services to LoadBalancer and the outputs
to the provisioned address.

## Alternatives rejected

| Option | Why not |
| ------ | ------- |
| LoadBalancer only, via k3s ServiceLB (klipper) | Works on k3d, but binds host ports on every node and hides how a cloud LB would behave. |
| Ingress | Not asked for, and adds a controller and hostnames to a two-URL demo. |
| kubectl port-forward only | Does not satisfy "exposed via LoadBalancer or NodePort", and the output URL would not work without a running command. |

## Consequences

- Prometheus stays ClusterIP: it has no authentication. Access is by port-forward.
- Metrics ports are on separate ClusterIP Services, so a NodePort or LoadBalancer never exposes them (enforced by the `metrics-not-public` policy).
- The policy pack flags the NodePort as advisory, which is the intended reminder for any non-demo environment.
