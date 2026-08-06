param([Parameter(Mandatory=$true)][string]$RepositoryUrl)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path .git)) { git init -b main }
git add .
git commit -m "Deploy fruitmarket-production" 2>$null
if ((git remote) -contains "origin") { git remote set-url origin $RepositoryUrl } else { git remote add origin $RepositoryUrl }
git push -u origin main
