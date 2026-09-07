// Signal & Ledger: utilitários defensivos do dashboard absorvido do e2ugh —
// payloads tolerantes a shape (as rotas do backend navegam em paralelo) e
// o wrapper único de api ({ok, status, body}) que a página inteira usa.
import { apifetch } from "../api";

/** one api round trip normalized for the whole dashboard. */
export type ApiResult = { ok: boolean; status: number; body: unknown };

/** the browser-local sandbox record (sessionStorage, never persisted elsewhere). */
export type LocalSandbox = {
  id: string;
  spec: { model: string; vcpus: number; ramgb: number; gpu: string; mig: string };
  createdat: string;
  state: string;
};

/** the account normalized out of /auth/me or the local browser session. */
export type SessionUser = {
  username: string;
  role: string;
  createdat: unknown;
  lastloginat: unknown;
  id: unknown;
};

/** the localStorage key the local engine mode keeps its shelf under. */
export const localsandboxkey = "saddle_local_sandboxes";

/**
 * normalizes one call through the shared apifetch wrapper: the consolidated
 * surface answers either the dashboard-style envelope {ok, status, body}
 * or a raw fetch Response; both become {ok, status, body} here so the
 * panels never depend on which page the wrapper was consolidated from.
 */
export async function apiresult(path: string, init?: RequestInit): Promise<ApiResult> {
  const response = (await apifetch(path, init)) as unknown;
  if (
    response !== null &&
    typeof response === "object" &&
    typeof (response as Response).json === "function"
  ) {
    let body: unknown = null;
    try {
      body = await (response as Response).json();
    } catch {
      body = null;
    }
    return { ok: (response as Response).ok, status: (response as Response).status, body };
  }
  const envelope = response as { ok?: boolean; status?: number; body?: unknown } | null;
  return {
    ok: envelope?.ok === true,
    status: typeof envelope?.status === "number" ? envelope.status : 0,
    body: envelope?.body ?? null,
  };
}

/** extracts the {error:{message}} text the api failures carry. */
export function errormessage(result: ApiResult, fallback: string): string {
  const error = (result.body as { error?: { message?: unknown } } | null)?.error;
  const message = error?.message;
  return typeof message === "string" && message.length > 0 ? message : fallback;
}

/** first defined value among candidate keys (case-flexible, snake tolerant). */
export function pick(source: unknown, keys: string[], fallback: unknown = null): unknown {
  if (source === null || source === undefined || typeof source !== "object") {
    return fallback;
  }
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  const lower: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    lower[key.toLowerCase()] = record[key];
  }
  for (const key of keys) {
    const hit = lower[key.toLowerCase()];
    if (hit !== undefined && hit !== null) {
      return hit;
    }
  }
  return fallback;
}

/** array out of a payload that may be a bare array or an envelope. */
export function asarray(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(record[key])) {
        return record[key];
      }
    }
  }
  return [];
}

/** formats a date-ish value (iso string, epoch seconds or ms). */
export function fmtdate(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "-";
  }
  let date: Date | null = null;
  if (typeof value === "number") {
    date = new Date(value < 1e12 ? value * 1000 : value);
  } else {
    date = new Date(String(value));
  }
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/** humanizes a duration in seconds. */
export function fmtuptime(seconds: unknown): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m ${total % 60}s`;
}

/** the state chip class with the raw state sanitized to css-safe characters. */
export function chipclass(state: unknown): string {
  const raw = String(state ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  return `dash-chip ${raw}`;
}

/** normalizes the node role out of a /health payload. */
export function noderole(health: unknown): string {
  const raw = pick(health, ["role", "nodeRole", "node", "mode", "kind"], "standalone");
  if (raw !== null && typeof raw === "object") {
    return String(pick(raw, ["role", "kind", "mode"], "standalone")).toLowerCase();
  }
  return String(raw).toLowerCase();
}

/** reads the browser-local sandbox shelf (sessionStorage, defensive). */
export function readlocalsandboxes(): LocalSandbox[] {
  try {
    const raw = window.sessionStorage.getItem(localsandboxkey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as LocalSandbox[]) : [];
  } catch {
    return [];
  }
}

/** writes the browser-local sandbox shelf. */
export function writelocalsandboxes(list: LocalSandbox[]): void {
  try {
    window.sessionStorage.setItem(localsandboxkey, JSON.stringify(list));
  } catch {
    /* storage may be unavailable; the list stays in memory for this view */
  }
}

/** the static fallback cpu list when the engine catalog is empty. */
export const fallbackcpus = [
  "AMD EPYC 9965",
  "AMD Ryzen 9 9950X3D",
  "AMD Threadripper PRO 9995WX",
  "AMD Threadripper 7980X",
  "Intel Core Ultra 9 285K",
  "AMD EPYC 9955",
  "Intel Xeon 6980P",
  "Apple M3 Ultra",
];

/** the static fallback gpu list when the engine catalog is empty. */
export const fallbackgpus = ["rtx5090", "rtxpro6000", "b200", "h100", "a100", "rx9070xt", "mi350x"];
