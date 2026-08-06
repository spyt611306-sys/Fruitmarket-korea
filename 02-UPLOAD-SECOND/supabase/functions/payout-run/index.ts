import { handleOptions, ok, errorResponse } from "../_shared/http.ts";
import { requestContext, requireRole, cleanString, uuid } from "../_shared/platform.ts";

Deno.serve(async (req: Request) => {
  const options = handleOptions(req); if (options) return options;
  try {
    if (req.method !== "POST") throw Object.assign(new Error("METHOD_NOT_ALLOWED"), { status: 405 });
    const ctx = await requestContext(req); requireRole(ctx, ["admin"]);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const settlementId = uuid(body.settlementId);
    const idempotencyKey = cleanString(req.headers.get("idempotency-key") || body.idempotencyKey || `PAYOUT:${settlementId}`, 300);
    const { data: settlement, error: settlementError } = await ctx.admin.from("settlements").select("id,seller_id,net_amount,status").eq("id", settlementId).single();
    if (settlementError) throw settlementError;
    const { data: risk, error: riskError } = await ctx.admin.rpc("assess_payout_risk", { p_seller_id: settlement.seller_id, p_amount: settlement.net_amount });
    if (riskError) throw riskError;
    const riskDecision = String((risk as Record<string, unknown> | null)?.decision || "ALLOW");
    if (riskDecision !== "ALLOW") {
      const { data: caseId } = await ctx.admin.rpc("open_trust_review_case", {
        p_subject_type: "SELLER", p_subject_id: settlement.seller_id, p_case_type: "PAYMENT_FRAUD",
        p_summary: riskDecision === "HOLD" ? "정산계좌 변경·활성 지급보류·확인된 제한으로 지급을 임시 보류합니다." : "판매자 위험신호와 정산유보를 수동 검토합니다.",
        p_facts: { settlementId, amount: settlement.net_amount, risk }, p_priority: riskDecision === "HOLD" ? "HIGH" : "NORMAL",
        p_temporary_action: "PAYOUT_HOLD", p_temporary_hours: 72, p_emergency: riskDecision === "HOLD",
      });
      throw Object.assign(new Error("판매자·소비자 피해 방지를 위해 지급을 임시 보류했습니다. 통제센터에서 근거를 확인하고 수동 심사해 주세요."), {
        status: 409, code: "PAYOUT_RISK_REVIEW_REQUIRED", details: { risk, caseId },
      });
    }
    const { data: requested, error: requestError } = await ctx.userClient.rpc("request_settlement_payout", { p_settlement_id: settlementId, p_idempotency_key: idempotencyKey });
    if (requestError) throw requestError;
    const requestId = requested.payoutRequestId as string;
    const endpoint = Deno.env.get("TOSS_PAYOUT_REQUEST_URL") || "";
    const secret = Deno.env.get("TOSS_PAYOUT_SECRET_KEY") || "";
    if (!endpoint || !secret) throw Object.assign(new Error("PAYOUT_PROVIDER_NOT_CONFIGURED"), { status: 503 });
    const { data: payout } = await ctx.admin.from("payout_requests").select("*,sellers!inner(id,store_name,seller_kyc(*),seller_settlement_accounts(*))").eq("id", requestId).single();
    const providerSellerId = payout?.sellers?.seller_kyc?.[0]?.provider_seller_id;
    const account = payout?.sellers?.seller_settlement_accounts?.[0];
    if (!providerSellerId) throw Object.assign(new Error("PAYOUT_SELLER_PROVIDER_ID_MISSING"), { status: 409 });
    if (!account || account.verification_status !== "VERIFIED") throw Object.assign(new Error("PAYOUT_ACCOUNT_NOT_VERIFIED"), { status: 409 });
    const payload = { amount: payout.amount, sellerId: providerSellerId, referenceId: payout.id, settlementId };
    await ctx.admin.from("payout_attempts").upsert({ payout_request_id: requestId, idempotency_key: idempotencyKey, request_payload: payload, status: "STARTED" }, { onConflict: "idempotency_key" });
    const providerResponse = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify(payload) });
    const provider = await providerResponse.json().catch(() => ({}));
    const success = providerResponse.ok;
    await ctx.admin.from("payout_attempts").update({ status: success ? "SUCCEEDED" : "FAILED", response_payload: provider, error_code: success ? null : provider.code || `HTTP_${providerResponse.status}`, error_message: success ? null : provider.message || "지급 요청 실패", completed_at: new Date().toISOString() }).eq("idempotency_key", idempotencyKey);
    if (!success) {
      await ctx.admin.rpc("complete_payout", { p_payout_request_id: requestId, p_provider_payout_id: provider.id || "", p_provider_response: provider, p_success: false, p_error: provider.message || "지급 요청 실패" });
      throw Object.assign(new Error(provider.message || "PAYOUT_PROVIDER_FAILED"), { status: providerResponse.status });
    }
    await ctx.admin.from("payout_requests").update({ provider_payout_id: provider.payoutId || provider.id, status: provider.status === "COMPLETED" ? "COMPLETED" : "PROCESSING", raw_response: provider, updated_at: new Date().toISOString() }).eq("id", requestId);
    if (provider.status === "COMPLETED") await ctx.admin.rpc("complete_payout", { p_payout_request_id: requestId, p_provider_payout_id: provider.payoutId || provider.id, p_provider_response: provider, p_success: true, p_error: null });
    return ok({ ...requested, providerStatus: provider.status || "PROCESSING", providerPayoutId: provider.payoutId || provider.id }, req, 202);
  } catch (error) { return errorResponse(error, req, "PAYOUT_RUN_FAILED"); }
});
