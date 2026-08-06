import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "site");
const dist = path.join(root, "dist");
const value = (name, fallback = "") => String(process.env[name] ?? fallback).trim();
const bool = (name, fallback = false) => /^(1|true|yes|on)$/i.test(value(name, String(fallback)));
const siteUrl = value("FRUITMARKET_SITE_URL", "https://fruit-market.netlify.app").replace(/\/$/, "");
const supabaseUrl = value("SUPABASE_URL");
const publishableKey = value("SUPABASE_PUBLISHABLE_KEY");
const tossClientKey = value("TOSS_CLIENT_KEY");
const paymentsEnabled = bool("FRUITMARKET_PAYMENTS_ENABLED", false);
const settlementsEnabled = bool("FRUITMARKET_SETTLEMENTS_ENABLED", false);

for (const secretName of ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "TOSS_SECRET_KEY", "DATABASE_PASSWORD"]) {
  if (value(secretName)) throw new Error(`${secretName}는 Netlify 빌드 환경에 넣지 말고 Supabase Edge Function Secret에서만 관리하세요.`);
}

if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl)) throw new Error("SUPABASE_URL을 https://PROJECT_REF.supabase.co 형식으로 입력하세요.");
if (publishableKey.length < 20) throw new Error("SUPABASE_PUBLISHABLE_KEY를 입력하세요. secret/service_role key는 사용하면 안 됩니다.");
if (!/^https:\/\//i.test(siteUrl)) throw new Error("FRUITMARKET_SITE_URL은 HTTPS 주소여야 합니다.");
if (paymentsEnabled && !/^(test_ck_|live_ck_)/.test(tossClientKey)) throw new Error("결제 활성화 시 TOSS_CLIENT_KEY가 필요합니다.");
if (/service_role|secret/i.test(publishableKey)) throw new Error("브라우저 설정에 secret/service_role key를 사용할 수 없습니다.");

fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(source, dist, { recursive: true });
const publicConfig = {
  enabled: true,
  url: supabaseUrl,
  publishableKey,
  tossClientKey: paymentsEnabled ? tossClientKey : "",
  features: { paymentsEnabled, settlementsEnabled },
  storage: { publicAssetsBucket: "public-assets", productImagesBucket: "product-images", sellerDocumentsBucket: "seller-documents", claimEvidenceBucket: "claim-evidence" }
};
fs.writeFileSync(path.join(dist, "config", "supabase-config.js"), `window.FRUITMARKET_SUPABASE = Object.freeze(${JSON.stringify(publicConfig, null, 2)});\nwindow.FRUITMARKET_PUBLIC_SITE_URL=${JSON.stringify(siteUrl)};\nwindow.FRUITMARKET_RUNTIME="SUPABASE";\n`);
fs.writeFileSync(path.join(dist, "build-manifest.json"), JSON.stringify({ version: "48.0.0", builtAt: new Date().toISOString(), siteUrl, backend: "Supabase", paymentsEnabled, settlementsEnabled, containsServerSecret: false }, null, 2));
if (!paymentsEnabled) fs.writeFileSync(path.join(dist, "robots.txt"), "User-agent: *\nDisallow: /checkout\nDisallow: /payment-success.html\nDisallow: /payment-fail.html\n");
console.log(`Netlify 배포 폴더 생성 완료: ${dist}`);
