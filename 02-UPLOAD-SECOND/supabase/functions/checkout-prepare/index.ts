import { handleOptions, ok, errorResponse } from "../_shared/http.ts";
import { requestContext, requireUser } from "../_shared/platform.ts";

Deno.serve(async (req: Request) => {
  const options = handleOptions(req);
  if (options) return options;
  try {
    if (req.method !== "POST") throw Object.assign(new Error("METHOD_NOT_ALLOWED"), { status: 405 });
    const ctx = await requestContext(req);
    const user = requireUser(ctx);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const payload = {
      ...body,
      idempotencyKey: body.idempotencyKey || req.headers.get("idempotency-key") || crypto.randomUUID(),
    };

    const { data: risk, error: riskError } = await ctx.admin.rpc("assess_checkout_risk", { p_buyer_id: user.id, p_payload: payload });
    if (riskError) throw riskError;
    const decision = String((risk as Record<string, unknown> | null)?.decision || "ALLOW");
    if (decision === "BLOCK") {
      throw Object.assign(new Error("확인된 계정 제한으로 주문을 진행할 수 없습니다. 이의제기 메뉴에서 재심을 요청해 주세요."), {
        status: 403, code: "CHECKOUT_ACCOUNT_RESTRICTED", details: risk,
      });
    }
    if (decision === "REVIEW") {
      const { data: caseId, error: caseError } = await ctx.admin.rpc("open_trust_review_case", {
        p_subject_type: "BUYER", p_subject_id: user.id, p_case_type: "PAYMENT_FRAUD",
        p_summary: "주문 속도 또는 기존 위험심사 신호로 결제 전 수동 확인이 필요합니다.",
        p_facts: { risk, idempotencyKey: payload.idempotencyKey }, p_priority: "HIGH",
        p_temporary_action: "CHECKOUT_REVIEW", p_temporary_hours: 24, p_emergency: false,
      });
      if (caseError) throw caseError;
      await ctx.admin.from("notifications").insert({
        user_id: user.id, type: "CHECKOUT_REVIEW", title: "주문 확인이 필요합니다",
        message: "안전한 거래를 위해 주문정보를 확인 중입니다. 신고나 점수만으로 구매 제한을 확정하지 않으며, 확인 후 결과를 안내합니다.",
      });
      throw Object.assign(new Error("안전한 거래를 위해 주문정보를 확인 중입니다. 마이페이지에서 진행상황과 이의제기를 확인할 수 있습니다."), {
        status: 409, code: "CHECKOUT_MANUAL_REVIEW_REQUIRED", details: { risk, caseId },
      });
    }

    const { data, error } = await ctx.userClient.rpc("prepare_checkout", { p_payload: payload });
    if (error) throw error;
    return ok({ ...(data as Record<string, unknown>), trustDecision: risk }, req, 201);
  } catch (error) {
    return errorResponse(error, req, "CHECKOUT_PREPARE_FAILED");
  }
});
