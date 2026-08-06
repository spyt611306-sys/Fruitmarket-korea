import { handleOptions, ok, errorResponse } from "../_shared/http.ts";
import { serviceClient } from "../_shared/platform.ts";

Deno.serve(async (req: Request) => {
  const options = handleOptions(req); if (options) return options;
  const admin = serviceClient();
  try {
    if (req.method !== "POST") throw Object.assign(new Error("METHOD_NOT_ALLOWED"), { status: 405 });
    const expected = Deno.env.get("FRUITMARKET_CRON_SECRET") || "";
    const supplied = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || req.headers.get("x-cron-secret") || "";
    if (!expected || supplied !== expected) throw Object.assign(new Error("CRON_FORBIDDEN"), { status: 403 });
    const runKey = `${new Date().toISOString().slice(0, 13)}:marketplace-maintenance`;
    const { data: prior } = await admin.from("scheduled_job_runs").select("*").eq("run_key", runKey).maybeSingle();
    if (prior?.status === "SUCCEEDED") return ok({ ...prior.result, idempotentReplay: true }, req);
    const { data: run, error: insertError } = await admin.from("scheduled_job_runs").upsert({ job_name: "MARKETPLACE_MAINTENANCE", run_key: runKey, status: "STARTED" }, { onConflict: "run_key" }).select().single();
    if (insertError) throw insertError;
    const { data: marketplaceData, error } = await admin.rpc("run_marketplace_scheduled_jobs");
    if (error) throw error;
    const { data: controlData, error: controlError } = await admin.rpc("run_part46_operational_controls");
    if (controlError) throw controlError;
    const { data: trustSafetyData, error: trustSafetyError } = await admin.rpc("run_mutual_protection_controls");
    if (trustSafetyError) throw trustSafetyError;
    const data = { marketplace: marketplaceData, part46Controls: controlData, mutualProtection: trustSafetyData, ranAt: new Date().toISOString() };
    await admin.from("scheduled_job_runs").update({ status: "SUCCEEDED", result: data, completed_at: new Date().toISOString() }).eq("id", run.id);
    return ok(data, req);
  } catch (error) { return errorResponse(error, req, "SCHEDULED_JOB_FAILED"); }
});
