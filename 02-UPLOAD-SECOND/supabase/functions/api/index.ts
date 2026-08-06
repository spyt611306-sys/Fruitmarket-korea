import { handleOptions, ok, errorResponse } from "../_shared/http.ts";
import {
  audit,
  cleanString,
  integer,
  page,
  requestContext,
  requireRole,
  requireUser,
  rpc,
  sellerFor,
  uuid,
} from "../_shared/platform.ts";

const PRODUCT_SELECT = `
  id,slug,name,short_description,description,category_id,seller_id,sale_price,list_price,
  stock_quantity,reserved_stock,origin,brix,free_shipping,today_shipping,shipping_fee,
  weight_spec,min_order_quantity,max_order_quantity,reward_rate,reward_max,primary_image_url,
  sale_status,approval_status,approval_reason,active,version,created_at,updated_at,
  product_info_notice,seller_disclosure_snapshot,return_policy_snapshot,compliance_status,
  compliance_flags,compliance_reviewed_at,prohibited_claim_check,
  categories(id,name,slug,icon_key,icon_url),
  sellers(id,store_name,approval_status,status,customer_service_phone,customer_service_email),
  product_images(id,image_url,alt_text,sort_order),
  product_options(id,sku,option_name,additional_price,stock_quantity,reserved_stock,active),
  product_fresh_profiles(*)
`;

function queryUrl(raw: string): URL {
  return new URL(raw, "https://fruitmarket.local");
}

function normalizeProduct(row: Record<string, unknown>): Record<string, unknown> {
  const category = row.categories as Record<string, unknown> | null;
  const seller = row.sellers as Record<string, unknown> | null;
  const images = Array.isArray(row.product_images) ? row.product_images : [];
  const options = Array.isArray(row.product_options) ? row.product_options : [];
  const freshRaw = row.product_fresh_profiles as Record<string, unknown> | Record<string, unknown>[] | null;
  const freshProfile = Array.isArray(freshRaw) ? (freshRaw[0] || null) : (freshRaw || null);
  return {
    ...row,
    categoryName: category?.name || "",
    category: category || null,
    sellerName: seller?.store_name || "",
    seller: seller || null,
    images: images.sort((a: any, b: any) => Number(a.sort_order) - Number(b.sort_order)),
    options: options.filter((x: any) => x.active).map((x: any) => ({
      ...x,
      optionDisplayName: x.option_name,
      stock: Math.max(0, Number(x.stock_quantity || 0) - Number(x.reserved_stock || 0)),
    })),
    availableStock: Math.max(0, Number(row.stock_quantity || 0) - Number(row.reserved_stock || 0)),
    commercialApprovalStatus: row.approval_status,
    freshProfile,
    freshInfo: freshProfile ? {
      fruitType: freshProfile.fruit_type, variety: freshProfile.variety, farmName: freshProfile.farm_name,
      producerName: freshProfile.producer_name, productionRegion: freshProfile.production_region,
      grade: freshProfile.grade, sizeSpec: freshProfile.size_spec, countSpec: freshProfile.count_spec,
      netWeightGrams: freshProfile.net_weight_grams, harvestDate: freshProfile.harvest_date,
      packingDate: freshProfile.packing_date, recommendedConsumeBy: freshProfile.recommended_consume_by,
      ripenessStage: freshProfile.ripeness_stage, storageMethod: freshProfile.storage_method,
      sweetnessClaimType: freshProfile.sweetness_claim_type, brixMin: freshProfile.brix_min,
      brixMax: freshProfile.brix_max, traceabilityCode: freshProfile.traceability_code,
      complianceStatus: freshProfile.compliance_status,
    } : null,
  };
}

function statusFilter(value: string | null): string | null {
  const v = String(value || "").trim().toUpperCase();
  return v && v !== "ALL" ? v : null;
}

function base64Bytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function bytesBase64(value: Uint8Array): string {
  let out = "";
  for (const byte of value) out += String.fromCharCode(byte);
  return btoa(out);
}

async function encryptAccountNumber(value: string): Promise<string> {
  const material = Deno.env.get("ACCOUNT_ENCRYPTION_KEY_BASE64") || Deno.env.get("ACCOUNT_ENCRYPTION_KEY");
  if (!material) throw new Error("ACCOUNT_ENCRYPTION_KEY_BASE64_REQUIRED");
  let keyBytes: Uint8Array;
  try { keyBytes = base64Bytes(material); } catch { keyBytes = new TextEncoder().encode(material); }
  if (keyBytes.length !== 32) {
    const digest = await crypto.subtle.digest("SHA-256", keyBytes);
    keyBytes = new Uint8Array(digest);
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value)));
  return `v1.${bytesBase64(iv)}.${bytesBase64(encrypted)}`;
}

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadPayload(filename: string, contentType: string, text: string): Record<string, unknown> {
  const bytes = new TextEncoder().encode(text);
  return { download: true, filename, contentType, base64: bytesBase64(bytes) };
}

async function publicProducts(ctx: Awaited<ReturnType<typeof requestContext>>, url: URL): Promise<Record<string, unknown>> {
  const size = integer(url.searchParams.get("size"), 100, 1, 200);
  const keyword = cleanString(url.searchParams.get("keyword"), 100).replace(/[%_,()]/g, " ");
  const category = cleanString(url.searchParams.get("category"), 100);
  let query = ctx.admin.from("products").select(PRODUCT_SELECT, { count: "exact" })
    .eq("active", true).eq("sale_status", "ON_SALE").eq("approval_status", "APPROVED")
    .order("updated_at", { ascending: false }).limit(size);
  if (keyword) query = query.or(`name.ilike.%${keyword}%,short_description.ilike.%${keyword}%,origin.ilike.%${keyword}%`);
  if (category) {
    const { data: cat } = await ctx.admin.from("categories").select("id").or(`slug.eq.${category},name.eq.${category}`).maybeSingle();
    if (cat?.id) query = query.eq("category_id", cat.id);
  }
  const { data, error, count } = await query;
  if (error) throw error;
  const rows = (data || []).filter((row: any) => row.sellers?.approval_status === "APPROVED" && row.sellers?.status === "ACTIVE").map(normalizeProduct);
  return { content: rows, totalElements: count ?? rows.length, totalPages: 1 };
}

async function orderDetails(ctx: Awaited<ReturnType<typeof requestContext>>, orderIdOrNumber: string): Promise<Record<string, unknown>> {
  const user = requireUser(ctx);
  let query = ctx.admin.from("orders").select(`*,payments(*),order_items(*,products(primary_image_url),sellers(store_name)),shipments(*)`);
  if (/^[0-9a-f-]{36}$/i.test(orderIdOrNumber)) query = query.eq("id", orderIdOrNumber);
  else query = query.eq("order_number", orderIdOrNumber);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("ORDER_NOT_FOUND");
  let participant = data.buyer_id === user.id || ctx.role === "admin";
  if (!participant && ctx.role === "seller") {
    const seller = await sellerFor(ctx);
    participant = (data.order_items || []).some((x: any) => String(x.seller_id) === String(seller.id));
  }
  if (!participant) throw Object.assign(new Error("ORDER_FORBIDDEN"), { status: 403 });
  const payment = Array.isArray(data.payments) ? data.payments[0] : data.payments;
  return {
    ...data,
    orderId: data.id, orderNumber: data.order_number, recipientName: data.recipient_name, recipientPhone: data.recipient_phone,
    itemSubtotal: data.product_total, shippingFee: data.shipping_total, couponDiscountAmount: Math.max(0, Number(data.discount_total || 0) - Number(data.points_used || 0)),
    pointUsedAmount: data.points_used, totalPaymentAmount: data.paid_total, paymentExpiresAt: data.expires_at,
    payment: payment ? { ...payment, paymentId: payment.id, approvedAmount: Number(payment.amount || 0) - Number(payment.balance_amount || 0) } : null,
    items: (data.order_items || []).map((item: any) => ({ ...item, orderItemId: item.id, productName: item.product_name, optionName: item.option_name })),
  };
}

async function sellerId(ctx: Awaited<ReturnType<typeof requestContext>>): Promise<string> {
  const seller = await sellerFor(ctx);
  return String(seller.id);
}

async function claimRefundContext(ctx: Awaited<ReturnType<typeof requestContext>>, claimId: string): Promise<Record<string, any>> {
  const { data: claim, error: claimError } = await ctx.admin.from("claims").select("*").eq("id", claimId).single();
  if (claimError) throw claimError;
  const { data: item, error: itemError } = await ctx.admin.from("order_items")
    .select("id,order_id,seller_id,product_id,option_id,unit_price,quantity,refunded_quantity,status")
    .eq("id", claim.order_item_id).single();
  if (itemError) throw itemError;
  const { data: payment, error: paymentError } = await ctx.admin.from("payments")
    .select("id,order_id,status,balance_amount").eq("order_id", item.order_id).single();
  if (paymentError) throw paymentError;
  const remainingQuantity = Math.max(0, Number(item.quantity || 0) - Number(item.refunded_quantity || 0));
  const refundQuantity = Math.min(Number(claim.quantity || 0), remainingQuantity);
  if (refundQuantity <= 0) throw Object.assign(new Error("CLAIM_ALREADY_REFUNDED"), { status: 409 });
  return {
    claimId: claim.id, claimType: claim.claim_type, claimStatus: claim.status, paymentId: payment.id,
    orderId: item.order_id, sellerId: item.seller_id, refundAmount: Number(item.unit_price || 0) * refundQuantity,
    items: [{ orderItemId: item.id, quantity: refundQuantity, amount: Number(item.unit_price || 0) * refundQuantity }],
  };
}

async function route(req: Request): Promise<Response> {
  const options = handleOptions(req);
  if (options) return options;
  const ctx = await requestContext(req);
  const input = await req.json().catch(() => ({})) as Record<string, any>;
  const method = String(input.method || "GET").toUpperCase();
  const rawPath = String(input.path || "/api/health");
  const body = (input.body && typeof input.body === "object") ? input.body : {};
  const url = queryUrl(rawPath);
  const path = url.pathname;

  // 상태/공개 데이터
  if (method === "GET" && ["/api/health", "/api/public/health"].includes(path)) {
    return ok({ status: "UP", backend: "SUPABASE_EDGE", buildVersion: "48.0.0", checkedAt: new Date().toISOString() }, req);
  }
  if (method === "GET" && path === "/api/auth/csrf") return ok({ token: null, mode: "SUPABASE_JWT" }, req);
  if (method === "POST" && path === "/api/client-errors") {
    const { error } = await ctx.admin.from("client_errors").insert({
      user_id: ctx.user?.id || null,
      message: cleanString(body.message, 2000), stack: cleanString(body.stack, 10000),
      url: cleanString(body.url, 1000), user_agent: cleanString(body.userAgent, 1000),
      build_version: cleanString(body.buildVersion, 100), metadata: body.metadata || {},
    });
    if (error) throw error;
    return ok({ accepted: true }, req, 202);
  }
  if (method === "GET" && path === "/api/public/categories") {
    const { data, error } = await ctx.admin.from("categories").select("*").eq("active", true).order("sort_order").order("name");
    if (error) throw error;
    return ok(data || [], req);
  }
  if (method === "GET" && path === "/api/public/promotions/banners") {
    const placement = cleanString(url.searchParams.get("placement") || "HOME_HERO", 50);
    const now = new Date().toISOString();
    const { data, error } = await ctx.admin.from("banners").select("*").eq("placement", placement).eq("active", true)
      .or(`starts_at.is.null,starts_at.lte.${now}`).or(`ends_at.is.null,ends_at.gte.${now}`).order("sort_order").order("created_at");
    if (error) throw error;
    return ok((data || []).map((x: any) => ({ ...x, status: x.active ? "ACTIVE" : "INACTIVE" })), req);
  }
  if (method === "GET" && path === "/api/public/products") return ok(await publicProducts(ctx, url), req);
  if (method === "GET" && path === "/api/public/home-products") {
    const { data, error } = await ctx.admin.from("home_products").select(`sort_order,products(${PRODUCT_SELECT})`).eq("active", true).order("sort_order").limit(30);
    if (error) throw error;
    return ok((data || []).filter((x: any) => x.products).map((x: any) => ({ sortOrder: x.sort_order, product: normalizeProduct(x.products) })), req);
  }
  const productMatch = path.match(/^\/api\/public\/products\/([0-9a-f-]{36})$/i);
  if (method === "GET" && productMatch) {
    const { data, error } = await ctx.admin.from("products").select(PRODUCT_SELECT).eq("id", productMatch[1]).eq("active", true).maybeSingle();
    if (error) throw error;
    if (!data || (data.approval_status !== "APPROVED" && ctx.role !== "admin")) throw new Error("PRODUCT_NOT_FOUND");
    return ok(normalizeProduct(data), req);
  }
  const productReviews = path.match(/^\/api\/public\/products\/([0-9a-f-]{36})\/reviews$/i);
  if (method === "GET" && productReviews) {
    const size = integer(url.searchParams.get("size"), 50, 1, 100);
    const { data, error, count } = await ctx.admin.from("reviews").select("*,profiles(display_name)", { count: "exact" }).eq("product_id", productReviews[1]).eq("status", "PUBLISHED").order("created_at", { ascending: false }).limit(size);
    if (error) throw error;
    return ok({ content: data || [], totalElements: count || 0, totalPages: 1 }, req);
  }
  const productQuestions = path.match(/^\/api\/public\/products\/([0-9a-f-]{36})\/questions$/i);
  if (method === "GET" && productQuestions) {
    const { data, error, count } = await ctx.admin.from("product_questions").select("id,user_id,title,content,secret,status,answer_content,answered_at,created_at,profiles(display_name)", { count: "exact" }).eq("product_id", productQuestions[1]).neq("status", "HIDDEN").order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    const visible = (data || []).filter((x: any) => !x.secret || x.user_id === ctx.user?.id || ctx.role === "admin");
    return ok({ content: visible, totalElements: visible.length, totalPages: 1 }, req);
  }
  if (method === "GET" && path === "/api/public/reviews") {
    const size = integer(url.searchParams.get("size"), 100, 1, 100);
    const { data, error } = await ctx.admin.from("reviews").select("*,profiles(display_name),products(name,primary_image_url)").eq("status", "PUBLISHED").order("created_at", { ascending: false }).limit(size);
    if (error) throw error;
    return ok(data || [], req);
  }
  if (method === "GET" && path === "/api/policies/public/current") {
    const { data, error } = await ctx.admin.from("policies").select("*").eq("published", true).order("effective_at", { ascending: false });
    if (error) throw error;
    return ok(data || [], req);
  }
  if (method === "GET" && path === "/api/public/search/popular") {
    const { data, error } = await ctx.admin.from("search_keywords").select("keyword,search_count").order("search_count", { ascending: false }).limit(10);
    if (error) throw error;
    return ok(data || [], req);
  }
  if (method === "GET" && path === "/api/public/search/suggestions") {
    const q = cleanString(url.searchParams.get("q"), 100).replace(/[%_,()]/g, " ");
    if (!q) return ok([], req);
    const { data, error } = await ctx.admin.from("products").select("id,name,primary_image_url,sale_price").eq("active", true).eq("approval_status", "APPROVED").ilike("name", `%${q}%`).limit(8);
    if (error) throw error;
    return ok(data || [], req);
  }
  if (method === "GET" && path === "/api/public/search/guide") {
    const q = cleanString(url.searchParams.get("q"), 100);
    return ok({ query: q, suggestions: q ? [`${q} 인기순`, `${q} 산지직송`, `${q} 무료배송`] : [], correctedQuery: q }, req);
  }
  if (method === "POST" && path === "/api/public/search/click") {
    const q = cleanString(url.searchParams.get("q"), 100);
    if (q) await ctx.admin.rpc("increment_search_keyword", { input_keyword: q });
    return ok({ accepted: true }, req);
  }
  if (method === "POST" && path === "/api/public/statistics/impressions") return ok({ accepted: true }, req, 202);

  // 입점/사업자/본인인증
  if (method === "POST" && path === "/api/public/seller-applications/verify-business") {
    const number = cleanString(body.businessNumber, 20).replace(/\D/g, "");
    if (number.length !== 10) throw new Error("BUSINESS_NUMBER_INVALID");
    const endpoint = Deno.env.get("BUSINESS_VERIFICATION_ENDPOINT");
    const key = Deno.env.get("BUSINESS_VERIFICATION_API_KEY");
    if (!endpoint || !key) return ok({ verified: false, status: "MANUAL_REVIEW_REQUIRED", businessNumber: number }, req);
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ businessNumber: number, startDate: body.businessStartDate, representativeName: body.representativeName }) });
    const payload = await response.json().catch(() => ({}));
    return ok({ verified: response.ok && Boolean(payload.verified), providerResult: payload }, req);
  }
  if (method === "POST" && path === "/api/public/identity/pass/start") {
    const callback = `${Deno.env.get("PUBLIC_SITE_URL") || "https://fruit-market.netlify.app"}/`;
    const providerEndpoint = Deno.env.get("IDENTITY_PROVIDER_START_URL");
    const providerKey = Deno.env.get("IDENTITY_PROVIDER_API_KEY");
    const { data, error } = await ctx.admin.from("identity_verifications").insert({ user_id: ctx.user?.id || null, purpose: cleanString(body.purpose || "SELLER_APPLICATION", 100) }).select().single();
    if (error) throw error;
    if (!providerEndpoint || !providerKey) return ok({ sessionId: data.id, status: "STARTED", mode: "MANUAL_OR_SANDBOX", redirectUrl: null }, req);
    const response = await fetch(providerEndpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerKey}` }, body: JSON.stringify({ sessionId: data.id, callbackUrl: callback }) });
    const payload = await response.json().catch(() => ({}));
    await ctx.admin.from("identity_verifications").update({ provider_session_id: payload.sessionId || null, metadata: payload }).eq("id", data.id);
    return ok({ sessionId: data.id, redirectUrl: payload.redirectUrl || null, status: "STARTED" }, req);
  }
  const identityComplete = path.match(/^\/api\/public\/identity\/pass\/([0-9a-f-]{36})$/i);
  if (method === "POST" && identityComplete) {
    const { data, error } = await ctx.admin.from("identity_verifications").select("*").eq("id", identityComplete[1]).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("IDENTITY_SESSION_NOT_FOUND");
    return ok(data, req);
  }
  if (method === "POST" && path === "/api/public/identity/pass/local-complete") {
    if (Deno.env.get("ENABLE_LOCAL_IDENTITY_SIMULATION") !== "true") throw new Error("LOCAL_IDENTITY_SIMULATION_DISABLED");
    const id = uuid(body.sessionId);
    const { data, error } = await ctx.admin.from("identity_verifications").update({ status: "VERIFIED", verified_name: cleanString(body.name, 100), verified_phone: cleanString(body.phone, 30), verified_at: new Date().toISOString() }).eq("id", id).select().single();
    if (error) throw error;
    return ok(data, req);
  }
  if (method === "POST" && path === "/api/public/seller-applications") {
    const row = {
      user_id: ctx.user?.id || null,
      applicant_email: cleanString(body.applicantEmail || body.email, 320), applicant_name: cleanString(body.applicantName || body.name, 100), phone: cleanString(body.phone, 30),
      store_name: cleanString(body.storeName, 200), business_number: cleanString(body.businessNumber, 20).replace(/\D/g, ""),
      business_address: cleanString(body.businessAddress || body.roadAddress, 1000), business_start_date: body.businessStartDate || null,
      representative_name: cleanString(body.representativeName, 100), business_type: cleanString(body.businessType, 200), business_item: cleanString(body.businessItem, 200),
      postal_code: cleanString(body.postalCode, 10), road_address: cleanString(body.roadAddress, 1000), detail_address: cleanString(body.detailAddress, 500),
      business_document_path: cleanString(body.businessDocumentPath || body.fileUrl, 1000) || null,
      business_verification_status: body.businessVerified ? "VERIFIED" : "PENDING",
      identity_verification_id: body.identityVerificationId || null,
      agreement_receipts: body.agreementReceipts || [],
    };
    if (!row.applicant_email || !row.applicant_name || !row.phone || !row.store_name || row.business_number.length !== 10) throw new Error("SELLER_APPLICATION_REQUIRED_FIELDS");
    const { data, error } = await ctx.admin.from("seller_applications").insert(row).select("id,application_number,status,submitted_at").single();
    if (error) throw error;
    await audit(ctx, "SELLER_APPLICATION_SUBMIT", "SELLER_APPLICATION", data.id);
    return ok(data, req, 201);
  }
  const sellerAppStatus = path.match(/^\/api\/public\/seller-applications\/([^/]+)\/status$/i);
  if (method === "GET" && sellerAppStatus) {
    const email = cleanString(url.searchParams.get("email") || url.searchParams.get("applicantEmail"), 320);
    const { data, error } = await ctx.admin.from("seller_applications").select("application_number,status,rejection_reason,submitted_at,reviewed_at").eq("application_number", decodeURIComponent(sellerAppStatus[1])).eq("applicant_email", email).maybeSingle();
    if (error) throw error;
    return ok(data || { status: "NOT_FOUND" }, req);
  }

  // 로그인 사용자 공통
  if (method === "GET" && ["/api/auth/me", "/api/auth/session", "/api/members/me"].includes(path)) {
    if (!ctx.user) return ok(null, req);
    return ok({ id: ctx.user.id, email: ctx.user.email, ...ctx.profile, role: String(ctx.role).toUpperCase() }, req);
  }
  if (["PUT", "PATCH"].includes(method) && ["/api/mypage/profile", "/api/members/me"].includes(path)) {
    const user = requireUser(ctx);
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined || body.displayName !== undefined) patch.display_name = cleanString(body.name || body.displayName, 100);
    if (body.phone !== undefined) patch.phone = cleanString(body.phone, 30);
    if (body.marketingOptIn !== undefined) patch.marketing_opt_in = Boolean(body.marketingOptIn);
    const { data, error } = await ctx.admin.from("profiles").update(patch).eq("id", user.id).select().single();
    if (error) throw error;
    if (Array.isArray(body.consentReceipts)) await ctx.userClient.rpc("register_consent_receipts", { p_receipts: body.consentReceipts, p_email: ctx.user.email });
    return ok(data, req);
  }
  if (method === "DELETE" && path === "/api/members/me") {
    requireUser(ctx);
    await rpc(ctx, "withdraw_member", { p_reason: cleanString(body.reason, 500) });
    return ok({ success: true }, req);
  }

  // 배송지
  if (path === "/api/mypage/addresses") {
    const user = requireUser(ctx);
    if (method === "GET") {
      const { data, error } = await ctx.admin.from("addresses").select("*").eq("user_id", user.id).order("is_default", { ascending: false }).order("created_at", { ascending: false });
      if (error) throw error;
      return ok(data || [], req);
    }
    if (method === "POST") {
      const row = {
        user_id: user.id, address_name: cleanString(body.addressName || "배송지", 100), recipient_name: cleanString(body.recipientName, 100), recipient_phone: cleanString(body.recipientPhone, 30),
        postal_code: cleanString(body.postalCode, 5), road_address: cleanString(body.roadAddress, 1000), detail_address: cleanString(body.detailAddress, 500),
        jibun_address: cleanString(body.jibunAddress, 1000) || null, building_name: cleanString(body.buildingName, 300) || null, delivery_memo: cleanString(body.deliveryMemo, 500) || null,
        is_default: Boolean(body.isDefault),
      };
      if (row.is_default) await ctx.admin.from("addresses").update({ is_default: false }).eq("user_id", user.id);
      const { data, error } = await ctx.admin.from("addresses").insert(row).select().single();
      if (error) throw error;
      if (Array.isArray(body.collectionContext?.consents)) await ctx.userClient.rpc("register_consent_receipts", { p_receipts: body.collectionContext.consents, p_email: ctx.user.email });
      return ok(data, req, 201);
    }
  }
  const address = path.match(/^\/api\/mypage\/addresses\/([0-9a-f-]{36})$/i);
  if (address && ["PUT", "PATCH"].includes(method)) {
    const user = requireUser(ctx);
    const patch: Record<string, unknown> = {};
    const mapping: Record<string, string> = { addressName: "address_name", recipientName: "recipient_name", recipientPhone: "recipient_phone", postalCode: "postal_code", roadAddress: "road_address", detailAddress: "detail_address", jibunAddress: "jibun_address", buildingName: "building_name", deliveryMemo: "delivery_memo" };
    for (const [key, col] of Object.entries(mapping)) if (body[key] !== undefined) patch[col] = cleanString(body[key], 1000);
    const { data, error } = await ctx.admin.from("addresses").update(patch).eq("id", address[1]).eq("user_id", user.id).select().single();
    if (error) throw error;
    return ok(data, req);
  }
  if (address && method === "DELETE") {
    const user = requireUser(ctx);
    const { error } = await ctx.admin.from("addresses").delete().eq("id", address[1]).eq("user_id", user.id);
    if (error) throw error;
    return ok({ success: true }, req);
  }
  const addressDefault = path.match(/^\/api\/mypage\/addresses\/([0-9a-f-]{36})\/default$/i);
  if (addressDefault && method === "PATCH") {
    requireUser(ctx);
    await rpc(ctx, "set_default_address", { target_id: addressDefault[1] });
    return ok({ success: true }, req);
  }

  // 장바구니/찜/최근 본 상품
  if (method === "GET" && path === "/api/cart") return ok(await rpc(ctx, "cart_snapshot"), req);
  if (method === "POST" && path === "/api/cart/items") return ok(await rpc(ctx, "cart_add", { p_product_id: uuid(body.productId), p_option_id: body.optionId ? uuid(body.optionId) : null, p_quantity: integer(body.quantity, 1, 1, 999) }), req, 201);
  const cartQuantity = path.match(/^\/api\/cart\/items\/([0-9a-f-]{36})\/quantity$/i);
  if (cartQuantity && method === "PATCH") return ok(await rpc(ctx, "cart_update_quantity", { p_item_id: cartQuantity[1], p_quantity: integer(body.quantity, 1, 1, 999) }), req);
  const cartItem = path.match(/^\/api\/cart\/items\/([0-9a-f-]{36})$/i);
  if (cartItem && method === "DELETE") return ok(await rpc(ctx, "cart_remove", { p_item_id: cartItem[1] }), req);
  if (method === "DELETE" && path === "/api/cart") return ok(await rpc(ctx, "cart_clear"), req);
  if (method === "GET" && ["/api/mypage/favorites", "/api/mypage/favorites/"].includes(path)) {
    const user = requireUser(ctx);
    const { data, error } = await ctx.admin.from("favorites").select(`created_at,products(${PRODUCT_SELECT})`).eq("user_id", user.id).order("created_at", { ascending: false });
    if (error) throw error;
    const rows = (data || []).filter((x: any) => x.products).map((x: any) => normalizeProduct(x.products));
    return ok({ content: rows, totalElements: rows.length, totalPages: 1 }, req);
  }
  const favorite = path.match(/^\/api\/mypage\/favorites\/([0-9a-f-]{36})$/i);
  if (favorite && ["POST", "DELETE"].includes(method)) return ok({ enabled: await rpc(ctx, "toggle_product_favorite", { p_product_id: favorite[1], p_enabled: method === "POST" }) }, req);
  if (method === "GET" && path === "/api/favorites/sellers") {
    const user = requireUser(ctx);
    const { data, error } = await ctx.admin.from("seller_favorites").select("created_at,sellers(*)").eq("user_id", user.id).order("created_at", { ascending: false });
    if (error) throw error;
    return ok(data || [], req);
  }
  const sellerFavorite = path.match(/^\/api\/favorites\/sellers\/([0-9a-f-]{36})(?:\/status)?$/i);
  if (sellerFavorite && method === "GET") {
    const user = requireUser(ctx);
    const { count, error } = await ctx.admin.from("seller_favorites").select("*", { count: "exact", head: true }).eq("user_id", user.id).eq("seller_id", sellerFavorite[1]);
    if (error) throw error;
    return ok({ favorite: (count || 0) > 0 }, req);
  }
  if (sellerFavorite && ["POST", "DELETE"].includes(method)) return ok({ enabled: await rpc(ctx, "toggle_seller_favorite", { p_seller_id: sellerFavorite[1], p_enabled: method === "POST" }) }, req);
  const recentRecord = path.match(/^\/api\/mypage\/recent-viewed\/([0-9a-f-]{36})$/i);
  if (recentRecord && method === "POST") { await rpc(ctx, "record_recent_view", { p_product_id: recentRecord[1] }); return ok({ success: true }, req); }
  if (method === "GET" && ["/api/mypage/recent-viewed", "/api/mypage/recent-products"].includes(path)) {
    const user = requireUser(ctx);
    const { data, error } = await ctx.admin.from("recent_product_views").select(`viewed_at,products(${PRODUCT_SELECT})`).eq("user_id", user.id).order("viewed_at", { ascending: false }).limit(100);
    if (error) throw error;
    const rows = (data || []).filter((x: any) => x.products).map((x: any) => ({ ...normalizeProduct(x.products), viewedAt: x.viewed_at }));
    return ok({ content: rows, totalElements: rows.length, totalPages: 1 }, req);
  }

  // 쿠폰/포인트
  if (method === "GET" && path === "/api/coupons/mine") {
    const user = requireUser(ctx);
    const { data, error } = await ctx.admin.from("coupon_issues").select("*,coupons(*)").eq("user_id", user.id).order("issued_at", { ascending: false });
    if (error) throw error;
    return ok(data || [], req);
  }
  if (method === "GET" && path === "/api/points/balance") {
    const user = requireUser(ctx);
    const { data, error } = await ctx.admin.from("point_accounts").select("available_balance,reserved_balance,updated_at").eq("user_id", user.id).single();
    if (error) throw error;
    return ok({ availableBalance: data.available_balance, reservedBalance: data.reserved_balance, updatedAt: data.updated_at }, req);
  }

  // 주문/결제 준비·실패·조회
  if (method === "POST" && ["/api/orders/checkout/cart", "/api/orders/checkout/direct"].includes(path)) {
    requireUser(ctx);
    const payload = { ...body, checkoutMode: path.endsWith("/cart") ? "CART" : "DIRECT", idempotencyKey: body.idempotencyKey || req.headers.get("idempotency-key") || crypto.randomUUID() };
    return ok(await rpc(ctx, "prepare_checkout", { p_payload: payload }), req, 201);
  }
  if (method === "GET" && ["/api/orders", "/api/orders/my"].includes(path)) {
    const user = requireUser(ctx);
    const { data, error, count } = await ctx.admin.from("orders").select("*,order_items(*,products(primary_image_url),sellers(store_name)),shipments(*)", { count: "exact" }).eq("buyer_id", user.id).order("ordered_at", { ascending: false }).limit(100);
    if (error) throw error;
    return ok({ content: data || [], totalElements: count || 0, totalPages: 1 }, req);
  }
  const orderMatch = path.match(/^\/api\/orders\/([^/]+)$/i);
  if (orderMatch && method === "GET") return ok(await orderDetails(ctx, decodeURIComponent(orderMatch[1])), req);
  const orderCancel = path.match(/^\/api\/orders\/([0-9a-f-]{36})\/cancel$/i);
  if (orderCancel && method === "POST") return ok(await rpc(ctx, "cancel_order", { p_order_id: orderCancel[1], p_reason: cleanString(body.reason || "BUYER_REQUEST", 500) }), req);
  const orderConfirm = path.match(/^\/api\/orders\/([0-9a-f-]{36})\/confirm$/i);
  if (orderConfirm && method === "POST") return ok(await rpc(ctx, "confirm_order", { p_order_id: orderConfirm[1] }), req);
  const paymentFail = path.match(/^\/api\/orders\/payments\/([0-9a-f-]{36})\/fail$/i);
  if (paymentFail && method === "POST") {
    requireUser(ctx);
    await ctx.admin.rpc("fail_payment", { p_payment_id: paymentFail[1], p_code: cleanString(body.failureCode, 100), p_message: cleanString(body.failureMessage, 1000) });
    return ok({ success: true }, req);
  }

  // 리뷰/문의/클레임
  if (method === "POST" && ["/api/reviews", "/api/mypage/reviews"].includes(path)) {
    const user = requireUser(ctx);
    const orderItemId = body.orderItemId ? uuid(body.orderItemId) : null;
    if (orderItemId) {
      const { count } = await ctx.admin.from("order_items").select("orders!inner(buyer_id,status)", { count: "exact", head: true }).eq("id", orderItemId).eq("orders.buyer_id", user.id).in("orders.status", ["DELIVERED", "CONFIRMED"]);
      if (!count) throw new Error("VERIFIED_PURCHASE_REQUIRED");
    }
    const { data, error } = await ctx.admin.from("reviews").insert({ product_id: uuid(body.productId), user_id: user.id, order_item_id: orderItemId, rating: integer(body.rating, 5, 1, 5), content: cleanString(body.content, 5000), status: "PENDING" }).select().single();
    if (error) throw error;
    return ok(data, req, 201);
  }
  if (method === "GET" && path === "/api/mypage/reviews") {
    const user = requireUser(ctx);
    const { data, error } = await ctx.admin.from("reviews").select("*,products(name,primary_image_url)").eq("user_id", user.id).order("created_at", { ascending: false });
    if (error) throw error;
    return ok(data || [], req);
  }
  const qCreate = path.match(/^\/api\/questions\/products\/([0-9a-f-]{36})$/i);
  if (qCreate && method === "POST") {
    const user = requireUser(ctx);
    const { data, error } = await ctx.admin.from("product_questions").insert({ product_id: qCreate[1], user_id: user.id, title: cleanString(body.title, 300), content: cleanString(body.content, 5000), secret: Boolean(body.secret) }).select().single();
    if (error) throw error;
    return ok(data, req, 201);
  }
  if (method === "POST" && path === "/api/claims") return ok(await rpc(ctx, "create_claim", { p_payload: body }), req, 201);
  if (method === "GET" && path === "/api/claims/me") {
    const user = requireUser(ctx);
    const { data, error, count } = await ctx.admin.from("claims").select("*,order_items(*,products(name,primary_image_url)),claim_evidence(*),claim_history(*)", { count: "exact" }).eq("requester_id", user.id).order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    return ok({ content: data || [], totalElements: count || 0, totalPages: 1 }, req);
  }
  const claimAction = path.match(/^\/api\/claims\/([0-9a-f-]{36})\/(withdraw|return-tracking)$/i);
  if (claimAction && method === "POST") {
    if (claimAction[2] === "return-tracking") {
      const user = requireUser(ctx);
      const { data, error } = await ctx.admin.from("claims").update({ return_method: `${cleanString(body.carrierName, 100)}:${cleanString(body.trackingNumber, 100)}` }).eq("id", claimAction[1]).eq("requester_id", user.id).select().single();
      if (error) throw error;
      return ok(data, req);
    }
    return ok(await rpc(ctx, "transition_claim", { p_claim_id: claimAction[1], p_action: claimAction[2], p_memo: null, p_payload: body }), req);
  }

  // 알림
  if (method === "GET" && ["/api/notifications", "/api/notifications/me"].includes(path)) {
    const user = requireUser(ctx);
    const { data, error } = await ctx.admin.from("notifications").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    return ok(data || [], req);
  }
  const notificationRead = path.match(/^\/api\/notifications\/([0-9a-f-]{36})\/read$/i);
  if (notificationRead && method === "PATCH") {
    const user = requireUser(ctx);
    const { data, error } = await ctx.admin.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", notificationRead[1]).eq("user_id", user.id).select().single();
    if (error) throw error;
    return ok(data, req);
  }

  // 판매자
  if (path.startsWith("/api/seller/")) requireRole(ctx, ["seller", "admin"]);
  if (method === "GET" && path === "/api/seller/statistics") {
    const sid = await sellerId(ctx);
    const from = new Date(); from.setMonth(from.getMonth() - 1);
    const { data: orderItems, error } = await ctx.admin.from("order_items").select("item_total,status,quantity,order_id,orders!inner(ordered_at)").eq("seller_id", sid).gte("orders.ordered_at", from.toISOString());
    if (error) throw error;
    const gross = (orderItems || []).filter((x: any) => !["CANCELED", "REFUNDED"].includes(x.status)).reduce((a: number, x: any) => a + Number(x.item_total || 0), 0);
    const { count: productCount } = await ctx.admin.from("products").select("*", { count: "exact", head: true }).eq("seller_id", sid).eq("active", true);
    const { count: followerCount } = await ctx.admin.from("seller_favorites").select("*", { count: "exact", head: true }).eq("seller_id", sid);
    return ok({ grossSales: gross, weeklyRevenue: gross, activeProducts: productCount || 0, followers: followerCount || 0, newOrders: (orderItems || []).filter((x: any) => x.status === "PAID").length }, req);
  }
  if (method === "GET" && path === "/api/seller/products") {
    const sid = await sellerId(ctx);
    const { data, error, count } = await ctx.admin.from("products").select(PRODUCT_SELECT, { count: "exact" }).eq("seller_id", sid).order("updated_at", { ascending: false }).limit(200);
    if (error) throw error;
    return ok({ content: (data || []).map(normalizeProduct), totalElements: count || 0, totalPages: 1 }, req);
  }
  if (method === "POST" && path === "/api/seller/products") {
    const sid = await sellerId(ctx);
    const product = body.product || body;
    const row = {
      seller_id: sid, category_id: product.categoryId || null, slug: cleanString(product.slug || `${product.name}-${crypto.randomUUID().slice(0, 8)}`, 200).replace(/\s+/g, "-").toLowerCase(),
      name: cleanString(product.name, 300), short_description: cleanString(product.shortDescription, 1000), description: cleanString(product.description, 50000),
      sale_price: integer(product.salePrice || product.price, 0, 1), list_price: product.listPrice || product.originalPrice || null, stock_quantity: integer(product.stockQuantity || product.stock, 0, 0),
      origin: cleanString(product.origin, 300), brix: product.brix || null, free_shipping: Boolean(product.freeShipping), today_shipping: Boolean(product.todayShipping),
      shipping_fee: integer(product.shippingFee, 3000, 0), weight_spec: cleanString(product.weightSpec || product.weight, 200), min_order_quantity: integer(product.minOrderQuantity, 1, 1), max_order_quantity: integer(product.maxOrderQuantity, 99, 1),
      reward_rate: Number(product.rewardRate || 0), reward_max: integer(product.rewardMax, 0, 0), primary_image_url: cleanString(product.primaryImageUrl || product.imageUrl, 2000) || null,
      shipping_policy: product.shippingPolicy || {}, return_policy: product.returnPolicy || {}, product_notice: product.productNotice || {},
      product_info_notice: product.productInfoNotice || product.productNotice || {},
      return_policy_snapshot: product.returnPolicySnapshot || product.returnPolicy || {},
      prohibited_claim_check: false, compliance_status: "INCOMPLETE", compliance_flags: ["ADMIN_REVIEW_REQUIRED"],
      sale_status: "DRAFT", approval_status: "PENDING",
    };
    if (!row.name || row.sale_price <= 0 || !row.origin) throw new Error("PRODUCT_REQUIRED_FIELDS_MISSING");
    const { data, error } = await ctx.admin.from("products").insert(row).select().single();
    if (error) throw error;
    if (Array.isArray(product.images)) await ctx.admin.from("product_images").insert(product.images.map((x: any, i: number) => ({ product_id: data.id, image_url: x.url || x.imageUrl || x, alt_text: x.altText || row.name, sort_order: i })));
    if (Array.isArray(product.options)) await ctx.admin.from("product_options").insert(product.options.map((x: any) => ({ product_id: data.id, sku: cleanString(x.sku || `${data.id}-${crypto.randomUUID().slice(0, 8)}`, 100), option_name: cleanString(x.optionName || x.name, 300), additional_price: integer(x.additionalPrice, 0), stock_quantity: integer(x.stockQuantity || x.stock, 0, 0), active: x.active !== false })));
    await audit(ctx, "SELLER_PRODUCT_CREATE", "PRODUCT", data.id);
    return ok(normalizeProduct(data), req, 201);
  }
  const sellerProduct = path.match(/^\/api\/seller\/products\/([0-9a-f-]{36})$/i);
  if (sellerProduct && ["PUT", "PATCH"].includes(method)) {
    const sid = await sellerId(ctx);
    const product = body.product || body;
    const patch: Record<string, unknown> = {};
    const map: Record<string, string> = { name: "name", shortDescription: "short_description", description: "description", categoryId: "category_id", salePrice: "sale_price", listPrice: "list_price", stockQuantity: "stock_quantity", origin: "origin", brix: "brix", freeShipping: "free_shipping", todayShipping: "today_shipping", shippingFee: "shipping_fee", weightSpec: "weight_spec", minOrderQuantity: "min_order_quantity", maxOrderQuantity: "max_order_quantity", rewardRate: "reward_rate", rewardMax: "reward_max", primaryImageUrl: "primary_image_url", shippingPolicy: "shipping_policy", returnPolicy: "return_policy", productNotice: "product_notice", productInfoNotice: "product_info_notice", returnPolicySnapshot: "return_policy_snapshot" };
    for (const [key, col] of Object.entries(map)) if (product[key] !== undefined) patch[col] = product[key];
    patch.approval_status = "PENDING"; patch.sale_status = "DRAFT"; patch.approval_reason = null;
    const { data, error } = await ctx.admin.from("products").update(patch).eq("id", sellerProduct[1]).eq("seller_id", sid).select().single();
    if (error) throw error;
    if (Array.isArray(product.images)) {
      await ctx.admin.from("product_images").delete().eq("product_id", data.id);
      await ctx.admin.from("product_images").insert(product.images.map((x: any, i: number) => ({ product_id: data.id, image_url: x.url || x.imageUrl || x, alt_text: x.altText || data.name, sort_order: i })));
    }
    if (Array.isArray(product.options)) {
      await ctx.admin.from("product_options").delete().eq("product_id", data.id);
      await ctx.admin.from("product_options").insert(product.options.map((x: any) => ({ product_id: data.id, sku: cleanString(x.sku || `${data.id}-${crypto.randomUUID().slice(0, 8)}`, 100), option_name: cleanString(x.optionName || x.name, 300), additional_price: integer(x.additionalPrice, 0), stock_quantity: integer(x.stockQuantity || x.stock, 0, 0), active: x.active !== false })));
    }
    return ok(data, req);
  }
  if (sellerProduct && method === "DELETE") {
    const sid = await sellerId(ctx);
    const { error } = await ctx.admin.from("products").delete().eq("id", sellerProduct[1]).eq("seller_id", sid).eq("sale_status", "DRAFT");
    if (error) throw error;
    return ok({ success: true }, req);
  }
  const sellerProductSubmit = path.match(/^\/api\/seller\/products\/([0-9a-f-]{36})\/submit$/i);
  if (sellerProductSubmit && method === "POST") return ok(await rpc(ctx, "submit_product_for_approval", { p_product_id: sellerProductSubmit[1] }), req);
  const sellerProductStop = path.match(/^\/api\/seller\/products\/([0-9a-f-]{36})\/discontinue$/i);
  if (sellerProductStop && method === "POST") {
    const sid = await sellerId(ctx);
    const { data, error } = await ctx.admin.from("products").update({ sale_status: "STOPPED" }).eq("id", sellerProductStop[1]).eq("seller_id", sid).select().single();
    if (error) throw error;
    return ok(data, req);
  }
  if (method === "GET" && path === "/api/seller/orders") {
    const sid = await sellerId(ctx);
    const { data, error, count } = await ctx.admin.from("order_items").select("*,orders(*),products(primary_image_url)", { count: "exact" }).eq("seller_id", sid).order("id", { ascending: false }).limit(200);
    if (error) throw error;
    return ok({ content: data || [], totalElements: count || 0, totalPages: 1 }, req);
  }
  if (method === "GET" && path === "/api/seller/shipments") {
    const sid = await sellerId(ctx);
    const status = statusFilter(url.searchParams.get("status"));
    let query = ctx.admin.from("shipments").select("*,orders(order_number,recipient_name,recipient_phone,postal_code,road_address,detail_address,delivery_memo),sellers(store_name)", { count: "exact" }).eq("seller_id", sid).order("created_at", { ascending: false }).limit(100);
    if (status) query = query.eq("status", status);
    const { data, error, count } = await query;
    if (error) throw error;
    return ok({ content: data || [], totalElements: count || 0, totalPages: 1 }, req);
  }
  const shipmentAction = path.match(/^\/api\/seller\/shipments\/([0-9a-f-]{36})\/(prepare|dispatch|in-transit|delivered)$/i);
  if (shipmentAction && method === "POST") {
    const target = ({ prepare: "PREPARING", dispatch: "SHIPPED", "in-transit": "IN_TRANSIT", delivered: "DELIVERED" } as Record<string, string>)[shipmentAction[2]];
    return ok(await rpc(ctx, "transition_shipment", { p_shipment_id: shipmentAction[1], p_target: target, p_payload: body }), req);
  }
  if (method === "GET" && path === "/api/seller/claims") {
    const sid = await sellerId(ctx); const status = statusFilter(url.searchParams.get("status"));
    let query = ctx.admin.from("claims").select("*,order_items!inner(*,products(name,primary_image_url)),claim_evidence(*),claim_history(*)", { count: "exact" }).eq("order_items.seller_id", sid).order("created_at", { ascending: false }).limit(100);
    if (status) query = query.eq("status", status);
    const { data, error, count } = await query; if (error) throw error;
    return ok({ content: data || [], totalElements: count || 0, totalPages: 1 }, req);
  }
  const sellerClaimAction = path.match(/^\/api\/seller\/claims\/([0-9a-f-]{36})\/(approve|reject|received|complete-return|replacement)$/i);
  if (sellerClaimAction && method === "POST") {
    const sid = await sellerId(ctx);
    const before = await claimRefundContext(ctx, sellerClaimAction[1]);
    if (String(before.sellerId) !== sid && ctx.role !== "admin") throw Object.assign(new Error("CLAIM_FORBIDDEN"), { status: 403 });
    if (sellerClaimAction[2] === "complete-return") {
      if (before.claimType !== "RETURN" || before.claimStatus !== "RETURN_RECEIVED") throw Object.assign(new Error("RETURN_NOT_READY_FOR_REFUND"), { status: 409 });
      return ok({ ...before, immediateRefund: true, restockAllowed: true }, req, 202);
    }
    const result = await rpc(ctx, "transition_claim", { p_claim_id: sellerClaimAction[1], p_action: sellerClaimAction[2], p_memo: cleanString(body.memo, 1000), p_payload: body }) as Record<string, unknown>;
    if (sellerClaimAction[2] === "approve" && before.claimType === "CANCEL") return ok({ ...result, ...before, claimStatus: "APPROVED", immediateRefund: true, restockAllowed: false }, req, 202);
    return ok(result, req);
  }
  if (method === "GET" && path === "/api/seller/questions") {
    const sid = await sellerId(ctx); const status = statusFilter(url.searchParams.get("status"));
    let query = ctx.admin.from("product_questions").select("*,products!inner(name,seller_id),profiles(display_name)", { count: "exact" }).eq("products.seller_id", sid).order("created_at", { ascending: false }).limit(100);
    if (status) query = query.eq("status", status);
    const { data, error, count } = await query; if (error) throw error;
    return ok({ content: data || [], totalElements: count || 0, totalPages: 1 }, req);
  }
  const answerQuestion = path.match(/^\/api\/seller\/questions\/([0-9a-f-]{36})\/answer$/i);
  if (answerQuestion && method === "POST") {
    const sid = await sellerId(ctx);
    const user = requireUser(ctx);
    const { data: question, error: questionError } = await ctx.admin.from("product_questions").select("id,product_id").eq("id", answerQuestion[1]).single();
    if (questionError) throw questionError;
    const { count, error: ownerError } = await ctx.admin.from("products").select("*", { count: "exact", head: true }).eq("id", question.product_id).eq("seller_id", sid);
    if (ownerError) throw ownerError;
    if (!count) throw Object.assign(new Error("QUESTION_FORBIDDEN"), { status: 403 });
    const { data, error } = await ctx.admin.from("product_questions").update({
      answer_content: cleanString(body.answerContent || body.answer, 5000),
      answered_by: user.id, answered_at: new Date().toISOString(), status: "ANSWERED",
    }).eq("id", answerQuestion[1]).select().single();
    if (error) throw error;
    return ok(data, req);
  }
  if (method === "GET" && path === "/api/seller/coupons") {
    const sid = await sellerId(ctx);
    const { data, error } = await ctx.admin.from("coupons").select("*,coupon_issues(count)").eq("seller_id", sid).order("created_at", { ascending: false });
    if (error) throw error;
    return ok(data || [], req);
  }
  if (method === "POST" && path === "/api/seller/coupons") {
    const sid = await sellerId(ctx); const user = requireUser(ctx);
    const row = { seller_id: sid, code: cleanString(body.code, 50).toUpperCase(), name: cleanString(body.name, 200), description: cleanString(body.description, 1000), discount_type: String(body.discountType || body.type || "FIXED").toUpperCase(), discount_value: integer(body.discountValue || body.value, 0, 1), minimum_order_amount: integer(body.minimumOrderAmount || body.minOrder, 0, 0), maximum_discount_amount: body.maximumDiscountAmount || body.maxDiscount || null, total_issue_limit: body.totalIssueLimit || null, per_user_limit: integer(body.perUserLimit, 1, 1, 100), starts_at: body.startsAt || body.start, ends_at: body.endsAt || body.end, status: "ACTIVE", scope: String(body.scope || "ALL").toUpperCase(), product_id: body.productId || null, created_by: user.id };
    const { data, error } = await ctx.admin.from("coupons").insert(row).select().single(); if (error) throw error;
    return ok(data, req, 201);
  }
  const couponIssue = path.match(/^\/api\/seller\/coupons\/([0-9a-f-]{36})\/issues$/i);
  if (couponIssue && method === "POST") {
    const sid = await sellerId(ctx);
    const { data: coupon } = await ctx.admin.from("coupons").select("*").eq("id", couponIssue[1]).eq("seller_id", sid).single();
    if (!coupon) throw new Error("COUPON_NOT_FOUND");
    const email = cleanString(body.consumerEmail, 320).toLowerCase();
    const { data: userData } = await ctx.admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const target = userData.users.find((x) => String(x.email || "").toLowerCase() === email);
    if (!target) throw new Error("CONSUMER_NOT_FOUND");
    const { data, error } = await ctx.admin.from("coupon_issues").insert({ coupon_id: coupon.id, user_id: target.id, expires_at: coupon.ends_at }).select().single(); if (error) throw error;
    return ok(data, req, 201);
  }
  const couponStatus = path.match(/^\/api\/seller\/coupons\/([0-9a-f-]{36})\/status$/i);
  if (couponStatus && method === "POST") {
    const sid = await sellerId(ctx); const status = statusFilter(url.searchParams.get("status")) || "PAUSED";
    const { data, error } = await ctx.admin.from("coupons").update({ status }).eq("id", couponStatus[1]).eq("seller_id", sid).select().single(); if (error) throw error;
    return ok(data, req);
  }
  if (path === "/api/seller/settlement-account") {
    const sid = await sellerId(ctx);
    if (method === "GET") {
      const { data, error } = await ctx.admin.from("seller_settlement_accounts").select("id,seller_id,bank_code,bank_name,account_holder,account_number_last4,account_type,verification_status,consented_at,verified_at,updated_at").eq("seller_id", sid).maybeSingle(); if (error) throw error;
      return ok(data, req);
    }
    if (["POST", "PUT"].includes(method)) {
      const raw = cleanString(body.accountNumber, 100).replace(/\s/g, "");
      if (!/^[0-9]{8,20}$/.test(raw)) throw new Error("ACCOUNT_NUMBER_INVALID");
      const encrypted = await encryptAccountNumber(raw)
      const row = { seller_id: sid, bank_code: cleanString(body.bankCode || body.bankName, 30), bank_name: cleanString(body.bankName, 100), account_holder: cleanString(body.accountHolder, 100), account_number_encrypted: encrypted, account_number_last4: raw.slice(-4), account_type: String(body.accountType || "BUSINESS").toUpperCase(), verification_status: "PENDING", consented_at: new Date().toISOString() };
      const { data, error } = await ctx.admin.from("seller_settlement_accounts").upsert(row, { onConflict: "seller_id" }).select("id,seller_id,bank_code,bank_name,account_holder,account_number_last4,account_type,verification_status,consented_at,updated_at").single(); if (error) throw error;
      return ok(data, req);
    }
  }
  if (method === "GET" && path === "/api/seller/settlements") {
    const sid = await sellerId(ctx);
    const { data, error, count } = await ctx.admin.from("settlements").select("*,settlement_items(*)", { count: "exact" }).eq("seller_id", sid).order("period_end", { ascending: false }).limit(100); if (error) throw error;
    return ok({ content: data || [], totalElements: count || 0, totalPages: 1 }, req);
  }
  if (method === "POST" && path === "/api/seller/settlements") {
    const sid = await sellerId(ctx);
    const { data: policy } = await ctx.admin.from("settlement_policies").select("*").eq("active", true).eq("locked", true).order("effective_from", { ascending: false }).limit(1).maybeSingle();
    if (!policy) throw new Error("SETTLEMENT_POLICY_NOT_READY");
    const start = body.periodStart || body.start; const end = body.periodEnd || body.end;
    const { data: items, error } = await ctx.admin.from("order_items").select("id,item_total,status,orders!inner(confirmed_at)").eq("seller_id", sid).eq("status", "CONFIRMED").gte("orders.confirmed_at", `${start}T00:00:00Z`).lte("orders.confirmed_at", `${end}T23:59:59Z`); if (error) throw error;
    const gross = (items || []).reduce((a: number, x: any) => a + Number(x.item_total || 0), 0); const fee = Math.floor(gross * Number(policy.platform_fee_bps) / 10000); const net = gross - fee;
    const { data: settlement, error: settlementError } = await ctx.admin.from("settlements").insert({ seller_id: sid, period_start: start, period_end: end, gross_amount: gross, fee_amount: fee, net_amount: net, status: "APPROVAL_PENDING", policy_id: policy.id }).select().single(); if (settlementError) throw settlementError;
    if ((items || []).length) await ctx.admin.from("settlement_items").insert((items || []).map((x: any) => ({ settlement_id: settlement.id, order_item_id: x.id, gross_amount: x.item_total, fee_amount: Math.floor(Number(x.item_total) * Number(policy.platform_fee_bps) / 10000), net_amount: Number(x.item_total) - Math.floor(Number(x.item_total) * Number(policy.platform_fee_bps) / 10000) })));
    return ok(settlement, req, 201);
  }
  if (method === "POST" && path === "/api/seller/marketing/messages") {
    const sid = await sellerId(ctx); const user = requireUser(ctx);
    const { count } = await ctx.admin.from("seller_favorites").select("*", { count: "exact", head: true }).eq("seller_id", sid);
    const { data, error } = await ctx.admin.from("marketing_messages").insert({ seller_id: sid, audience: cleanString(body.audience || "FAVORITE_CUSTOMERS", 100), message: cleanString(body.message, 1000), target_count: count || 0, requested_by: user.id }).select().single(); if (error) throw error;
    return ok(data, req, 202);
  }
  if (method === "GET" && ["/api/seller/operations/readiness", "/api/seller/operations/checklist"].includes(path)) {
    const sid = await sellerId(ctx);
    const checks = await Promise.all([
      ctx.admin.from("seller_kyc").select("status").eq("seller_id", sid).maybeSingle(),
      ctx.admin.from("seller_settlement_accounts").select("verification_status").eq("seller_id", sid).maybeSingle(),
      ctx.admin.from("products").select("*", { count: "exact", head: true }).eq("seller_id", sid).eq("approval_status", "APPROVED"),
      ctx.admin.from("shipments").select("*", { count: "exact", head: true }).eq("seller_id", sid).in("status", ["READY", "PREPARING"]),
    ]);
    return ok({ metrics: { kycStatus: checks[0].data?.status || "NOT_STARTED", settlementAccountStatus: checks[1].data?.verification_status || "NOT_REGISTERED", approvedProducts: checks[2].count || 0, pendingShipments: checks[3].count || 0 }, tasks: [], checkedAt: new Date().toISOString() }, req);
  }
  if (method === "GET" && path === "/api/seller/alerts/realtime") {
    const sid = await sellerId(ctx);
    const { data: seller } = await ctx.admin.from("sellers").select("owner_id").eq("id", sid).single();
    const { data, error } = await ctx.admin.from("notifications").select("*").eq("user_id", seller?.owner_id).is("read_at", null).order("created_at", { ascending: false }).limit(50); if (error) throw error;
    return ok(data || [], req);
  }

  // Part 45 완전 기능 보강: 폼 임시저장, 질문, 리뷰, 주문/클레임, 엑셀, 배송 일괄처리
  if (path === "/api/form-drafts") {
    const user = requireUser(ctx);
    const formKey = cleanString(url.searchParams.get("formKey") || body.draftKey || body.formKey || body.key, 100);
    if (!formKey) throw new Error("FORM_KEY_REQUIRED");
    if (method === "GET") { const { data, error } = await ctx.admin.from("form_drafts").select("*").eq("user_id", user.id).eq("draft_key", formKey).maybeSingle(); if (error) throw error; return ok(data, req); }
    if (["POST", "PUT", "PATCH"].includes(method)) { const { data, error } = await ctx.admin.from("form_drafts").upsert({ user_id: user.id, draft_key: formKey, payload: body.payload || body.data || body, expires_at: body.expiresAt || new Date(Date.now()+30*86400000).toISOString() }, { onConflict: "user_id,draft_key" }).select().single(); if (error) throw error; return ok(data, req); }
    if (method === "DELETE") { const { error } = await ctx.admin.from("form_drafts").delete().eq("user_id", user.id).eq("draft_key", formKey); if (error) throw error; return ok({ success: true }, req); }
  }

  const productQuestionsRoute = path.match(/^\/api\/questions\/products\/([0-9a-f-]{36})$/i);
  if (productQuestionsRoute && method === "GET") {
    let query = ctx.admin.from("product_questions").select("id,user_id,title,content,secret,status,answer_content,answered_at,created_at,profiles(display_name)").eq("product_id", productQuestionsRoute[1]).neq("status", "HIDDEN").order("created_at", { ascending: false });
    const { data, error } = await query; if (error) throw error;
    const rows = (data || []).filter((x: any) => !x.secret || x.user_id === ctx.user?.id || ctx.role === "admin");
    return ok({ content: rows, totalElements: rows.length, totalPages: 1 }, req);
  }
  if (productQuestionsRoute && method === "POST") {
    const user = requireUser(ctx);
    const { data, error } = await ctx.admin.from("product_questions").insert({ product_id: productQuestionsRoute[1], user_id: user.id, title: cleanString(body.title, 300), content: cleanString(body.content, 5000), secret: Boolean(body.secret), status: "WAITING" }).select().single(); if (error) throw error; return ok(data, req, 201);
  }
  const questionOwn = path.match(/^\/api\/questions\/([0-9a-f-]{36})$/i);
  if (questionOwn && ["PUT", "PATCH"].includes(method)) { const user=requireUser(ctx); const {data,error}=await ctx.admin.from("product_questions").update({title:cleanString(body.title,300),content:cleanString(body.content,5000),secret:Boolean(body.secret)}).eq("id",questionOwn[1]).eq("user_id",user.id).eq("status","WAITING").select().single();if(error)throw error;return ok(data,req); }
  if (questionOwn && method === "DELETE") { const user=requireUser(ctx);const{error}=await ctx.admin.from("product_questions").delete().eq("id",questionOwn[1]).eq("user_id",user.id).eq("status","WAITING");if(error)throw error;return ok({success:true},req); }

  const reviewOwn = path.match(/^\/api\/reviews\/([0-9a-f-]{36})$/i);
  if (reviewOwn && ["PUT", "PATCH"].includes(method)) { const user=requireUser(ctx);const{data,error}=await ctx.admin.from("reviews").update({rating:integer(body.rating,5,1,5),content:cleanString(body.content,5000),status:"PUBLISHED"}).eq("id",reviewOwn[1]).eq("user_id",user.id).select().single();if(error)throw error;return ok(data,req); }
  if (reviewOwn && method === "DELETE") { const user=requireUser(ctx);const{error}=await ctx.admin.from("reviews").update({status:"HIDDEN"}).eq("id",reviewOwn[1]).eq("user_id",user.id);if(error)throw error;return ok({success:true},req); }

  const orderAction = path.match(/^\/api\/orders\/([0-9a-f-]{36}|FM-[A-Z0-9-]+)\/(cancel|confirm)$/i);
  if (orderAction && method === "POST") {
    const orderId = /^[0-9a-f-]{36}$/i.test(orderAction[1]) ? orderAction[1] : String((await orderDetails(ctx, orderAction[1])).id);
    return ok(await rpc(ctx, orderAction[2] === "cancel" ? "cancel_order" : "confirm_order", orderAction[2] === "cancel" ? { p_order_id: orderId, p_reason: cleanString(body.reason, 1000) } : { p_order_id: orderId }), req);
  }
  const paymentFailRoute = path.match(/^\/api\/orders\/payments\/([0-9a-f-]{36})\/fail$/i);
  if (paymentFailRoute && method === "POST") { await rpc(ctx, "fail_payment", { p_payment_id: paymentFailRoute[1], p_code: cleanString(body.failureCode || body.code, 100), p_message: cleanString(body.failureMessage || body.message, 1000) }); return ok({ success: true }, req); }

  const claimDetail = path.match(/^\/api\/claims\/([0-9a-f-]{36})$/i);
  if (claimDetail && method === "GET") { const user=requireUser(ctx); const {data,error}=await ctx.admin.from("claims").select("*,order_items(*,orders(buyer_id),sellers(owner_id)),claim_evidence(*),claim_history(*)").eq("id",claimDetail[1]).single();if(error)throw error;const sellerOwner=(data as any)?.order_items?.sellers?.owner_id;if((data as any).requester_id!==user.id&&sellerOwner!==user.id&&ctx.role!=="admin")throw Object.assign(new Error("CLAIM_FORBIDDEN"),{status:403});return ok(data,req); }
  if (claimDetail && method === "DELETE") { const user=requireUser(ctx);const{data,error}=await ctx.admin.from("claims").update({status:"WITHDRAWN"}).eq("id",claimDetail[1]).eq("requester_id",user.id).in("status",["REQUESTED","REVIEWING"]).select().single();if(error)throw error;return ok(data,req); }

  if (method === "GET" && path === "/api/seller/inventory/bulk/template/info") return ok({ columns: ["productId","productName","optionId","sku","currentStock","newStock","reason"], mode: "UPSERT_STOCK_ONLY", maxRows: 5000 }, req);
  if (method === "GET" && path === "/api/seller/inventory/bulk/template") {
    const sid=await sellerId(ctx);const{data,error}=await ctx.admin.from("products").select("id,name,stock_quantity,product_options(id,sku,option_name,stock_quantity)").eq("seller_id",sid).order("updated_at",{ascending:false});if(error)throw error;
    const rows=["productId,productName,optionId,sku,currentStock,newStock,reason"];for(const p of data||[]){if((p as any).product_options?.length){for(const o of (p as any).product_options)rows.push([p.id,p.name,o.id,o.sku,o.stock_quantity,"","재고조정"].map(csvEscape).join(","));}else rows.push([p.id,p.name,"","",p.stock_quantity,"","재고조정"].map(csvEscape).join(","));}
    return ok(downloadPayload(`fruitmarket-inventory-${new Date().toISOString().slice(0,10)}.csv`,`text/csv;charset=utf-8`,`\uFEFF${rows.join("\n")}`),req);
  }
  if (method === "POST" && ["/api/seller/inventory/bulk/preview","/api/seller/inventory/bulk"].includes(path)) {
    await sellerId(ctx);
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 5000) : [];
    if (!rows.length) throw new Error("INVENTORY_ROWS_REQUIRED");
    const functionName = path.endsWith("/preview") ? "preview_inventory_bulk" : "apply_inventory_bulk";
    const result = await rpc(ctx, functionName, { p_rows: rows });
    return ok(result, req);
  }
  const shipmentBatch = path.match(/^\/api\/seller\/shipments\/batch\/(prepare|dispatch)$/i);
  if (shipmentBatch && method === "POST") { const ids=(Array.isArray(body.shipmentIds)?body.shipmentIds:[]).map(uuid);const target=shipmentBatch[1]==="prepare"?"PREPARING":"SHIPPED";const results=[];for(const id of ids)results.push(await rpc(ctx,"transition_shipment",{p_shipment_id:id,p_target:target,p_payload:body}));return ok({processed:results.length,results},req); }
  if (method === "GET" && path === "/api/seller/shipments/carrier-request.csv") { const sid=await sellerId(ctx);const{data,error}=await ctx.admin.from("shipments").select("id,status,carrier_code,tracking_number,orders(order_number,recipient_name,recipient_phone,postal_code,road_address,detail_address)").eq("seller_id",sid).order("created_at");if(error)throw error;const rows=["shipmentId,orderNumber,recipientName,recipientPhone,postalCode,address,carrierCode,trackingNumber"];for(const x of data||[]){const o=(x as any).orders||{};rows.push([x.id,o.order_number,o.recipient_name,o.recipient_phone,o.postal_code,`${o.road_address||""} ${o.detail_address||""}`.trim(),x.carrier_code,x.tracking_number].map(csvEscape).join(","));}return ok(downloadPayload("carrier-request.csv","text/csv;charset=utf-8",`\uFEFF${rows.join("\n")}`),req); }


  // 관리자
  if (path.startsWith("/api/admin/")) requireRole(ctx, ["admin"]);
  if (method === "GET" && path === "/api/admin/statistics") {
    const start = new Date(); start.setMonth(start.getMonth() - 1);
    const [{ data: orders }, { count: sellers }, { count: consumers }, { count: products }] = await Promise.all([
      ctx.admin.from("orders").select("paid_total,status,ordered_at").gte("ordered_at", start.toISOString()),
      ctx.admin.from("sellers").select("*", { count: "exact", head: true }),
      ctx.admin.from("profiles").select("*", { count: "exact", head: true }).eq("role", "consumer"),
      ctx.admin.from("products").select("*", { count: "exact", head: true }),
    ]);
    const gross = (orders || []).filter((x: any) => ["PAID", "PREPARING", "SHIPPED", "IN_TRANSIT", "DELIVERED", "CONFIRMED"].includes(x.status)).reduce((a: number, x: any) => a + Number(x.paid_total || 0), 0);
    const { data: policy } = await ctx.admin.from("settlement_policies").select("platform_fee_bps").eq("active", true).limit(1).maybeSingle();
    const fee = Math.floor(gross * Number(policy?.platform_fee_bps || 0) / 10000);
    return ok({ grossSales: gross, platformFee: fee, sellerNet: gross - fee, effectiveFeeRate: gross ? fee / gross * 100 : 0, sellerCount: sellers || 0, consumerCount: consumers || 0, productCount: products || 0 }, req);
  }
  if (method === "GET" && path === "/api/admin/sellers") {
    const { data, error, count } = await ctx.admin.from("sellers").select("*,profiles!sellers_owner_id_fkey(email,display_name,phone,status),seller_kyc(*),seller_settlement_accounts(id,bank_name,account_holder,account_number_last4,verification_status)", { count: "exact" }).order("created_at", { ascending: false }).limit(300); if (error) throw error;
    return ok({ content: data || [], totalElements: count || 0, totalPages: 1 }, req);
  }
  const adminSellerStatus = path.match(/^\/api\/admin\/sellers\/([0-9a-f-]{36})\/status$/i);
  if (adminSellerStatus && method === "PATCH") {
    const status = String(body.status || "SUSPENDED").toUpperCase();
    const { data, error } = await ctx.admin.from("sellers").update({ status }).eq("id", adminSellerStatus[1]).select().single(); if (error) throw error;
    await audit(ctx, "ADMIN_SELLER_STATUS", "SELLER", adminSellerStatus[1], cleanString(body.reason, 500), { status });
    return ok(data, req);
  }
  if (method === "GET" && path === "/api/admin/seller-applications") {
    const status = statusFilter(url.searchParams.get("status"));
    let query = ctx.admin.from("seller_applications").select("*").order("submitted_at", { ascending: false }).limit(200);
    if (status) query = query.eq("status", status);
    const { data, error } = await query; if (error) throw error;
    return ok({ content: data || [], totalElements: data?.length || 0, totalPages: 1 }, req);
  }
  const adminApp = path.match(/^\/api\/admin\/seller-applications\/([0-9a-f-]{36})$/i);
  if (adminApp && method === "GET") {
    const { data, error } = await ctx.admin.from("seller_applications").select("*,identity_verifications(*)").eq("id", adminApp[1]).single(); if (error) throw error;
    return ok(data, req);
  }
  const adminAppAction = path.match(/^\/api\/admin\/seller-applications\/([0-9a-f-]{36})\/(approve|reject)$/i);
  if (adminAppAction && method === "POST") return ok(await rpc(ctx, adminAppAction[2] === "approve" ? "approve_seller_application" : "reject_seller_application", adminAppAction[2] === "approve" ? { p_application_id: adminAppAction[1], p_memo: cleanString(body.memo, 1000) } : { p_application_id: adminAppAction[1], p_reason: cleanString(body.memo || body.reason, 1000) }), req);
  if (method === "GET" && path === "/api/admin/products") {
    const status = statusFilter(url.searchParams.get("status"));
    let query = ctx.admin.from("products").select(PRODUCT_SELECT, { count: "exact" }).order("updated_at", { ascending: false }).limit(500);
    if (status) query = query.or(`approval_status.eq.${status},sale_status.eq.${status}`);
    const { data, error, count } = await query; if (error) throw error;
    return ok({ content: (data || []).map(normalizeProduct), totalElements: count || 0, totalPages: 1 }, req);
  }
  const adminProductReview = path.match(/^\/api\/admin\/products\/([0-9a-f-]{36})\/commercial-approval$/i);
  if (adminProductReview && ["POST", "PUT", "PATCH"].includes(method)) return ok(await rpc(ctx, "review_product", { p_product_id: adminProductReview[1], p_approve: String(body.status || body.approvalStatus || "APPROVED").toUpperCase() === "APPROVED", p_reason: cleanString(body.reason, 1000) || null }), req);
  const adminProductStatus = path.match(/^\/api\/admin\/products\/([0-9a-f-]{36})\/status$/i);
  if (adminProductStatus && method === "PATCH") {
    const patch = { sale_status: statusFilter(body.saleStatus || body.status), active: body.active !== undefined ? Boolean(body.active) : undefined } as Record<string, unknown>;
    Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);
    const { data, error } = await ctx.admin.from("products").update(patch).eq("id", adminProductStatus[1]).select().single(); if (error) throw error;
    return ok(data, req);
  }
  if (path === "/api/admin/categories") {
    if (method === "GET") { const { data, error } = await ctx.admin.from("categories").select("*").order("sort_order").order("name"); if (error) throw error; return ok(data || [], req); }
    if (method === "POST") { const { data, error } = await ctx.admin.from("categories").insert({ name: cleanString(body.name, 100), slug: cleanString(body.code || body.slug || body.name, 100).toLowerCase().replace(/\s+/g, "-"), icon_key: cleanString(body.iconKey || body.name, 100), sort_order: integer(body.sortOrder, 0), active: body.active !== false }).select().single(); if (error) throw error; return ok(data, req, 201); }
  }
  const adminCategory = path.match(/^\/api\/admin\/categories\/([0-9]+)$/i);
  if (adminCategory && ["PUT", "PATCH"].includes(method)) { const { data, error } = await ctx.admin.from("categories").update({ name: body.name, slug: body.code || body.slug, sort_order: body.sortOrder, icon_key: body.iconKey }).eq("id", Number(adminCategory[1])).select().single(); if (error) throw error; return ok(data, req); }
  if (adminCategory && method === "DELETE") { const { error } = await ctx.admin.from("categories").delete().eq("id", Number(adminCategory[1])); if (error) throw error; return ok({ success: true }, req); }
  const adminCategoryActive = path.match(/^\/api\/admin\/categories\/([0-9]+)\/active$/i);
  if (adminCategoryActive && method === "PATCH") { const { data, error } = await ctx.admin.from("categories").update({ active: Boolean(body.active) }).eq("id", Number(adminCategoryActive[1])).select().single(); if (error) throw error; return ok(data, req); }
  if (path === "/api/admin/home-products" && method === "GET") { const { data, error } = await ctx.admin.from("home_products").select("*,products(name,primary_image_url,sale_price)").order("sort_order"); if (error) throw error; return ok(data || [], req); }
  if (path === "/api/admin/home-products" && method === "POST") { const { data, error } = await ctx.admin.from("home_products").upsert({ product_id: uuid(body.productId), sort_order: integer(body.sortOrder, 0), active: true }).select().single(); if (error) throw error; return ok(data, req, 201); }
  const homeProduct = path.match(/^\/api\/admin\/home-products\/([0-9a-f-]{36})$/i);
  if (homeProduct && method === "DELETE") { const { error } = await ctx.admin.from("home_products").delete().eq("product_id", homeProduct[1]); if (error) throw error; return ok({ success: true }, req); }
  if (path === "/api/admin/promotions/banners") {
    if (method === "GET") { const { data, error } = await ctx.admin.from("banners").select("*").order("sort_order").order("created_at", { ascending: false }); if (error) throw error; return ok(data || [], req); }
    if (method === "POST") { const { data, error } = await ctx.admin.from("banners").insert({ placement: body.placement || "HOME_HERO", title: cleanString(body.title, 300), image_url: cleanString(body.imageUrl || body.url, 2000), link_url: cleanString(body.linkUrl || body.link, 2000) || null, active: body.active !== false, sort_order: integer(body.sortOrder, 0), starts_at: body.startsAt || body.start || null, ends_at: body.endsAt || body.end || null, created_by: ctx.user?.id }).select().single(); if (error) throw error; return ok(data, req, 201); }
  }
  const banner = path.match(/^\/api\/admin\/promotions\/banners\/([0-9a-f-]{36})$/i);
  if (banner && ["PUT", "PATCH"].includes(method)) { const { data, error } = await ctx.admin.from("banners").update({ title: body.title, image_url: body.imageUrl || body.url, link_url: body.linkUrl || body.link, sort_order: body.sortOrder, starts_at: body.startsAt || body.start, ends_at: body.endsAt || body.end }).eq("id", banner[1]).select().single(); if (error) throw error; return ok(data, req); }
  if (banner && method === "DELETE") { const { error } = await ctx.admin.from("banners").delete().eq("id", banner[1]); if (error) throw error; return ok({ success: true }, req); }
  const bannerStatus = path.match(/^\/api\/admin\/promotions\/banners\/([0-9a-f-]{36})\/status$/i);
  if (bannerStatus && method === "PUT") { const { data, error } = await ctx.admin.from("banners").update({ active: String(body.status).toUpperCase() === "ACTIVE" }).eq("id", bannerStatus[1]).select().single(); if (error) throw error; return ok(data, req); }
  if (method === "GET" && path === "/api/admin/orders") {
    const { data, error, count } = await ctx.admin.from("orders").select("*,order_items(*,sellers(store_name)),payments(*),shipments(*)", { count: "exact" }).order("ordered_at", { ascending: false }).limit(300); if (error) throw error;
    return ok({ content: data || [], totalElements: count || 0, totalPages: 1 }, req);
  }
  if (method === "GET" && path === "/api/admin/claims") {
    const status = statusFilter(url.searchParams.get("status")); let query = ctx.admin.from("claims").select("*,order_items(*,products(name),sellers(store_name)),profiles(display_name,email),claim_evidence(*),claim_history(*)", { count: "exact" }).order("created_at", { ascending: false }).limit(200); if (status) query = query.eq("status", status); const { data, error, count } = await query; if (error) throw error; return ok({ content: data || [], totalElements: count || 0, totalPages: 1 }, req);
  }
  const adminClaim = path.match(/^\/api\/admin\/claims\/([0-9a-f-]{36})\/(approve|reject)$/i);
  if (adminClaim && method === "POST") {
    const before = await claimRefundContext(ctx, adminClaim[1]);
    const result = await rpc(ctx, "transition_claim", { p_claim_id: adminClaim[1], p_action: adminClaim[2], p_memo: cleanString(body.memo, 1000), p_payload: body }) as Record<string, unknown>;
    if (adminClaim[2] === "approve" && before.claimType === "CANCEL") return ok({ ...result, ...before, claimStatus: "APPROVED", immediateRefund: true, restockAllowed: false }, req, 202);
    return ok(result, req);
  }
  if (method === "GET" && path === "/api/admin/consumers") {
    const status = statusFilter(url.searchParams.get("status")); let query = ctx.admin.from("profiles").select("id,email,display_name,phone,status,grade,marketing_opt_in,created_at,updated_at", { count: "exact" }).eq("role", "consumer").order("created_at", { ascending: false }).limit(500); if (status) query = query.eq("status", status.toLowerCase()); const { data, error, count } = await query; if (error) throw error; return ok({ content: data || [], totalElements: count || 0, totalPages: 1 }, req);
  }
  const consumerAction = path.match(/^\/api\/admin\/consumers\/([0-9a-f-]{36})\/(suspend|activate)$/i);
  if (consumerAction && method === "POST") { const status = consumerAction[2] === "suspend" ? "suspended" : "active"; const { data, error } = await ctx.admin.from("profiles").update({ status, suspended_reason: consumerAction[2] === "suspend" ? cleanString(body.reason, 500) : null }).eq("id", consumerAction[1]).eq("role", "consumer").select().single(); if (error) throw error; return ok(data, req); }
  const consumerGrade = path.match(/^\/api\/admin\/consumers\/([0-9a-f-]{36})\/grade(?:\/recalculate)?$/i);
  if (consumerGrade && ["PUT", "POST"].includes(method)) { const grade = cleanString(body.grade || "NORMAL", 50).toUpperCase(); const { data, error } = await ctx.admin.from("profiles").update({ grade }).eq("id", consumerGrade[1]).eq("role", "consumer").select().single(); if (error) throw error; return ok(data, req); }
  if (method === "GET" && path === "/api/admin/shipments") { const status = statusFilter(url.searchParams.get("status")); let query = ctx.admin.from("shipments").select("*,orders(order_number,recipient_name),sellers(store_name)", { count: "exact" }).order("created_at", { ascending: false }).limit(300); if (status) query=query.eq("status",status); const { data,error,count }=await query;if(error)throw error;return ok({content:data||[],totalElements:count||0,totalPages:1},req); }
  const adminShipment = path.match(/^\/api\/admin\/shipments\/([0-9a-f-]{36})\/(in-transit|delivered)$/i);
  if (adminShipment && method === "POST") return ok(await rpc(ctx,"transition_shipment",{p_shipment_id:adminShipment[1],p_target:adminShipment[2]==="delivered"?"DELIVERED":"IN_TRANSIT",p_payload:body}),req);
  if (method === "GET" && path === "/api/admin/settlements") { const status=statusFilter(url.searchParams.get("status"));let query=ctx.admin.from("settlements").select("*,sellers(store_name),settlement_items(*)",{count:"exact"}).order("period_end",{ascending:false}).limit(300);if(status)query=query.eq("status",status);const{data,error,count}=await query;if(error)throw error;return ok({content:data||[],totalElements:count||0,totalPages:1},req); }
  const settlementAction = path.match(/^\/api\/admin\/settlements\/([0-9a-f-]{36})\/(approve|hold|release-hold|complete)$/i);
  if (settlementAction && method === "POST") {
    const user=requireUser(ctx);const{data:current,error:readError}=await ctx.admin.from("settlements").select("*").eq("id",settlementAction[1]).single();if(readError)throw readError;
    const patch:Record<string,unknown>={};
    if(settlementAction[2]==="approve") { if(!current.first_approved_by) { patch.first_approved_by=user.id;patch.status="APPROVAL_PENDING"; } else { if(current.first_approved_by===user.id)throw new Error("SECOND_APPROVER_MUST_DIFFER");patch.second_approved_by=user.id;patch.approved_at=new Date().toISOString();patch.status="APPROVED"; } }
    if(settlementAction[2]==="hold"){patch.status="HOLD";patch.hold_reason=cleanString(body.reason,1000)}
    if(settlementAction[2]==="release-hold"){patch.status="APPROVAL_PENDING";patch.hold_reason=null}
    if(settlementAction[2]==="complete"){
      const{data:payout,error:payoutError}=await ctx.admin.from("payout_requests").select("id,status,provider_payout_id,completed_at").eq("settlement_id",settlementAction[1]).maybeSingle();
      if(payoutError)throw payoutError;
      if(!payout||payout.status!=="COMPLETED")throw Object.assign(new Error("PAYOUT_NOT_COMPLETED"),{status:409});
      patch.status="COMPLETED";
    }
    const{data,error}=await ctx.admin.from("settlements").update(patch).eq("id",settlementAction[1]).select().single();if(error)throw error;return ok(data,req);
  }
  if (path === "/api/admin/settlement-policy") {
    if(method==="GET"){const{data,error}=await ctx.admin.from("settlement_policies").select("*").order("effective_from",{ascending:false});if(error)throw error;return ok(data||[],req)}
    if(["POST","PUT"].includes(method)){const{data,error}=await ctx.admin.from("settlement_policies").insert({version:cleanString(body.version||`v${Date.now()}`,100),platform_fee_bps:integer(body.platformFeeBps,0,0,10000),settlement_delay_days:integer(body.settlementDelayDays,7,0,365),effective_from:body.effectiveFrom||new Date().toISOString().slice(0,10),active:Boolean(body.active),locked:false,created_by:ctx.user?.id}).select().single();if(error)throw error;return ok(data,req,201)}
  }
  if(method==="POST"&&path==="/api/admin/settlements/lock-policy"){const id=uuid(body.policyId);await ctx.admin.from("settlement_policies").update({active:false}).neq("id",id);const{data,error}=await ctx.admin.from("settlement_policies").update({active:true,locked:true}).eq("id",id).select().single();if(error)throw error;return ok(data,req)}
  if(method==="GET"&&path==="/api/admin/sellers/settlement-accounts"){const{data,error}=await ctx.admin.from("seller_settlement_accounts").select("id,seller_id,bank_name,account_holder,account_number_last4,account_type,verification_status,consented_at,verified_at,updated_at,sellers(store_name)").order("updated_at",{ascending:false});if(error)throw error;return ok(data||[],req)}
  if(method==="GET"&&path==="/api/admin/operations/unanswered-questions"){const{data,error}=await ctx.admin.from("product_questions").select("*,products(name),profiles(display_name)").eq("status","WAITING").order("created_at").limit(100);if(error)throw error;return ok(data||[],req)}
  if(method==="GET"&&path==="/api/admin/operations/readiness"){const{data,error}=await ctx.admin.from("operation_readiness").select("*").order("category").order("control_key");if(error)throw error;const required=(data||[]).filter((x:any)=>x.required_for_live);return ok({controls:data||[],ready:required.length>0&&required.every((x:any)=>x.status==="VERIFIED"&&(!x.expires_at||new Date(x.expires_at)>new Date())),verified:required.filter((x:any)=>x.status==="VERIFIED").length,total:required.length,checkedAt:new Date().toISOString()},req)}
  if(method==="POST"&&path==="/api/admin/operations/normalize"){const{data,error}=await ctx.admin.rpc("expire_stale_reservations");if(error)throw error;return ok({expiredReservations:data},req)}
  if(method==="POST"&&path==="/api/admin/privacy/mask-expired"){const{data,error}=await ctx.admin.rpc("run_marketplace_scheduled_jobs");if(error)throw error;await audit(ctx,"ADMIN_PRIVACY_RETENTION_RUN","PRIVACY",undefined,cleanString(body.reason,500),data||{});return ok(data,req,202)}
  if(method==="GET"&&path==="/api/admin/alerts/realtime"){const{data,error}=await ctx.admin.from("notifications").select("*").is("read_at",null).order("created_at",{ascending:false}).limit(100);if(error)throw error;return ok(data||[],req)}

  const adminSellerDetail = path.match(/^\/api\/admin\/sellers\/([0-9a-f-]{36})$/i);
  if(adminSellerDetail&&method==="GET"){const{data,error}=await ctx.admin.from("sellers").select("*,profiles!sellers_owner_id_fkey(*),seller_kyc(*),seller_settlement_accounts(id,bank_name,account_holder,account_number_last4,verification_status)").eq("id",adminSellerDetail[1]).single();if(error)throw error;return ok(data,req)}
  const adminProduct = path.match(/^\/api\/admin\/products\/([0-9a-f-]{36})$/i);
  if(adminProduct&&method==="GET"){const{data,error}=await ctx.admin.from("products").select(PRODUCT_SELECT).eq("id",adminProduct[1]).single();if(error)throw error;return ok(normalizeProduct(data),req)}
  if(adminProduct&&["PUT","PATCH"].includes(method)){const patch:any={};for(const[k,v]of Object.entries(body)){const m:any={name:"name",salePrice:"sale_price",listPrice:"list_price",stockQuantity:"stock_quantity",origin:"origin",description:"description",shortDescription:"short_description",shippingFee:"shipping_fee",saleStatus:"sale_status",active:"active"};if(m[k])patch[m[k]]=v}const{data,error}=await ctx.admin.from("products").update(patch).eq("id",adminProduct[1]).select().single();if(error)throw error;return ok(data,req)}
  if(adminProduct&&method==="DELETE"){const{data,error}=await ctx.admin.from("products").update({active:false,sale_status:"STOPPED"}).eq("id",adminProduct[1]).select().single();if(error)throw error;return ok(data,req)}
  const adminOrder = path.match(/^\/api\/admin\/orders\/([0-9a-f-]{36}|FM-[A-Z0-9-]+)$/i);
  if(adminOrder&&method==="GET")return ok(await orderDetails(ctx,adminOrder[1]),req);
  const adminConsumer = path.match(/^\/api\/admin\/consumers\/([0-9a-f-]{36})$/i);
  if(adminConsumer&&method==="GET"){const{data,error}=await ctx.admin.from("profiles").select("*,addresses(*),orders(id,order_number,status,paid_total,ordered_at),coupon_issues(*),point_accounts(*)").eq("id",adminConsumer[1]).single();if(error)throw error;return ok(data,req)}
  if(path==="/api/admin/inventory-excel-templates"&&method==="GET"){const{data,error}=await ctx.admin.from("inventory_excel_templates").select("*").order("version",{ascending:false});if(error)throw error;return ok(data||[],req)}
  if(path==="/api/admin/inventory-excel-templates"&&method==="POST"){const{data,error}=await ctx.admin.from("inventory_excel_templates").insert({title:cleanString(body.title||body.name,200),version:cleanString(body.version||"1",50),file_path:cleanString(body.filePath||"GENERATED",1000),guide_text:cleanString(body.guideText,5000)||null,columns:body.columns||[],validation_rules:body.validationRules||{},active:body.active!==false,created_by:ctx.user?.id}).select().single();if(error)throw error;return ok(data,req,201)}
  const adminTemplateActivate=path.match(/^\/api\/admin\/inventory-excel-templates\/([0-9a-f-]{36})\/activate$/i);
  if(adminTemplateActivate&&method==="POST"){await ctx.admin.from("inventory_excel_templates").update({active:false}).neq("id",adminTemplateActivate[1]);const{data,error}=await ctx.admin.from("inventory_excel_templates").update({active:true,updated_at:new Date().toISOString()}).eq("id",adminTemplateActivate[1]).select().single();if(error)throw error;return ok(data,req)}
  const adminTemplateDownload=path.match(/^\/api\/admin\/inventory-excel-templates\/([0-9a-f-]{36})\/download$/i);
  if(adminTemplateDownload&&method==="GET"){const{data,error}=await ctx.admin.from("inventory_excel_templates").select("*").eq("id",adminTemplateDownload[1]).single();if(error)throw error;const columns=Array.isArray(data.columns)&&data.columns.length?data.columns:["productId","productName","optionId","sku","currentStock","newStock","reason"];return ok(downloadPayload(`fruitmarket-template-${data.version}.csv`,`text/csv;charset=utf-8`,`\uFEFF${columns.map(csvEscape).join(",")}\n`),req)}
  const adminTemplate=path.match(/^\/api\/admin\/inventory-excel-templates\/([0-9a-f-]{36})$/i);
  if(adminTemplate&&["PUT","PATCH"].includes(method)){const{data,error}=await ctx.admin.from("inventory_excel_templates").update({title:body.title||body.name,version:body.version,file_path:body.filePath,guide_text:body.guideText,columns:body.columns,validation_rules:body.validationRules,active:body.active}).eq("id",adminTemplate[1]).select().single();if(error)throw error;return ok(data,req)}
  if(adminTemplate&&method==="DELETE"){const{error}=await ctx.admin.from("inventory_excel_templates").delete().eq("id",adminTemplate[1]);if(error)throw error;return ok({success:true},req)}
  const accountVerify=path.match(/^\/api\/admin\/sellers\/settlement-accounts\/([0-9a-f-]{36})\/(verify|reject)$/i);
  if(accountVerify&&method==="POST"){const status=accountVerify[2]==="verify"?"VERIFIED":"REJECTED";const{data,error}=await ctx.admin.from("seller_settlement_accounts").update({verification_status:status,verified_at:status==="VERIFIED"?new Date().toISOString():null,verified_by:ctx.user?.id,rejection_reason:status==="REJECTED"?cleanString(body.reason,1000):null}).eq("id",accountVerify[1]).select("id,seller_id,bank_name,account_holder,account_number_last4,verification_status,verified_at").single();if(error)throw error;return ok(data,req)}
  const payoutRun=path.match(/^\/api\/admin\/settlements\/([0-9a-f-]{36})\/payout$/i);
  if(payoutRun&&method==="POST"){const result=await rpc(ctx,"request_settlement_payout",{p_settlement_id:payoutRun[1],p_idempotency_key:cleanString(body.idempotencyKey||`PAYOUT:${payoutRun[1]}`,300)});return ok(result,req,202)}
  if(method==="POST"&&path==="/api/admin/operations/readiness"){const{data,error}=await ctx.admin.from("operation_readiness").upsert({control_key:cleanString(body.controlKey,100),category:cleanString(body.category,100),required_for_live:body.requiredForLive!==false,status:String(body.status||"NOT_VERIFIED").toUpperCase(),evidence_hash:cleanString(body.evidenceHash,500)||null,verified_by:ctx.user?.id,verified_at:String(body.status).toUpperCase()==="VERIFIED"?new Date().toISOString():null,expires_at:body.expiresAt||null,notes:cleanString(body.notes,1000)||null},{onConflict:"control_key"}).select().single();if(error)throw error;return ok(data,req)}


  // Part 46: 오픈마켓 법적 통제·과일 신선도·로트 추적 API
  if (method === "GET" && path === "/api/public/marketplace-disclosures") {
    const placement = cleanString(url.searchParams.get("placement"), 50).toUpperCase();
    let query = ctx.admin.from("marketplace_disclosures")
      .select("code,version,title,content,disclosure_type,required_at,effective_from,effective_to")
      .eq("active", true).eq("legal_review_status", "APPROVED")
      .lte("effective_from", new Date().toISOString()).order("code");
    const { data, error } = await query;
    if (error) throw error;
    const now = Date.now();
    const rows = (data || []).filter((row: any) => (!row.effective_to || new Date(row.effective_to).getTime() > now)
      && (!placement || (Array.isArray(row.required_at) && row.required_at.includes(placement))));
    return ok(rows, req);
  }

  const publicTraceability = path.match(/^\/api\/public\/products\/([0-9a-f-]{36})\/traceability$/i);
  if (publicTraceability && method === "GET") {
    const productId = publicTraceability[1];
    const { data: product, error: productError } = await ctx.admin.from("products")
      .select("id,name,origin,approval_status,sale_status,active,sellers(id,store_name,legal_name,business_number,mail_order_report_number,business_status),product_fresh_profiles(*)")
      .eq("id", productId).eq("active", true).eq("approval_status", "APPROVED").eq("sale_status", "ON_SALE").single();
    if (productError) throw productError;
    const { data: evidence, error: evidenceError } = await ctx.admin.from("product_quality_evidence")
      .select("id,evidence_type,document_number,issued_by,issued_at,expires_at,status,metadata")
      .eq("product_id", productId).eq("status", "VERIFIED").order("created_at", { ascending: false });
    if (evidenceError) throw evidenceError;
    const { data: lots, error: lotError } = await ctx.admin.from("inventory_lots")
      .select("id,lot_code,harvest_date,packing_date,recommended_consume_by,qc_status,brix_sample,origin_trace_code,recall_status")
      .eq("product_id", productId).eq("active", true).in("qc_status", ["PASSED", "CONDITIONAL"])
      .eq("recall_status", "NORMAL").order("recommended_consume_by", { ascending: true }).limit(20);
    if (lotError) throw lotError;
    const rawFresh = Array.isArray((product as any).product_fresh_profiles) ? (product as any).product_fresh_profiles[0] : (product as any).product_fresh_profiles;
    const publicProduct = { ...(product as any), product_fresh_profiles: rawFresh?.compliance_status === "APPROVED" ? rawFresh : null };
    return ok({ product: publicProduct, verifiedEvidence: evidence || [], availableLots: lots || [], checkedAt: new Date().toISOString() }, req);
  }

  if (method === "GET" && path === "/api/public/delivery/availability") {
    const productId = uuid(url.searchParams.get("productId"));
    const regionCode = cleanString(url.searchParams.get("regionCode"), 20);
    if (!regionCode) throw new Error("REGION_CODE_REQUIRED");
    const { data: product, error: productError } = await ctx.admin.from("products").select("id,seller_id,today_shipping,active,sale_status,approval_status")
      .eq("id", productId).single();
    if (productError) throw productError;
    const nowIso = new Date().toISOString();
    const { data: hold, error: holdError } = await ctx.admin.from("weather_shipping_holds").select("hold_type,reason,starts_at,ends_at")
      .eq("region_code", regionCode).eq("active", true).lte("starts_at", nowIso).gte("ends_at", nowIso).maybeSingle();
    if (holdError) throw holdError;
    const weekday = new Date().getUTCDay();
    const { data: calendars, error: calendarError } = await ctx.admin.from("delivery_calendars").select("delivery_mode,order_cutoff,expected_ship_days,expected_delivery_days")
      .eq("seller_id", product.seller_id).eq("region_code", regionCode).eq("weekday", weekday).eq("active", true);
    if (calendarError) throw calendarError;
    const productReady = product.active && product.sale_status === "ON_SALE" && product.approval_status === "APPROVED";
    return ok({ available: Boolean(productReady && !hold && (calendars || []).length), weatherHold: hold || null, options: calendars || [], checkedAt: nowIso }, req);
  }

  if (path === "/api/mypage/disputes" && method === "GET") {
    const user = requireUser(ctx);
    const { data, error } = await ctx.admin.from("dispute_cases")
      .select("*,dispute_events(*)").eq("claimant_id", user.id).order("created_at", { ascending: false });
    if (error) throw error;
    return ok(page(data || []), req);
  }
  if (path === "/api/mypage/disputes" && method === "POST") {
    requireUser(ctx);
    const result = await rpc(ctx, "open_dispute_case", {
      p_order_id: uuid(body.orderId), p_order_item_id: uuid(body.orderItemId),
      p_case_type: cleanString(body.caseType || "OTHER", 50), p_title: cleanString(body.title, 300),
      p_description: cleanString(body.description, 5000), p_evidence: Array.isArray(body.evidence) ? body.evidence : [],
    });
    return ok({ disputeId: result }, req, 201);
  }
  const buyerDispute = path.match(/^\/api\/mypage\/disputes\/([0-9a-f-]{36})$/i);
  if (buyerDispute && method === "GET") {
    const user = requireUser(ctx);
    const { data, error } = await ctx.admin.from("dispute_cases").select("*,dispute_events(*)")
      .eq("id", buyerDispute[1]).eq("claimant_id", user.id).single();
    if (error) throw error;
    return ok(data, req);
  }

  const sellerFreshProfile = path.match(/^\/api\/seller\/products\/([0-9a-f-]{36})\/fresh-profile$/i);
  if (sellerFreshProfile && method === "GET") {
    const sid = await sellerId(ctx);
    const { data: owned } = await ctx.admin.from("products").select("id").eq("id", sellerFreshProfile[1]).eq("seller_id", sid).maybeSingle();
    if (!owned) throw Object.assign(new Error("PRODUCT_FORBIDDEN"), { status: 403 });
    const { data, error } = await ctx.admin.from("product_fresh_profiles").select("*").eq("product_id", sellerFreshProfile[1]).maybeSingle();
    if (error) throw error;
    return ok(data, req);
  }
  if (sellerFreshProfile && ["PUT", "PATCH"].includes(method)) {
    const sid = await sellerId(ctx);
    const productId = sellerFreshProfile[1];
    const { data: owned } = await ctx.admin.from("products").select("id").eq("id", productId).eq("seller_id", sid).maybeSingle();
    if (!owned) throw Object.assign(new Error("PRODUCT_FORBIDDEN"), { status: 403 });
    const payload = {
      product_id: productId,
      fruit_type: cleanString(body.fruitType, 100), variety: cleanString(body.variety, 100), cultivar: cleanString(body.cultivar, 100) || null,
      farm_name: cleanString(body.farmName, 200), producer_name: cleanString(body.producerName, 200), production_region: cleanString(body.productionRegion, 300),
      origin_country: cleanString(body.originCountry || "대한민국", 100), grade: cleanString(body.grade, 100) || null,
      size_spec: cleanString(body.sizeSpec, 200) || null, count_spec: cleanString(body.countSpec, 200) || null,
      net_weight_grams: body.netWeightGrams == null ? null : integer(body.netWeightGrams, 0, 1, 1000000),
      harvest_date: body.harvestDate || null, packing_date: body.packingDate || null, recommended_consume_by: body.recommendedConsumeBy || null,
      ripeness_stage: body.ripenessStage || null, ripening_guide: cleanString(body.ripeningGuide, 2000) || null,
      storage_method: cleanString(body.storageMethod, 1000), storage_min_c: body.storageMinC ?? null, storage_max_c: body.storageMaxC ?? null,
      wash_before_eating: body.washBeforeEating !== false, seed_notice: cleanString(body.seedNotice, 500) || null,
      defect_tolerance: cleanString(body.defectTolerance, 1000) || null,
      sweetness_claim_type: String(body.sweetnessClaimType || "NONE").toUpperCase(), brix_min: body.brixMin ?? null, brix_max: body.brixMax ?? null,
      brix_measurement_method: cleanString(body.brixMeasurementMethod, 500) || null, brix_evidence_required: Boolean(body.brixEvidenceRequired),
      gap_certified: Boolean(body.gapCertified), organic_certified: Boolean(body.organicCertified),
      pesticide_test_status: String(body.pesticideTestStatus || "NOT_SUBMITTED").toUpperCase(),
      quarantine_document_required: Boolean(body.quarantineDocumentRequired), traceability_code: cleanString(body.traceabilityCode, 200) || null,
      compliance_status: "REVIEW_REQUIRED", approved_by: null, approved_at: null, updated_at: new Date().toISOString(),
    };
    if (!payload.fruit_type || !payload.variety || !payload.farm_name || !payload.producer_name || !payload.production_region || !payload.storage_method) {
      throw new Error("FRESH_PROFILE_REQUIRED_FIELDS_MISSING");
    }
    const { data, error } = await ctx.admin.from("product_fresh_profiles").upsert(payload, { onConflict: "product_id" }).select().single();
    if (error) throw error;
    const compliance = await ctx.admin.rpc("evaluate_fresh_product_compliance", { p_product_id: productId });
    await audit(ctx, "SELLER_FRESH_PROFILE_UPSERT", "PRODUCT", productId, cleanString(body.reason || "과일 신선정보 수정", 500), { compliance: compliance.data || null });
    return ok({ profile: data, compliance: compliance.data || null }, req);
  }

  const sellerEvidence = path.match(/^\/api\/seller\/products\/([0-9a-f-]{36})\/quality-evidence$/i);
  if (sellerEvidence && method === "GET") {
    const sid = await sellerId(ctx);
    const { data, error } = await ctx.admin.from("product_quality_evidence").select("*").eq("product_id", sellerEvidence[1]).eq("seller_id", sid).order("created_at", { ascending: false });
    if (error) throw error;
    return ok(data || [], req);
  }
  if (sellerEvidence && method === "POST") {
    const sid = await sellerId(ctx);
    const { data: owned } = await ctx.admin.from("products").select("id").eq("id", sellerEvidence[1]).eq("seller_id", sid).maybeSingle();
    if (!owned) throw Object.assign(new Error("PRODUCT_FORBIDDEN"), { status: 403 });
    const { data, error } = await ctx.admin.from("product_quality_evidence").insert({
      product_id: sellerEvidence[1], seller_id: sid, evidence_type: String(body.evidenceType || "OTHER").toUpperCase(),
      file_path: cleanString(body.filePath, 1000), document_number: cleanString(body.documentNumber, 200) || null,
      issued_by: cleanString(body.issuedBy, 300) || null, issued_at: body.issuedAt || null, expires_at: body.expiresAt || null,
      metadata: body.metadata || {}, status: "PENDING",
    }).select().single();
    if (error) throw error;
    return ok(data, req, 201);
  }

  if (path === "/api/seller/inventory/lots" && method === "GET") {
    const sid = await sellerId(ctx);
    const { data, error } = await ctx.admin.from("inventory_lots").select("*,products(name),product_options(option_name,sku)").eq("seller_id", sid)
      .order("recommended_consume_by", { ascending: true }).limit(integer(url.searchParams.get("size"), 300, 1, 1000));
    if (error) throw error;
    return ok(page(data || []), req);
  }
  if (path === "/api/seller/inventory/lots" && method === "POST") {
    const sid = await sellerId(ctx);
    const productId = uuid(body.productId);
    const { data: owned } = await ctx.admin.from("products").select("id").eq("id", productId).eq("seller_id", sid).maybeSingle();
    if (!owned) throw Object.assign(new Error("PRODUCT_FORBIDDEN"), { status: 403 });
    const quantity = integer(body.quantity ?? body.initialQuantity, 0, 0, 10000000);
    const { data, error } = await ctx.admin.from("inventory_lots").insert({
      seller_id: sid, product_id: productId, option_id: body.optionId ? uuid(body.optionId) : null,
      lot_code: cleanString(body.lotCode, 200), harvest_date: body.harvestDate || null, packing_date: body.packingDate || null,
      recommended_consume_by: body.recommendedConsumeBy || null, warehouse_code: cleanString(body.warehouseCode, 100) || null,
      storage_zone: cleanString(body.storageZone, 100) || null, storage_min_c: body.storageMinC ?? null, storage_max_c: body.storageMaxC ?? null,
      initial_quantity: quantity, available_quantity: quantity, brix_sample: body.brixSample ?? null,
      origin_trace_code: cleanString(body.originTraceCode, 200) || null, qc_status: String(body.qcStatus || "PENDING").toUpperCase(),
    }).select().single();
    if (error) throw error;
    return ok(data, req, 201);
  }
  const sellerLot = path.match(/^\/api\/seller\/inventory\/lots\/([0-9a-f-]{36})$/i);
  if (sellerLot && ["PUT", "PATCH"].includes(method)) {
    const sid = await sellerId(ctx);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const mapping: Record<string, string> = { recommendedConsumeBy: "recommended_consume_by", qcStatus: "qc_status", recallStatus: "recall_status", brixSample: "brix_sample", active: "active", storageZone: "storage_zone", warehouseCode: "warehouse_code" };
    for (const [key, column] of Object.entries(mapping)) if (body[key] !== undefined) patch[column] = body[key];
    const { data, error } = await ctx.admin.from("inventory_lots").update(patch).eq("id", sellerLot[1]).eq("seller_id", sid).select().single();
    if (error) throw error;
    return ok(data, req);
  }

  if (path === "/api/seller/disputes" && method === "GET") {
    const sid = await sellerId(ctx);
    const { data, error } = await ctx.admin.from("dispute_cases").select("*,dispute_events(*)").eq("seller_id", sid).order("created_at", { ascending: false });
    if (error) throw error;
    return ok(page(data || []), req);
  }
  const sellerDisputeRespond = path.match(/^\/api\/seller\/disputes\/([0-9a-f-]{36})\/respond$/i);
  if (sellerDisputeRespond && method === "POST") {
    await sellerId(ctx);
    const result = await rpc(ctx, "transition_dispute_case", {
      p_case_id: sellerDisputeRespond[1], p_status: cleanString(body.status || "BUYER_RESPONSE_PENDING", 50),
      p_message: cleanString(body.message, 5000), p_resolution_summary: body.resolutionSummary || null,
      p_liability_party: null, p_compensation_amount: 0,
    });
    return ok(result, req);
  }
  if (path === "/api/seller/performance" && method === "GET") {
    const sid = await sellerId(ctx);
    const { data, error } = await ctx.admin.from("seller_performance_daily").select("*").eq("seller_id", sid).order("metric_date", { ascending: false }).limit(90);
    if (error) throw error;
    return ok(data || [], req);
  }

  if (path === "/api/admin/marketplace/compliance-dashboard" && method === "GET") {
    const { data: summary, error } = await ctx.admin.from("admin_marketplace_compliance_dashboard").select("*").single();
    if (error) throw error;
    const { data: gates, error: gatesError } = await ctx.admin.from("operation_readiness").select("*").order("category").order("control_key");
    if (gatesError) throw gatesError;
    return ok({ summary, gates: gates || [] }, req);
  }
  if (path === "/api/admin/disputes" && method === "GET") {
    const status = statusFilter(url.searchParams.get("status"));
    let query = ctx.admin.from("dispute_cases").select("*,dispute_events(*),orders(order_number),sellers(store_name)")
      .order("priority", { ascending: false }).order("created_at", { ascending: false }).limit(500);
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    return ok(page(data || []), req);
  }
  const adminDisputeTransition = path.match(/^\/api\/admin\/disputes\/([0-9a-f-]{36})\/transition$/i);
  if (adminDisputeTransition && method === "POST") {
    const result = await rpc(ctx, "transition_dispute_case", {
      p_case_id: adminDisputeTransition[1], p_status: cleanString(body.status, 50), p_message: cleanString(body.message, 5000),
      p_resolution_summary: cleanString(body.resolutionSummary, 5000) || null, p_liability_party: body.liabilityParty || null,
      p_compensation_amount: integer(body.compensationAmount, 0, 0, 1000000000),
    });
    await audit(ctx, "ADMIN_DISPUTE_TRANSITION", "DISPUTE", adminDisputeTransition[1], cleanString(body.message, 500), { status: body.status });
    return ok(result, req);
  }

  if (path === "/api/admin/recalls" && method === "GET") {
    const { data, error } = await ctx.admin.from("recall_cases").select("*,recall_lots(*,inventory_lots(lot_code,product_id)),recall_notifications(*)")
      .order("initiated_at", { ascending: false });
    if (error) throw error;
    return ok(page(data || []), req);
  }
  if (path === "/api/admin/recalls" && method === "POST") {
    const user = requireRole(ctx, ["admin"]);
    const { data, error } = await ctx.admin.from("recall_cases").insert({
      title: cleanString(body.title, 300), reason: cleanString(body.reason, 5000), severity: String(body.severity || "NOTICE").toUpperCase(),
      authority_reference: cleanString(body.authorityReference, 500) || null, seller_id: body.sellerId ? uuid(body.sellerId) : null,
      initiated_by: user.id, buyer_notice_template: cleanString(body.buyerNoticeTemplate, 5000) || null,
      seller_instruction: cleanString(body.sellerInstruction, 5000) || null, metadata: body.metadata || {},
    }).select().single();
    if (error) throw error;
    await audit(ctx, "ADMIN_RECALL_OPEN", "RECALL", data.id, cleanString(body.reason, 500), { severity: data.severity });
    return ok(data, req, 201);
  }
  const adminRecallLot = path.match(/^\/api\/admin\/recalls\/([0-9a-f-]{36})\/lots$/i);
  if (adminRecallLot && method === "POST") {
    const lotId = uuid(body.lotId);
    const { data, error } = await ctx.admin.from("recall_lots").insert({ recall_id: adminRecallLot[1], lot_id: lotId, affected_quantity: body.affectedQuantity ?? null }).select().single();
    if (error) throw error;
    await ctx.admin.from("inventory_lots").update({ recall_status: "RECALLING", qc_status: "BLOCKED", active: false, updated_at: new Date().toISOString() }).eq("id", lotId);
    await audit(ctx, "ADMIN_RECALL_LOT_BLOCK", "INVENTORY_LOT", lotId, cleanString(body.reason || "리콜 로트 차단", 500), { recallId: adminRecallLot[1] });
    return ok(data, req, 201);
  }

  if (path === "/api/admin/legal/disclosures" && method === "GET") {
    const { data, error } = await ctx.admin.from("marketplace_disclosures").select("*").order("code");
    if (error) throw error;
    return ok(data || [], req);
  }
  if (path === "/api/admin/legal/disclosures" && method === "POST") {
    const code = cleanString(body.code, 100).toUpperCase();
    const { data, error } = await ctx.admin.from("marketplace_disclosures").upsert({
      code, version: cleanString(body.version, 100), title: cleanString(body.title, 300), content: cleanString(body.content, 20000),
      disclosure_type: String(body.disclosureType || "OTHER").toUpperCase(), required_at: Array.isArray(body.requiredAt) ? body.requiredAt : ["FOOTER"],
      active: body.active !== false, legal_review_status: String(body.legalReviewStatus || "REVIEW_REQUIRED").toUpperCase(),
      approved_by: String(body.legalReviewStatus || "").toUpperCase() === "APPROVED" ? ctx.user?.id : null,
      approved_at: String(body.legalReviewStatus || "").toUpperCase() === "APPROVED" ? new Date().toISOString() : null,
      effective_from: body.effectiveFrom || new Date().toISOString(), effective_to: body.effectiveTo || null,
      content_hash: cleanString(body.contentHash, 500) || null, updated_at: new Date().toISOString(),
    }, { onConflict: "code" }).select().single();
    if (error) throw error;
    await audit(ctx, "ADMIN_DISCLOSURE_UPSERT", "DISCLOSURE", code, cleanString(body.reason || "법정 고지 변경", 500), { version: data.version, legalReviewStatus: data.legal_review_status });
    return ok(data, req, 201);
  }
  const adminDisclosure = path.match(/^\/api\/admin\/legal\/disclosures\/([A-Z0-9_-]+)$/i);
  if (adminDisclosure && ["PUT", "PATCH"].includes(method)) {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const mapping: Record<string, string> = { version: "version", title: "title", content: "content", active: "active", requiredAt: "required_at", effectiveFrom: "effective_from", effectiveTo: "effective_to", legalReviewStatus: "legal_review_status" };
    for (const [key, column] of Object.entries(mapping)) if (body[key] !== undefined) patch[column] = body[key];
    if (String(body.legalReviewStatus || "").toUpperCase() === "APPROVED") { patch.approved_by = ctx.user?.id; patch.approved_at = new Date().toISOString(); }
    const { data, error } = await ctx.admin.from("marketplace_disclosures").update(patch).eq("code", adminDisclosure[1].toUpperCase()).select().single();
    if (error) throw error;
    return ok(data, req);
  }
  if (path === "/api/admin/legal/holds" && method === "POST") {
    const { data, error } = await ctx.admin.from("legal_holds").insert({
      entity_type: cleanString(body.entityType, 100), entity_id: cleanString(body.entityId, 300), reason: cleanString(body.reason, 5000), placed_by: ctx.user?.id,
    }).select().single();
    if (error) throw error;
    await audit(ctx, "ADMIN_LEGAL_HOLD", cleanString(body.entityType, 100), cleanString(body.entityId, 300), cleanString(body.reason, 500), {});
    return ok(data, req, 201);
  }

  if (path === "/api/admin/settlements/reserves" && method === "GET") {
    const { data, error } = await ctx.admin.from("settlement_reserves").select("*,sellers(store_name),settlements(period_start,period_end,status)").order("held_at", { ascending: false }).limit(500);
    if (error) throw error;
    return ok(page(data || []), req);
  }
  if (path === "/api/admin/settlements/adjustments" && method === "GET") {
    const { data, error } = await ctx.admin.from("settlement_adjustments").select("*,sellers(store_name),settlements(period_start,period_end,status)").order("created_at", { ascending: false }).limit(500);
    if (error) throw error;
    return ok(page(data || []), req);
  }
  if (path === "/api/admin/settlements/reconciliations" && method === "GET") {
    const { data, error } = await ctx.admin.from("settlement_reconciliations").select("*").order("created_at", { ascending: false }).limit(500);
    if (error) throw error;
    return ok(page(data || []), req);
  }


  if (path === "/api/seller/contracts/current" && method === "GET") {
    const sid = await sellerId(ctx);
    const { data: contract, error } = await ctx.admin.from("seller_contract_versions").select("id,version,title,body,fee_schedule,settlement_terms,sanctions_policy,effective_from")
      .eq("active", true).eq("legal_review_status", "APPROVED").lte("effective_from", new Date().toISOString()).order("effective_from", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    const { data: acceptance } = contract ? await ctx.admin.from("seller_contract_acceptances").select("accepted_at").eq("seller_id", sid).eq("contract_version_id", contract.id).maybeSingle() : { data: null } as any;
    return ok({ contract, accepted: Boolean(acceptance), acceptedAt: acceptance?.accepted_at || null }, req);
  }
  if (path === "/api/seller/contracts/accept" && method === "POST") {
    const version = cleanString(body.version, 100);
    const result = await rpc(ctx, "accept_current_seller_contract", { p_contract_version: version, p_ip_hash: cleanString(body.ipHash, 500) || null, p_user_agent_hash: cleanString(body.userAgentHash, 500) || null, p_evidence: body.evidence || {} });
    return ok(result, req);
  }

  const adminSellerVerification = path.match(/^\/api\/admin\/sellers\/([0-9a-f-]{36})\/verification$/i);
  if (adminSellerVerification && method === "PATCH") {
    const status = String(body.businessStatus || "UNVERIFIED").toUpperCase();
    if (!["UNVERIFIED","PENDING","VERIFIED","REJECTED","SUSPENDED"].includes(status)) throw new Error("BUSINESS_STATUS_INVALID");
    const { data, error } = await ctx.admin.from("sellers").update({
      business_status: status, legal_name: cleanString(body.legalName, 300) || null,
      mail_order_report_number: cleanString(body.mailOrderReportNumber, 200) || null,
      mail_order_report_agency: cleanString(body.mailOrderReportAgency, 300) || null,
      return_address: cleanString(body.returnAddress, 1000) || null,
      risk_hold: Boolean(body.riskHold), risk_hold_reason: cleanString(body.riskHoldReason, 1000) || null,
      updated_at: new Date().toISOString(),
    }).eq("id", adminSellerVerification[1]).select().single();
    if (error) throw error;
    await audit(ctx, "ADMIN_SELLER_LEGAL_VERIFICATION", "SELLER", adminSellerVerification[1], cleanString(body.reason, 500), { businessStatus: status, riskHold: Boolean(body.riskHold) });
    return ok(data, req);
  }

  const adminFreshReview = path.match(/^\/api\/admin\/products\/([0-9a-f-]{36})\/fresh-review$/i);
  if (adminFreshReview && method === "POST") {
    const approved = String(body.status || body.approvalStatus || "APPROVED").toUpperCase() === "APPROVED";
    const result = await rpc(ctx, "review_fresh_product", { p_product_id: adminFreshReview[1], p_approve: approved, p_reason: cleanString(body.reason, 1000) || null });
    return ok(result, req);
  }
  const adminEvidenceReview = path.match(/^\/api\/admin\/quality-evidence\/([0-9a-f-]{36})\/(verify|reject)$/i);
  if (adminEvidenceReview && method === "POST") {
    const verified = adminEvidenceReview[2] === "verify";
    const { data, error } = await ctx.admin.from("product_quality_evidence").update({
      status: verified ? "VERIFIED" : "REJECTED", verified_by: verified ? ctx.user?.id : null,
      verified_at: verified ? new Date().toISOString() : null, rejection_reason: verified ? null : cleanString(body.reason, 1000),
    }).eq("id", adminEvidenceReview[1]).select().single();
    if (error) throw error;
    await ctx.admin.rpc("evaluate_fresh_product_compliance", { p_product_id: data.product_id });
    await audit(ctx, verified ? "ADMIN_QUALITY_EVIDENCE_VERIFY" : "ADMIN_QUALITY_EVIDENCE_REJECT", "QUALITY_EVIDENCE", data.id, cleanString(body.reason, 500), { productId: data.product_id });
    return ok(data, req);
  }
  const adminProductCompliance = path.match(/^\/api\/admin\/products\/([0-9a-f-]{36})\/legal-compliance$/i);
  if (adminProductCompliance && ["PUT","PATCH"].includes(method)) {
    const { data, error } = await ctx.admin.from("products").update({
      product_info_notice: body.productInfoNotice || {}, return_policy_snapshot: body.returnPolicySnapshot || {},
      prohibited_claim_check: Boolean(body.prohibitedClaimCheck),
      compliance_status: String(body.complianceStatus || "INCOMPLETE").toUpperCase(),
      compliance_flags: Array.isArray(body.complianceFlags) ? body.complianceFlags : [],
      compliance_reviewed_by: ctx.user?.id, compliance_reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", adminProductCompliance[1]).select().single();
    if (error) throw error;
    await audit(ctx, "ADMIN_PRODUCT_LEGAL_COMPLIANCE", "PRODUCT", data.id, cleanString(body.reason, 500), { complianceStatus: data.compliance_status, prohibitedClaimCheck: data.prohibited_claim_check });
    return ok(data, req);
  }

  if (path === "/api/admin/legal/seller-contracts" && method === "GET") {
    const { data, error } = await ctx.admin.from("seller_contract_versions").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    return ok(data || [], req);
  }
  if (path === "/api/admin/legal/seller-contracts" && method === "POST") {
    if (String(body.legalReviewStatus || "REVIEW_REQUIRED").toUpperCase() === "APPROVED" && !body.contentHash) throw new Error("APPROVED_CONTRACT_CONTENT_HASH_REQUIRED");
    if (body.active === true) await ctx.admin.from("seller_contract_versions").update({ active: false }).neq("version", cleanString(body.version, 100));
    const { data, error } = await ctx.admin.from("seller_contract_versions").insert({
      version: cleanString(body.version, 100), title: cleanString(body.title, 300), body: cleanString(body.body, 50000), content_hash: cleanString(body.contentHash, 500),
      fee_schedule: body.feeSchedule || {}, settlement_terms: body.settlementTerms || {}, sanctions_policy: body.sanctionsPolicy || {},
      active: Boolean(body.active), legal_review_status: String(body.legalReviewStatus || "REVIEW_REQUIRED").toUpperCase(),
      approved_by: String(body.legalReviewStatus || "").toUpperCase() === "APPROVED" ? ctx.user?.id : null,
      approved_at: String(body.legalReviewStatus || "").toUpperCase() === "APPROVED" ? new Date().toISOString() : null,
      effective_from: body.effectiveFrom || null,
    }).select().single();
    if (error) throw error;
    await audit(ctx, "ADMIN_SELLER_CONTRACT_CREATE", "SELLER_CONTRACT", data.id, cleanString(body.reason, 500), { version: data.version, active: data.active });
    return ok(data, req, 201);
  }


  // Part 48: 판매자·구매자 상호 부정행위 방지, 증거보존, 이의제기
  if (path === "/api/mypage/trust-protection" && method === "GET") {
    const user = requireUser(ctx);
    const [profileResult, casesResult, appealsResult] = await Promise.all([
      ctx.admin.from("entity_trust_profiles").select("*").eq("entity_type", "BUYER").eq("entity_id", user.id).maybeSingle(),
      ctx.admin.from("trust_review_cases").select("*,trust_case_actions(*),trust_case_evidence(*)").eq("subject_type", "BUYER").eq("subject_id", user.id).order("created_at", { ascending: false }).limit(100),
      ctx.admin.from("trust_appeals").select("*,trust_review_cases(case_number,case_type,status,decision,decision_reason,appeal_deadline)").eq("appellant_id", user.id).order("created_at", { ascending: false }).limit(100),
    ]);
    if (profileResult.error) throw profileResult.error;
    if (casesResult.error) throw casesResult.error;
    if (appealsResult.error) throw appealsResult.error;
    return ok({
      profile: profileResult.data || { entity_type: "BUYER", entity_id: user.id, risk_score: 0, risk_level: "NORMAL", final_adverse_action: false },
      cases: casesResult.data || [], appeals: appealsResult.data || [],
      principles: { automaticFinalDecision: false, manualReview: true, appealDays: 14, emergencyActionsAreTemporary: true },
    }, req);
  }

  if (path === "/api/mypage/trust-reports" && method === "POST") {
    const user = requireUser(ctx);
    const sellerIdValue = uuid(body.sellerId);
    const orderIdValue = body.orderId ? uuid(body.orderId) : null;
    const { data: sellerRecord, error: sellerLookupError } = await ctx.admin.from("sellers").select("id,approval_status,status").eq("id", sellerIdValue).maybeSingle();
    if (sellerLookupError) throw sellerLookupError;
    if (!sellerRecord) throw new Error("SELLER_NOT_FOUND");
    if (orderIdValue) {
      const { data: ownedItem, error: ownedItemError } = await ctx.admin.from("order_items").select("id,orders!inner(id,buyer_id)").eq("order_id", orderIdValue).eq("seller_id", sellerIdValue).eq("orders.buyer_id", user.id).limit(1).maybeSingle();
      if (ownedItemError) throw ownedItemError;
      if (!ownedItem) throw Object.assign(new Error("ORDER_SELLER_RELATION_FORBIDDEN"), { status: 403 });
    }
    const since = new Date(Date.now() - 86400000).toISOString();
    const { count: dailyReports, error: reportCountError } = await ctx.admin.from("trust_review_cases").select("id", { count: "exact", head: true }).eq("created_by", user.id).gte("created_at", since);
    if (reportCountError) throw reportCountError;
    if ((dailyReports || 0) >= 5) throw Object.assign(new Error("TRUST_REPORT_DAILY_LIMIT"), { status: 429 });
    const summary = cleanString(body.summary || body.reason, 2000);
    if (summary.length < 10) throw new Error("REPORT_SUMMARY_TOO_SHORT");
    const caseType = String(body.caseType || "SELLER_MISCONDUCT").toUpperCase();
    const { data: caseId, error: caseError } = await ctx.admin.rpc("open_trust_review_case", {
      p_subject_type: "SELLER", p_subject_id: sellerIdValue, p_case_type: caseType,
      p_summary: summary, p_facts: { orderId: orderIdValue, reporterId: user.id, evidence: Array.isArray(body.evidence) ? body.evidence : [] },
      p_priority: "NORMAL", p_temporary_action: null, p_temporary_hours: 72, p_emergency: false,
    });
    if (caseError) throw caseError;
    await ctx.admin.from("trust_review_cases").update({ created_by: user.id }).eq("id", caseId).is("created_by", null);
    await audit(ctx, "BUYER_REPORT_SELLER_MISCONDUCT", "TRUST_CASE", String(caseId), summary.slice(0, 500), { sellerId: sellerIdValue, orderId: orderIdValue });
    return ok({ caseId, status: "OPEN", notice: "신고만으로 판매자에게 최종 불이익을 확정하지 않으며, 객관적 증거와 양측 의견을 확인합니다." }, req, 201);
  }

  if (path === "/api/mypage/trust-appeals" && method === "POST") {
    requireUser(ctx);
    const result = await rpc(ctx, "submit_trust_appeal", { p_case_id: uuid(body.caseId), p_reason: cleanString(body.reason, 5000), p_evidence: Array.isArray(body.evidence) ? body.evidence : [] });
    return ok({ appealId: result, status: "RECEIVED" }, req, 201);
  }

  if (path === "/api/seller/trust-protection" && method === "GET") {
    const sid = await sellerId(ctx);
    const [profileResult, casesResult, holdsResult, accountResult] = await Promise.all([
      ctx.admin.from("entity_trust_profiles").select("*").eq("entity_type", "SELLER").eq("entity_id", sid).maybeSingle(),
      ctx.admin.from("trust_review_cases").select("*,trust_case_actions(*),trust_case_evidence(*)").eq("subject_type", "SELLER").eq("subject_id", sid).order("created_at", { ascending: false }).limit(100),
      ctx.admin.from("trust_case_actions").select("*,trust_review_cases!inner(subject_type,subject_id,case_number)").eq("trust_review_cases.subject_type", "SELLER").eq("trust_review_cases.subject_id", sid).eq("status", "ACTIVE").order("created_at", { ascending: false }),
      ctx.admin.from("account_security_events").select("event_type,risk_level,cooling_off_until,confirmed_by_mfa,created_at").eq("seller_id", sid).order("created_at", { ascending: false }).limit(20),
    ]);
    if (profileResult.error) throw profileResult.error;
    if (casesResult.error) throw casesResult.error;
    if (holdsResult.error) throw holdsResult.error;
    if (accountResult.error) throw accountResult.error;
    return ok({
      profile: profileResult.data || { entity_type: "SELLER", entity_id: sid, risk_score: 0, risk_level: "NORMAL", final_adverse_action: false },
      cases: casesResult.data || [], activeActions: holdsResult.data || [], accountSecurityEvents: accountResult.data || [],
      principles: { payoutAccountCoolingOffHours: 72, automaticFinalDecision: false, appealDays: 14 },
    }, req);
  }

  if (path === "/api/seller/trust-reports" && method === "POST") {
    const sid = await sellerId(ctx);
    const buyerId = uuid(body.buyerId);
    const orderIdValue = uuid(body.orderId);
    const claimIdValue = body.claimId ? uuid(body.claimId) : null;
    const { data: ownedItem, error: ownedError } = await ctx.admin.from("order_items").select("id,orders!inner(id,buyer_id)").eq("seller_id", sid).eq("order_id", orderIdValue).eq("orders.buyer_id", buyerId).limit(1).maybeSingle();
    if (ownedError) throw ownedError;
    if (!ownedItem) throw Object.assign(new Error("SELLER_ORDER_RELATION_NOT_FOUND"), { status: 403 });
    if (claimIdValue) {
      const { data: relatedClaim, error: relatedClaimError } = await ctx.admin.from("claims").select("id,order_item_id,order_items!inner(id,order_id,seller_id)").eq("id", claimIdValue).eq("order_items.seller_id", sid).eq("order_items.order_id", orderIdValue).maybeSingle();
      if (relatedClaimError) throw relatedClaimError;
      if (!relatedClaim) throw Object.assign(new Error("CLAIM_ORDER_RELATION_FORBIDDEN"), { status: 403 });
    }
    const since = new Date(Date.now() - 86400000).toISOString();
    const { count: dailyReports, error: reportCountError } = await ctx.admin.from("trust_review_cases").select("id", { count: "exact", head: true }).eq("created_by", ctx.user?.id).gte("created_at", since);
    if (reportCountError) throw reportCountError;
    if ((dailyReports || 0) >= 5) throw Object.assign(new Error("TRUST_REPORT_DAILY_LIMIT"), { status: 429 });
    const summary = cleanString(body.summary || body.reason, 2000);
    if (summary.length < 10) throw new Error("REPORT_SUMMARY_TOO_SHORT");
    const caseType = String(body.caseType || "BUYER_ABUSE").toUpperCase();
    const { data: caseId, error: caseError } = await ctx.admin.rpc("open_trust_review_case", {
      p_subject_type: "BUYER", p_subject_id: buyerId, p_case_type: caseType,
      p_summary: summary, p_facts: { orderId: orderIdValue, claimId: claimIdValue, sellerId: sid, evidence: Array.isArray(body.evidence) ? body.evidence : [] },
      p_priority: "NORMAL", p_temporary_action: null, p_temporary_hours: 72, p_emergency: false,
    });
    if (caseError) throw caseError;
    await ctx.admin.from("trust_review_cases").update({ created_by: ctx.user?.id }).eq("id", caseId).is("created_by", null);
    await audit(ctx, "SELLER_REPORT_BUYER_ABUSE", "TRUST_CASE", String(caseId), summary.slice(0, 500), { buyerId, orderId: orderIdValue, claimId: claimIdValue, sellerId: sid });
    return ok({ caseId, status: "OPEN", notice: "신고만으로 환불 거절이나 계정정지를 확정하지 않으며, 배송·반품·결제 증거를 함께 심사합니다." }, req, 201);
  }

  if (path === "/api/seller/return-inspections" && method === "POST") {
    const sid = await sellerId(ctx);
    const claimId = uuid(body.claimId);
    const { data: claim, error: claimError } = await ctx.admin.from("claims").select("id,order_item_id,order_items!inner(id,seller_id,orders!inner(buyer_id))").eq("id", claimId).single();
    if (claimError) throw claimError;
    if (String((claim as any).order_items?.seller_id) !== String(sid)) throw Object.assign(new Error("RETURN_INSPECTION_FORBIDDEN"), { status: 403 });
    const row = {
      claim_id: claimId, order_item_id: (claim as any).order_item_id, seller_id: sid, inspected_by: ctx.user?.id,
      received_at: body.receivedAt || new Date().toISOString(), package_weight_grams: body.packageWeightGrams == null ? null : integer(body.packageWeightGrams, 0, 0, 1000000),
      expected_weight_grams: body.expectedWeightGrams == null ? null : integer(body.expectedWeightGrams, 0, 0, 1000000),
      seal_status: body.sealStatus || null, item_match_status: body.itemMatchStatus || null, quality_status: body.qualityStatus || null,
      inspection_result: String(body.inspectionResult || "PENDING").toUpperCase(), evidence: Array.isArray(body.evidence) ? body.evidence : [],
      memo: cleanString(body.memo, 3000) || null, completed_at: body.completed === true ? new Date().toISOString() : null, updated_at: new Date().toISOString(),
    };
    const { data, error } = await ctx.admin.from("return_inspections").upsert(row, { onConflict: "claim_id" }).select().single();
    if (error) throw error;
    if (row.inspection_result === "BUYER_FAULT_INDICATOR") {
      await ctx.admin.rpc("record_trust_risk_signal", { p_rule_code: "BUYER_EMPTY_OR_SWITCH_RETURN", p_entity_type: "BUYER", p_entity_id: String((claim as any).order_items?.orders?.buyer_id || ""), p_source: "RETURN_INSPECTION", p_facts: { inspectionId: data.id, claimId, orderItemId: row.order_item_id }, p_order_id: null, p_claim_id: claimId, p_idempotency_key: `RETURN_INSPECTION:${data.id}`, p_points: null }).catch(() => null);
    }
    await audit(ctx, "SELLER_RETURN_INSPECTION", "CLAIM", claimId, row.memo || "반품 검수", { inspectionResult: row.inspection_result, inspectionId: data.id });
    return ok(data, req, 201);
  }

  if (path === "/api/admin/trust/dashboard" && method === "GET") {
    const { data: summary, error: summaryError } = await ctx.admin.from("admin_mutual_protection_dashboard").select("*").single();
    if (summaryError) throw summaryError;
    const { data: rules, error: rulesError } = await ctx.admin.from("trust_risk_rules").select("*").eq("active", true).order("actor_scope").order("severity", { ascending: false });
    if (rulesError) throw rulesError;
    return ok({ summary, rules: rules || [], safeguards: { automaticFinalDecision: false, manualReviewRequired: true, noticeBusinessDays: 3, decisionBusinessDays: 10, appealDays: 14 } }, req);
  }

  if (path === "/api/admin/trust/cases" && method === "GET") {
    const status = statusFilter(url.searchParams.get("status"));
    const subjectType = statusFilter(url.searchParams.get("subjectType"));
    let query = ctx.admin.from("trust_review_cases").select("*,trust_case_actions(*),trust_case_evidence(*),trust_appeals(*)", { count: "exact" }).order("created_at", { ascending: false }).limit(300);
    if (status) query = query.eq("status", status);
    if (subjectType) query = query.eq("subject_type", subjectType);
    const { data, error, count } = await query;
    if (error) throw error;
    return ok({ content: data || [], totalElements: count || 0, totalPages: 1 }, req);
  }

  const adminTrustCase = path.match(/^\/api\/admin\/trust\/cases\/([0-9a-f-]{36})$/i);
  if (adminTrustCase && method === "GET") {
    const { data, error } = await ctx.admin.from("trust_review_cases").select("*,trust_case_actions(*),trust_case_evidence(*),trust_appeals(*)").eq("id", adminTrustCase[1]).single();
    if (error) throw error;
    const { data: signals, error: signalError } = await ctx.admin.from("trust_risk_signals").select("*,trust_risk_rules(title,description,severity)").eq("entity_type", data.subject_type).eq("entity_id", data.subject_id).order("detected_at", { ascending: false });
    if (signalError) throw signalError;
    return ok({ ...data, signals: signals || [] }, req);
  }

  const adminTrustResolve = path.match(/^\/api\/admin\/trust\/cases\/([0-9a-f-]{36})\/resolve$/i);
  if (adminTrustResolve && method === "POST") {
    const result = await rpc(ctx, "resolve_trust_review_case", {
      p_case_id: adminTrustResolve[1], p_decision: cleanString(body.decision, 100), p_reason: cleanString(body.reason, 5000),
      p_signal_status: body.signalStatus ? cleanString(body.signalStatus, 30) : null, p_final_adverse_action: Boolean(body.finalAdverseAction),
    });
    return ok(result, req);
  }

  const adminTrustEvidence = path.match(/^\/api\/admin\/trust\/cases\/([0-9a-f-]{36})\/evidence$/i);
  if (adminTrustEvidence && method === "POST") {
    const hash = cleanString(body.contentHash, 500);
    if (hash.length < 16) throw new Error("EVIDENCE_HASH_REQUIRED");
    const { data, error } = await ctx.admin.from("trust_case_evidence").insert({
      case_id: adminTrustEvidence[1], submitted_by: ctx.user?.id, party_type: String(body.partyType || "PLATFORM").toUpperCase(),
      evidence_type: String(body.evidenceType || "OTHER").toUpperCase(), object_path: cleanString(body.objectPath, 2000) || null,
      content_hash: hash, metadata: body.metadata || {}, captured_at: body.capturedAt || null,
    }).select().single();
    if (error) throw error;
    await audit(ctx, "TRUST_EVIDENCE_ADD", "TRUST_CASE", adminTrustEvidence[1], cleanString(body.memo, 500), { evidenceId: data.id, evidenceType: data.evidence_type });
    return ok(data, req, 201);
  }

  const adminTrustAction = path.match(/^\/api\/admin\/trust\/cases\/([0-9a-f-]{36})\/actions$/i);
  if (adminTrustAction && method === "POST") {
    const temporary = body.temporary !== false;
    const endsAt = temporary ? (body.endsAt || new Date(Date.now() + integer(body.hours, 72, 1, 720) * 3600000).toISOString()) : null;
    const { data, error } = await ctx.admin.from("trust_case_actions").insert({
      case_id: adminTrustAction[1], action_type: String(body.actionType || "NOTICE").toUpperCase(), action_scope: body.scope || {},
      reason: cleanString(body.reason, 3000), temporary, ends_at: endsAt, created_by: ctx.user?.id, approved_by: temporary ? null : ctx.user?.id,
    }).select().single();
    if (error) throw error;
    await audit(ctx, "TRUST_TEMPORARY_ACTION", "TRUST_CASE", adminTrustAction[1], data.reason, { actionId: data.id, actionType: data.action_type, temporary, endsAt });
    return ok(data, req, 201);
  }

  if (path === "/api/admin/trust/appeals" && method === "GET") {
    const { data, error, count } = await ctx.admin.from("trust_appeals").select("*,trust_review_cases(case_number,subject_type,subject_id,case_type,status,decision,decision_reason)", { count: "exact" }).order("created_at", { ascending: false }).limit(300);
    if (error) throw error;
    return ok({ content: data || [], totalElements: count || 0, totalPages: 1 }, req);
  }

  const adminAppealResolve = path.match(/^\/api\/admin\/trust\/appeals\/([0-9a-f-]{36})\/resolve$/i);
  if (adminAppealResolve && method === "POST") {
    const status = String(body.status || "REJECTED").toUpperCase();
    if (!["ACCEPTED","PARTIALLY_ACCEPTED","REJECTED","CLOSED"].includes(status)) throw new Error("APPEAL_STATUS_INVALID");
    const { data, error } = await ctx.admin.from("trust_appeals").update({ status, resolution: cleanString(body.resolution, 5000), resolved_by: ctx.user?.id, resolved_at: new Date().toISOString() }).eq("id", adminAppealResolve[1]).select().single();
    if (error) throw error;
    if (["ACCEPTED","PARTIALLY_ACCEPTED"].includes(status)) {
      await ctx.admin.from("trust_case_actions").update({ status: "REVOKED" }).eq("case_id", data.case_id).eq("status", "ACTIVE");
      await ctx.admin.from("trust_review_cases").update({ updated_at: new Date().toISOString() }).eq("id", data.case_id);
    }
    await audit(ctx, "TRUST_APPEAL_RESOLVE", "TRUST_APPEAL", data.id, data.resolution, { status, caseId: data.case_id });
    return ok(data, req);
  }

  const adminSignalReview = path.match(/^\/api\/admin\/trust\/signals\/([0-9a-f-]{36})\/review$/i);
  if (adminSignalReview && method === "POST") {
    const status = String(body.status || "DISMISSED").toUpperCase();
    if (!["CONFIRMED","DISMISSED","EXPIRED"].includes(status)) throw new Error("SIGNAL_STATUS_INVALID");
    const { data, error } = await ctx.admin.from("trust_risk_signals").update({ status, reviewed_by: ctx.user?.id, reviewed_at: new Date().toISOString(), review_memo: cleanString(body.memo, 3000) }).eq("id", adminSignalReview[1]).select().single();
    if (error) throw error;
    await ctx.admin.rpc("recalculate_entity_trust", { p_entity_type: data.entity_type, p_entity_id: data.entity_id });
    return ok(data, req);
  }


  throw Object.assign(new Error(`ROUTE_NOT_IMPLEMENTED:${method} ${path}`), { status: 404, code: "ROUTE_NOT_IMPLEMENTED" });
}

Deno.serve(async (req: Request) => {
  try {
    return await route(req);
  } catch (error) {
    console.error("fruitmarket-api", error);
    return errorResponse(error, req);
  }
});
