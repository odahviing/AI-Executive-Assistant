# Maelle on GKE — deployment

Runs Maelle as a single always-on pod on GKE, Claude served by **Vertex AI**.
Merged from the platform team's deploy template + the fixes Maelle actually needs
to boot. This is still **framework stage**: `scripts/migrate-data.sh` is an empty
stub and nothing is provisioned yet.

**Environment (from the platform team):** project `reflectiz-ai-backoffice`,
region `europe-west4`, Artifact Registry `maelle-repo`, cluster `maelle-cluster`,
keyless CI via Workload Identity (`github-deployer` SA).

## The one rule that matters
Maelle holds **exactly one** Slack socket-mode WebSocket. Two pods = two sockets =
Slack `too_many_connections` (a failure already seen). Enforced by
`strategy: Recreate` + `replicas: 1` + a `ReadWriteOnce` PVC. **Never** switch to
RollingUpdate. There is no Service/Ingress — Maelle is outbound-only.

## Files
| File | Purpose |
|------|---------|
| `deployment.yaml` | Deployment (Recreate) + PVC. Real image/project values + the boot fixes. |
| `secret.example.yaml` | Template for the `maelle-secrets` Secret. **No real values.** |
| `../Dockerfile` | Multi-stage build (compiles better-sqlite3, injects boot stamp, adds Vertex SDK). |
| `../.github/workflows/deploy.yml` | Auto-build → Artifact Registry → GKE, keyless WIF (branch `master`). |
| `../scripts/migrate-data.sh` | **Empty stub** — the cutover data copy, built later. |

---

## ⚠️ For the platform team — required to get Maelle running

Your template assumes a stateless, env-configured web app. Maelle is a **stateful
daemon**: config lives in a YAML profile file, data in SQLite on disk, Claude via
Vertex, and it opens no inbound port. The manifest was adapted accordingly. Please
confirm / set up the following — **Maelle will not boot until these are true:**

1. **Vertex auth (Q1).** The pod authenticates to Vertex AI with **no key**, via
   Workload Identity. The `default` KSA in the target namespace must be bound to a
   GCP service account holding **`roles/aiplatform.user`**. If it isn't, point
   `serviceAccountName` at one that is. *(Your template used `serviceAccountName:
   default` and predates the Vertex decision — this likely needs setting up.)*

2. **Secret contents (Q2).** `maelle-secrets` must contain **more than the 3 Slack
   keys** — Maelle exits at startup without the Azure Graph creds:
   `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, **`AZURE_TENANT_ID`,
   `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`** (+ optional `OPENAI_API_KEY`,
   `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`). **No `ANTHROPIC_API_KEY`** — Vertex
   handles the LLM. See `secret.example.yaml`.

3. **Pre-created resources (Q3).** Confirm these exist or tell us to create them:
   Artifact Registry `maelle-repo`, cluster `maelle-cluster`, the `maelle-db-pvc`
   PVC, and the `maelle-secrets` Secret. **Which namespace** should we deploy to?

4. **Branch (Q4).** Your workflow triggered on `main`; Maelle's default branch is
   **`master`** — the workflow now uses `master`. Confirm, and confirm the WIF pool
   trusts repo `odahviing/AI-Executive-Assistant`, and that `github-deployer` has
   Artifact Registry writer + GKE developer.

5. **Config on the PVC (Q5).** Maelle reads its full profile (schedule, categories,
   meeting rules, timezone) from `config/users/idan.yaml`, and writes owner state
   there at runtime — so `config/users/` is mounted from the PVC, **not** built from
   env. Until `migrate-data.sh` seeds it at cutover, the pod **intentionally
   CrashLoops** ("No user profiles found") — that's expected, not a bug.

6. **Vertex region (Q6).** Set `VERTEX_REGION` to a Claude-serving Vertex location.
   `global` is the safe default; `europe-west1` / `us-east5` are known. Confirm the
   preference (data-residency, latency).

Also note: `@anthropic-ai/vertex-sdk` is installed at image-build time pinned to
`^0.4.0` — verify it's compatible with the app's `@anthropic-ai/sdk` before the
first real build (see `../Dockerfile`).

## First deploy & cutover (later — not now)
1. Platform team confirms/sets up items 1–6 above.
2. Push to `master` → CI builds + deploys. Pod CrashLoops until the PVC has a
   profile (expected).
3. Run `scripts/migrate-data.sh` (once built) to seed the PVC with the live DB +
   `config/users/`, verifying row counts against the baseline.
4. Confirm the boot stamp in logs (`version` + `gitSha`), socket alive, a test DM
   round-trips, briefs/timers fire — **then** stop the laptop process. Never both.
