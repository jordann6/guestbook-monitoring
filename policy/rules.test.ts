// Fixture tests: each rule passes a known-good resource and fails a known-bad one.
// Run with `npm test` in policy/.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { rules } from "./rules";

const rule = (name: string) => {
    const r = rules.find(x => x.name === name);
    if (!r) throw new Error(`no rule ${name}`);
    return r;
};

const labels = { app: "frontend", "app.kubernetes.io/managed-by": "pulumi" };
const goodContainer = { name: "web", image: "redis:7.4.6", resources: { limits: { cpu: "100m", memory: "64Mi" } } };
const deployment = (containers: unknown[], extra: Record<string, unknown> = {}) => ({
    metadata: { labels },
    spec: { template: { spec: { containers, ...extra } } },
});

test("container-resource-limits", () => {
    const r = rule("container-resource-limits");
    assert.deepEqual(r.check(deployment([goodContainer])), []);
    assert.deepEqual(r.check(deployment([{ name: "web", image: "redis:7.4.6" }])), [
        "container 'web' has no cpu limit",
        "container 'web' has no memory limit",
    ]);
});

test("no-host-access", () => {
    const r = rule("no-host-access");
    assert.deepEqual(r.check(deployment([goodContainer])), []);
    const bad = deployment([{ ...goodContainer, securityContext: { privileged: true } }], {
        hostNetwork: true,
        volumes: [{ name: "root", hostPath: { path: "/" } }],
    });
    assert.equal(r.check(bad).length, 3);
});

test("pinned-images", () => {
    const r = rule("pinned-images");
    assert.deepEqual(r.check(deployment([goodContainer, { ...goodContainer, name: "d", image: "pulumi/x@sha256:abc" }])), []);
    assert.equal(r.check(deployment([{ ...goodContainer, image: "redis" }])).length, 1);
    assert.equal(r.check(deployment([{ ...goodContainer, image: "redis:latest" }])).length, 1);
    // A registry port is not a tag.
    assert.equal(r.check(deployment([{ ...goodContainer, image: "registry:5000/redis" }])).length, 1);
});

test("required-labels", () => {
    const r = rule("required-labels");
    assert.deepEqual(r.check({ metadata: { labels } }), []);
    assert.equal(r.check({ metadata: { labels: { app: "x" } } }).length, 1);
    assert.equal(r.check({ metadata: {} }).length, 2);
});

test("metrics-not-public", () => {
    const r = rule("metrics-not-public");
    assert.deepEqual(r.check({ spec: { type: "NodePort", ports: [{ name: "http", port: 80 }] } }), []);
    assert.deepEqual(r.check({ spec: { ports: [{ name: "metrics", port: 9901 }] } }), []);
    assert.equal(r.check({ spec: { type: "LoadBalancer", ports: [{ name: "metrics", port: 9901 }] } }).length, 1);
});

test("helm release rules", () => {
    assert.deepEqual(rule("helm-chart-pinned").check({ chart: "kps", version: "1.0.0" }), []);
    assert.equal(rule("helm-chart-pinned").check({ chart: "kps" }).length, 1);
    const pw = rule("no-plaintext-grafana-password");
    assert.deepEqual(pw.check({ values: { grafana: { admin: { existingSecret: "s" } } } }), []);
    assert.equal(pw.check({ values: { grafana: { adminPassword: "hunter2" } } }).length, 1);
});

test("public-exposure is advisory", () => {
    const r = rule("public-exposure");
    assert.equal(r.level, "advisory");
    assert.equal(r.check({ metadata: { name: "frontend" }, spec: { type: "NodePort" } }).length, 1);
});
