(function (global) {
  "use strict";
  const VERSION = "48.0.0";
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const toast = (m) => global.app?.showToast?.(String(m)) || global.alert(String(m));
  const unwrap = (x) => x && Object.prototype.hasOwnProperty.call(x, "data") ? x.data : x;
  const pending = new WeakSet();

  async function request(method, path, body) {
    const api = global.FruitMarketApi;
    if (!api) throw new Error("서버 연결 설정이 필요합니다.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const fn = api[method.toLowerCase()] || api.request;
      const result = fn === api.request
        ? await fn(path, { method, body, signal: controller.signal })
        : await fn(path, body, { signal: controller.signal });
      return unwrap(result);
    } finally { clearTimeout(timer); }
  }

  async function safe(button, task, success) {
    if (!button || pending.has(button)) return;
    pending.add(button);
    const original = button.innerHTML;
    const disabled = button.disabled;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "처리 중…";
    try {
      const value = await task();
      if (success) toast(success);
      return value;
    } catch (error) {
      console.error("FruitMarket Part48", error);
      toast(error?.message || "요청을 처리하지 못했습니다.");
      throw error;
    } finally {
      pending.delete(button);
      button.disabled = disabled;
      button.removeAttribute("aria-busy");
      button.innerHTML = original;
    }
  }

  function style() {
    if ($("fm48-style")) return;
    const node = document.createElement("style");
    node.id = "fm48-style";
    node.textContent = `
      .fm48-card{min-width:0;border:1px solid #dfe8df;border-radius:22px;background:#fff;padding:clamp(16px,2.2vw,24px);box-shadow:0 12px 32px rgba(17,66,20,.055)}
      .fm48-card h3,.fm48-card h4{margin:0;color:#114214;font-weight:900}.fm48-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.fm48-grid-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
      .fm48-field{display:grid;gap:6px;min-width:0;font-size:12px;font-weight:800;color:#33443a}.fm48-field input,.fm48-field select,.fm48-field textarea{box-sizing:border-box;width:100%;min-width:0;border:1px solid #cfdacf;border-radius:12px;padding:11px 12px;background:#fff;color:#18241b;font:inherit}.fm48-field textarea{min-height:88px;resize:vertical}
      .fm48-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.fm48-btn{min-height:42px;border:0;border-radius:12px;padding:10px 14px;background:#114214;color:#fff;font-size:12px;font-weight:900;cursor:pointer}.fm48-btn.secondary{border:1px solid #cad6cb;background:#fff;color:#114214}.fm48-btn.warn{background:#9a4a09}.fm48-btn.danger{background:#991b1b}.fm48-btn:disabled{cursor:not-allowed;opacity:.55}
      .fm48-note{margin-top:10px;border-radius:12px;background:#f3f7f2;padding:10px 12px;color:#536157;font-size:11px;line-height:1.7;overflow-wrap:anywhere}.fm48-note.warn{background:#fff7ed;color:#9a3412}.fm48-note.danger{background:#fef2f2;color:#991b1b}
      .fm48-list{display:grid;gap:9px;margin-top:12px}.fm48-row{min-width:0;border:1px solid #e5ebe5;border-radius:14px;padding:12px;font-size:12px;line-height:1.65;overflow-wrap:anywhere}.fm48-badge{display:inline-flex;border-radius:999px;padding:3px 8px;background:#edf6ed;color:#114214;font-size:10px;font-weight:900}.fm48-badge.warn{background:#fff7ed;color:#9a3412}.fm48-badge.danger{background:#fef2f2;color:#991b1b}
      .fm48-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:12px}.fm48-kpi{min-width:0;border-radius:14px;background:#f4f7f3;padding:12px}.fm48-kpi span{display:block;color:#607066;font-size:10px;font-weight:800}.fm48-kpi b{display:block;margin-top:4px;color:#114214;font-size:20px;overflow-wrap:anywhere}
      .fm48-legal-banner{border:1px solid #dce7dc;background:linear-gradient(135deg,#f7fbf6,#fffaf2);border-radius:18px;padding:14px 16px;color:#46564b;font-size:11px;line-height:1.75;margin:12px 0}
      @media(max-width:900px){.fm48-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.fm48-grid-3{grid-template-columns:1fr 1fr}}
      @media(max-width:640px){.fm48-grid,.fm48-grid-3{grid-template-columns:1fr}.fm48-card{border-radius:18px;padding:16px}.fm48-actions>*{flex:1 1 140px}.fm48-kpi b{font-size:17px}}
    `;
    document.head.append(node);
  }

  function levelBadge(level) {
    const value = String(level || "NORMAL").toUpperCase();
    const cls = ["HOLD","BLOCKED"].includes(value) ? "danger" : ["WATCH","REVIEW"].includes(value) ? "warn" : "";
    return `<span class="fm48-badge ${cls}">${esc(value)}</span>`;
  }

  function buyerPanel() {
    const view = $("view-mypage");
    if (!view || $("fm48-buyer-protection")) return;
    const card = document.createElement("section");
    card.id = "fm48-buyer-protection";
    card.className = "fm48-card";
    card.innerHTML = `<details><summary style="cursor:pointer;font-size:16px;font-weight:900;color:#114214">안전거래·부정판매 신고·이의제기</summary>
      <p class="fm48-note">판매자의 허위정보·미출고·원산지 불일치·반복 품질문제를 신고할 수 있습니다. 신고만으로 판매자를 제재하지 않고 주문·배송·상품 스냅샷과 양측 증거를 확인합니다.</p>
      <div class="fm48-actions"><button class="fm48-btn secondary" id="fm48-buyer-refresh">내 보호상태</button></div><div id="fm48-buyer-status" class="fm48-list"></div>
      <h4 style="margin-top:18px">판매자 부정행위 신고</h4><div class="fm48-grid-3" style="margin-top:10px"><label class="fm48-field">판매자 ID<input id="fm48-report-seller"></label><label class="fm48-field">주문 ID<input id="fm48-report-order"></label><label class="fm48-field">유형<select id="fm48-report-type"><option>SELLER_MISCONDUCT</option><option>DELIVERY_DISPUTE</option><option>COLLUSION</option><option>OTHER</option></select></label><label class="fm48-field" style="grid-column:1/-1">구체적 사실<textarea id="fm48-report-summary" placeholder="언제, 어떤 상품·주문에서, 무엇이 달랐는지 객관적으로 작성"></textarea></label></div><div class="fm48-actions"><button class="fm48-btn warn" id="fm48-report-submit">신고 접수</button></div>
      <h4 style="margin-top:18px">제한조치 이의제기</h4><div class="fm48-grid"><label class="fm48-field">심사 사건 ID<input id="fm48-appeal-case"></label><label class="fm48-field">이의제기 사유<textarea id="fm48-appeal-reason" placeholder="오탐 근거와 확인 가능한 사실을 작성"></textarea></label></div><div class="fm48-actions"><button class="fm48-btn" id="fm48-appeal-submit">재심 요청</button></div>
      <p class="fm48-note warn">배송완료 직후 상품 전체·포장·송장·문제부위를 촬영하면 신선식품 분쟁을 빠르게 확인할 수 있습니다. 다만 과도한 증빙요구로 법정 권리를 제한하지 않습니다.</p></details>`;
    view.append(card);

    async function refresh() {
      const data = await request("GET", "/api/mypage/trust-protection");
      const profile = data.profile || {};
      const cases = data.cases || [];
      $("fm48-buyer-status").innerHTML = `<div class="fm48-row"><b>현재 보호상태</b><br>${levelBadge(profile.risk_level)} · 점수 ${esc(profile.risk_score || 0)}<br><small>점수만으로 최종 제한하지 않으며, 최종 불이익은 수동심사 후 사유와 이의제기 방법을 통지합니다.</small></div>` + (cases.length ? cases.map((x) => `<div class="fm48-row"><b>${esc(x.case_number)} · ${esc(x.case_type)}</b><br>${levelBadge(x.status)}<br><small>${esc(x.summary)} · 이의제기 기한 ${esc(x.appeal_deadline || "결정 후 안내")}</small></div>`).join("") : `<div class="fm48-row">진행 중인 안전거래 심사가 없습니다.</div>`);
    }
    $("fm48-buyer-refresh").onclick = (e) => safe(e.currentTarget, refresh).catch(() => {});
    $("fm48-report-submit").onclick = (e) => safe(e.currentTarget, async () => {
      await request("POST", "/api/mypage/trust-reports", { sellerId: $("fm48-report-seller").value.trim(), orderId: $("fm48-report-order").value.trim() || null, caseType: $("fm48-report-type").value, summary: $("fm48-report-summary").value, evidence: [] });
      await refresh();
    }, "판매자 부정행위 신고를 접수했습니다.").catch(() => {});
    $("fm48-appeal-submit").onclick = (e) => safe(e.currentTarget, async () => {
      await request("POST", "/api/mypage/trust-appeals", { caseId: $("fm48-appeal-case").value.trim(), reason: $("fm48-appeal-reason").value, evidence: [] });
      await refresh();
    }, "이의제기를 접수했습니다.").catch(() => {});
  }

  function sellerPanel() {
    const view = $("view-seller");
    if (!view || $("fm48-seller-protection")) return;
    const card = document.createElement("section");
    card.id = "fm48-seller-protection";
    card.className = "fm48-card";
    card.innerHTML = `<details><summary style="cursor:pointer;font-size:16px;font-weight:900;color:#114214">판매자 피해보호·악성환불 대응센터</summary>
      <p class="fm48-note">반복 허위 미수령, 빈 상자·상품 바꿔치기, 환불 후 차지백, 다계정 쿠폰 악용 등을 객관적 증거와 함께 접수합니다. 소비자의 적법한 청약철회·하자권리는 제한하지 않습니다.</p>
      <div class="fm48-actions"><button class="fm48-btn secondary" id="fm48-seller-refresh">내 보호상태</button></div><div id="fm48-seller-status" class="fm48-list"></div>
      <h4 style="margin-top:18px">구매자 부정행위 신고</h4><div class="fm48-grid-3" style="margin-top:10px"><label class="fm48-field">구매자 ID<input id="fm48-report-buyer"></label><label class="fm48-field">주문 ID<input id="fm48-seller-order"></label><label class="fm48-field">클레임 ID<input id="fm48-seller-claim"></label><label class="fm48-field">유형<select id="fm48-buyer-abuse-type"><option>BUYER_ABUSE</option><option>REFUND_ABUSE</option><option>COUPON_ABUSE</option><option>DELIVERY_DISPUTE</option><option>OTHER</option></select></label><label class="fm48-field" style="grid-column:1/-1">구체적 사실<textarea id="fm48-buyer-abuse-summary"></textarea></label></div><div class="fm48-actions"><button class="fm48-btn warn" id="fm48-buyer-abuse-submit">보호심사 요청</button></div>
      <h4 style="margin-top:18px">반품 검수기록</h4><div class="fm48-grid-3" style="margin-top:10px"><label class="fm48-field">클레임 ID<input id="fm48-inspect-claim"></label><label class="fm48-field">수령중량(g)<input id="fm48-inspect-weight" type="number" min="0"></label><label class="fm48-field">예상중량(g)<input id="fm48-inspect-expected" type="number" min="0"></label><label class="fm48-field">상품 일치<select id="fm48-inspect-match"><option>UNDETERMINED</option><option>MATCH</option><option>MISMATCH</option><option>PARTIAL</option></select></label><label class="fm48-field">품질상태<select id="fm48-inspect-quality"><option>UNDETERMINED</option><option>SELLABLE</option><option>DAMAGED</option><option>CONSUMED</option><option>SPOILED</option><option>EMPTY_PACKAGE</option><option>WRONG_ITEM</option></select></label><label class="fm48-field">검수판정<select id="fm48-inspect-result"><option>PENDING</option><option>BUYER_FAULT_INDICATOR</option><option>SELLER_FAULT_INDICATOR</option><option>CARRIER_FAULT_INDICATOR</option><option>NO_FAULT</option><option>INCONCLUSIVE</option></select></label><label class="fm48-field" style="grid-column:1/-1">검수 메모<textarea id="fm48-inspect-memo"></textarea></label></div><div class="fm48-actions"><button class="fm48-btn" id="fm48-inspect-submit">검수기록 저장</button></div>
      <p class="fm48-note danger">정산계좌 변경 시 72시간 지급 냉각기간과 재검증이 자동 적용됩니다. 관리자도 근거 없이 지급을 영구 보류할 수 없으며, 사유·기간·이의제기를 기록해야 합니다.</p></details>`;
    view.append(card);
    async function refresh() {
      const data = await request("GET", "/api/seller/trust-protection");
      const profile = data.profile || {};
      const actions = data.activeActions || [];
      $("fm48-seller-status").innerHTML = `<div class="fm48-row"><b>판매자 신뢰·보호상태</b><br>${levelBadge(profile.risk_level)} · 점수 ${esc(profile.risk_score || 0)}<br><small>정산계좌 냉각기간, 지급보류, 상품중지 등 임시조치는 범위와 종료시각을 기록합니다.</small></div>` + (actions.length ? actions.map((x) => `<div class="fm48-row"><b>${esc(x.action_type)}</b><br>${levelBadge(x.status)}<br><small>${esc(x.reason)} · 종료 ${esc(x.ends_at || "관리자 해제 시")}</small></div>`).join("") : `<div class="fm48-row">현재 적용 중인 보호조치가 없습니다.</div>`);
    }
    $("fm48-seller-refresh").onclick = (e) => safe(e.currentTarget, refresh).catch(() => {});
    $("fm48-buyer-abuse-submit").onclick = (e) => safe(e.currentTarget, async () => {
      await request("POST", "/api/seller/trust-reports", { buyerId: $("fm48-report-buyer").value.trim(), orderId: $("fm48-seller-order").value.trim(), claimId: $("fm48-seller-claim").value.trim() || null, caseType: $("fm48-buyer-abuse-type").value, summary: $("fm48-buyer-abuse-summary").value, evidence: [] });
      await refresh();
    }, "구매자 부정행위 보호심사를 접수했습니다.").catch(() => {});
    $("fm48-inspect-submit").onclick = (e) => safe(e.currentTarget, async () => {
      await request("POST", "/api/seller/return-inspections", { claimId: $("fm48-inspect-claim").value.trim(), packageWeightGrams: $("fm48-inspect-weight").value || null, expectedWeightGrams: $("fm48-inspect-expected").value || null, itemMatchStatus: $("fm48-inspect-match").value, qualityStatus: $("fm48-inspect-quality").value, inspectionResult: $("fm48-inspect-result").value, memo: $("fm48-inspect-memo").value, evidence: [], completed: $("fm48-inspect-result").value !== "PENDING" });
    }, "반품 검수기록을 저장했습니다.").catch(() => {});
  }

  function adminPanel() {
    const view = $("view-admin");
    if (!view || $("fm48-admin-protection")) return;
    const card = document.createElement("section");
    card.id = "fm48-admin-protection";
    card.className = "fm48-card";
    card.innerHTML = `<details open><summary style="cursor:pointer;font-size:16px;font-weight:900;color:#114214">상호 부정행위·피해보호 통제센터</summary>
      <p class="fm48-note warn">위험점수는 조사 우선순위를 정하는 신호일 뿐입니다. 최종 환불거절·정산몰수·계정해지는 관리자 수동심사, 구체적 사유, 통지와 이의제기 절차 없이 확정할 수 없습니다.</p>
      <div class="fm48-actions"><button class="fm48-btn" id="fm48-admin-dashboard">통제현황</button><button class="fm48-btn secondary" id="fm48-admin-cases">심사사건</button><button class="fm48-btn secondary" id="fm48-admin-appeals">이의제기</button></div><div id="fm48-admin-kpis" class="fm48-kpis"></div><div id="fm48-admin-list" class="fm48-list"></div>
      <h4 style="margin-top:18px">사건 결정</h4><div class="fm48-grid-3" style="margin-top:10px"><label class="fm48-field">사건 ID<input id="fm48-admin-case-id"></label><label class="fm48-field">결정<select id="fm48-admin-decision"><option>NO_ABUSE</option><option>WARNING</option><option>LIMITED_RESTRICTION</option><option>HOLD_CONTINUE</option><option>SUSPEND</option><option>TERMINATE</option><option>COMPENSATE</option><option>RECOVER_LOSS</option><option>SHARED_RESPONSIBILITY</option></select></label><label class="fm48-field">신호판정<select id="fm48-admin-signal"><option value="">변경 안 함</option><option>CONFIRMED</option><option>DISMISSED</option><option>EXPIRED</option></select></label><label class="fm48-field" style="grid-column:1/-1">구체적 결정사유<textarea id="fm48-admin-reason"></textarea></label><label style="font-size:12px;font-weight:800"><input type="checkbox" id="fm48-admin-final"> 수동심사와 서로 다른 관리자 2인 승인을 거친 최종 계정 제한</label></div><div class="fm48-actions"><button class="fm48-btn danger" id="fm48-admin-resolve">결정 저장</button></div>
      <h4 style="margin-top:18px">임시 보호조치</h4><div class="fm48-grid-3" style="margin-top:10px"><label class="fm48-field">조치<select id="fm48-admin-action"><option>NOTICE</option><option>EVIDENCE_REQUEST</option><option>CHECKOUT_REVIEW</option><option>REFUND_REVIEW</option><option>PAYOUT_HOLD</option><option>ACCOUNT_CHANGE_HOLD</option><option>COUPON_LIMIT</option><option>PRODUCT_STOP</option><option>EXPOSURE_LIMIT</option><option>LOGIN_CHALLENGE</option></select></label><label class="fm48-field">기간(시간)<input id="fm48-admin-hours" type="number" min="1" max="720" value="72"></label><label class="fm48-field" style="grid-column:1/-1">조치사유<textarea id="fm48-admin-action-reason"></textarea></label></div><div class="fm48-actions"><button class="fm48-btn warn" id="fm48-admin-action-submit">임시조치 적용</button></div></details>`;
    view.append(card);

    const list = $("fm48-admin-list");
    async function dashboard() {
      const data = await request("GET", "/api/admin/trust/dashboard");
      const s = data.summary || {};
      const entries = [["진행 사건",s.open_cases],["긴급 사건",s.urgent_cases],["판매자 심사",s.seller_profiles_under_review],["구매자 심사",s.buyer_profiles_under_review],["지급보류",s.active_payout_holds],["환불검토",s.pending_refund_reviews],["이의제기",s.pending_appeals],["기한초과",s.overdue_decisions]];
      $("fm48-admin-kpis").innerHTML = entries.map(([k,v]) => `<div class="fm48-kpi"><span>${esc(k)}</span><b>${esc(v || 0)}</b></div>`).join("");
      list.innerHTML = (data.rules || []).map((r) => `<div class="fm48-row"><b>${esc(r.rule_code)} · ${esc(r.title)}</b><br><span class="fm48-badge ${r.severity === "CRITICAL" ? "danger" : ["HIGH","MEDIUM"].includes(r.severity) ? "warn" : ""}">${esc(r.severity)} / ${esc(r.default_points)}점</span><br><small>${esc(r.description)} · 최종조치 수동심사 ${r.final_action_requires_manual_review ? "필수" : "확인 필요"}</small></div>`).join("");
    }
    async function cases() {
      const data = await request("GET", "/api/admin/trust/cases");
      const rows = data.content || [];
      list.innerHTML = rows.length ? rows.map((x) => `<div class="fm48-row"><b>${esc(x.case_number)} · ${esc(x.case_type)}</b><br>${levelBadge(x.priority)} ${levelBadge(x.status)}<br><small>${esc(x.subject_type)} ${esc(x.subject_id)} · ${esc(x.summary)}<br>처리기한 ${esc(x.decision_due_at)} · 자동최종결정 ${x.automatic_final_decision ? "금지 위반" : "없음"}</small></div>`).join("") : `<div class="fm48-row">진행 사건이 없습니다.</div>`;
    }
    async function appeals() {
      const data = await request("GET", "/api/admin/trust/appeals");
      const rows = data.content || [];
      list.innerHTML = rows.length ? rows.map((x) => `<div class="fm48-row"><b>이의제기 ${esc(x.id)}</b><br>${levelBadge(x.status)}<br><small>${esc(x.appellant_type)} · ${esc(x.reason)} · 사건 ${esc(x.trust_review_cases?.case_number || x.case_id)}</small></div>`).join("") : `<div class="fm48-row">접수된 이의제기가 없습니다.</div>`;
    }
    $("fm48-admin-dashboard").onclick = (e) => safe(e.currentTarget, dashboard).catch(() => {});
    $("fm48-admin-cases").onclick = (e) => safe(e.currentTarget, cases).catch(() => {});
    $("fm48-admin-appeals").onclick = (e) => safe(e.currentTarget, appeals).catch(() => {});
    $("fm48-admin-resolve").onclick = (e) => safe(e.currentTarget, async () => {
      const id = $("fm48-admin-case-id").value.trim();
      await request("POST", `/api/admin/trust/cases/${id}/resolve`, { decision: $("fm48-admin-decision").value, reason: $("fm48-admin-reason").value, signalStatus: $("fm48-admin-signal").value || null, finalAdverseAction: $("fm48-admin-final").checked });
      await cases();
    }, "심사결정을 저장했습니다.").catch(() => {});
    $("fm48-admin-action-submit").onclick = (e) => safe(e.currentTarget, async () => {
      const id = $("fm48-admin-case-id").value.trim();
      await request("POST", `/api/admin/trust/cases/${id}/actions`, { actionType: $("fm48-admin-action").value, hours: $("fm48-admin-hours").value, reason: $("fm48-admin-action-reason").value, temporary: true });
      await cases();
    }, "임시 보호조치를 적용했습니다.").catch(() => {});
  }

  function legalBanner() {
    const targets = [$("view-checkout"), $("view-claims")].filter(Boolean);
    targets.forEach((target) => {
      if (target.querySelector(".fm48-legal-banner")) return;
      const node = document.createElement("div");
      node.className = "fm48-legal-banner";
      node.innerHTML = `<strong style="color:#114214">공정한 피해보호 원칙</strong><br>판매자와 구매자 어느 한쪽의 주장만으로 환불·정산·계정을 최종 제한하지 않습니다. 주문시점 상품·판매자·가격 스냅샷, 택배사 기록, 사진·중량·반품검수, 결제·환불 이력을 함께 확인하며 긴급 임시조치는 사유와 종료시각을 기록합니다.`;
      target.prepend(node);
    });
  }

  function audit() {
    global.FRUITMARKET_PART48_PROTECTION_AUDIT = {
      version: VERSION,
      buyerPanel: Boolean($("fm48-buyer-protection")),
      sellerPanel: Boolean($("fm48-seller-protection")),
      adminPanel: Boolean($("fm48-admin-protection")),
      duplicateIds: [...document.querySelectorAll("[id]")].map((n) => n.id).filter((id, i, a) => a.indexOf(id) !== i),
      overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      checkedAt: new Date().toISOString(),
    };
    document.documentElement.dataset.fruitmarketPart48 = "ready";
  }

  let scheduled = false;
  function install() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      style(); buyerPanel(); sellerPanel(); adminPanel(); legalBanner(); audit();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true }); else install();
  new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: true });
  global.addEventListener("hashchange", () => setTimeout(install, 50));
  global.addEventListener("fruitmarket:auth", () => setTimeout(install, 50));
})(window);
