param(
  [Parameter(Mandatory=$true)][string]$RepositoryUrl
)
$ErrorActionPreference = "Stop"
git init -b main
git add .
git commit -m "Fruitmarket Part 48 mutual protection"
git remote remove origin 2>$null
git remote add origin $RepositoryUrl
git push -u origin main
