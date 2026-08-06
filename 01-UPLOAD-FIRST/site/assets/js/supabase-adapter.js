(function (global) {
  "use strict";

  const config = global.FRUITMARKET_SUPABASE || {};
  const legacyFetch = global.fetch.bind(global);
  const legacyApiAtBoot = global.FruitMarketApi;
  const isConfigured = config.enabled === true
    && /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(String(config.url || ""))
    && String(config.publishableKey || "").length > 20
    && typeof global.supabase?.createClient === "function";

  const toCamel = (value) => {
    if (Array.isArray(value)) return value.map(toCamel);
    if (!value || typeof value !== "object" || value instanceof Blob || value instanceof File || value instanceof FormData) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), toCamel(item)]));
  };
  const toSnake = (value) => {
    if (Array.isArray(value)) return value.map(toSnake);
    if (!value || typeof value !== "object" || value instanceof Blob || value instanceof File || value instanceof FormData) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`), toSnake(item)]));
  };

  // 기존 단일 HTML은 ID를 Number로 다루는 구간이 있어 UUID를 안전한 숫자 별칭으로 변환합니다.
  // 네트워크 요청 직전에는 반드시 원래 UUID로 복원합니다.
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const uuidToAlias = new Map();
  const aliasToUuid = new Map();
  function aliasFor(uuidValue) {
    const uuid = String(uuidValue).toLowerCase();
    if (uuidToAlias.has(uuid)) return uuidToAlias.get(uuid);
    const hex = uuid.replace(/-/g, "");
    let alias = Number.parseInt(hex.slice(0, 13), 16) % 8_000_000_000_000_000 + 1;
    while (aliasToUuid.has(String(alias)) && aliasToUuid.get(String(alias)) !== uuid) alias += 1;
    uuidToAlias.set(uuid, alias); aliasToUuid.set(String(alias), uuid);
    return alias;
  }
  function legacyIds(value) {
    if (Array.isArray(value)) return value.map(legacyIds);
    if (typeof value === "string" && uuidPattern.test(value)) return aliasFor(value);
    if (!value || typeof value !== "object" || value instanceof Blob || value instanceof File || value instanceof FormData) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, legacyIds(item)]));
  }
  function backendIds(value, key = "") {
    if (Array.isArray(value)) return value.map((item) => backendIds(item, key));
    if (typeof value === "number" && /(^id$|Id$|Ids$|_id$)/i.test(key) && aliasToUuid.has(String(value))) return aliasToUuid.get(String(value));
    if (typeof value === "string" && /^\d+$/.test(value) && /(^id$|Id$|Ids$|_id$)/i.test(key) && aliasToUuid.has(value)) return aliasToUuid.get(value);
    if (!value || typeof value !== "object" || value instanceof Blob || value instanceof File || value instanceof FormData) return value;
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, backendIds(item, childKey)]));
  }
  function backendPath(path) {
    const [pathname, query = ""] = String(path).split("?", 2);
    const converted = pathname.split("/").map((segment) => aliasToUuid.get(decodeURIComponent(segment)) || segment).join("/");
    if (!query) return converted;
    const params = new URLSearchParams(query);
    for (const [key, value] of [...params.entries()]) if (aliasToUuid.has(value)) params.set(key, aliasToUuid.get(value));
    return `${converted}?${params.toString()}`;
  }

  const parseBody = (body) => {
    if (body == null) return {};
    if (body instanceof FormData) return body;
    if (typeof body === "string") { try { return JSON.parse(body); } catch { return {}; } }
    return body;
  };
  const errorFrom = (raw, fallback = "요청 처리에 실패했습니다.") => {
    const source = raw?.context?.body || raw?.error || raw;
    const e = new Error(source?.message || raw?.message || fallback);
    e.code = source?.code || raw?.code || "SUPABASE_REQUEST_FAILED";
    e.status = source?.status || raw?.status || raw?.context?.status || 500;
    e.details = source?.details || null;
    e.hint = source?.hint || null;
    return e;
  };
  const wrap = (data) => ({ data: legacyIds(toCamel(data)) });

  if (!isConfigured) {
    global.FRUITMARKET_SUPABASE_STATUS = Object.freeze({ connected: false, reason: "CONFIG_REQUIRED" });
    global.FRUITMARKET_FEATURES = Object.freeze({
      ...(global.FRUITMARKET_FEATURES || {}), publicCatalog: true, payments: false,
      guestCheckout: false, settlements: false, pgRegistrationDeferred: true,
    });
    return;
  }

  const client = global.supabase.createClient(config.url, config.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
      storageKey: "fruitmarket-auth-v1",
    },
    global: { headers: { "X-Client-Info": "fruitmarket-part45-web" } },
  });

  async function authHeaders() {
    const { data } = await client.auth.getSession();
    return data?.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {};
  }

  async function profileFor(user) {
    if (!user) return null;
    const { data, error } = await client.from("profiles").select("*").eq("id", user.id).maybeSingle();
    if (error) throw errorFrom(error);
    return {
      id: user.id,
      email: user.email || data?.email || "",
      name: data?.display_name || user.user_metadata?.name || String(user.email || "").split("@")[0],
      phone: data?.phone || user.user_metadata?.phone || "",
      role: String(data?.role || "consumer").toUpperCase(),
      status: data?.status || "active",
      grade: data?.grade || "NORMAL",
      marketingOptIn: Boolean(data?.marketing_opt_in),
      emailConfirmedAt: user.email_confirmed_at || null,
    };
  }

  async function currentUser() {
    const { data, error } = await client.auth.getUser();
    if (error && error.name !== "AuthSessionMissingError") throw errorFrom(error);
    return profileFor(data?.user || null);
  }

  async function invoke(name, body, extraHeaders = {}) {
    const headers = { ...(await authHeaders()), ...extraHeaders };
    const { data, error } = await client.functions.invoke(name, { body, headers });
    if (error) {
      let parsed = null;
      try { parsed = await error.context?.json?.(); } catch (_) { /* no-op */ }
      throw errorFrom(parsed || error);
    }
    if (data?.error) throw errorFrom(data.error);
    return data && Object.prototype.hasOwnProperty.call(data, "data") ? data.data : data;
  }

  async function gateway(path, method, body, headers = {}) {
    return invoke("api", { path: backendPath(path), method, body: body instanceof FormData ? {} : backendIds(body || {}) }, headers);
  }

  async function register(body) {
    const receipts = Array.isArray(body.consentReceipts)
      ? body.consentReceipts
      : [
          { scope: "SIGNUP", policyCode: "BUYER_TERMS", policyVersion: body.termsVersion || "current", contentHash: body.termsHash || "CLIENT_RECORDED", consented: Boolean(body.termsAgreed ?? body.agreeTerms ?? true), clientSubmissionId: crypto.randomUUID() },
          { scope: "SIGNUP", policyCode: "PRIVACY_COLLECTION", policyVersion: body.privacyVersion || "current", contentHash: body.privacyHash || "CLIENT_RECORDED", consented: Boolean(body.privacyAgreed ?? body.agreePrivacy ?? true), clientSubmissionId: crypto.randomUUID() },
          { scope: "SIGNUP", policyCode: "AGE_CONFIRM", policyVersion: "current", contentHash: "CLIENT_RECORDED", consented: Boolean(body.ageConfirmed ?? body.agreeAge ?? true), clientSubmissionId: crypto.randomUUID() },
        ];
    if (receipts.some(r => r.consentRequired !== false && r.consented === false)) throw errorFrom({ code: "CONSENT_REQUIRED", message: "필수 약관에 동의해야 회원가입할 수 있습니다.", status: 400 });
    const redirectTo = `${global.location.origin}/auth-callback.html`;
    const { data, error } = await client.auth.signUp({
      email: String(body.email || "").trim().toLowerCase(),
      password: String(body.password || ""),
      options: {
        emailRedirectTo: redirectTo,
        data: {
          name: body.name || body.displayName || "",
          phone: body.phone || "",
          marketingOptIn: Boolean(body.marketingOptIn),
          consentReceipts: receipts,
        },
      },
    });
    if (error) throw errorFrom(error);
    if (data.session) {
      try { await gateway("/api/mypage/profile", "PATCH", { name: body.name || body.displayName, phone: body.phone, marketingOptIn: body.marketingOptIn, consentReceipts: receipts }); } catch (_) { /* trigger already stored core profile */ }
    }
    return { userId: data.user?.id, email: data.user?.email, emailConfirmationRequired: !data.session, session: data.session || null };
  }

  async function uploadFile(pathWithQuery, form) {
    const url = new URL(pathWithQuery, global.location.origin);
    const file = form.get("file") || [...form.values()].find(v => v instanceof File);
    if (!(file instanceof File)) throw errorFrom({ code: "FILE_REQUIRED", message: "업로드 파일이 없습니다.", status: 400 });
    const usage = String(url.searchParams.get("usage") || form.get("usage") || "PUBLIC_ASSET").toUpperCase();
    const bucket = usage.includes("SELLER") ? config.storage?.sellerDocumentsBucket
      : usage.includes("CLAIM") ? config.storage?.claimEvidenceBucket
      : usage.includes("PRODUCT") ? config.storage?.productImagesBucket
      : config.storage?.publicAssetsBucket;
    const profile = await currentUser();
    if (!profile && ![config.storage?.publicAssetsBucket].includes(bucket)) throw errorFrom({ code: "AUTH_REQUIRED", message: "로그인이 필요합니다.", status: 401 });
    const owner = profile?.id || "public";
    const safeName = String(file.name || "upload.bin").normalize("NFKD").replace(/[^a-zA-Z0-9._-]/g, "-").slice(-120);
    const objectPath = `${owner}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safeName}`;
    const { error } = await client.storage.from(bucket).upload(objectPath, file, { cacheControl: "3600", upsert: false, contentType: file.type || undefined });
    if (error) throw errorFrom(error);
    const isPublic = [config.storage?.publicAssetsBucket, config.storage?.productImagesBucket].includes(bucket);
    const publicUrl = isPublic ? client.storage.from(bucket).getPublicUrl(objectPath).data.publicUrl : null;
    return { url: publicUrl || objectPath, objectPath, bucket, originalFilename: file.name, size: file.size, contentType: file.type };
  }

  async function parseWorkbook(file) {
    if (!global.XLSX?.read || !global.XLSX?.utils?.sheet_to_json) throw errorFrom({ code: "XLSX_ENGINE_MISSING", message: "엑셀 처리 모듈을 불러오지 못했습니다.", status: 500 });
    const buffer = await file.arrayBuffer();
    const workbook = global.XLSX.read(buffer, { type: "array", cellDates: false, cellNF: false, cellText: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw errorFrom({ code: "XLSX_SHEET_MISSING", message: "엑셀 첫 번째 시트를 찾을 수 없습니다.", status: 400 });
    const raw = global.XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
    return raw.map((row, index) => {
      const lower = Object.fromEntries(Object.entries(row).map(([k, v]) => [String(k).trim().toLowerCase(), v]));
      const pick = (...keys) => keys.map(k => lower[k.toLowerCase()]).find(v => v !== undefined && v !== "") ?? "";
      return {
        rowNumber: index + 2,
        productId: pick("productid", "상품id", "상품아이디"),
        productCode: pick("productcode", "상품코드"),
        productName: pick("productname", "상품명"),
        optionId: pick("optionid", "옵션id"),
        sku: pick("sku", "판매자sku"),
        currentStock: Number(pick("currentstock", "현재재고") || 0),
        newStock: Number(pick("newstock", "변경재고", "재고") || 0),
        reason: pick("reason", "사유") || "EXCEL_IMPORT",
      };
    });
  }

  async function excelImport(path, form) {
    const file = form.get("file") || [...form.values()].find(v => v instanceof File);
    if (!(file instanceof File)) throw errorFrom({ code: "FILE_REQUIRED", message: "엑셀 파일이 없습니다.", status: 400 });
    if (file.size > 10 * 1024 * 1024) throw errorFrom({ code: "FILE_TOO_LARGE", message: "엑셀 파일은 10MB 이하여야 합니다.", status: 400 });
    const rows = await parseWorkbook(file);
    const data = await gateway(path, "POST", { rows, fileName: file.name, fileSize: file.size });
    const resultRows = data?.rows || [];
    const errors = resultRows.filter(r => !r.valid).map(r => ({ rowNumber: r.rowNumber, sku: r.sku, productCode: r.productId, message: r.error || "검증 실패" }));
    return {
      totalRows: rows.length,
      createdProducts: Number(data?.createdProducts || 0),
      adjustedStocks: Number(data?.applied || 0),
      failedRows: errors.length,
      errors,
      rows: resultRows,
      valid: errors.length === 0,
    };
  }

  async function route(pathWithQuery, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const body = parseBody(options.body);
    const url = new URL(pathWithQuery, global.location.origin);
    const path = url.pathname;

    if (method === "GET" && ["/api/auth/me", "/api/auth/session", "/api/members/me"].includes(path)) return wrap(await currentUser());
    if (method === "GET" && path === "/api/auth/csrf") return wrap({ token: null, mode: "SUPABASE_JWT" });
    if (method === "POST" && path === "/api/auth/login") {
      const { data, error } = await client.auth.signInWithPassword({ email: String(body.email || "").trim().toLowerCase(), password: String(body.password || "") });
      if (error) throw errorFrom(error);
      const profile = await profileFor(data.user);
      if (profile?.status !== "active") { await client.auth.signOut(); throw errorFrom({ code: "ACCOUNT_NOT_ACTIVE", message: "정지 또는 탈퇴된 계정입니다.", status: 403 }); }
      return wrap({ user: profile, session: data.session });
    }
    if (method === "POST" && ["/api/public/auth/register", "/api/auth/register"].includes(path)) return wrap(await register(body));
    if (method === "POST" && path === "/api/auth/logout") { const { error } = await client.auth.signOut({ scope: body.scope === "global" ? "global" : "local" }); if (error) throw errorFrom(error); return wrap({ success: true }); }
    if (method === "POST" && path === "/api/auth/password/reset-request") { const { error } = await client.auth.resetPasswordForEmail(String(body.email || "").trim().toLowerCase(), { redirectTo: `${global.location.origin}/auth-callback.html?mode=recovery` }); if (error) throw errorFrom(error); return wrap({ accepted: true }); }
    if (method === "POST" && path === "/api/auth/password/update") { const { error } = await client.auth.updateUser({ password: String(body.password || "") }); if (error) throw errorFrom(error); return wrap({ success: true }); }
    if (method === "POST" && path === "/api/auth/email/resend") { const { error } = await client.auth.resend({ type: "signup", email: String(body.email || "").trim().toLowerCase(), options: { emailRedirectTo: `${global.location.origin}/auth-callback.html` } }); if (error) throw errorFrom(error); return wrap({ accepted: true }); }
    if (method === "POST" && path === "/api/auth/oauth/kakao") {
      const { data, error } = await client.auth.signInWithOAuth({ provider: "kakao", options: { redirectTo: `${global.location.origin}/auth-callback.html` } });
      if (error) throw errorFrom(error); return wrap(data);
    }
    if (path === "/api/public/dev-login") throw errorFrom({ code: "DEV_LOGIN_DISABLED", message: "운영 환경에서는 개발용 로그인을 사용할 수 없습니다.", status: 403 });

    if (path === "/api/files" && method === "POST" && body instanceof FormData) return wrap(await uploadFile(pathWithQuery, body));
    if (["/api/seller/inventory/bulk/preview", "/api/seller/inventory/bulk"].includes(path) && method === "POST" && body instanceof FormData) return wrap(await excelImport(path, body));

    if (method === "POST" && ["/api/orders/checkout/cart", "/api/orders/checkout/direct"].includes(path)) {
      const data = await invoke("checkout-prepare", { ...backendIds(body), checkoutMode: path.endsWith("/cart") ? "CART" : "DIRECT" }, { "Idempotency-Key": body.idempotencyKey || crypto.randomUUID() });
      return wrap(data);
    }
    const paymentApprove = path.match(/^\/api\/orders\/payments\/([0-9a-f-]{36}|\d+)\/approve$/i);
    if (paymentApprove && method === "POST") return wrap(await invoke("payment-confirm", { ...backendIds(body), paymentId: backendPath(paymentApprove[1]) }, { "Idempotency-Key": body.idempotencyKey || `${paymentApprove[1]}:confirm` }));
    const paymentCancel = path.match(/^\/api\/orders\/payments\/([0-9a-f-]{36}|\d+)\/(cancel|refund)$/i);
    if (paymentCancel && method === "POST") return wrap(await invoke("payment-cancel", { ...backendIds(body), paymentId: backendPath(paymentCancel[1]) }, { "Idempotency-Key": body.idempotencyKey || crypto.randomUUID() }));

    // 결제 완료 주문의 취소는 DB 상태만 변경하지 않고 토스 전체취소와 재고 원복을 실행합니다.
    const paidOrderCancel = path.match(/^\/api\/orders\/([0-9a-f-]{36}|\d+|FM-[A-Z0-9-]+)\/cancel$/i);
    if (paidOrderCancel && method === "POST") {
      const orderRef = backendPath(paidOrderCancel[1]);
      const detail = await gateway(`/api/orders/${orderRef}`, "GET", {}, options.headers || {});
      const payment = detail?.payment || (Array.isArray(detail?.payments) ? detail.payments[0] : null);
      if (payment && ["DONE", "PARTIAL_CANCELED"].includes(String(payment.status)) && ["PAID", "PREPARING"].includes(String(detail.status))) {
        const idempotencyKey = body.idempotencyKey || `ORDER:${detail.id}:FULL_CANCEL`;
        return wrap(await invoke("payment-cancel", {
          paymentId: payment.id, orderId: detail.id, cancelAll: true, restock: true,
          cancelReason: body.reason || "구매자 주문 취소", idempotencyKey,
        }, { "Idempotency-Key": idempotencyKey }));
      }
      return wrap(await gateway(pathWithQuery, method, body, options.headers || {}));
    }

    // 판매자/관리자의 취소 승인과 반품 입고완료는 토스 환불 성공 후에만 클레임을 완료합니다.
    const claimRefundAction = path.match(/^\/api\/(seller|admin)\/claims\/([0-9a-f-]{36}|\d+)\/(approve|complete-return)$/i);
    if (claimRefundAction && method === "POST") {
      const reviewed = await gateway(pathWithQuery, method, body, options.headers || {});
      if (!reviewed?.immediateRefund) return wrap(reviewed);
      const idempotencyKey = body.idempotencyKey || `CLAIM:${reviewed.claimId}:REFUND`;
      const refunded = await invoke("payment-cancel", {
        paymentId: reviewed.paymentId, claimId: reviewed.claimId, cancelAmount: reviewed.refundAmount,
        cancelReason: body.reason || body.memo || `${reviewed.claimType} 승인`, items: reviewed.items || [],
        restock: Boolean(body.resalable ?? body.restock) && Boolean(reviewed.restockAllowed), idempotencyKey,
      }, { "Idempotency-Key": idempotencyKey });
      return wrap({ ...reviewed, refund: refunded, status: "COMPLETED" });
    }

    // 관리자 정산 완료 버튼은 DB 상태만 바꾸지 않고 실제 지급대행 Edge Function을 호출합니다.
    const settlementComplete = path.match(/^\/api\/admin\/settlements\/([0-9a-f-]{36}|\d+)\/complete$/i);
    if (settlementComplete && method === "POST") {
      const settlementId = backendPath(settlementComplete[1]);
      return wrap(await invoke("payout-run", { ...backendIds(body), settlementId }, { "Idempotency-Key": body.idempotencyKey || `PAYOUT:${settlementId}` }));
    }

    return wrap(await gateway(pathWithQuery, method, body, options.headers || {}));
  }

  function decodeBase64(base64) {
    const binary = atob(base64 || "");
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  }

  async function fetchIntercept(input, init = {}) {
    const raw = typeof input === "string" ? input : String(input?.url || "");
    const url = new URL(raw, global.location.origin);
    if (url.origin !== global.location.origin || !url.pathname.startsWith("/api/")) return legacyFetch(input, init);
    const method = String(init.method || input?.method || "GET").toUpperCase();
    let body = init.body;
    if (!body && input instanceof Request && !["GET", "HEAD"].includes(method)) body = await input.clone().text();
    try {
      const payload = await route(url.pathname + url.search, { ...init, method, body });
      const data = payload?.data;
      if (data?.download && data?.base64) {
        return new Response(decodeBase64(data.base64), { status: 200, headers: { "Content-Type": data.contentType || "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(data.filename || "download.bin")}`, "Cache-Control": "no-store" } });
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
    } catch (error) {
      const e = errorFrom(error);
      return new Response(JSON.stringify({ error: { code: e.code, message: e.message, details: e.details }, message: e.message }), { status: e.status || 500, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
    }
  }

  const facade = Object.freeze({
    request: (path, options = {}) => route(path, options),
    get: (path) => route(path, { method: "GET" }),
    post: (path, body, options = {}) => route(path, { ...options, method: "POST", body }),
    put: (path, body, options = {}) => route(path, { ...options, method: "PUT", body }),
    patch: (path, body, options = {}) => route(path, { ...options, method: "PATCH", body }),
    delete: (path, body, options = {}) => route(path, { ...options, method: "DELETE", body }),
    originalApi: legacyApiAtBoot,
    client,
  });

  try {
    Object.defineProperty(global, "FruitMarketApi", {
      configurable: false,
      enumerable: true,
      get: () => facade,
      set: (candidate) => { if (candidate && candidate !== facade) global.FRUITMARKET_IGNORED_LEGACY_API = candidate; },
    });
  } catch (_) { global.FruitMarketApi = facade; }
  global.fetch = fetchIntercept;
  global.FRUITMARKET_NATIVE_FETCH = fetchIntercept;
  global.FruitMarketSupabase = Object.freeze({ client, connected: true, api: facade });
  global.FruitMarketIds = Object.freeze({ toBackend: (value) => aliasToUuid.get(String(value)) || value, toLegacy: aliasFor, backendPath });
  global.FRUITMARKET_SUPABASE_STATUS = Object.freeze({ connected: true, projectUrl: config.url, gateway: "api" });
  global.FRUITMARKET_AUTH_MODE = "SUPABASE_JWT";

  const paymentEnabled = Boolean(config.features?.paymentsEnabled && config.tossClientKey);
  global.FRUITMARKET_FEATURES = Object.freeze({
    ...(global.FRUITMARKET_FEATURES || {}),
    publicCatalog: true,
    payments: paymentEnabled,
    guestCheckout: false,
    settlements: Boolean(config.features?.settlementsEnabled),
    pgRegistrationDeferred: !paymentEnabled,
  });
  global.FRUITMARKET_SERVER_CONFIG = Object.freeze({
    ...(global.FRUITMARKET_SERVER_CONFIG || {}),
    tossClientKey: paymentEnabled ? String(config.tossClientKey) : "",
    tossSuccessUrl: `${global.location.origin}/payment-success.html`,
    tossFailUrl: `${global.location.origin}/payment-fail.html`,
  });

  async function startKakao() {
    try { await route("/api/auth/oauth/kakao", { method: "POST", body: {} }); }
    catch (e) { global.app?.showToast?.(e.message || "카카오 로그인을 시작하지 못했습니다."); }
  }
  global.FruitMarketAuth = Object.freeze({
    client,
    signInWithKakao: startKakao,
    resetPassword: (email) => route("/api/auth/password/reset-request", { method: "POST", body: { email } }),
    updatePassword: (password) => route("/api/auth/password/update", { method: "POST", body: { password } }),
    resendVerification: (email) => route("/api/auth/email/resend", { method: "POST", body: { email } }),
    signOutAll: () => route("/api/auth/logout", { method: "POST", body: { scope: "global" } }),
    updateEmail: async (email) => { const { data, error } = await client.auth.updateUser({ email: String(email || "").trim().toLowerCase() }); if (error) throw errorFrom(error); return data; },
    listMfaFactors: async () => { const { data, error } = await client.auth.mfa.listFactors(); if (error) throw errorFrom(error); return data; },
    enrollMfa: async (friendlyName = "푸릇마켓 관리자") => { const { data, error } = await client.auth.mfa.enroll({ factorType: "totp", friendlyName }); if (error) throw errorFrom(error); return data; },
    verifyMfa: async (factorId, code) => { const challenge = await client.auth.mfa.challenge({ factorId }); if (challenge.error) throw errorFrom(challenge.error); const result = await client.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code: String(code || "").replace(/\D/g, "") }); if (result.error) throw errorFrom(result.error); return result.data; },
    unenrollMfa: async (factorId) => { const { data, error } = await client.auth.mfa.unenroll({ factorId }); if (error) throw errorFrom(error); return data; },
    assuranceLevel: async () => { const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel(); if (error) throw errorFrom(error); return data; },
  });

  document.addEventListener("click", (event) => {
    const target = event.target?.closest?.("a,button");
    if (!target) return;
    const href = target.getAttribute?.("href") || "";
    const action = target.getAttribute?.("data-fm-onclick") || target.getAttribute?.("onclick") || "";
    const text = String(target.textContent || "");
    if (href.includes("/oauth2/authorization/kakao") || action.includes("oauth2/authorization/kakao") || /카카오.*로그인/.test(text)) {
      event.preventDefault(); event.stopImmediatePropagation(); startKakao();
    }
  }, true);

  let notificationChannel = null;
  async function connectRealtimeNotifications() {
    try {
      const { data } = await client.auth.getUser();
      const userId = data?.user?.id;
      if (notificationChannel) { await client.removeChannel(notificationChannel); notificationChannel = null; }
      if (!userId) return;
      notificationChannel = client.channel(`fruitmarket-notifications-${userId}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` }, (payload) => {
          global.dispatchEvent(new CustomEvent("fruitmarket:notification", { detail: legacyIds(toCamel(payload.new)) }));
          global.app?.showToast?.(payload.new?.title || "새 알림이 도착했습니다.");
        }).subscribe();
    } catch (error) { console.warn("notification realtime", error); }
  }
  connectRealtimeNotifications();

  client.auth.onAuthStateChange((event) => {
    connectRealtimeNotifications();
    global.dispatchEvent(new CustomEvent("fruitmarket:auth", { detail: { event } }));
  });
})(window);
