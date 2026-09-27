<#
.SYNOPSIS
  Copies copyfomo's database backups OFF the server to this PC, verifies each copy's sha256, and records on the
  server which backup is safely off it (copyfomo-offsite pulled). Runs on your PC, never on the server.

.DESCRIPTION
  The server keeps its backups on its own disk (/var/backups/copyfomo): a lost server loses them too. Run this
  daily (Task Scheduler, see deploy/README.md section 8). It downloads every backup it does not have yet, keeps
  them all (it never deletes anything here), and tells the server about the newest verified one:
  copyfomo-status warns when that is older than 26 h, and copyfomo-set-mode live refuses when it is older than 48 h.
  Exit code 0 = all good; anything else = look at the output (Task Scheduler shows the last result).

  Keep these database backups APART from your copy of worker.env (password manager): both together open every
  agent wallet.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\pull-backups.ps1 -Server 203.0.113.10
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\pull-backups.ps1 -Server copyfomo.example -Dest D:\copyfomo-backups
#>
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$Dest = (Join-Path $HOME 'copyfomo-backups'),
  [string]$Key = (Join-Path $HOME '.ssh\copyfomo_deploy'),
  [string]$User = 'root'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

if ($Server -notmatch '^[A-Za-z0-9.:-]+$') { throw "not a host name or IP address: $Server" }
if (-not (Test-Path -LiteralPath $Key)) { throw "no SSH key at $Key" }
$sshOpts = @('-i', $Key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20')
$target = "$User@$Server"
$namePattern = '^copyfomo-\d{8}T\d{6}Z-[a-z0-9-]{1,32}\.db\.gz$'

New-Item -ItemType Directory -Force -Path $Dest | Out-Null

function Get-Sha256([string]$Path) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

$listing = @(& ssh @sshOpts $target 'copyfomo-offsite list')
if ($LASTEXITCODE -ne 0) { throw "ssh $target copyfomo-offsite list failed (exit $LASTEXITCODE)" }

$newest = $null
$copied = 0
foreach ($line in $listing) {
  $parts = @(-split [string]$line)
  if ($parts.Count -ne 2 -or $parts[0] -notmatch $namePattern -or $parts[1] -notmatch '^[0-9a-f]{64}$') {
    throw "unexpected line from the server: $line"
  }
  $name = $parts[0]
  $sha = $parts[1]
  $local = Join-Path $Dest $name
  if (-not (Test-Path -LiteralPath $local) -or (Get-Sha256 $local) -ne $sha) {
    $partial = "$local.partial"
    & scp @sshOpts -q "${target}:/var/backups/copyfomo/$name" $partial
    if ($LASTEXITCODE -ne 0) { throw "scp of $name failed (exit $LASTEXITCODE)" }
    $got = Get-Sha256 $partial
    if ($got -ne $sha) {
      Remove-Item -LiteralPath $partial -Force
      throw "sha256 mismatch for $name (got $got): not kept"
    }
    Move-Item -LiteralPath $partial -Destination $local -Force
    Set-Content -LiteralPath "$local.sha256" -Value "$sha  $name" -Encoding Ascii
    Write-Output "copied   $name"
    $copied++
  }
  if ($null -eq $newest) { $newest = @($name, $sha) }
}
if ($null -eq $newest) { throw "the server lists no backups yet (it takes one nightly and before every update)" }

& ssh @sshOpts $target "copyfomo-offsite pulled $($newest[0]) $($newest[1])"
if ($LASTEXITCODE -ne 0) { throw "could not record the copy on the server (exit $LASTEXITCODE)" }
Write-Output "ok: $copied new backup(s) in $Dest; newest $($newest[0]) verified and recorded on the server"
