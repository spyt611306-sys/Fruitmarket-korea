param([Parameter(Mandatory=$true)][string]$ProjectRef)
$ErrorActionPreference = "Stop"
$functions = @("health","api","checkout-prepare","payment-confirm","payment-cancel","payment-webhook","payout-run","scheduled-jobs")
foreach ($fn in $functions) {
  Write-Host "Deploying $fn..."
  npx supabase@latest functions deploy $fn --project-ref $ProjectRef --use-api
}
