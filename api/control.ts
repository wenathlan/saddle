/**
 * control service exposes operator controls through Web Request and Response without selecting a web framework.
 */

import { authorize } from "./auth.js";
import { requestcontext } from "./contracts.js";
import { errorresponse, jsonresponse } from "./http.js";
import { controlsurface } from "../automation/surfacecontrols.js";

/** Creates a framework-neutral HTTP handler for an injected operator control surface. */
export function controlservice(options = {}) {
  const controls = options.controls ?? controlsurface({ adapters: options.adapters, audit: options.audit });
  const path = String(options.path ?? "/v1/control");
  if (!path.startsWith("/")) throw new TypeError("control service path must be absolute");

  async function handle(request) {
    const context = requestcontext(request, { path });
    try {
      await authorize(request, { verify: options.verify });
      const url = new URL(request.url ?? request);
      if (url.pathname !== path) return errorresponse("NOT_FOUND", "control route not found", { status: 404, requestid: context.requestid });
      if (request.method === "GET") return jsonresponse({ ...controls.describe(), requestid: context.requestid });
      if (request.method !== "POST") return errorresponse("METHOD_NOT_ALLOWED", "control route requires GET or POST", { status: 405, requestid: context.requestid });
      const input = typeof request.json === "function" ? await request.json() : {};
      const result = await controls.execute(input);
      return jsonresponse({ requestid: context.requestid, data: result }, { status: result.ok ? 200 : 409 });
    } catch (error) {
      return errorresponse(error?.code ?? "CONTROL_REQUEST_FAILED", error?.message ?? error, { status: error?.code === "UNAUTHORIZED" ? 401 : 400, requestid: context.requestid });
    }
  }

  return { path, controls, handle };
}
