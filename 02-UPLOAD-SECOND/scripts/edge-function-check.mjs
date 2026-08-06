import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const functionsRoot = path.join(root, "supabase/functions");
const files = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else if (name.endsWith(".ts")) files.push(full);
  }
}
walk(functionsRoot);
files.sort();
const declaration = path.join(os.tmpdir(), `fruitmarket-edge-${process.pid}.d.ts`);
fs.writeFileSync(declaration, `
declare const Deno: { serve(handler: (req: Request) => Response | Promise<Response>): void; env: { get(key: string): string | undefined } };
declare module "npm:@supabase/supabase-js@2" { export type SupabaseClient = any; export type User = any; export const createClient: any; }
declare module "npm:@supabase/supabase-js@2.57.4" { export type SupabaseClient = any; export type User = any; export const createClient: any; }
`);
const args = [
  "--noEmit", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler",
  "--allowImportingTsExtensions", "--lib", "ES2022,DOM", "--skipLibCheck", declaration, ...files,
];
const run = spawnSync("tsc", args, { cwd: root, encoding: "utf8" });
fs.rmSync(declaration, { force: true });
const requiredFunctions = ["api", "checkout-prepare", "payment-confirm", "payment-cancel", "payment-webhook", "payout-run", "scheduled-jobs", "health"];
const missing = requiredFunctions.filter(name => !fs.existsSync(path.join(functionsRoot, name, "index.ts")));
const combined = files.map(file => fs.readFileSync(file, "utf8")).join("\n");
const securityChecks = {
  noServiceKeyInFrontend: !fs.readFileSync(path.join(root, "site/assets/js/supabase-adapter.js"), "utf8").match(/service[_-]?role|SUPABASE_SECRET_KEY/i),
  paymentServerSecretOnly: combined.includes('Deno.env.get("TOSS_SECRET_KEY")'),
  webhookIdempotency: combined.includes("payment_webhook_events") && combined.includes("transmission"),
  refundIdempotency: combined.includes("Idempotency-Key") && combined.includes("apply_payment_refund"),
  payoutMfaGuard: fs.readFileSync(path.join(functionsRoot, "_shared/platform.ts"), "utf8").includes("ADMIN_MFA_REQUIRED"),
  cronSecretGuard: fs.readFileSync(path.join(functionsRoot, "scheduled-jobs/index.ts"), "utf8").includes("FRUITMARKET_CRON_SECRET"),
  zeroPaymentServerFinalize: fs.readFileSync(path.join(functionsRoot, "payment-confirm/index.ts"), "utf8").includes("ZERO_PAYMENT"),
  providerStatusReconciliation: combined.includes("reconcile_provider_payment"),
  payoutRequiresProvider: fs.readFileSync(path.join(functionsRoot, "payout-run/index.ts"), "utf8").includes("TOSS_PAYOUT_REQUEST_URL"),
  checkoutRiskReview: fs.readFileSync(path.join(functionsRoot, "checkout-prepare/index.ts"), "utf8").includes("assess_checkout_risk"),
  refundRiskReview: fs.readFileSync(path.join(functionsRoot, "payment-cancel/index.ts"), "utf8").includes("assess_refund_risk"),
  payoutRiskReview: fs.readFileSync(path.join(functionsRoot, "payout-run/index.ts"), "utf8").includes("assess_payout_risk"),
  scheduledProtectionControls: fs.readFileSync(path.join(functionsRoot, "scheduled-jobs/index.ts"), "utf8").includes("run_mutual_protection_controls"),
  manualTrustDecisionRoutes: fs.readFileSync(path.join(functionsRoot, "api/index.ts"), "utf8").includes("/api/admin/trust/cases") && fs.readFileSync(path.join(functionsRoot, "api/index.ts"), "utf8").includes("finalAdverseAction"),
};
const failedSecurity = Object.entries(securityChecks).filter(([,ok]) => !ok).map(([name]) => name);
const result = {
  checkedAt: new Date().toISOString(),
  typescriptFileCount: files.length,
  edgeFunctionCount: requiredFunctions.length,
  requiredFunctions,
  missingFunctions: missing,
  securityChecks,
  tscExitCode: run.status,
  tscStdout: run.stdout.trim(),
  tscStderr: run.stderr.trim(),
  passed: run.status === 0 && missing.length === 0 && failedSecurity.length === 0,
};
fs.writeFileSync(path.join(root, "tests/edge-function-results.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, tscStdout: result.tscStdout.slice(0, 1500), tscStderr: result.tscStderr.slice(0, 1500) }, null, 2));
process.exit(result.passed ? 0 : 1);
