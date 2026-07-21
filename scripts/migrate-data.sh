#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# migrate-data.sh — ONE-SHOT cutover from the local (PM2) host to GKE.
#
# Moves the live data — the SQLite DB + the config/users/ tree (idan.yaml + the
# owner's people/prefs/kb memory) — into the cluster's PersistentVolume, then
# hands the single Slack socket from local → cluster.
#
# ⚠️  STATUS: ready to REHEARSE, not yet run. It is UNTESTED — there is no cluster
#     yet (blocked on GCP access). Before the real cutover: fill in the CONFIG
#     block, then dry-run it against a THROWAWAY namespace with a COPY of the DB.
#     Treat every kubectl line as "verify against the actual cluster first".
#
# THE ONE INVARIANT — never two live Maelle processes. Two = two Slack sockets =
# `too_many_connections` and they fight. This script enforces it by construction:
#   • local is STOPPED (step 1) before the cluster ever serves (step 6);
#   • the Deployment is held at replicas=0 during the copy;
#   • the Deployment uses strategy:Recreate, so a redeploy never overlaps pods.
# Do not deviate from that ordering.
#
# Requires (on the machine running this): kubectl pointed at the GKE cluster,
# sqlite3, pm2, and the local repo checked out with data/ + config/users/ present.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── CONFIG — fill in before running ──────────────────────────────────────────
NAMESPACE="maelle"                 # kubectl namespace (see k8s/)
DEPLOYMENT="maelle-deployment"     # metadata.name in k8s/deployment.yaml
PVC="maelle-db-pvc"                # claimName in k8s/deployment.yaml
LOCAL_REPO="E:/Code/Maelle"        # local checkout
SNAPSHOT="/tmp/maelle-snapshot.db"
BASELINE="/tmp/maelle-baseline.txt"
# ─────────────────────────────────────────────────────────────────────────────

cd "$LOCAL_REPO"

echo "== 1/7  Stop the local process (single-socket: local MUST be down first) =="
pm2 stop maelle
sleep 3
if pm2 pid maelle | grep -qE '^[0-9]+$'; then
  echo "ABORT: local maelle still has a live PID — do not proceed (two-socket risk)."; exit 1
fi

echo "== 2/7  Checkpoint the WAL + snapshot a consistent single-file DB =="
sqlite3 data/maelle.db "PRAGMA wal_checkpoint(TRUNCATE);"
sqlite3 data/maelle.db ".backup '$SNAPSHOT'"
if ! sqlite3 "$SNAPSHOT" "PRAGMA integrity_check;" | grep -qx 'ok'; then
  echo "ABORT: snapshot failed integrity_check."; exit 1
fi

echo "== 3/7  Record baseline row counts (post-cutover parity check) =="
: > "$BASELINE"
for t in people_memory requests tasks audit_log social_subjects user_preferences slot_holds; do
  printf '%-22s %s\n' "$t" "$(sqlite3 "$SNAPSHOT" "SELECT COUNT(*) FROM $t;")" >> "$BASELINE"
done
cat "$BASELINE"

echo "== 4/7  Copy DB + config/users into the PVC via a helper pod (Deployment held at 0) =="
kubectl -n "$NAMESPACE" scale deployment/"$DEPLOYMENT" --replicas=0
kubectl -n "$NAMESPACE" rollout status deployment/"$DEPLOYMENT" --timeout=120s || true
kubectl -n "$NAMESPACE" delete pod maelle-seed --ignore-not-found
kubectl -n "$NAMESPACE" run maelle-seed --restart=Never --image=busybox:1.36 --overrides='{
  "spec":{"containers":[{"name":"maelle-seed","image":"busybox:1.36","command":["sleep","3600"],
  "volumeMounts":[{"name":"state","mountPath":"/state"}]}],
  "volumes":[{"name":"state","persistentVolumeClaim":{"claimName":"'"$PVC"'"}}]}}'
kubectl -n "$NAMESPACE" wait --for=condition=Ready pod/maelle-seed --timeout=120s
# subPaths used by the Deployment: data/ and config-users/
kubectl -n "$NAMESPACE" exec maelle-seed -- mkdir -p /state/data /state/config-users
kubectl -n "$NAMESPACE" cp "$SNAPSHOT"    "$NAMESPACE/maelle-seed:/state/data/maelle.db"
kubectl -n "$NAMESPACE" cp config/users/. "$NAMESPACE/maelle-seed:/state/config-users/"

echo "== 5/7  Sanity-check the copy in the PVC =="
# Row parity is guaranteed by construction — this is a byte-identical copy of a
# file that already passed integrity_check in step 2. busybox has no sqlite3, so
# we verify presence/size here; the functional verify is the boot + test DM below.
kubectl -n "$NAMESPACE" exec maelle-seed -- sh -c 'ls -l /state/data/maelle.db && ls /state/config-users/'
kubectl -n "$NAMESPACE" delete pod maelle-seed

echo "== 6/7  Bring the cluster up (Recreate → exactly one socket) =="
kubectl -n "$NAMESPACE" scale deployment/"$DEPLOYMENT" --replicas=1
kubectl -n "$NAMESPACE" rollout status deployment/"$DEPLOYMENT" --timeout=180s

echo "== 7/7  Confirm the boot stamp + socket, then round-trip a test DM =="
kubectl -n "$NAMESPACE" logs deployment/"$DEPLOYMENT" --tail=60 | grep -iE 'version|gitSha|online|socket' || true
cat <<'NEXT'

  → Now: DM Maelle a test message and confirm she replies. Then watch the first
    briefs/timers fire. Only after a clean round-trip is the cutover "done".
    Baseline row counts are in /tmp/maelle-baseline.txt — spot-check a couple
    against the running pod once you have a query path.

  ROLLBACK (if anything is wrong — restores the single socket to local):
    kubectl -n NAMESPACE scale deployment/DEPLOYMENT --replicas=0   # drop cluster socket
    pm2 start maelle                                                # local resumes
NEXT
