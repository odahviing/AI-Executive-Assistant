#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# migrate-data.sh — seed the cluster's PersistentVolume with the live data from
# the current host: the SQLite DB + the config/users/ tree. ONE-SHOT, run once at
# cutover (Phase 4). This is the "migrate the data" step.
#
# ⚠️  INTENTIONALLY EMPTY (framework stage). The real migration is NOT built yet —
#     by owner direction we are only scaffolding the framework right now. Fill this
#     in at cutover.
#
# When implemented, this will (outline — not final):
#   1. Stop the local Maelle process FIRST (single-socket: never two live at once).
#   2. Snapshot a consistent DB:
#        sqlite3 data/maelle.db "PRAGMA wal_checkpoint(TRUNCATE);"
#        sqlite3 data/maelle.db ".backup /tmp/maelle-snapshot.db"
#   3. Copy the snapshot + config/users/ into the PVC — either `kubectl cp` into a
#      short-lived helper pod that mounts `maelle-state`, or an init Job.
#        - DB           → <pvc>/data/maelle.db
#        - config/users → <pvc>/config-users/
#   4. Verify row counts against the pre-cutover baseline BEFORE first real boot
#      (people_memory, requests, tasks, audit_log, …).
#   5. Scale the Deployment up; confirm the boot stamp (version + gitSha), socket
#      alive, and a test DM round-trip.
#
# Until then this is a no-op so the framework is complete but does nothing.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

echo "migrate-data.sh is a framework stub — data migration not implemented yet."
echo "See k8s/README.md and the migration project notes before filling this in."
exit 0
