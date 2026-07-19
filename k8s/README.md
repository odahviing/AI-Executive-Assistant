# Maelle on GKE — deployment framework

Scaffolding to run Maelle as a single always-on pod on GKE, with Claude served by
**Vertex AI**. This is the **framework only** — nothing here provisions cloud
resources, and the data migration (`scripts/migrate-data.sh`) is an empty stub.
Fill in every `TODO` before a real deploy.

> Today's live deploy is still PM2 on the owner's laptop. This directory is the
> target state, not yet cut over.

## What runs, and the one rule that matters

Maelle is **one stateful, always-on process**: it holds exactly **one** Slack
socket-mode WebSocket, runs in-process timers (briefs, sweeps, catch-up), and
owns a **single-writer SQLite** file. Therefore:

- **Never two pods.** Two pods = two Slack sockets → Slack sends
  `too_many_connections` and they fight. This is enforced three ways:
  `replicas: 1`, `strategy: Recreate` (old pod dies before new starts — no
  rolling overlap), and a `ReadWriteOnce` PVC (one node attaches the disk).
- **No Service / Ingress / LoadBalancer.** Maelle is outbound-only (Slack wss,
  MS Graph, Vertex AI). Nothing listens for inbound traffic, so there are no
  Service or Ingress manifests here by design.

## Files

| File | Purpose |
|------|---------|
| `deployment.yaml` | The pod: `Recreate` strategy, Vertex env, PVC mounts, Workload-Identity SA. |
| `pvc.yaml` | `ReadWriteOnce` persistent disk for the DB + `config/users/`. |
| `serviceaccount.yaml` | KSA bound (Workload Identity) to a GCP SA with `roles/aiplatform.user`. |
| `secret.example.yaml` | Template for the `maelle-env` Secret (Azure + optional keys). **No real values.** |
| `kustomization.yaml` | Ties the resources together; CI pins the image tag here. |
| `../Dockerfile` | Multi-stage build (compiles better-sqlite3, injects the boot stamp). |
| `../.github/workflows/deploy-gke.yml` | Auto-build → Artifact Registry → GKE, keyless via WIF. |
| `../scripts/migrate-data.sh` | **Empty stub** — the cutover data copy, built later. |

## How the pieces fit

- **Image** — `Dockerfile` builds on `node:20-bookworm` (compiles the
  `better-sqlite3` native addon), prunes dev deps, adds `@anthropic-ai/vertex-sdk`,
  then copies `dist/` + prod `node_modules` into a slim runtime. The boot stamp
  (`version` + `gitSha`) is injected as build args, since the image has no `.git`.
- **LLM = Vertex, keyless** — `LLM_PROVIDER=vertex` + `VERTEX_PROJECT_ID` +
  `VERTEX_REGION`. Auth comes from the pod's Workload Identity SA
  (`roles/aiplatform.user`) via ADC — **no Anthropic key, no key file.**
- **State** — one PVC (`maelle-state`) mounted at two cwd-relative paths the app
  hard-codes: `/app/data` (SQLite) and `/app/config/users` (idan.yaml + owner
  memory/prefs/kb, which the app writes at runtime). Logs go to an `emptyDir`
  and to stdout → Cloud Logging.
- **Secrets** — infra creds come from the `maelle-env` Secret (`envFrom`). Slack
  tokens currently live in `idan.yaml` on the PVC (schema requires them inline).
  No Anthropic key anywhere.

## One-time cluster setup (fill in TODOs first)

```sh
# 1. Namespace
kubectl create namespace maelle

# 2. GCP service account for the pod (Vertex) — see serviceaccount.yaml header
#    for the full gcloud block, then apply the KSA:
kubectl apply -k k8s/            # after editing the TODO placeholders

# 3. The maelle-env Secret (from Secret Manager, or manually — see secret.example.yaml)
kubectl -n maelle create secret generic maelle-env --from-literal=AZURE_TENANT_ID=... ...

# 4. Workload Identity Federation for GitHub Actions (keyless CI). Create a WIF
#    pool + provider for the repo and a `maelle-deployer` GCP SA with
#    roles/artifactregistry.writer + roles/container.developer, then set the
#    WIF_PROVIDER / DEPLOY_SA envs in deploy-gke.yml.
```

## Placeholders to fill (every `TODO`)

- `deployment.yaml`: `VERTEX_PROJECT_ID`.
- `serviceaccount.yaml`: `iam.gke.io/gcp-service-account` (PROJECT_ID).
- `kustomization.yaml`: image `newName` (Artifact Registry path).
- `deploy-gke.yml`: `GCP_PROJECT_ID`, `GCP_REGION`, `AR_REPO`, `GKE_CLUSTER`,
  `GKE_LOCATION`, `WIF_PROVIDER`, `DEPLOY_SA`.
- `pvc.yaml`: `storageClassName` (optional; defaults to the cluster default).

## First deploy & cutover (later — not now)

1. Fill TODOs; complete cluster setup above.
2. Push to `master` → CI builds + deploys. The pod will start but **exit** until
   the PVC has a profile (`config/users/idan.yaml`) — that's expected pre-cutover.
3. Run `scripts/migrate-data.sh` (once built) to seed the PVC with the live DB +
   `config/users/`, verifying row counts against the baseline.
4. Confirm the boot stamp in logs (`version` + `gitSha`), socket alive, a test DM
   round-trips, briefs/timers fire — **then** stop the laptop process. Never both.
