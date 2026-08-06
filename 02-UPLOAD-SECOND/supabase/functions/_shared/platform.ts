import { createClient, SupabaseClient, User } from "npm:@supabase/supabase-js@2";

export type AppRole = "consumer" | "seller" | "admin" | "anonymous";

export interface RequestContext {
  admin: SupabaseClient;
  userClient: SupabaseClient;
  user: User | null;
  profile: Record<string, unknown> | null;
  role: AppRole;
  token: string | null;
  aal: "aal1" | "aal2" | null;
}

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`ENV_REQUIRED:${name}`);
  return value;
}

function firstKey(names: string[]): string {
  for (const name of names) {
    const direct = Deno.env.get(name);
    if (direct) return direct;
  }
  for (const containerName of ["SUPABASE_SECRET_KEYS", "SUPABASE_PUBLISHABLE_KEYS"]) {
    const raw = Deno.env.get(containerName);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed[0]) return String(parsed[0]);
      if (typeof parsed === "object" && parsed) {
        const candidate = Object.values(parsed).find(Boolean);
        if (candidate) return String(candidate);
      }
    } catch { /* allow comma-separated dashboard input */
      const candidate = raw.split(",").map((v) => v.trim()).find(Boolean);
      if (candidate) return candidate;
    }
  }
  throw new Error(`ENV_REQUIRED:${names.join("|")}`);
}

export function serviceClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), firstKey(["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"]), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "X-Client-Info": "fruitmarket-part48-edge" } },
  });
}

function bearer(req: Request): string | null {
  const auth = req.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

export async function requestContext(req: Request): Promise<RequestContext> {
  const admin = serviceClient();
  const token = bearer(req);
  const userClient = createClient(env("SUPABASE_URL"), firstKey(["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"]), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: token ? { headers: { Authorization: `Bearer ${token}`, "X-Client-Info": "fruitmarket-part48-edge-user" } } : undefined,
  });
  let user: User | null = null;
  let profile: Record<string, unknown> | null = null;
  let role: AppRole = "anonymous";
  let aal: "aal1" | "aal2" | null = null;
  if (token) {
    const { data, error } = await admin.auth.getUser(token);
    if (!error && data.user) {
      user = data.user;
      const { data: row } = await admin.from("profiles").select("*").eq("id", user.id).maybeSingle();
      profile = row || null;
      role = String(row?.role || "consumer") as AppRole;
      try {
        const { data: aalData } = await userClient.auth.mfa.getAuthenticatorAssuranceLevel();
        aal = (aalData?.currentLevel || null) as "aal1" | "aal2" | null;
      } catch { aal = "aal1"; }
    }
  }
  return { admin, userClient, user, profile, role, token, aal };
}

export function requireUser(ctx: RequestContext): User {
  if (!ctx.user) {
    const e = new Error("AUTH_REQUIRED");
    (e as { status?: number }).status = 401;
    throw e;
  }
  if (String(ctx.profile?.status || "active") !== "active") {
    const e = new Error("ACCOUNT_NOT_ACTIVE");
    (e as { status?: number }).status = 403;
    throw e;
  }
  return ctx.user;
}

export function requireRole(ctx: RequestContext, roles: AppRole[]): User {
  const user = requireUser(ctx);
  if (!roles.includes(ctx.role)) {
    const e = new Error(`ROLE_FORBIDDEN:${roles.join("|")}`);
    (e as { status?: number }).status = 403;
    throw e;
  }
  if (roles.includes("admin") && ctx.role === "admin" && Deno.env.get("REQUIRE_ADMIN_MFA") !== "false" && ctx.aal !== "aal2") {
    const e = new Error("ADMIN_MFA_REQUIRED");
    (e as { status?: number }).status = 403;
    throw e;
  }
  return user;
}

export async function sellerFor(ctx: RequestContext): Promise<Record<string, unknown>> {
  const user = requireRole(ctx, ["seller", "admin"]);
  let query = ctx.admin.from("sellers").select("*").eq("owner_id", user.id);
  if (ctx.role !== "admin") query = query.eq("approval_status", "APPROVED").eq("status", "ACTIVE");
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("SELLER_NOT_FOUND_OR_NOT_ACTIVE");
  return data;
}

export function parseInput(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") || "";
  if (type.includes("application/json")) return req.json().catch(() => ({}));
  return Promise.resolve({});
}

export function page<T>(rows: T[] | null | undefined, total?: number): { content: T[]; totalElements: number; totalPages: number } {
  const content = rows || [];
  return { content, totalElements: total ?? content.length, totalPages: 1 };
}

export function cleanString(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

export function uuid(value: unknown): string {
  const text = cleanString(value, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new Error("INVALID_UUID");
  return text;
}

export function integer(value: unknown, fallback = 0, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export async function rpc(ctx: RequestContext, fn: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const client = ctx.user ? ctx.userClient : ctx.admin;
  const { data, error } = await client.rpc(fn, args);
  if (error) throw error;
  return data;
}

export async function audit(ctx: RequestContext, action: string, entityType?: string, entityId?: string, reason?: string, payload: Record<string, unknown> = {}): Promise<void> {
  await ctx.admin.from("audit_logs").insert({
    actor_id: ctx.user?.id || null,
    action,
    entity_type: entityType || null,
    entity_id: entityId || null,
    reason: reason || null,
    payload,
  });
}

export function pathParts(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export async function countQuery(query: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}
