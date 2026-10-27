// Prometheus and Grafana via kube-prometheus-stack, plus the two ServiceMonitors
// and the Guestbook dashboard.
//
// The Grafana admin password is generated here and handed to the chart as an
// existing Secret, so it never appears in Helm values or in plaintext state.

import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

const CHART_VERSION = "92.14.0";
export const GRAFANA_NODE_PORT = 30300;

export interface MonitoringArgs {
    namespace: pulumi.Input<string>;
    guestbookNamespace: pulumi.Input<string>;
    useLoadBalancer: boolean;
}

const managedBy = { "app.kubernetes.io/managed-by": "pulumi" };

export class Monitoring extends pulumi.ComponentResource {
    /** Only read back on LoadBalancer clusters, where the address is not known up front. */
    public readonly grafanaService?: k8s.core.v1.Service;
    public readonly grafanaUser: pulumi.Output<string>;
    public readonly grafanaPassword: pulumi.Output<string>;
    public readonly releaseName: pulumi.Output<string>;

    constructor(name: string, args: MonitoringArgs, opts?: pulumi.ComponentResourceOptions) {
        super("guestbook:monitoring:Monitoring", name, {}, opts);
        const parent = { parent: this };

        const password = new random.RandomPassword("grafana-admin", { length: 24, special: false }, parent);
        const adminSecret = new k8s.core.v1.Secret("grafana-admin", {
            metadata: { namespace: args.namespace, labels: { app: "grafana", ...managedBy } },
            stringData: { "admin-user": "admin", "admin-password": password.result },
        }, parent);

        const release = new k8s.helm.v3.Release("kube-prometheus-stack", {
            chart: "kube-prometheus-stack",
            version: CHART_VERSION,
            repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
            namespace: args.namespace,
            // Short, stable names (prometheus-operated, kps-grafana) instead of the
            // release-name-plus-suffix Pulumi would otherwise generate.
            name: "kps",
            values: {
                fullnameOverride: "kps",
                // k3s embeds the control plane in one binary; these scrape targets
                // do not exist as pods and would sit DOWN forever.
                kubeControllerManager: { enabled: false },
                kubeScheduler: { enabled: false },
                kubeEtcd: { enabled: false },
                kubeProxy: { enabled: false },
                // Not part of the exercise. See README "On a real cluster".
                alertmanager: { enabled: false },
                prometheus: {
                    prometheusSpec: {
                        retention: "6h",
                        scrapeInterval: "15s",
                        resources: { requests: { cpu: "200m", memory: "512Mi" }, limits: { memory: "1Gi" } },
                        // Discover ServiceMonitors in every namespace, not only those
                        // carrying this release's label.
                        serviceMonitorSelectorNilUsesHelmValues: false,
                        podMonitorSelectorNilUsesHelmValues: false,
                        ruleSelectorNilUsesHelmValues: false,
                    },
                },
                grafana: {
                    admin: { existingSecret: adminSecret.metadata.name, userKey: "admin-user", passwordKey: "admin-password" },
                    defaultDashboardsEnabled: true,
                    service: args.useLoadBalancer
                        ? { type: "LoadBalancer" }
                        : { type: "NodePort", nodePort: GRAFANA_NODE_PORT },
                    sidecar: { dashboards: { enabled: true, label: "grafana_dashboard", labelValue: "1", searchNamespace: "ALL" } },
                },
            },
        }, parent);

        const afterCrds = { parent: this, dependsOn: [release] };

        // Frontend: Envoy sidecar metrics, via the dedicated ClusterIP Service.
        new k8s.apiextensions.CustomResource("guestbook-frontend", {
            apiVersion: "monitoring.coreos.com/v1",
            kind: "ServiceMonitor",
            metadata: { namespace: args.guestbookNamespace, labels: { app: "frontend", ...managedBy } },
            spec: {
                selector: { matchLabels: { app: "frontend", "guestbook/metrics": "true" } },
                endpoints: [{ port: "metrics", path: "/stats/prometheus", interval: "15s" }],
            },
        }, afterCrds);

        // Backend: redis_exporter sidecars on the leader and replica Services.
        new k8s.apiextensions.CustomResource("guestbook-redis", {
            apiVersion: "monitoring.coreos.com/v1",
            kind: "ServiceMonitor",
            metadata: { namespace: args.guestbookNamespace, labels: { app: "redis", ...managedBy } },
            spec: {
                selector: { matchLabels: { tier: "backend", "app.kubernetes.io/part-of": "guestbook" } },
                endpoints: [{ port: "metrics", interval: "15s" }],
            },
        }, afterCrds);

        // Picked up by the Grafana dashboard sidecar. Pulumi replaces a ConfigMap
        // when its data changes, create-before-delete by default. Both copies map
        // to the same file in the sidecar, so deleting the old one removed the
        // dashboard the new one had just written. Delete first instead.
        new k8s.core.v1.ConfigMap("guestbook-dashboard", {
            metadata: { namespace: args.namespace, labels: { grafana_dashboard: "1", app: "grafana", ...managedBy } },
            data: { "guestbook.json": fs.readFileSync(path.join(__dirname, "dashboards", "guestbook.json"), "utf8") },
        }, { ...afterCrds, deleteBeforeReplace: true });

        this.releaseName = release.status.name as pulumi.Output<string>;
        if (args.useLoadBalancer) {
            this.grafanaService = k8s.core.v1.Service.get("kps-grafana", pulumi.interpolate`${args.namespace}/kps-grafana`, afterCrds);
        }
        this.grafanaUser = pulumi.output("admin");
        this.grafanaPassword = pulumi.secret(password.result);

        this.registerOutputs({ grafanaUser: this.grafanaUser, grafanaPassword: this.grafanaPassword });
    }
}
