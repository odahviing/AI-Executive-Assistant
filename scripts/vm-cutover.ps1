# ─────────────────────────────────────────────────────────────────────────────
# vm-cutover.ps1 — migrate live data from THIS LAPTOP to maelle-agent-vm and
# bring Maelle up in the cloud. Run from the laptop (PowerShell) when you're ready
# to go live. This is the single-socket hand-off — it stops the laptop bot BEFORE
# the VM serves, so exactly one Slack socket exists at every moment.
#
# Prereqs: gcloud auth active (`gcloud auth login`), the repo at $REPO, PM2 running
# maelle here, tar (built into Windows 10+), node (for the checkpoint).
#
# The VM is already provisioned (Node/PM2/app on /mnt/disks/maelle, symlinks +
# egress verified). This script only moves the DATA and starts the process.
#
# ROLLBACK at any point: stop the VM ( gcloud compute ssh maelle-agent-vm --zone
# europe-west4-b --tunnel-through-iap --command "pm2 stop maelle" ) then restart
# here ( pm2 start maelle ). Never run both at once.
# ─────────────────────────────────────────────────────────────────────────────
$ErrorActionPreference = 'Stop'
$gcloud = "C:\Users\idanc\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$VM     = 'maelle-agent-vm'
$ZONE   = 'europe-west4-b'
$REPO   = 'E:\Code\Maelle'
function Check($msg) { if ($LASTEXITCODE -ne 0) { throw "FAILED: $msg (exit $LASTEXITCODE)" } }

Write-Host '== 1/6  Stop the laptop bot (single-socket: local down before VM serves) =='
pm2 stop maelle; Check 'pm2 stop maelle'

Write-Host '== 2/6  Checkpoint the DB + capture baseline row counts =='
node "$REPO\scripts\checkpoint-db.cjs"; Check 'checkpoint-db'

Write-Host '== 3/6  Package config/users (idan.yaml + people/prefs/kb) =='
$cfgTar = "$env:TEMP\maelle-config.tgz"
tar -czf $cfgTar -C "$REPO\config\users" .; Check 'tar config/users'

Write-Host '== 4/6  Copy DB + config + .env to the VM (over IAP) =='
& $gcloud compute scp "$REPO\data\maelle.db" "${VM}:/mnt/disks/maelle/data/maelle.db" --zone=$ZONE --tunnel-through-iap; Check 'scp maelle.db'
& $gcloud compute scp $cfgTar "${VM}:/mnt/disks/maelle/tmp/maelle-config.tgz" --zone=$ZONE --tunnel-through-iap; Check 'scp config'
& $gcloud compute scp "$REPO\.env" "${VM}:/mnt/disks/maelle/app/.env" --zone=$ZONE --tunnel-through-iap; Check 'scp .env'

Write-Host '== 5/6  Unpack config, normalize .env paths, start Maelle on the VM =='
# Strip any DB_PATH/LOG_PATH from the copied .env so the defaults (./data, ./logs)
# resolve through the symlinks onto the persistent disk.
& $gcloud compute ssh $VM --zone=$ZONE --tunnel-through-iap --quiet --command "tar -xzf /mnt/disks/maelle/tmp/maelle-config.tgz -C /mnt/disks/maelle/config-users && sed -i '/^DB_PATH=/d; /^LOG_PATH=/d' /mnt/disks/maelle/app/.env && cd /mnt/disks/maelle/app && pm2 start ecosystem.config.js && pm2 save && sleep 8 && pm2 logs maelle --lines 40 --nostream"; Check 'start on VM'

Write-Host ''
Write-Host '== 6/6  Verify, then finish =='
Write-Host '  - Confirm the boot stamp in the logs above (version 4.3.x + gitSha) and socket online.'
Write-Host '  - DM Maelle a test message; confirm a round-trip + that briefs/timers fire.'
Write-Host '  - Reboot-safe: SSH in and run the command printed by:  pm2 startup systemd'
Write-Host '  - Row counts: compare the VM against the baseline printed in step 2.'
Write-Host '  ROLLBACK if wrong: pm2 stop maelle on the VM, then  pm2 start maelle  here.'
