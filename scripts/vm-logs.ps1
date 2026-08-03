# vm-logs.ps1 — read Maelle's logs from Google Cloud Logging.
#
# She runs on maelle-agent-vm; the local logs/ dir is STALE (frozen at cutover),
# so never diagnose from it.
#
# DURABLE AUTH — no more "Reauthentication failed". This reads Cloud Logging as
# the `maelle-logs-reader` service account (roles/logging.viewer), parked in the
# `maelle-logs` gcloud configuration. The SA mints its own tokens from a key file,
# so it is NOT subject to the SSO reauth that expires `gcloud auth login`. No IAP,
# no SSH, no personal login. (One-time setup did:
#   gcloud config configurations create maelle-logs
#   gcloud config configurations activate maelle-logs
#   gcloud config set project reflectiz-ai-backoffice
#   gcloud auth activate-service-account --key-file=<locked path to the SA key>
#   gcloud config configurations activate default
# so the SA lives in its own config and your default login is untouched.)
#
# Usage (from the repo root):
#   powershell -File scripts/vm-logs.ps1                 # last 200 Maelle lines, past 1 day
#   powershell -File scripts/vm-logs.ps1 "Yael"          # filter for a term (case-insensitive)
#   powershell -File scripts/vm-logs.ps1 "error" 400     # term + line count
#   powershell -File scripts/vm-logs.ps1 "" 500 3        # no term, 500 lines, past 3 days
param([string]$Filter = "", [int]$Lines = 200, [int]$Days = 1)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8   # keep Hebrew / em-dashes intact
$env:PYTHONUTF8 = "1"                                       # make gcloud's python emit UTF-8...
$env:PYTHONIOENCODING = "utf-8"                             # ...so PowerShell decodes it correctly

$g = "C:\Users\idanc\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
if (-not (Test-Path $g)) { $g = "gcloud" }

# The filter is kept space-free and passed as ONE arg so gcloud.cmd (cmd.exe) can't
# mangle it. The text search is done client-side below, which also lets a term match
# any field (message OR metadata), like the old grep-the-line behaviour.
$logFilter = 'jsonPayload.service="maelle"'
$pull = if ($Filter) { [Math]::Max(2000, $Lines * 10) } else { $Lines }

$raw = & $g logging read $logFilter --configuration=maelle-logs --project=reflectiz-ai-backoffice --limit=$pull --freshness="${Days}d" --format=json
if ($LASTEXITCODE -ne 0) {
  Write-Host "gcloud logging read failed (exit $LASTEXITCODE)."
  Write-Host "Expected the 'maelle-logs' SA config. Check:  gcloud config configurations list"
  exit 1
}

# gcloud prints the JSON array across many lines; join back to ONE string before
# parsing. ConvertFrom-Json (PS 5.1) emits the parsed array as a SINGLE pipeline
# object, so assign FIRST (which keeps it an array), then coerce — wrapping the
# pipeline in @() instead would make a 1-element array of the whole array.
$entries = ($raw -join "`n") | ConvertFrom-Json
if ($entries -isnot [System.Array]) { $entries = @($entries) }
if ($entries.Count -eq 0) {
  $suffix = if ($Filter) { " matching '$Filter'" } else { "" }
  Write-Host "(no Maelle log entries in the past $Days day(s)$suffix)"
  exit 0
}

[array]::Reverse($entries)   # Logging returns newest-first; show oldest -> newest like a tail

$rendered = foreach ($e in $entries) {
  $p = $e.jsonPayload
  $line = "$($e.timestamp) [$($p.level)] $($p.message)"
  $meta = @{}
  foreach ($m in $p.PSObject.Properties) {
    if ($m.Name -notin @('level', 'message', 'service')) { $meta[$m.Name] = $m.Value }
  }
  if ($meta.Count -gt 0) { $line += "  " + ($meta | ConvertTo-Json -Compress -Depth 12) }
  $line
}

if ($Filter) { $rendered = $rendered | Where-Object { $_ -match [regex]::Escape($Filter) } }
$rendered | Select-Object -Last $Lines | ForEach-Object { Write-Host $_ }
