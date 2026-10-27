// Guardrail rules as plain functions over a resource's type and inputs, so they
// can be unit tested without the Pulumi engine. index.ts wires them into the
// CrossGuard pack.
//
// Same split as the OPA policy in platform-guardrails: "mandatory" blocks the
// update, "advisory" prints and passes. Advisory is used where the finding is a
// judgment call the code cannot settle (a NodePort is fine on a laptop, not fine
// on a shared cluster).

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Level = "mandatory" | "advisory";

export interface Rule {
    name: string;
    description: string;
    level: Level;
    types: string[];
    check: (props: any) => string[];
}

const DEPLOYMENT = "kubernetes:apps/v1:Deployment";
const SERVICE = "kubernetes:core/v1:Service";
const CONFIGMAP = "kubernetes:core/v1:ConfigMap";
const SECRET = "kubernetes:core/v1:Secret";
const NAMESPACE = "kubernetes:core/v1:Namespace";
const RELEASE = "kubernetes:helm.sh/v3:Release";

const podSpec = (props: any) => props?.spec?.template?.spec ?? {};
const allContainers = (props: any): any[] => [...(podSpec(props).initContainers ?? []), ...(podSpec(props).containers ?? [])];

export const rules: Rule[] = [
    {
        name: "container-resource-limits",
        description: "Every container sets CPU and memory limits, so one noisy pod cannot starve the node.",
        level: "mandatory",
        types: [DEPLOYMENT],
        check: props => allContainers(props).flatMap(c => {
            const limits = c?.resources?.limits ?? {};
            return ["cpu", "memory"].filter(k => !limits[k]).map(k => `container '${c.name}' has no ${k} limit`);
        }),
    },
    {
        name: "no-host-access",
        description: "No privileged containers, host namespaces or hostPath volumes in application workloads.",
        level: "mandatory",
        types: [DEPLOYMENT],
        check: props => {
            const spec = podSpec(props);
            const out: string[] = [];
            for (const k of ["hostNetwork", "hostPID", "hostIPC"]) if (spec[k]) out.push(`pod sets ${k}: true`);
            for (const v of spec.volumes ?? []) if (v?.hostPath) out.push(`volume '${v.name}' mounts a hostPath`);
            for (const c of allContainers(props)) {
                if (c?.securityContext?.privileged) out.push(`container '${c.name}' is privileged`);
            }
            return out;
        },
    },
    {
        name: "pinned-images",
        description: "Images carry an explicit tag or digest, never :latest. An unpinned redis is what broke the upstream example.",
        level: "mandatory",
        types: [DEPLOYMENT],
        check: props => allContainers(props).flatMap(c => {
            const image: string = c?.image ?? "";
            if (image.includes("@sha256:")) return [];
            const lastSegment = image.split("/").pop() ?? "";
            if (!lastSegment.includes(":")) return [`container '${c.name}' image '${image}' has no tag`];
            if (lastSegment.endsWith(":latest")) return [`container '${c.name}' image '${image}' uses :latest`];
            return [];
        }),
    },
    {
        name: "required-labels",
        description: "Resources carry 'app' and 'app.kubernetes.io/managed-by: pulumi', so anything in the cluster traces back to its owner.",
        level: "mandatory",
        types: [DEPLOYMENT, SERVICE, CONFIGMAP, SECRET, NAMESPACE],
        check: props => {
            const labels = props?.metadata?.labels ?? {};
            const out: string[] = [];
            if (!labels.app) out.push("missing label 'app'");
            if (labels["app.kubernetes.io/managed-by"] !== "pulumi") out.push("label 'app.kubernetes.io/managed-by' must be 'pulumi'");
            return out;
        },
    },
    {
        name: "metrics-not-public",
        description: "A NodePort or LoadBalancer Service never exposes a metrics port. Scrape over ClusterIP.",
        level: "mandatory",
        types: [SERVICE],
        check: props => {
            const type = props?.spec?.type ?? "ClusterIP";
            if (type !== "NodePort" && type !== "LoadBalancer") return [];
            return (props?.spec?.ports ?? [])
                .filter((p: any) => /metric/i.test(p?.name ?? "") || [9090, 9091, 9121, 9901, 9902].includes(p?.port))
                .map((p: any) => `${type} Service exposes metrics port '${p.name ?? p.port}'`);
        },
    },
    {
        name: "helm-chart-pinned",
        description: "Helm releases pin a chart version, so a re-run months later installs the same chart.",
        level: "mandatory",
        types: [RELEASE],
        check: props => (props?.version ? [] : [`release '${props?.chart}' has no chart version`]),
    },
    {
        name: "no-plaintext-grafana-password",
        description: "The Grafana admin password comes from a Secret (grafana.admin.existingSecret), never from Helm values.",
        level: "mandatory",
        types: [RELEASE],
        check: props => (props?.values?.grafana?.adminPassword !== undefined
            ? ["grafana.adminPassword is set in Helm values; use grafana.admin.existingSecret"]
            : []),
    },
    {
        name: "public-exposure",
        description: "NodePort and LoadBalancer Services are reachable from outside the cluster. Intentional here; worth a second look anywhere else.",
        level: "advisory",
        types: [SERVICE],
        check: props => {
            const type = props?.spec?.type;
            return type === "NodePort" || type === "LoadBalancer" ? [`Service '${props?.metadata?.name}' is ${type}`] : [];
        },
    },
];
