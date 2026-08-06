(function (global) {
  "use strict";
  const VERSION = "46.0.0";
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const unwrap = (result) => result && Object.prototype.hasOwnProperty.call(result, "data") ? result.data : result;
  const api = () => global.FruitMarketApi;
  const toast = (message) => global.app?.showToast?.(String(message)) || global.alert(String(message));
  const pending = new WeakMap();

  async function request(method, path, body) {
    if (!api()) throw new Error("서버 연결 설정이 필요합니다.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const fn = api()[method.toLowerCase()] || api().request;
      const result = fn === api().request
        ? await fn(path, { method, body, signal: controller.signal })
        : await fn(path, body, { signal: controller.signal });
      return unwrap(result);
    } finally { clearTimeout(timer); }
  }

  async function safeAction(button, task, options = {}) {
    if (!button || pending.has(button)) return;
    const original = button.innerHTML;
    const previousDisabled = button.disabled;
    const label = options.pendingLabel || "처리 중…";
    pending.set(button, true); button.disabled = true; button.setAttribute("aria-busy", "true"); button.innerHTML = esc(label);
    try {
      const value = await task();
      if (options.successMessage) toast(options.successMessage);
      return value;
    } catch (error) {
      console.error("FruitMarket Part46 action", error);
      toast(error?.message || "요청 처리 중 오류가 발생했습니다.");
      throw error;
    } finally {
      pending.delete(button); button.disabled = previousDisabled; button.removeAttribute("aria-busy"); button.innerHTML = original;
    }
  }
  global.FruitMarketSafeAction = Object.freeze({ run: safeAction, version: VERSION });

  function injectStyle() {
    if ($("fm46-style")) return;
    const style = document.createElement("style"); style.id = "fm46-style";
    style.textContent = `
      .fm46-card{min-width:0;border:1px solid #e3e9e3;border-radius:22px;background:#fff;padding:clamp(16px,2.2vw,24px);box-shadow:0 10px 30px rgba(17,66,20,.055)}
      .fm46-card h3,.fm46-card h4{margin:0;color:#114214;font-weight:900;letter-spacing:-.02em}.fm46-card p{overflow-wrap:anywhere}
      .fm46-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.fm46-grid-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
      .fm46-field{display:grid;gap:6px;min-width:0;font-size:12px;font-weight:800;color:#34463a}.fm46-field input,.fm46-field select,.fm46-field textarea{box-sizing:border-box;width:100%;min-width:0;border:1px solid #ced8cf;border-radius:12px;background:#fff;padding:11px 12px;font:inherit;color:#15251a}.fm46-field textarea{min-height:92px;resize:vertical}
      .fm46-btn{display:inline-flex;align-items:center;justify-content:center;min-height:42px;border:0;border-radius:12px;padding:10px 15px;background:#114214;color:#fff;font-size:12px;font-weight:900;cursor:pointer}.fm46-btn.secondary{border:1px solid #ccd6cd;background:#fff;color:#114214}.fm46-btn.warn{background:#a64608}.fm46-btn:disabled{cursor:not-allowed;opacity:.55}
      .fm46-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.fm46-note{margin-top:10px;border-radius:12px;background:#f4f7f3;padding:10px 12px;color:#526158;font-size:11px;line-height:1.65}.fm46-warn{background:#fff7ed;color:#9a3412}.fm46-danger{background:#fef2f2;color:#991b1b}
      .fm46-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.fm46-kpi{min-width:0;border-radius:14px;background:#f5f8f4;padding:12px}.fm46-kpi span{display:block;color:#617166;font-size:10px;font-weight:800}.fm46-kpi b{display:block;margin-top:4px;color:#114214;font-size:20px;overflow-wrap:anywhere}
      .fm46-list{display:grid;gap:9px;margin-top:14px}.fm46-row{min-width:0;border:1px solid #e7ece7;border-radius:14px;padding:12px;font-size:12px;line-height:1.6}.fm46-row b{overflow-wrap:anywhere}.fm46-badge{display:inline-flex;border-radius:999px;padding:3px 8px;background:#edf6ed;color:#114214;font-size:10px;font-weight:900}.fm46-badge.warn{background:#fff7ed;color:#9a3412}.fm46-badge.danger{background:#fef2f2;color:#991b1b}
      #fm46-platform-footer{margin-top:28px;border-top:1px solid #e6ebe6;padding:18px 16px 22px;color:#59675e;font-size:11px;line-height:1.75;text-align:center}#fm46-platform-footer strong{color:#114214}
      #fm46-checkout-notice{border:1px solid #f1d2b7;background:#fff8f1}.fm46-table-wrap{max-width:100%;overflow:auto;-webkit-overflow-scrolling:touch}.fm46-table{width:100%;min-width:720px;border-collapse:collapse;font-size:11px}.fm46-table th,.fm46-table td{border-bottom:1px solid #e5ebe5;padding:10px;text-align:left;vertical-align:top}
      @media(max-width:900px){.fm46-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.fm46-grid-3{grid-template-columns:1fr 1fr}}
      @media(max-width:640px){.fm46-grid,.fm46-grid-3{grid-template-columns:1fr}.fm46-card{border-radius:18px;padding:16px}.fm46-actions>*{flex:1 1 140px}.fm46-kpi b{font-size:17px}}
      @media(prefers-reduced-motion:reduce){.fm46-btn{transition:none!important}}
    `;
    document.head.append(style);
  }

  function currentProduct() {
    return global.app?.state?.currentProduct
      || (global.liveState?.products || []).find((p) => Number(p.id) === Number(global.app?.state?.currentDetailId || global.app?.state?.currentProductId));
  }
  function backendId(value) { return global.FruitMarketIds?.toBackend?.(value) || value; }
  function fmtDate(value) { return value ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" }).format(new Date(value)) : "미입력"; }

  async function renderFreshDetail() {
    const view = $("view-detail"); const product = currentProduct();
    if (!view || !product) return;
    const host = $("detail-action-buttons")?.parentElement || view;
    let card = $("fm46-fresh-detail"); if (!card) { card = document.createElement("section"); card.id = "fm46-fresh-detail"; card.className = "fm46-card mt-5"; host.append(card); }
    const productId = backendId(product.id);
    if (!productId || String(card.dataset.productId) === String(productId)) return;
    card.dataset.productId = String(productId);
    card.innerHTML = `<h3>산지·신선도·판매자 확인</h3><p class="fm46-note">검증된 원산지·수확·보관·로트 정보만 표시합니다. 로트별 상태는 주문 시점에 다시 확인됩니다.</p><div class="fm46-list"><div class="fm46-row">정보를 불러오는 중입니다.</div></div>`;
    try {
      const data = await request("GET", `/api/public/products/${productId}/traceability`);
      const freshRaw = data?.product?.product_fresh_profiles; const fresh = Array.isArray(freshRaw) ? freshRaw[0] : freshRaw;
      const seller = data?.product?.sellers || {};
      const lots = data?.availableLots || []; const evidence = data?.verifiedEvidence || [];
      card.innerHTML = `<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start"><div><h3>산지·신선도·판매자 확인</h3><p style="margin-top:5px;font-size:11px;color:#65736a">주문 전 표시정보와 실제 출고 로트를 비교할 수 있습니다.</p></div><span class="fm46-badge ${fresh?.compliance_status === "APPROVED" ? "" : "warn"}">${esc(fresh?.compliance_status || "확인 필요")}</span></div>
        <div class="fm46-grid-3" style="margin-top:14px">
          <div class="fm46-row"><b>품종·산지</b><br>${esc(fresh?.fruit_type || product.name || "-")} · ${esc(fresh?.variety || "-")}<br>${esc(fresh?.production_region || data?.product?.origin || "-")}</div>
          <div class="fm46-row"><b>수확·포장·섭취 권장</b><br>${fmtDate(fresh?.harvest_date)} / ${fmtDate(fresh?.packing_date)}<br>${fmtDate(fresh?.recommended_consume_by)}</div>
          <div class="fm46-row"><b>보관·후숙</b><br>${esc(fresh?.storage_method || "판매자 확인 필요")}<br>${esc(fresh?.ripening_guide || "-")}</div>
          <div class="fm46-row"><b>당도 표시 기준</b><br>${esc(fresh?.sweetness_claim_type || "NONE")} ${fresh?.brix_min != null ? `· 최소 ${esc(fresh.brix_min)} Brix` : ""}<br>${esc(fresh?.brix_measurement_method || "측정방법 미표시")}</div>
          <div class="fm46-row"><b>판매자</b><br>${esc(seller.store_name || seller.legal_name || "-")}<br>사업자·통신판매 정보는 주문 전 확인</div>
          <div class="fm46-row"><b>품질증빙·출고가능 로트</b><br>검증 증빙 ${evidence.length}건 · 로트 ${lots.length}건<br>${lots[0] ? `최근 권장기한 ${fmtDate(lots[0].recommended_consume_by)}` : "출고 시 재확인"}</div>
        </div><p class="fm46-note fm46-warn">과일은 자연산물 특성상 크기·색·당도에 편차가 있을 수 있습니다. 수치·등급·인증 표현은 등록 증빙과 관리자 검토가 완료된 경우에만 공개됩니다.</p>`;
    } catch (error) {
      card.innerHTML = `<h3>산지·신선도·판매자 확인</h3><p class="fm46-note fm46-warn">${esc(error.message || "신선정보를 불러오지 못했습니다.")} 주문 전 판매자·원산지·반품기준을 다시 확인해 주세요.</p>`;
    }
  }

  function sellerPanel() {
    const view = $("view-seller"); if (!view || $("fm46-seller-fresh-center")) return;
    const card = document.createElement("section"); card.id = "fm46-seller-fresh-center"; card.className = "fm46-card";
    card.innerHTML = `<details open><summary style="cursor:pointer;font-weight:900;color:#114214;font-size:16px">과일 상품 신선정보·로트 재고센터</summary>
      <p class="fm46-note">상품별 품종·산지·수확일·보관법·당도표시 근거를 등록하고, 유통기한이 빠른 로트부터 출고되도록 관리합니다.</p>
      <div class="fm46-row" style="margin-top:12px"><div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px;align-items:center"><div><b>판매자 계약·정산조건</b><br><small id="fm46-contract-status">활성 계약과 수수료·정산조건을 확인해 주세요.</small></div><div class="fm46-actions" style="margin-top:0"><button class="fm46-btn secondary" id="fm46-load-contract" data-fm46-safe>계약 확인</button><button class="fm46-btn" id="fm46-accept-contract" data-fm46-safe disabled>계약 동의</button></div></div><div id="fm46-contract-body" class="fm46-note" hidden></div></div>
      <div class="fm46-grid" style="margin-top:14px">
        <label class="fm46-field">상품 ID<input id="fm46-fp-product" placeholder="상품 UUID 또는 화면 상품 ID"></label>
        <label class="fm46-field">과일 종류<input id="fm46-fp-type" placeholder="예: 사과"></label>
        <label class="fm46-field">품종<input id="fm46-fp-variety" placeholder="예: 홍로"></label>
        <label class="fm46-field">농장명<input id="fm46-fp-farm" placeholder="실제 생산 농장"></label>
        <label class="fm46-field">생산자명<input id="fm46-fp-producer" placeholder="실제 생산자"></label>
        <label class="fm46-field">생산지역<input id="fm46-fp-region" placeholder="시·군 단위"></label>
        <label class="fm46-field">순중량(g)<input id="fm46-fp-weight" type="number" min="1"></label>
        <label class="fm46-field">수확일<input id="fm46-fp-harvest" type="date"></label>
        <label class="fm46-field">포장일<input id="fm46-fp-packing" type="date"></label>
        <label class="fm46-field">섭취 권장기한<input id="fm46-fp-consume" type="date"></label>
        <label class="fm46-field">후숙상태<select id="fm46-fp-ripeness"><option value="">선택</option><option>FIRM</option><option>READY_SOON</option><option>READY_TO_EAT</option><option>SOFT</option></select></label>
        <label class="fm46-field">보관방법<input id="fm46-fp-storage" placeholder="냉장 0~5℃ 등"></label>
        <label class="fm46-field">당도표시<select id="fm46-fp-sweet"><option>NONE</option><option>SAMPLE</option><option>LOT_MEASURED</option><option>GUARANTEED_MINIMUM</option></select></label>
        <label class="fm46-field">최소 Brix<input id="fm46-fp-brix" type="number" step="0.1" min="0"></label>
        <label class="fm46-field" style="grid-column:1/-1">당도 측정·표시 근거<textarea id="fm46-fp-method" placeholder="표본 수, 측정도구, 측정부위, 측정일 등을 적어주세요."></textarea></label>
      </div><div class="fm46-actions"><button class="fm46-btn" id="fm46-save-fresh" data-fm46-safe>신선정보 저장·재심사 요청</button><button class="fm46-btn secondary" id="fm46-load-fresh" data-fm46-safe>기존정보 불러오기</button></div>
      <hr style="margin:20px 0;border:0;border-top:1px solid #e7ece7"><h4>로트 재고 등록</h4>
      <div class="fm46-grid-3" style="margin-top:12px"><label class="fm46-field">상품 ID<input id="fm46-lot-product"></label><label class="fm46-field">옵션 ID<input id="fm46-lot-option" placeholder="선택사항"></label><label class="fm46-field">로트번호<input id="fm46-lot-code"></label><label class="fm46-field">입고수량<input id="fm46-lot-qty" type="number" min="0"></label><label class="fm46-field">수확일<input id="fm46-lot-harvest" type="date"></label><label class="fm46-field">포장일<input id="fm46-lot-packing" type="date"></label><label class="fm46-field">섭취 권장기한<input id="fm46-lot-consume" type="date"></label><label class="fm46-field">검수상태<select id="fm46-lot-qc"><option>PENDING</option><option>PASSED</option><option>CONDITIONAL</option><option>FAILED</option><option>BLOCKED</option></select></label><label class="fm46-field">표본 Brix<input id="fm46-lot-brix" type="number" step="0.1"></label></div>
      <div class="fm46-actions"><button class="fm46-btn" id="fm46-create-lot" data-fm46-safe>로트 등록</button><button class="fm46-btn secondary" id="fm46-refresh-lots" data-fm46-safe>로트 목록 새로고침</button></div><div id="fm46-lot-list" class="fm46-list"></div></details>`;
    view.append(card);

    let currentContract = null;
    async function loadContract() {
      const data = await request("GET", "/api/seller/contracts/current"); currentContract = data?.contract || null;
      $("fm46-contract-status").textContent = currentContract ? `${currentContract.version} · ${data.accepted ? "동의 완료" : "동의 필요"}` : "법률검토·승인된 활성 계약이 없습니다.";
      $("fm46-contract-body").hidden = !currentContract; $("fm46-contract-body").textContent = currentContract ? `${currentContract.title}\n\n${currentContract.body}` : "";
      $("fm46-accept-contract").disabled = !currentContract || Boolean(data.accepted);
    }
    $("fm46-load-contract").onclick = (event) => safeAction(event.currentTarget, loadContract).catch(() => {});
    $("fm46-accept-contract").onclick = (event) => safeAction(event.currentTarget, async () => {
      if (!currentContract) await loadContract(); if (!currentContract) throw new Error("동의할 활성 계약이 없습니다.");
      await request("POST", "/api/seller/contracts/accept", { version: currentContract.version, evidence: { acceptedFrom: "SELLER_UI", acceptedAt: new Date().toISOString() } }); await loadContract();
    }, { successMessage: "판매자 계약에 동의했습니다." }).catch(() => {});

    $("fm46-save-fresh").onclick = (event) => safeAction(event.currentTarget, async () => {
      const productId = backendId($("fm46-fp-product").value.trim());
      await request("PUT", `/api/seller/products/${productId}/fresh-profile`, {
        fruitType: $("fm46-fp-type").value, variety: $("fm46-fp-variety").value, farmName: $("fm46-fp-farm").value,
        producerName: $("fm46-fp-producer").value, productionRegion: $("fm46-fp-region").value,
        netWeightGrams: $("fm46-fp-weight").value || null, harvestDate: $("fm46-fp-harvest").value || null,
        packingDate: $("fm46-fp-packing").value || null, recommendedConsumeBy: $("fm46-fp-consume").value || null,
        ripenessStage: $("fm46-fp-ripeness").value || null, storageMethod: $("fm46-fp-storage").value,
        sweetnessClaimType: $("fm46-fp-sweet").value, brixMin: $("fm46-fp-brix").value || null,
        brixMeasurementMethod: $("fm46-fp-method").value, brixEvidenceRequired: $("fm46-fp-sweet").value !== "NONE",
        reason: "판매자 신선정보 수정",
      });
    }, { successMessage: "신선정보를 저장하고 재심사를 요청했습니다." }).catch(() => {});

    $("fm46-load-fresh").onclick = (event) => safeAction(event.currentTarget, async () => {
      const productId = backendId($("fm46-fp-product").value.trim()); const data = await request("GET", `/api/seller/products/${productId}/fresh-profile`); if (!data) return;
      const map = { "fm46-fp-type": "fruitType", "fm46-fp-variety": "variety", "fm46-fp-farm": "farmName", "fm46-fp-producer": "producerName", "fm46-fp-region": "productionRegion", "fm46-fp-weight": "netWeightGrams", "fm46-fp-harvest": "harvestDate", "fm46-fp-packing": "packingDate", "fm46-fp-consume": "recommendedConsumeBy", "fm46-fp-ripeness": "ripenessStage", "fm46-fp-storage": "storageMethod", "fm46-fp-sweet": "sweetnessClaimType", "fm46-fp-brix": "brixMin", "fm46-fp-method": "brixMeasurementMethod" };
      for (const [id, key] of Object.entries(map)) if ($(id)) $(id).value = data[key] ?? "";
    }, { successMessage: "기존 신선정보를 불러왔습니다." }).catch(() => {});

    async function refreshLots() {
      const data = await request("GET", "/api/seller/inventory/lots?size=300"); const rows = data?.content || data || [];
      $("fm46-lot-list").innerHTML = rows.length ? rows.map((x) => `<div class="fm46-row"><div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(x.products?.name || x.productId || "상품")}</b><span class="fm46-badge ${["FAILED","BLOCKED"].includes(x.qcStatus) ? "danger" : x.qcStatus === "PENDING" ? "warn" : ""}">${esc(x.qcStatus)}</span></div><div>${esc(x.lotCode)} · 가용 ${esc(x.availableQuantity)} / 예약 ${esc(x.reservedQuantity)}</div><small>수확 ${fmtDate(x.harvestDate)} · 권장 ${fmtDate(x.recommendedConsumeBy)} · 리콜 ${esc(x.recallStatus)}</small></div>`).join("") : `<div class="fm46-row">등록된 로트가 없습니다.</div>`;
    }
    $("fm46-refresh-lots").onclick = (event) => safeAction(event.currentTarget, refreshLots).catch(() => {});
    $("fm46-create-lot").onclick = (event) => safeAction(event.currentTarget, async () => {
      await request("POST", "/api/seller/inventory/lots", { productId: backendId($("fm46-lot-product").value.trim()), optionId: $("fm46-lot-option").value ? backendId($("fm46-lot-option").value.trim()) : null, lotCode: $("fm46-lot-code").value, quantity: $("fm46-lot-qty").value, harvestDate: $("fm46-lot-harvest").value || null, packingDate: $("fm46-lot-packing").value || null, recommendedConsumeBy: $("fm46-lot-consume").value || null, qcStatus: $("fm46-lot-qc").value, brixSample: $("fm46-lot-brix").value || null });
      await refreshLots();
    }, { successMessage: "로트 재고를 등록했습니다." }).catch(() => {});
  }

  function buyerDisputePanel() {
    const view = $("view-mypage"); if (!view || $("fm46-buyer-disputes")) return;
    const card = document.createElement("section"); card.id = "fm46-buyer-disputes"; card.className = "fm46-card";
    card.innerHTML = `<details><summary style="cursor:pointer;font-size:16px;font-weight:900;color:#114214">플랫폼 분쟁조정·처리기한 확인</summary><p class="fm46-note">판매자 문의로 해결되지 않은 배송·품질·수량·표시·결제·환불 문제를 플랫폼에 접수합니다. 진행상황과 처리기한을 기록으로 남깁니다.</p><div class="fm46-grid" style="margin-top:12px"><label class="fm46-field">주문 ID<input id="fm46-dsp-order"></label><label class="fm46-field">주문상품 ID<input id="fm46-dsp-item"></label><label class="fm46-field">유형<select id="fm46-dsp-type"><option>QUALITY</option><option>DELIVERY</option><option>QUANTITY</option><option>MISDESCRIPTION</option><option>PAYMENT</option><option>REFUND</option><option>OTHER</option></select></label><label class="fm46-field">제목<input id="fm46-dsp-title"></label><label class="fm46-field" style="grid-column:1/-1">상세내용<textarea id="fm46-dsp-description"></textarea></label></div><div class="fm46-actions"><button class="fm46-btn" id="fm46-open-dispute" data-fm46-safe>분쟁 접수</button><button class="fm46-btn secondary" id="fm46-refresh-disputes" data-fm46-safe>진행상황 새로고침</button></div><div id="fm46-buyer-dispute-list" class="fm46-list"></div></details>`;
    view.append(card);
    async function refresh() { const data = await request("GET", "/api/mypage/disputes"); const rows = data?.content || data || []; $("fm46-buyer-dispute-list").innerHTML = rows.length ? rows.map((x) => `<div class="fm46-row"><b>${esc(x.caseNumber)} · ${esc(x.title)}</b><br><span class="fm46-badge ${["RECEIVED","INVESTIGATING"].includes(x.status) ? "warn" : ""}">${esc(x.status)}</span><small style="display:block;margin-top:6px">1차 안내기한 ${fmtDate(x.firstResponseDueAt)} · 처리방안 기한 ${fmtDate(x.resolutionDueAt)}</small></div>`).join("") : `<div class="fm46-row">접수된 분쟁이 없습니다.</div>`; }
    $("fm46-refresh-disputes").onclick = (e) => safeAction(e.currentTarget, refresh).catch(() => {});
    $("fm46-open-dispute").onclick = (e) => safeAction(e.currentTarget, async () => { await request("POST", "/api/mypage/disputes", { orderId: backendId($("fm46-dsp-order").value.trim()), orderItemId: backendId($("fm46-dsp-item").value.trim()), caseType: $("fm46-dsp-type").value, title: $("fm46-dsp-title").value, description: $("fm46-dsp-description").value, evidence: [] }); await refresh(); }, { successMessage: "분쟁조정 건을 접수했습니다." }).catch(() => {});
  }

  function adminPanel() {
    const view = $("view-admin"); if (!view || $("fm46-admin-marketplace-center")) return;
    const card = document.createElement("section"); card.id = "fm46-admin-marketplace-center"; card.className = "fm46-card";
    card.innerHTML = `<details open><summary style="cursor:pointer;font-size:16px;font-weight:900;color:#114214">오픈마켓 법적·품질·정산 통제센터</summary><p class="fm46-note fm46-warn">운영 준비 게이트가 모두 VERIFIED가 되기 전에는 결제·정산 라이브 전환을 금지합니다. 법률 문구는 변호사 검토 상태 APPROVED에서만 공개됩니다.</p><div class="fm46-actions"><button class="fm46-btn" id="fm46-admin-refresh" data-fm46-safe>통제현황 새로고침</button><button class="fm46-btn secondary" id="fm46-admin-disputes" data-fm46-safe>분쟁 목록</button><button class="fm46-btn secondary" id="fm46-admin-recalls" data-fm46-safe>리콜 목록</button></div><div id="fm46-admin-kpis" class="fm46-kpis" style="margin-top:14px"></div><div id="fm46-admin-list" class="fm46-list"></div>
      <hr style="margin:20px 0;border:0;border-top:1px solid #e7ece7"><h4>리콜 로트 즉시 차단</h4><div class="fm46-grid-3" style="margin-top:12px"><label class="fm46-field">리콜 제목<input id="fm46-recall-title"></label><label class="fm46-field">심각도<select id="fm46-recall-severity"><option>NOTICE</option><option>VOLUNTARY</option><option>URGENT</option><option>CRITICAL</option></select></label><label class="fm46-field">판매자 ID<input id="fm46-recall-seller" placeholder="선택사항"></label><label class="fm46-field" style="grid-column:1/-1">사유<textarea id="fm46-recall-reason"></textarea></label></div><div class="fm46-actions"><button class="fm46-btn warn" id="fm46-open-recall" data-fm46-safe>리콜 생성</button></div></details>`;
    view.append(card);
    const list = $("fm46-admin-list");
    async function refreshDashboard() { const data = await request("GET", "/api/admin/marketplace/compliance-dashboard"); const s = data?.summary || {}; const gates = data?.gates || []; $("fm46-admin-kpis").innerHTML = [["라이브 게이트 미통과",s.liveGateFailures],["상품 법정정보 미완료",s.productsComplianceIncomplete],["차단·미검수 로트",s.blockedOrUnverifiedLots],["기한초과 분쟁",Number(s.overdueFirstResponses||0)+Number(s.overdueResolutions||0)]].map(([k,v])=>`<div class="fm46-kpi"><span>${esc(k)}</span><b>${esc(v ?? 0)}</b></div>`).join(""); list.innerHTML = gates.map((g)=>`<div class="fm46-row"><div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(g.controlKey)}</b><span class="fm46-badge ${g.status === "VERIFIED" ? "" : "danger"}">${esc(g.status)}</span></div><small>${esc(g.category)} · ${esc(g.notes || "증빙 필요")}</small></div>`).join("") || `<div class="fm46-row">운영 게이트가 없습니다.</div>`; }
    async function loadDisputes() { const data = await request("GET", "/api/admin/disputes"); const rows=data?.content||data||[]; list.innerHTML=rows.map((x)=>`<div class="fm46-row"><b>${esc(x.caseNumber)} · ${esc(x.title)}</b><br><span class="fm46-badge ${x.priority === "CRITICAL" ? "danger" : x.priority === "HIGH" ? "warn" : ""}">${esc(x.status)} / ${esc(x.priority)}</span><small style="display:block">판매자 ${esc(x.sellers?.storeName||x.sellerId||"-")} · 처리기한 ${fmtDate(x.resolutionDueAt)}</small></div>`).join("")||`<div class="fm46-row">분쟁이 없습니다.</div>`; }
    async function loadRecalls() { const data=await request("GET","/api/admin/recalls"); const rows=data?.content||data||[]; list.innerHTML=rows.map((x)=>`<div class="fm46-row"><b>${esc(x.recallNumber)} · ${esc(x.title)}</b><br><span class="fm46-badge ${["URGENT","CRITICAL"].includes(x.severity)?"danger":"warn"}">${esc(x.status)} / ${esc(x.severity)}</span><small style="display:block">영향 로트 ${x.recallLots?.length||0}건 · 통지 ${x.recallNotifications?.length||0}건</small></div>`).join("")||`<div class="fm46-row">진행 중인 리콜이 없습니다.</div>`; }
    $("fm46-admin-refresh").onclick=(e)=>safeAction(e.currentTarget,refreshDashboard).catch(()=>{}); $("fm46-admin-disputes").onclick=(e)=>safeAction(e.currentTarget,loadDisputes).catch(()=>{}); $("fm46-admin-recalls").onclick=(e)=>safeAction(e.currentTarget,loadRecalls).catch(()=>{});
    $("fm46-open-recall").onclick=(e)=>safeAction(e.currentTarget,async()=>{await request("POST","/api/admin/recalls",{title:$("fm46-recall-title").value,severity:$("fm46-recall-severity").value,sellerId:$("fm46-recall-seller").value?backendId($("fm46-recall-seller").value.trim()):null,reason:$("fm46-recall-reason").value});await loadRecalls();},{successMessage:"리콜 건을 생성했습니다. 영향 로트를 연결해 즉시 차단하세요."}).catch(()=>{});
  }

  function legalNotices() {
    const checkout = $("view-checkout"); if (checkout && !$("fm46-checkout-notice")) { const box=document.createElement("section");box.id="fm46-checkout-notice";box.className="fm46-card";box.innerHTML=`<h3>판매자·결제·신선식품 확인</h3><ul style="margin:10px 0 0;padding-left:18px;font-size:11px;line-height:1.8;color:#5d6a61"><li>각 상품의 판매자는 상품 상세에 표시된 입점 판매자이며, 푸릇마켓은 거래 중개와 분쟁 접수·조치를 담당합니다.</li><li>주문 전 판매자 정보, 원산지, 중량·등급, 배송비, 교환·환불 기준과 결제금액을 확인해야 합니다.</li><li>결제와 환불은 계약된 PG·구매안전 절차로만 처리하며 개인계좌 송금을 요구하지 않습니다.</li></ul><p class="fm46-note fm46-warn">신선식품의 청약철회 제한은 상품 특성과 사전 고지 요건을 충족하는 범위에서만 적용되며, 오배송·하자·표시와 다른 품질은 별도 심사 대상입니다.</p>`; checkout.prepend(box); }
    if (!$("fm46-platform-footer")) { const footer=document.createElement("section");footer.id="fm46-platform-footer";footer.innerHTML=`<strong>푸릇마켓 오픈마켓 운영 안내</strong><br>입점 판매자 상품의 판매주체는 상품 상세에 표시된 판매자입니다. 푸릇마켓은 통신판매중개, 거래기록 보존, 분쟁 접수 및 피해 파악·조치 업무를 수행합니다.<br><span>법정 고지·약관·수수료·정산 규정은 관리자 승인과 법률검토를 거친 버전만 운영에 적용됩니다.</span>`; (document.querySelector("footer") || document.body).append(footer); }
  }

  function reliabilityAudit() {
    const ids = new Map(); const duplicates=[];
    document.querySelectorAll("[id]").forEach((node)=>{ const n=(ids.get(node.id)||0)+1;ids.set(node.id,n);if(n===2)duplicates.push(node.id); });
    document.querySelectorAll("button").forEach((button)=>{ if(!button.getAttribute("type")) button.setAttribute("type", button.closest("form") ? "submit" : "button"); if(button.disabled&&!button.getAttribute("aria-disabled"))button.setAttribute("aria-disabled","true"); });
    global.FRUITMARKET_PART46_UI_AUDIT={version:VERSION,duplicateIds:duplicates,buttonCount:document.querySelectorAll("button").length,viewportWidth:document.documentElement.clientWidth,overflowX:Math.max(0,document.documentElement.scrollWidth-document.documentElement.clientWidth),checkedAt:new Date().toISOString()};
    document.documentElement.dataset.fm46UiAudit=duplicates.length?"warning":"passed";
  }

  let scheduled = false;
  function install() { if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;injectStyle();sellerPanel();buyerDisputePanel();adminPanel();legalNotices();renderFreshDetail();reliabilityAudit();document.documentElement.dataset.fruitmarketPart46="ready";}); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once:true }); else install();
  new MutationObserver(install).observe(document.documentElement,{childList:true,subtree:true});
  global.addEventListener("hashchange",()=>setTimeout(install,50));
  global.addEventListener("fruitmarket:auth",()=>setTimeout(install,50));
})(window);
