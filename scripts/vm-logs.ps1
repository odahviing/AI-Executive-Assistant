# vm-logs.ps1 — read Maelle's logs from the cloud VM. She runs on
# maelle-agent-vm now, NOT this laptop — the local logs/ dir is STALE (frozen at
# the cutover), so never diagnose from it.
#
# Usage (from the repo root):
#   powershell -File scripts/vm-logs.ps1                    # last 200 lines of today's log
#   powershell -File scripts/vm-logs.ps1 "Yael"             # filter for a term
#   powershell -File scripts/vm-logs.ps1 "error" 400        # term + line count
#
# Requires gcloud auth to be live. If it errors "Reauthentication failed",
# run:  gcloud auth login
param([string]$Filter = "", [int]$Lines = 200)
$g = "C:\Users\idanc\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
if (-not (Test-Path $g)) { $g = "gcloud" }
& $g compute ssh maelle-agent-vm --zone=europe-west4-b --tunnel-through-iap --quiet --command "bash /mnt/disks/maelle/app/scripts/tail-logs.sh '$Filter' $Lines"
