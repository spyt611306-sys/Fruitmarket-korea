const defaultOrigins = ["https://fruit-market.netlify.app", "http://localhost:8888", "http://localhost:5173"];

function allowedOrigins(): string[] {
  const configured = (Deno.env.get("ALLOWED_ORIGINS") || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return configured.length ? configured : defaultOrigins;
}

export function corsHeaders(req?: Request): Record<string, string> {
  const origin = req?.headers.get("origin") || "";
  const allowed = allowedOrigins();
  const selected = allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": selected,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, idempotency-key, x-request-id",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

export function json(body: unknown, status = 200, req?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function ok(data: unknown, req?: Request, status = 200): Response {
  return json({ data }, status, req);
}

export function errorResponse(error: unknown, req?: Request, fallbackCode = "INTERNAL_ERROR"): Response {
  const raw = error as { message?: string; code?: string; details?: unknown; status?: number; hint?: unknown };
  const message = String(raw?.message || "요청 처리 중 오류가 발생했습니다.");
  const code = String(raw?.code || fallbackCode);
  let status = Number(raw?.status || 500);
  if (/AUTH_REQUIRED|JWT|SESSION|INVALID_LOGIN/i.test(message + code)) status = 401;
  else if (/FORBIDDEN|ROLE_|ACCOUNT_NOT_ACTIVE|RLS|42501/i.test(message + code)) status = 403;
  else if (/NOT_FOUND|PGRST116/i.test(message + code)) status = 404;
  else if (/CONFLICT|DUPLICATE|23505|IDEMPOTENCY/i.test(message + code)) status = 409;
  else if (/REQUIRED|INVALID|SHORTAGE|OUT_OF_RANGE|MISMATCH|23514|22P02/i.test(message + code)) status = 400;
  return json({ error: { code, message, details: raw?.details || null, hint: raw?.hint || null } }, status, req);
}

export function handleOptions(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}
