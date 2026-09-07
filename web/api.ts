/**
 * shared api client for the React interface: one typed module replaces
 * the three copies of apibase()/iscrossorigin()/apifetch() that lived
 * inside login.js, register.js and dashboard.js. the api base resolves
 * from the ?api= query string (persisted for convenience), the
 * window.SADDLE_API global, the "saddle_api" localstorage key or
 * same-origin; cross-origin targets switch to credentials: "include"
 * so the saddlesession cookie still flows. json in, json out, family
 * error handling.
 */

/** localstorage key carrying the persisted api base override. */
const apistoragekey = "saddle_api";

/** standardized error payload answered by every /api/v1 endpoint. */
export type ApiErrorBody = {
  error: { code: string; message: string };
};

/** health endpoint payload (/api/v1/health). */
export type HealthStatus = {
  ok: boolean;
  version: string;
  uptime: number;
};

/** sandbox creation request carried by POST /api/v1/sandboxes. */
export type SandboxSpecPayload = {
  model: string;
  vcpus: number;
  ramgb: number;
  gpu: string;
  mig: string;
  quotamb?: number;
};

/** sandbox creation response. */
export type SandboxCreated = {
  id: string;
  state: string;
};

/** exec response shared by the api and the local engine dispatcher. */
export type ExecResult = {
  output: string;
  exitCode: number;
};

/** session payload answered by the auth endpoints (/api/v1/auth/*). */
export type ApiSession = {
  user: string;
  role: "admin" | "user";
  issuedat: string;
  expiresat: string;
};

declare global {
  interface Window {
    /** optional api base override for static-edge deployments. */
    SADDLE_API?: string;
  }
}

/**
 * resolves the api base: ?api= wins (and persists), then the window
 * global, then localstorage, then same origin ("").
 *
 * @returns the trimmed api base ("" means same-origin).
 */
export function apibase(): string {
  try {
    const fromquery = new URLSearchParams(window.location.search).get("api");
    if (fromquery !== null && fromquery.trim() !== "") {
      const trimmed = fromquery.trim().replace(/\/+$/, "");
      window.localStorage.setItem(apistoragekey, trimmed);
      return trimmed;
    }
    const preset = window.SADDLE_API || window.localStorage.getItem(apistoragekey) || "";
    return String(preset).trim().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/**
 * checks whether the api base points at a different origin.
 *
 * @param base the resolved api base ("" means same-origin).
 * @returns true when the target is cross-origin.
 */
export function iscrossorigin(base: string): boolean {
  if (base === "") return false;
  try {
    return new URL(base, window.location.href).origin !== window.location.origin;
  } catch {
    return false;
  }
}

/**
 * fetch wrapper: json in, json out, credentials follow the origin.
 * sets the content-type automatically whenever a body is present and
 * switches to credentials: "include" for cross-origin bases so the
 * session cookie still reaches the api.
 *
 * @param path the api path (must start with "/").
 * @param init the fetch init; body must already be a json string.
 * @returns the raw response for ok/status handling by the caller.
 */
export async function apifetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = apibase();
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const credentials: RequestCredentials = iscrossorigin(base) ? "include" : "same-origin";
  return fetch(`${base}${path}`, { ...init, headers, credentials });
}

/**
 * probes the api health endpoint with a short timeout.
 *
 * @param base the api base to probe ("" means same-origin).
 * @param timeoutms abort budget in milliseconds.
 * @returns the health payload when the api answers ok, null otherwise.
 */
export async function fetchhealth(base: string, timeoutms = 1500): Promise<HealthStatus | null> {
  try {
    const url = `${base ? base.replace(/\/+$/, "") : ""}/api/v1/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutms);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = (await response.json()) as HealthStatus | null;
    return body && body.ok === true ? body : null;
  } catch {
    return null;
  }
}

/**
 * reads the {error:{code,message}} payload the family endpoints answer
 * with; returns null when the body is not a recognizable error object.
 *
 * @param response a non-ok api response.
 * @returns the error message when present, null otherwise.
 */
export async function apierrormessage(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as ApiErrorBody | null;
    if (payload?.error && typeof payload.error.message === "string") {
      return payload.error.message;
    }
  } catch {
    /* keep null: the generic message stays */
  }
  return null;
}

/**
 * human label for the resolved api base, used by the auth pages status
 * line ("api: same origin" or the cross-origin target with credentials).
 *
 * @returns the status line text.
 */
export function apistatustext(): string {
  const base = apibase();
  return base === "" ? "api: same origin" : `api: ${base} (cross-origin, credentials: include)`;
}
