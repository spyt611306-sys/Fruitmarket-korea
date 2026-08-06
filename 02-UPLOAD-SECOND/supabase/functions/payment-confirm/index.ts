import { handleOptions, ok, errorResponse } from "../_shared/http.ts";
import { requestContext, requireUser, uuid } from "../_shared/platform.ts";

function basic(secret: string): string {
  return `Basic ${btoa(`${secret}:`)}`;
}

Deno.serve(async (req: Request) => {
  const options = handleOptions(req);
  if (options) return options;
  try {
    if (req.method !== "POST") throw Object.assign(new Error("METHOD_NOT_ALLOWED"), { status: 405 });
    const ctx = await requestContext(req);
    const user = requireUser(ctx);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const paymentId = uuid(body.paymentId);
    const paymentKey = String(body.paymentKey || "");
    const orderId = String(body.orderId || "");
    const amount = Number(body.amount);
    if (!paymentKey || !orderId || !Number.isSafeInteger(amount) || amount < 0) throw new Error("PAYMENT_CONFIRM_REQUIRED_FIELDS");

    const { data: payment, error: paymentError } = await ctx.admin.from("payments").select("*,orders!inner(id,buyer_id,order_number,paid_total,status)").eq("id", paymentId).single();
    if (paymentError) throw paymentError;
    if (payment.orders.buyer_id !== user.id) throw Object.assign(new Error("PAYMENT_FORBIDDEN"), { status: 403 });
    if (payment.status === "DONE") return ok({ orderId: payment.orders.id, orderNumber: payment.orders.order_number, paymentId, status: "DONE", idempotentReplay: true }, req);
    if (payment.provider_order_id !== orderId || Number(payment.amount) !== amount || Number(payment.orders.paid_total) !== amount) throw new Error("PAYMENT_AMOUNT_OR_ORDER_MISMATCH");

    if (amount === 0) {
      const zeroKey = `ZERO_PAYMENT:${paymentId}`;
      const { data: finalized, error: finalizeError } = await ctx.admin.rpc("finalize_payment", {
        p_payment_id: paymentId, p_payment_key: zeroKey, p_order_id: orderId, p_amount: 0,
        p_provider_payload: { status: "DONE", method: "FREE", totalAmount: 0, balanceAmount: 0, approvedAt: new Date().toISOString(), zeroPayment: true },
      });
      if (finalizeError) throw finalizeError;
      return ok(finalized, req);
    }

    const secret = Deno.env.get("TOSS_SECRET_KEY") || "";
    const environment = Deno.env.get("TOSS_ENVIRONMENT") || "deferred";
    if (!secret || environment === "deferred") throw Object.assign(new Error("PG_NOT_CONFIGURED"), { status: 503 });

    const attemptKey = String(req.headers.get("idempotency-key") || `CONFIRM:${paymentId}:${paymentKey}`);
    const { data: existing } = await ctx.admin.from("payment_attempts").select("*").eq("idempotency_key", attemptKey).maybeSingle();
    if (existing?.status === "SUCCEEDED") return ok(existing.response_payload, req);
    await ctx.admin.from("payment_attempts").upsert({ payment_id: paymentId, attempt_type: "CONFIRM", idempotency_key: attemptKey, status: "STARTED", request_payload: { paymentKey, orderId, amount } }, { onConflict: "idempotency_key" });

    const response = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
      method: "POST",
      headers: {
        Authorization: basic(secret),
        "Content-Type": "application/json",
        "Idempotency-Key": attemptKey.slice(0, 300),
      },
      body: JSON.stringify({ paymentKey, orderId, amount }),
    });
    const provider = await response.json().catch(() => ({}));
    if (!response.ok) {
      await ctx.admin.from("payment_attempts").update({ status: "FAILED", response_payload: provider, error_code: provider.code || `HTTP_${response.status}`, error_message: provider.message || "결제 승인 실패", completed_at: new Date().toISOString() }).eq("idempotency_key", attemptKey);
      await ctx.admin.rpc("fail_payment", { p_payment_id: paymentId, p_code: provider.code || `HTTP_${response.status}`, p_message: provider.message || "결제 승인 실패" });
      throw Object.assign(new Error(provider.message || "TOSS_CONFIRM_FAILED"), { code: provider.code || "TOSS_CONFIRM_FAILED", status: response.status });
    }
    const { data: finalized, error: finalizeError } = await ctx.admin.rpc("finalize_payment", {
      p_payment_id: paymentId,
      p_payment_key: paymentKey,
      p_order_id: orderId,
      p_amount: amount,
      p_provider_payload: provider,
    });
    if (finalizeError) {
      // 승인 성공 후 DB 실패는 자동 취소를 시도하고 운영 경보를 남깁니다.
      const cancelResponse = await fetch(`https://api.tosspayments.com/v1/payments/${encodeURIComponent(paymentKey)}/cancel`, {
        method: "POST",
        headers: { Authorization: basic(secret), "Content-Type": "application/json", "Idempotency-Key": `${attemptKey}:COMPENSATE`.slice(0, 300) },
        body: JSON.stringify({ cancelReason: "상점 주문 저장 실패 자동 보상취소" }),
      });
      const cancelPayload = await cancelResponse.json().catch(() => ({}));
      if (cancelResponse.ok) {
        const { error: reconcileError } = await ctx.admin.rpc("reconcile_provider_payment", {
          p_payment_id: paymentId, p_status: "CANCELED", p_balance_amount: 0, p_provider_payload: cancelPayload, p_event_key: `${attemptKey}:COMPENSATE`,
        });
        await ctx.admin.from("payment_attempts").update({ status: reconcileError ? "COMPENSATION_RECONCILE_FAILED" : "COMPENSATED", response_payload: { provider, finalizeError, cancelPayload, reconcileError }, error_code: reconcileError ? "COMPENSATION_RECONCILE_FAILED" : "DB_FINALIZE_FAILED_COMPENSATED", error_message: reconcileError?.message || finalizeError.message, completed_at: new Date().toISOString() }).eq("idempotency_key", attemptKey);
      } else {
        await ctx.admin.from("payment_attempts").update({ status: "COMPENSATION_REQUIRED", response_payload: { provider, finalizeError, cancelPayload }, error_code: "DB_FINALIZE_FAILED", error_message: finalizeError.message, completed_at: new Date().toISOString() }).eq("idempotency_key", attemptKey);
        await ctx.admin.from("notifications").insert({ user_id: payment.orders.buyer_id, type: "PAYMENT_RECONCILIATION", title: "결제 처리 상태를 확인하고 있습니다", message: `${payment.orders.order_number} 주문의 결제 상태를 안전하게 확인 중입니다.` });
      }
      throw finalizeError;
    }
    await ctx.admin.from("payment_attempts").update({ status: "SUCCEEDED", response_payload: finalized, completed_at: new Date().toISOString() }).eq("idempotency_key", attemptKey);
    return ok(finalized, req);
  } catch (error) {
    return errorResponse(error, req, "PAYMENT_CONFIRM_FAILED");
  }
});
