(function (global) {
  "use strict";
  const cfg = global.FRUITMARKET_SUPABASE_CONFIG || {};
  const base = String(cfg.functionsBaseUrl || (cfg.url ? `${cfg.url}/functions/v1` : "")).replace(/\/$/, "");
  async function health() {
    if (!base) return { ok: false, code: "SUPABASE_NOT_CONFIGURED" };
    const response = await fetch(`${base}/health`, { headers: { Accept: "application/json" } });
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, ...payload };
  }
  global.FruitMarketProduction = Object.freeze({
    config: Object.freeze({
      enabled: Boolean(cfg.enabled),
      siteUrl: cfg.siteUrl || global.location.origin,
      paymentsEnabled: Boolean(cfg.paymentsEnabled),
      settlementsEnabled: Boolean(cfg.settlementsEnabled)
    }),
    health
  });
})(window);
