"""Architecture diagram for guestbook-monitoring.

Pulumi deploys the upstream Guestbook plus kube-prometheus-stack to a k3d
cluster. Every frontend request passes through an Envoy sidecar, which counts
it by status code; each Redis pod runs a redis_exporter sidecar. Prometheus
finds both through ServiceMonitors and Grafana reads from Prometheus.

Usage: pip install diagrams, then python3 diagram.py
Requires graphviz (brew install graphviz).
"""

from diagrams import Cluster, Diagram, Edge
from diagrams.k8s.infra import Node
from diagrams.k8s.podconfig import Secret
from diagrams.k8s.others import CRD
from diagrams.onprem.ci import GithubActions
from diagrams.onprem.client import Users
from diagrams.onprem.iac import Pulumi
from diagrams.onprem.inmemory import Redis
from diagrams.onprem.monitoring import Grafana, Prometheus
from diagrams.onprem.network import Apache, Envoy
from diagrams.programming.flowchart import Decision

graph_attr = {"pad": "0.4", "nodesep": "0.6", "ranksep": "1.1", "fontsize": "13", "splines": "spline"}

with Diagram(
    "Guestbook + Prometheus + Grafana (Pulumi on k3d)",
    filename="docs/architecture",
    show=False,
    direction="LR",
    graph_attr=graph_attr,
):
    user = Users("Browser\nlocalhost:30080\nlocalhost:30300")

    with Cluster("Delivery"):
        ci = GithubActions("CI\ngitleaks, tsc, Trivy\nk3d e2e")
        policy = Decision("CrossGuard policy\n+ destroy-guard")
        pulumi = Pulumi("pulumi up\n(local state)")
        ci >> policy >> pulumi

    with Cluster("k3d cluster"):
        kubelet = Node("kubelet / cAdvisor\npod CPU + memory")

        with Cluster("namespace: guestbook"):
            with Cluster("frontend pod x3"):
                envoy = Envoy("Envoy :8080\nmetrics :9901")
                php = Apache("PHP / Apache :80")
                envoy >> php
            with Cluster("redis-leader pod"):
                leader = Redis("redis 7.4.6")
                exp_l = Redis("redis_exporter\n:9121")
            with Cluster("redis-replica pod"):
                replica = Redis("redis 7.4.6\n--replicaof")
                exp_r = Redis("redis_exporter\n:9121")
            php >> Edge(label="writes") >> leader
            php >> Edge(label="reads") >> replica
            leader >> Edge(style="dashed", label="replication") >> replica

        with Cluster("namespace: monitoring (kube-prometheus-stack)"):
            sm = CRD("ServiceMonitors\nfrontend + redis")
            prom = Prometheus("Prometheus\nClusterIP")
            graf = Grafana("Grafana\nNodePort 30300\nGuestbook dashboard")
            secret = Secret("grafana-admin\n(random, secret output)")
            sm >> prom
            secret >> graf
            prom >> graf

        prom >> Edge(label="/stats/prometheus", color="darkorange") >> envoy
        prom >> Edge(label="/metrics", color="darkorange") >> exp_l
        prom >> Edge(label="/metrics", color="darkorange") >> exp_r
        prom >> Edge(label="cAdvisor CPU/mem", color="darkorange", style="dotted") >> kubelet

    pulumi >> Edge(style="dashed", label="deploys") >> sm
    user >> Edge(label="NodePort 30080") >> envoy
    user >> Edge(label="NodePort 30300") >> graf
