import { handleOptions, ok, errorResponse } from "../_shared/http.ts";
import { serviceClient } from "../_shared/platform.ts";

function basic(secret: string): string { return `Basic ${btoa(`${secret}:`)}`; }
async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false; let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  const options = handleOptions(req); if (options) return options;
  const admin = serviceClient();
  let transmissionId = req.headers.get("tosspayments-webhook-transmission-id") || req.headers.get("x-tosspayments-transmission-id") || "";
  try {
    if (req.method !== "POST") throw Object.assign(new Error("METHOD_NOT_ALLOWED"), { status: 405 });
    const raw = await req.text(); const payload = JSON.parse(raw || "{}") as Record<string, any>;
    transmissionId ||= await sha256(`${payload.eventType || payload.event_type || "UNKNOWN"}:${raw}`);
    const eventType = String(payload.eventType || payload.event_type || "UNKNOWN");
    const data = payload.data || payload;
    const { data: existing } = await admin.from("payment_webhook_events").select("processing_status").eq("transmission_id", transmissionId).maybeSingle();
    if (existing?.processing_status === "PROCESSED") return ok({ accepted: true, idempotentReplay: true }, req);
    await admin.from("payment_webhook_events").upsert({ transmission_id: transmissionId, event_type: eventType, payment_key: data.paymentKey || null, order_id: data.orderId || null, payload, verified: false, processing_status: "PROCESSING" }, { onConflict: "transmission_id" });

    if (["PAYOUT_STATUS_CHANGED", "SELLER_STATUS_CHANGED", "payout.changed", "seller.changed"].includes(eventType)) {
      const signature = req.headers.get("tosspayments-webhook-signature") || "";
      const secret = Deno.env.get("TOSS_PAYOUT_WEBHOOK_SECURITY_KEY") || "";
      const transmissionTime = req.headers.get("tosspayments-webhook-transmission-time") || "";
      if (!signature || !secret || !transmissionTime) throw Object.assign(new Error("WEBHOOK_SIGNATURE_REQUIRED"), { status: 401 });
      const expected = await hmacHex(secret, `${transmissionId}:${transmissionTime}:${raw}`);
      if (!safeEqual(signature.toLowerCase(), expected.toLowerCase())) throw Object.assign(new Error("WEBHOOK_SIGNATURE_INVALID"), { status: 401 });
      if (eventType.toLowerCase().includes("payout")) {
        const providerId = data.payoutId || data.id;
        const status = String(data.status || "PROCESSING").toUpperCase();
        const localStatus = ["COMPLETED", "DONE"].includes(status) ? "COMPLETED" : ["FAILED", "REJECTED", "CANCELED"].includes(status) ? status : "PROCESSING";
        const { data: payout } = await admin.from("payout_requests").select("id").eq("provider_payout_id", providerId).maybeSingle();
        if (payout) {
          if (localStatus === "COMPLETED") {
            await admin.rpc("complete_payout", { p_payout_request_id: payout.id, p_provider_payout_id: providerId, p_provider_response: data, p_success: true, p_error: null });
          } else if (["FAILED", "REJECTED", "CANCELED"].includes(localStatus)) {
            await admin.rpc("complete_payout", { p_payout_request_id: payout.id, p_provider_payout_id: providerId, p_provider_response: data, p_success: false, p_error: String(data.failure?.message || status) });
          } else {
            await admin.from("payout_requests").update({ status: "PROCESSING", raw_response: data, updated_at: new Date().toISOString() }).eq("id", payout.id);
          }
        }
      } else {
        const sellerId = data.sellerId || data.id;
        const rawStatus = String(data.status || "KYC_REQUIRED").toUpperCase();
        const allowed = ["NOT_STARTED", "APPROVAL_REQUIRED", "PARTIALLY_APPROVED", "KYC_REQUIRED", "APPROVED", "REJECTED", "SUSPENDED"];
        const mappedStatus = allowed.includes(rawStatus) ? rawStatus : "KYC_REQUIRED";
        if (sellerId) await admin.from("seller_kyc").update({ status: mappedStatus, payload: data, last_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("provider_seller_id", sellerId);
      }
    } else {
      const paymentKey = String(data.paymentKey || "");
      if (!paymentKey) throw new Error("PAYMENT_KEY_REQUIRED");
      const secret = Deno.env.get("TOSS_SECRET_KEY") || "";
      if (!secret) throw Object.assign(new Error("PG_NOT_CONFIGURED"), { status: 503 });
      const verifyResponse = await fetch(`https://api.tosspayments.com/v1/payments/${encodeURIComponent(paymentKey)}`, { headers: { Authorization: basic(secret) } });
      const provider = await verifyResponse.json().catch(() => ({}));
      if (!verifyResponse.ok) throw Object.assign(new Error(provider.message || "PAYMENT_WEBHOOK_VERIFY_FAILED"), { status: verifyResponse.status });
      const { data: local, error: localError } = await admin.from("payments").select("*,orders!inner(id,order_number,paid_total)").or(`provider_payment_key.eq.${paymentKey},provider_order_id.eq.${provider.orderId}`).limit(1).maybeSingle();
      if (localError) throw localError;
      if (!local) throw new Error("LOCAL_PAYMENT_NOT_FOUND");
      if (String(local.provider_order_id) !== String(provider.orderId) || Number(local.amount) !== Number(provider.totalAmount)) throw new Error("WEBHOOK_PAYMENT_MISMATCH");
      const status = String(provider.status || data.status || "").toUpperCase();
      if (["DONE", "WAITING_FOR_DEPOSIT"].includes(status) && local.status !== status) {
        const { error } = await admin.rpc("finalize_payment", { p_payment_id: local.id, p_payment_key: paymentKey, p_order_id: provider.orderId, p_amount: Number(provider.totalAmount), p_provider_payload: provider });
        if (error) throw error;
      } else if (["CANCELED", "PARTIAL_CANCELED", "ABORTED", "EXPIRED"].includes(status)) {
        const { error } = await admin.rpc("reconcile_provider_payment", {
          p_payment_id: local.id, p_status: status, p_balance_amount: Number(provider.balanceAmount || 0),
          p_provider_payload: provider, p_event_key: transmissionId,
        });
        if (error) throw error;
      }
    }
    await admin.from("payment_webhook_events").update({ verified: true, processing_status: "PROCESSED", processed_at: new Date().toISOString(), error_message: null }).eq("transmission_id", transmissionId);
    return ok({ accepted: true }, req);
  } catch (error) {
    if (transmissionId) await admin.from("payment_webhook_events").update({ processing_status: "FAILED", error_message: String((error as Error).message || error), processed_at: new Date().toISOString() }).eq("transmission_id", transmissionId);
    return errorResponse(error, req, "PAYMENT_WEBHOOK_FAILED");
  }
});
