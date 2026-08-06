import { handleOptions, ok, errorResponse } from "../_shared/http.ts";
import { requestContext, requireUser, uuid, cleanString, sellerFor } from "../_shared/platform.ts";

function basic(secret: string): string { return `Basic ${btoa(`${secret}:`)}`; }

type ClaimContext = {
  id: string;
  claim_type: string;
  status: string;
  quantity: number;
  order_items: {
    id: string;
    order_id: string;
    seller_id: string;
    unit_price: number;
    quantity: number;
    refunded_quantity: number;
  };
};

Deno.serve(async (req: Request) => {
  const options = handleOptions(req); if (options) return options;
  try {
    if (req.method !== "POST") throw Object.assign(new Error("METHOD_NOT_ALLOWED"), { status: 405 });
    const ctx = await requestContext(req); const user = requireUser(ctx);
    const body = await req.json().catch(() => ({})) as Record<string, any>;
    const paymentId = uuid(body.paymentId);
    const idempotencyKey = cleanString(req.headers.get("idempotency-key") || body.idempotencyKey || crypto.randomUUID(), 300);
    const { data: payment, error } = await ctx.admin.from("payments")
      .select("*,orders!inner(id,buyer_id,order_number,status,paid_total)")
      .eq("id", paymentId).single();
    if (error) throw error;

    const role = String(ctx.profile?.role || "consumer");
    let claim: ClaimContext | null = null;
    let items = Array.isArray(body.items) ? body.items : [];
    let restock = Boolean(body.restock);
    let amount = body.cancelAmount == null ? Number(payment.balance_amount) : Number(body.cancelAmount);

    if (body.claimId) {
      const claimId = uuid(body.claimId);
      const { data, error: claimError } = await ctx.admin.from("claims")
        .select("id,claim_type,status,quantity,order_items!inner(id,order_id,seller_id,unit_price,quantity,refunded_quantity)")
        .eq("id", claimId).single();
      if (claimError) throw claimError;
      claim = data as unknown as ClaimContext;
      if (String(claim.order_items.order_id) !== String(payment.order_id)) throw Object.assign(new Error("CLAIM_PAYMENT_MISMATCH"), { status: 409 });
      if (claim.claim_type === "CANCEL" && claim.status !== "APPROVED") throw Object.assign(new Error("CANCEL_CLAIM_NOT_APPROVED"), { status: 409 });
      if (claim.claim_type === "RETURN" && claim.status !== "RETURN_RECEIVED") throw Object.assign(new Error("RETURN_NOT_RECEIVED"), { status: 409 });
      if (claim.claim_type === "EXCHANGE") throw Object.assign(new Error("EXCHANGE_IS_NOT_REFUND"), { status: 409 });
      const remaining = Math.max(0, Number(claim.order_items.quantity || 0) - Number(claim.order_items.refunded_quantity || 0));
      const quantity = Math.min(Number(claim.quantity || 0), remaining);
      if (!Number.isSafeInteger(quantity) || quantity <= 0) throw Object.assign(new Error("CLAIM_ALREADY_REFUNDED"), { status: 409 });
      amount = Number(claim.order_items.unit_price || 0) * quantity;
      items = [{ orderItemId: claim.order_items.id, quantity, amount }];
      restock = claim.claim_type === "RETURN" && Boolean(body.restock);
    }

    if (!claim && body.cancelAll === true) {
      if (String(body.orderId || payment.order_id) !== String(payment.order_id)) throw Object.assign(new Error("ORDER_PAYMENT_MISMATCH"), { status: 409 });
      if (!["PAID", "PREPARING"].includes(String(payment.orders.status))) throw Object.assign(new Error("ORDER_NOT_FULL_CANCELABLE"), { status: 409 });
      const { data: dispatched, error: shipmentError } = await ctx.admin.from("shipments").select("id").eq("order_id", payment.order_id).in("status", ["SHIPPED", "IN_TRANSIT", "DELIVERED"]).limit(1);
      if (shipmentError) throw shipmentError;
      if ((dispatched || []).length) throw Object.assign(new Error("SHIPPED_ORDER_REQUIRES_CLAIM"), { status: 409 });
      const { data: orderItems, error: itemError } = await ctx.admin.from("order_items").select("id,quantity,refunded_quantity,unit_price").eq("order_id", payment.order_id);
      if (itemError) throw itemError;
      items = (orderItems || []).map((item: any) => { const quantity = Math.max(0, Number(item.quantity || 0) - Number(item.refunded_quantity || 0)); return { orderItemId: item.id, quantity, amount: Number(item.unit_price || 0) * quantity }; }).filter((item: any) => item.quantity > 0);
      amount = Number(payment.balance_amount);
      restock = true;
    }

    let allowed = role === "admin" || payment.orders.buyer_id === user.id;
    if (!allowed && role === "seller" && claim) {
      const seller = await sellerFor(ctx);
      allowed = String(seller.id) === String(claim.order_items.seller_id);
    }
    if (!allowed) throw Object.assign(new Error("PAYMENT_CANCEL_FORBIDDEN"), { status: 403 });
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > Number(payment.balance_amount)) throw new Error("CANCEL_AMOUNT_INVALID");
    if (!["DONE", "PARTIAL_CANCELED"].includes(String(payment.status))) throw new Error("PAYMENT_NOT_CANCELABLE");

    const { data: risk, error: riskError } = await ctx.admin.rpc("assess_refund_risk", {
      p_requester_id: payment.orders.buyer_id,
      p_payment_id: paymentId,
      p_claim_id: claim?.id || null,
      p_amount: amount,
    });
    if (riskError) throw riskError;
    const riskDecision = String((risk as Record<string, unknown> | null)?.decision || "ALLOW");
    if (riskDecision === "DUPLICATE_BLOCK") {
      await ctx.admin.rpc("record_trust_risk_signal", {
        p_rule_code: "BUYER_DUPLICATE_REFUND", p_entity_type: "BUYER", p_entity_id: String(payment.orders.buyer_id),
        p_source: "PAYMENT_CANCEL", p_facts: { paymentId, claimId: claim?.id || null, amount },
        p_order_id: payment.order_id, p_claim_id: claim?.id || null,
        p_idempotency_key: `DUPLICATE_REFUND:${paymentId}:${claim?.id || "NONE"}:${amount}`, p_points: null,
      });
      throw Object.assign(new Error("이미 처리 중이거나 완료된 환불 요청입니다."), { status: 409, code: "DUPLICATE_REFUND_REQUEST", details: risk });
    }
    if (riskDecision === "REVIEW") {
      const { data: caseId } = await ctx.admin.rpc("open_trust_review_case", {
        p_subject_type: "BUYER", p_subject_id: String(payment.orders.buyer_id), p_case_type: "REFUND_ABUSE",
        p_summary: "반복 환불 신호가 감지되어 향후 거래 보호를 위한 수동심사를 진행합니다. 이미 적법하게 승인된 이번 환불은 별도로 처리합니다.",
        p_facts: { paymentId, claimId: claim?.id || null, amount, risk }, p_priority: "NORMAL",
        p_temporary_action: null, p_temporary_hours: 72, p_emergency: false,
      });
      let reviewQuery = ctx.admin.from("refund_request_reviews").select("id").eq("payment_id", paymentId).eq("requested_amount", amount);
      reviewQuery = claim?.id ? reviewQuery.eq("claim_id", claim.id) : reviewQuery.is("claim_id", null);
      const { data: existingReview } = await reviewQuery.maybeSingle();
      if (!existingReview) await ctx.admin.from("refund_request_reviews").insert({
        payment_id: paymentId, claim_id: claim?.id || null, requester_id: payment.orders.buyer_id,
        requested_amount: amount, risk_decision: "REVIEW", risk_reasons: (risk as any)?.reasons || [],
        case_id: caseId || null, status: "APPROVED", reviewed_by: role === "admin" ? user.id : null,
        reviewed_at: new Date().toISOString(),
      });
    }

    const secret = Deno.env.get("TOSS_SECRET_KEY") || "";
    if (!secret || (Deno.env.get("TOSS_ENVIRONMENT") || "deferred") === "deferred") throw Object.assign(new Error("PG_NOT_CONFIGURED"), { status: 503 });

    const { data: prior } = await ctx.admin.from("refunds").select("*").eq("idempotency_key", idempotencyKey).maybeSingle();
    if (prior?.status === "DONE") return ok({ refundId: prior.id, status: "DONE", idempotentReplay: true }, req);

    const reason = cleanString(body.cancelReason || body.reason || "고객 요청", 200);
    const providerResponse = await fetch(`https://api.tosspayments.com/v1/payments/${encodeURIComponent(payment.provider_payment_key)}/cancel`, {
      method: "POST",
      headers: { Authorization: basic(secret), "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ cancelReason: reason, ...(amount < Number(payment.balance_amount) ? { cancelAmount: amount } : {}) }),
    });
    const provider = await providerResponse.json().catch(() => ({}));
    if (!providerResponse.ok) throw Object.assign(new Error(provider.message || "TOSS_CANCEL_FAILED"), { code: provider.code || "TOSS_CANCEL_FAILED", status: providerResponse.status, details: provider });
    const { data: result, error: rpcError } = await ctx.admin.rpc("apply_payment_refund", {
      p_payment_id: paymentId,
      p_amount: amount,
      p_reason: reason,
      p_idempotency_key: idempotencyKey,
      p_provider_response: provider,
      p_claim_id: claim?.id || null,
      p_items: items,
      p_restock: restock,
    });
    if (rpcError) throw rpcError;
    return ok(result, req);
  } catch (error) { return errorResponse(error, req, "PAYMENT_CANCEL_FAILED"); }
});
