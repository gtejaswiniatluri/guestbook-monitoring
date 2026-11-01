/**
 * Extends the upstream Pulumi kubernetes-ts-guestbook/simple example.
 *
 * App metrics:
 * - frontend: blackbox-exporter HTTP probe success & response duration
 * - Redis leader/replica: redis_exporter /metrics sidecars
 * - all app pods: kubelet/cAdvisor container CPU and memory from kube-prometheus-stack
 *
 * The upstream PHP frontend is NOT instrumented for HTTP request totals.
 */
import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const isMinikube = config.getBoolean("isMinikube") ?? false;
const grafanaServiceType = config.get("grafanaServiceType") ?? "LoadBalancer";
const nodeAddress = config.get("nodeAddress");
const adminUser = config.get("grafanaAdminUser") ?? "admin";
const adminPassword = config.requireSecret("grafanaPassword");
const nodePort = 30300;

if (grafanaServiceType !== "LoadBalancer" && grafanaServiceType !== "NodePort") {
    throw new Error("grafanaServiceType must be LoadBalancer or NodePort");
}
if (grafanaServiceType === "NodePort" && !nodeAddress) {
    throw new Error("For NodePort, set nodeAddress to a reachable Kubernetes node IP/hostname (e.g. `minikube ip`).");
}

const guestbookNs = new k8s.core.v1.Namespace("guestbook-namespace", {
    metadata: { name: "guestbook", labels: { app: "guestbook" } },
});
const monitoringNs = new k8s.core.v1.Namespace("monitoring-namespace", {
    metadata: { name: "monitoring" },
});

const redisExporter = {
    name: "redis-exporter",
    image: "oliver006/redis_exporter:v1.92.0",
    env: [{ name: "REDIS_ADDR", value: "redis://127.0.0.1:6379" }],
    ports: [{ containerPort: 9121, name: "metrics" }],
    resources: { requests: { cpu: "20m", memory: "32Mi" }, limits: { memory: "128Mi" } },
};

function createRedis(name: "redis-leader" | "redis-replica", image: string) {
    const labels = { app: name };
    const deployment = new k8s.apps.v1.Deployment(`${name}-deployment`, {
        metadata: { name, namespace: guestbookNs.metadata.name },
        spec: {
            replicas: 1,
            selector: { matchLabels: labels },
            template: {
                metadata: { labels },
                spec: {
                    containers: [
                        {
                            name: name === "redis-leader" ? "redis-leader" : "replica",
                            image,
                            command: name === "redis-replica" ? ["redis-server", "--replicaof", "redis-leader", "6379"] : undefined,
                            ports: [{ containerPort: 6379, name: "redis" }],
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        },
                        { ...redisExporter },
                    ],
                },
            },
        },
    });

    // Redis and /metrics are exposed by *the same backend Service*.
    const service = new k8s.core.v1.Service(`${name}-service`, {
        metadata: { name, namespace: guestbookNs.metadata.name, labels },
        spec: {
            selector: labels,
            ports: [
                { name: "redis", port: 6379, targetPort: "redis" },
                { name: "metrics", port: 9121, targetPort: "metrics" },
            ],
        },
    });
    return { deployment, service };
}

const leader = createRedis("redis-leader", "redis:7.4-alpine");
const replica = createRedis("redis-replica", "redis:7.4-alpine");

const frontendLabels = { app: "frontend" };
const frontendDeployment = new k8s.apps.v1.Deployment("frontend-deployment", {
    metadata: { name: "frontend", namespace: guestbookNs.metadata.name },
    spec: {
        replicas: 3,
        selector: { matchLabels: frontendLabels },
        template: {
            metadata: { labels: frontendLabels },
            spec: {
                containers: [{
                    name: "frontend",
                    image: "pulumi/guestbook-php-redis",
                    env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                    ports: [{ containerPort: 80, name: "http" }],
                    resources: { requests: { cpu: "100m", memory: "100Mi" } },
                }],
            },
        },
    },
}, { dependsOn: [leader.service, replica.service] });

const frontendService = new k8s.core.v1.Service("frontend-service", {
    metadata: { name: "frontend", namespace: guestbookNs.metadata.name, labels: frontendLabels },
    spec: {
        type: isMinikube ? "ClusterIP" : "LoadBalancer",
        selector: frontendLabels,
        ports: [{ name: "http", port: 80, targetPort: "http" }],
    },
});

// Installs Prometheus Operator/CRDs, Prometheus, Grafana, kube-state-metrics
// and node-exporter. Kubelet/cAdvisor scraping supplies frontend CPU/memory.
const monitoring = new k8s.helm.v3.Release("monitoring-stack", {
    name: "monitoring", // Fixed name for predictable service names and README commands.
    chart: "kube-prometheus-stack",
    version: "89.2.0",
    namespace: monitoringNs.metadata.name,
    repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
    timeout: 900,
    values: {
        alertmanager: { enabled: false },
        grafana: {
            enabled: true,
            adminUser,
            adminPassword,
            "grafana.ini": {
                plugins: {
                    preinstall_auto_update: false,
                },
                analytics: {
                    check_for_updates: false,
                },
            },
            service: {
                type: grafanaServiceType,
                ...(grafanaServiceType === "NodePort" ? { nodePort } : {}),
            },
            sidecar: {
                dashboards: { enabled: true, searchNamespace: "monitoring" },
            },
        },
        prometheus: {
            prometheusSpec: {
                retention: "3d",
                // Select ServiceMonitors in both 'guestbook' and 'monitoring'.
                // Preserve the stack's built-in Kubernetes monitors too.
                serviceMonitorSelectorNilUsesHelmValues: false,
                serviceMonitorSelector: {},
                serviceMonitorNamespaceSelector: {},
                // Keep built-in PodMonitor targets (e.g. monitoring components).
                podMonitorSelectorNilUsesHelmValues: false,
                podMonitorSelector: {},
                podMonitorNamespaceSelector: {},
            },
        },
    },
}, { dependsOn: [monitoringNs] });

// Install explicit ServiceMonitors *after* the Helm release's CRDs exist.
for (const backend of ["redis-leader", "redis-replica"] as const) {
    new k8s.apiextensions.CustomResource(`${backend}-service-monitor`, {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: { name: `${backend}-monitor`, namespace: guestbookNs.metadata.name },
        spec: {
            jobLabel: "app",
            selector: { matchLabels: { app: backend } },
            namespaceSelector: { matchNames: ["guestbook"] },
            endpoints: [{ port: "metrics", path: "/metrics", interval: "15s" }],
        },
    }, { dependsOn: [monitoring, backend === "redis-leader" ? leader.service : replica.service] });
}

// The upstream PHP frontend exposes no /metrics endpoint. Use a blackbox HTTP
// probe instead of pretending that the frontend exposes request totals.
const blackboxConfig = new k8s.core.v1.ConfigMap("blackbox-config", {
    metadata: { name: "guestbook-blackbox-config", namespace: monitoringNs.metadata.name },
    data: {
        "blackbox.yml": [
            "modules:",
            "  http_2xx:",
            "    prober: http",
            "    timeout: 5s",
            "    http:",
            "      preferred_ip_protocol: ip4",
            "      follow_redirects: true",
            "",
        ].join("\n"),
    },
});
const blackboxLabels = { app: "guestbook-blackbox" };
const blackboxDeployment = new k8s.apps.v1.Deployment("guestbook-blackbox", {
    metadata: { name: "guestbook-blackbox", namespace: monitoringNs.metadata.name },
    spec: {
        replicas: 1,
        selector: { matchLabels: blackboxLabels },
        template: {
            metadata: { labels: blackboxLabels },
            spec: {
                containers: [{
                    name: "blackbox-exporter",
                    image: "quay.io/prometheus/blackbox-exporter:v0.28.0",
                    args: ["--config.file=/etc/blackbox/blackbox.yml"],
                    ports: [{ name: "http", containerPort: 9115 }],
                    volumeMounts: [{ name: "config", mountPath: "/etc/blackbox", readOnly: true }],
                    readinessProbe: { httpGet: { path: "/-/healthy", port: "http" } },
                    resources: { requests: { cpu: "20m", memory: "32Mi" }, limits: { memory: "128Mi" } },
                }],
                volumes: [{ name: "config", configMap: { name: blackboxConfig.metadata.name } }],
            },
        },
    },
});
const blackboxService = new k8s.core.v1.Service("guestbook-blackbox-service", {
    metadata: { name: "guestbook-blackbox", namespace: monitoringNs.metadata.name, labels: blackboxLabels },
    spec: { selector: blackboxLabels, ports: [{ name: "http", port: 9115, targetPort: "http" }] },
});
new k8s.apiextensions.CustomResource("frontend-probe-monitor", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: { name: "guestbook-frontend-probe", namespace: monitoringNs.metadata.name },
    spec: {
        jobLabel: "app",
        selector: { matchLabels: blackboxLabels },
        namespaceSelector: { matchNames: ["monitoring"] },
        endpoints: [{
            port: "http",
            path: "/probe",
            interval: "30s",
            params: {
                module: ["http_2xx"],
                target: ["http://frontend.guestbook.svc.cluster.local/"],
            },
            relabelings: [{ targetLabel: "instance", replacement: "guestbook-frontend" }],
        }],
    },
}, { dependsOn: [monitoring, blackboxDeployment, blackboxService, frontendService] });

// Grafana's chart sidecar automatically imports labeled dashboard ConfigMaps.
const dashboardJson = fs.readFileSync(path.join(__dirname, "dashboards", "guestbook.json"), "utf8");
new k8s.core.v1.ConfigMap("guestbook-grafana-dashboard", {
    metadata: {
        name: "guestbook-grafana-dashboard",
        namespace: monitoringNs.metadata.name,
        labels: { grafana_dashboard: "1" },
    },
    data: { "guestbook.json": dashboardJson },
}, { dependsOn: [monitoring] });

// Helm creates Service 'monitoring-grafana'. Look it up after the release.
const grafanaService = k8s.core.v1.Service.get(
    "grafana-service-lookup",
    pulumi.interpolate`${monitoring.status.namespace}/${monitoring.status.name}-grafana`,
    { dependsOn: [monitoring] },
);

const lbUrl = (status: k8s.types.output.core.v1.ServiceStatus | undefined): string => {
    const entry = status?.loadBalancer?.ingress?.[0];
    const address = entry?.ip || entry?.hostname;
    return address ? `http://${address}` : "LoadBalancer address pending; run: kubectl -n monitoring get svc monitoring-grafana";
};

export const grafanaUrl = grafanaServiceType === "NodePort"
    ? `http://${nodeAddress}:${nodePort}`
    : grafanaService.status.apply(lbUrl);
export const grafanaAdminUser = adminUser;
// Secret output, intentionally redacted by default by the Pulumi CLI.
export const grafanaAdminPassword = adminPassword;
export const grafanaDashboard = "Guestbook Overview (Dashboards > Guestbook Overview)";
export const prometheusPortForward = "kubectl -n monitoring port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090";
export const grafanaPortForward = "kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80";
export const frontendPortForward = "kubectl -n guestbook port-forward svc/frontend 8080:80";
export const guestbookUrl = isMinikube
    ? "http://localhost:8080 (start frontendPortForward first)"
    : frontendService.status.apply(status => {
        const address = status?.loadBalancer?.ingress?.[0]?.ip || status?.loadBalancer?.ingress?.[0]?.hostname;
        return address ? `http://${address}` : "LoadBalancer address pending; run: kubectl -n guestbook get svc frontend";
    });
