// The Guestbook from pulumi/examples kubernetes-ts-guestbook (simple), ported
// with three kinds of change and nothing else:
//
//   1. Metrics. The PHP frontend and Redis expose no /metrics, so the frontend
//      gets an Envoy sidecar (request and status-code counters) and each Redis
//      pod gets a redis_exporter sidecar.
//   2. Pinned images. Upstream runs an unpinned `redis` leader against a replica
//      image built on Redis 6.0.5. Once `redis:latest` moved to 8.x the replica
//      could no longer load the leader's RDB format and replication stopped
//      syncing. Both tiers now run the same pinned Redis.
//   3. Limits and labels on every container, so the policy pack in policy/ passes.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const REDIS_IMAGE = "redis:7.4.6";
const REDIS_EXPORTER_IMAGE = "oliver006/redis_exporter:v1.96.0";
const ENVOY_IMAGE = "envoyproxy/envoy:v1.39.6";
const FRONTEND_IMAGE = "pulumi/guestbook-php-redis@sha256:f21cbff35c0bad29d0c480f741e19919fb135d7c7941b8b5fc7240503d0a1c4f";

export const FRONTEND_NODE_PORT = 30080;

export interface GuestbookArgs {
    namespace: pulumi.Input<string>;
    useLoadBalancer: boolean;
}

const commonLabels = { "app.kubernetes.io/part-of": "guestbook", "app.kubernetes.io/managed-by": "pulumi" };

const redisExporter = (): k8s.types.input.core.v1.Container => ({
    name: "redis-exporter",
    image: REDIS_EXPORTER_IMAGE,
    env: [{ name: "REDIS_ADDR", value: "redis://localhost:6379" }],
    ports: [{ name: "metrics", containerPort: 9121 }],
    resources: { requests: { cpu: "10m", memory: "16Mi" }, limits: { cpu: "100m", memory: "64Mi" } },
    securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, runAsUser: 59000 },
});

export class Guestbook extends pulumi.ComponentResource {
    public readonly frontendService: k8s.core.v1.Service;

    constructor(name: string, args: GuestbookArgs, opts?: pulumi.ComponentResourceOptions) {
        super("guestbook:app:Guestbook", name, {}, opts);
        const parent = { parent: this };
        const ns = args.namespace;

        //
        // REDIS LEADER.
        //

        const redisLeaderLabels = { app: "redis-leader", tier: "backend", ...commonLabels };
        new k8s.apps.v1.Deployment("redis-leader", {
            metadata: { namespace: ns, labels: redisLeaderLabels },
            spec: {
                selector: { matchLabels: { app: "redis-leader" } },
                template: {
                    metadata: { labels: redisLeaderLabels },
                    spec: {
                        containers: [
                            {
                                name: "redis-leader",
                                image: REDIS_IMAGE,
                                resources: { requests: { cpu: "100m", memory: "100Mi" }, limits: { cpu: "250m", memory: "256Mi" } },
                                ports: [{ name: "redis", containerPort: 6379 }],
                            },
                            redisExporter(),
                        ],
                    },
                },
            },
        }, parent);
        new k8s.core.v1.Service("redis-leader", {
            metadata: { name: "redis-leader", namespace: ns, labels: redisLeaderLabels },
            spec: {
                ports: [
                    { name: "redis", port: 6379, targetPort: "redis" },
                    { name: "metrics", port: 9121, targetPort: "metrics" },
                ],
                selector: { app: "redis-leader" },
            },
        }, parent);

        //
        // REDIS REPLICA.
        //

        const redisReplicaLabels = { app: "redis-replica", tier: "backend", ...commonLabels };
        new k8s.apps.v1.Deployment("redis-replica", {
            metadata: { namespace: ns, labels: redisReplicaLabels },
            spec: {
                selector: { matchLabels: { app: "redis-replica" } },
                template: {
                    metadata: { labels: redisReplicaLabels },
                    spec: {
                        containers: [
                            {
                                name: "replica",
                                // Same image as the leader. This is what pulumi/guestbook-redis-replica's
                                // run.sh does, minus the version skew.
                                image: REDIS_IMAGE,
                                args: ["--replicaof", "redis-leader", "6379"],
                                resources: { requests: { cpu: "100m", memory: "100Mi" }, limits: { cpu: "250m", memory: "256Mi" } },
                                ports: [{ name: "redis", containerPort: 6379 }],
                            },
                            redisExporter(),
                        ],
                    },
                },
            },
        }, parent);
        new k8s.core.v1.Service("redis-replica", {
            metadata: { name: "redis-replica", namespace: ns, labels: redisReplicaLabels },
            spec: {
                ports: [
                    { name: "redis", port: 6379, targetPort: "redis" },
                    { name: "metrics", port: 9121, targetPort: "metrics" },
                ],
                selector: { app: "redis-replica" },
            },
        }, parent);

        //
        // FRONTEND
        //

        const envoyConfig = fs.readFileSync(path.join(__dirname, "envoy", "envoy.yaml"), "utf8");
        const envoyConfigMap = new k8s.core.v1.ConfigMap("frontend-envoy", {
            metadata: { namespace: ns, labels: { app: "frontend", ...commonLabels } },
            data: { "envoy.yaml": envoyConfig },
        }, parent);

        const frontendLabels = { app: "frontend", tier: "frontend", ...commonLabels };
        new k8s.apps.v1.Deployment("frontend", {
            metadata: { namespace: ns, labels: frontendLabels },
            spec: {
                selector: { matchLabels: { app: "frontend" } },
                replicas: 3,
                template: {
                    metadata: {
                        labels: frontendLabels,
                        // Roll the pods when the Envoy config changes; a ConfigMap edit alone does not.
                        annotations: { "guestbook/envoy-config-sha": crypto.createHash("sha256").update(envoyConfig).digest("hex").slice(0, 16) },
                    },
                    spec: {
                        containers: [
                            {
                                name: "frontend",
                                image: FRONTEND_IMAGE,
                                resources: { requests: { cpu: "100m", memory: "100Mi" }, limits: { cpu: "250m", memory: "256Mi" } },
                                env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                                ports: [{ name: "php", containerPort: 80 }],
                            },
                            {
                                name: "envoy",
                                image: ENVOY_IMAGE,
                                args: ["-c", "/etc/envoy/envoy.yaml", "--log-level", "warn"],
                                ports: [
                                    { name: "http", containerPort: 8080 },
                                    { name: "metrics", containerPort: 9901 },
                                ],
                                readinessProbe: { httpGet: { path: "/stats/prometheus", port: "metrics" }, periodSeconds: 10 },
                                resources: { requests: { cpu: "25m", memory: "32Mi" }, limits: { cpu: "200m", memory: "128Mi" } },
                                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, runAsUser: 101 },
                                volumeMounts: [{ name: "envoy-config", mountPath: "/etc/envoy", readOnly: true }],
                            },
                        ],
                        volumes: [{ name: "envoy-config", configMap: { name: envoyConfigMap.metadata.name } }],
                    },
                },
            },
        }, parent);

        const frontendSelector = { app: "frontend" };

        // Public Service: port 80 only, and it targets Envoy, so every request is counted.
        this.frontendService = new k8s.core.v1.Service("frontend", {
            metadata: { name: "frontend", namespace: ns, labels: frontendLabels },
            spec: {
                type: args.useLoadBalancer ? "LoadBalancer" : "NodePort",
                ports: [{ name: "http", port: 80, targetPort: "http", nodePort: args.useLoadBalancer ? undefined : FRONTEND_NODE_PORT }],
                selector: frontendSelector,
            },
        }, parent);

        // Separate ClusterIP Service for scraping, so the metrics port never gets a
        // NodePort or a public load balancer.
        new k8s.core.v1.Service("frontend-metrics", {
            metadata: { name: "frontend-metrics", namespace: ns, labels: { ...frontendLabels, "guestbook/metrics": "true" } },
            spec: {
                ports: [{ name: "metrics", port: 9901, targetPort: "metrics" }],
                selector: frontendSelector,
            },
        }, parent);

        this.registerOutputs({ frontendService: this.frontendService });
    }
}
