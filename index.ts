import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { FRONTEND_NODE_PORT, Guestbook } from "./guestbook";
import { GRAFANA_NODE_PORT, Monitoring } from "./monitoring";

const config = new pulumi.Config();
// k3d, kind and minikube have no cloud load balancer, so the default is NodePort.
const useLoadBalancer = config.getBoolean("useLoadBalancer") ?? false;
const nodeHost = config.get("nodeHost") ?? "localhost";

const managedBy = { "app.kubernetes.io/managed-by": "pulumi" };
const appNs = new k8s.core.v1.Namespace("guestbook", { metadata: { name: "guestbook", labels: { app: "guestbook", ...managedBy } } });
const monNs = new k8s.core.v1.Namespace("monitoring", { metadata: { name: "monitoring", labels: { app: "monitoring", ...managedBy } } });

const guestbook = new Guestbook("guestbook", { namespace: appNs.metadata.name, useLoadBalancer });
const monitoring = new Monitoring("monitoring", {
    namespace: monNs.metadata.name,
    guestbookNamespace: appNs.metadata.name,
    useLoadBalancer,
});

const lbAddress = (svc: k8s.core.v1.Service) =>
    svc.status.loadBalancer.ingress.apply(i => i?.[0]?.hostname ?? i?.[0]?.ip ?? "<pending>");

export const frontendUrl = useLoadBalancer
    ? pulumi.interpolate`http://${lbAddress(guestbook.frontendService)}`
    : `http://${nodeHost}:${FRONTEND_NODE_PORT}`;

export const grafanaUrl = useLoadBalancer
    ? pulumi.interpolate`http://${lbAddress(monitoring.grafanaService!)}`
    : `http://${nodeHost}:${GRAFANA_NODE_PORT}`;

export const grafanaUser = monitoring.grafanaUser;
// Secret: `pulumi stack output grafanaPassword --show-secrets`
export const grafanaPassword = monitoring.grafanaPassword;
export const grafanaDashboard = pulumi.interpolate`${grafanaUrl}/d/guestbook-overview`;

// Prometheus stays ClusterIP; it has no auth of its own.
export const prometheusPortForward = pulumi.interpolate`kubectl -n ${monNs.metadata.name} port-forward svc/kps-prometheus 9090:9090`;
