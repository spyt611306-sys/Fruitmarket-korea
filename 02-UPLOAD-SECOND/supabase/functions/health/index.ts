import { handleOptions, ok, errorResponse } from "../_shared/http.ts";

Deno.serve((request: Request) => {
  const options = handleOptions(request); if (options) return options;
  if (request.method !== "GET") return errorResponse(Object.assign(new Error("METHOD_NOT_ALLOWED"), { status: 405 }), request);
  return ok({ status: "UP", service: "fruitmarket-supabase-functions", version: "45.0.0", checkedAt: new Date().toISOString() }, request);
});
