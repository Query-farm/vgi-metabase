/**
 * Metabase REST API client: auth, session caching, rate limits and retries.
 *
 * - **Auth.** A `metabase` DuckDB secret carries the instance `base_url` plus either
 *   an `api_key` (sent as `x-api-key`, Metabase 0.49+) or a `username` / `password`
 *   pair. A password login POSTs to `/api/session`, caches the session id in process
 *   memory and sends it as `X-Metabase-Session`; a 401 drops the cached session and
 *   logs in again once. Credentials and session ids never enter table-function
 *   state, URLs, logs or error messages.
 * - **Rate limits.** 429 honours `Retry-After` (seconds or an HTTP date, bounded);
 *   5xx and network errors retry with exponential backoff.
 * - **Read-only.** Only GETs, plus POSTs that change nothing: `POST /api/session`
 *   (login), `POST /api/card/:id/query` (run a saved question) and `POST /api/dataset`
 *   (an ad-hoc SELECT over the Usage Analytics models).
 */

import { createHash } from "node:crypto";
import { secretOfType } from "@query-farm/vgi";
import { log } from "../log.ts";
import { VERSION } from "../meta.ts";

export const SECRET_TYPE = "metabase";
export const TIMEOUT_MS = 120_000;
export const MAX_ATTEMPTS = 5;
/** Longest single wait for a 429's Retry-After. */
export const MAX_RATE_WAIT_MS = 60_000;
export const DEFAULT_PAGE_SIZE = 500;
const USER_AGENT = `vgi-metabase-worker/${VERSION}`;

export class MetabaseError extends Error {}

export interface MetabaseConfig {
  /** Site origin (+ optional path prefix), e.g. https://acme.metabaseapp.com or https://bi.acme.com/metabase */
  baseUrl: string;
  apiKey?: string;
  username?: string;
  password?: string;
  pageSize: number;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Normalize a Metabase site URL: https (http only for loopback fixtures); drop a trailing /api and slashes. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new MetabaseError(
      `metabase secret: base_url '${raw}' is not a URL (expected e.g. https://acme.metabaseapp.com)`,
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new MetabaseError(
      "metabase secret: base_url must use https:// (http:// is accepted only for 127.0.0.1/localhost)",
    );
  }
  if (url.username || url.password) throw new MetabaseError("metabase secret: base_url must not contain credentials");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  return url.origin + path;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Build the client config from the `metabase` secret DuckDB resolved for this call. */
export function configFromSecrets(secrets: Record<string, Record<string, unknown>>): MetabaseConfig {
  const s = secretOfType(secrets as never, SECRET_TYPE) as Record<string, unknown> | undefined;
  if (!s) {
    throw new MetabaseError(
      "no metabase secret: run CREATE SECRET (TYPE metabase, BASE_URL 'https://<site>', API_KEY '<api key>') " +
        "or use USERNAME '<email>', PASSWORD '<password>' instead of API_KEY",
    );
  }
  const base = str(s.base_url);
  if (!base) throw new MetabaseError("metabase secret: base_url is required (e.g. https://acme.metabaseapp.com)");
  const apiKey = str(s.api_key);
  const username = str(s.username);
  const password = typeof s.password === "string" && s.password !== "" ? s.password : undefined;
  if (!apiKey && !(username && password)) {
    throw new MetabaseError("metabase secret: set api_key, or username and password");
  }
  let pageSize = DEFAULT_PAGE_SIZE;
  const ps = s.page_size;
  if (ps !== undefined && ps !== null && ps !== "") {
    const n = Number(ps);
    if (!Number.isInteger(n) || n < 1 || n > 10_000) {
      throw new MetabaseError("metabase secret: page_size must be an integer between 1 and 10000");
    }
    pageSize = n;
  }
  return {
    baseUrl: normalizeBaseUrl(base),
    apiKey,
    username: apiKey ? undefined : username,
    password: apiKey ? undefined : password,
    pageSize,
  };
}

const sessionCache = new Map<string, Promise<string>>();

/** Cache key: site + identity + a hash of the credential (never the credential itself). */
export function cacheKey(cfg: MetabaseConfig): string {
  return createHash("sha256")
    .update([cfg.baseUrl, cfg.apiKey ?? "", cfg.username ?? "", cfg.password ?? ""].join("\u0000"))
    .digest("hex");
}

/** Forget cached sessions (tests). */
export function clearSessionCache(): void {
  sessionCache.clear();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait time from a Retry-After header (seconds or HTTP date), bounded. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const v = headers.get("Retry-After");
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v.trim())) return Math.min(Number(v) * 1000, MAX_RATE_WAIT_MS);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.min(Math.max(0, t - now), MAX_RATE_WAIT_MS);
}

/** Metabase errors are plain text, `{message}`, or `{errors: {field: msg}}` / `{error}`. */
export async function errorSummary(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { message?: string; error?: string; errors?: Record<string, unknown> };
    const parts = [
      j.message,
      j.error,
      ...Object.entries(j.errors ?? {}).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`),
    ];
    return parts.filter(Boolean).join(" - ").slice(0, 400) || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

async function login(cfg: MetabaseConfig): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${cfg.baseUrl}/api/session`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ username: cfg.username, password: cfg.password }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw new MetabaseError(`Metabase login failed: ${(err as Error).message}`);
      await sleep(250 * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      const j = (await res.json()) as { id?: string };
      if (!j.id) throw new MetabaseError("Metabase login response had no session id");
      return j.id;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      const wait = res.status === 429 ? (retryAfterMs(res.headers) ?? 1000 * attempt) : 250 * 2 ** attempt;
      await res.body?.cancel();
      await sleep(wait);
      continue;
    }
    const hint = res.status === 401 || res.status === 400 ? " (check username / password)" : "";
    throw new MetabaseError(`Metabase login failed with HTTP ${res.status}${hint}: ${await errorSummary(res)}`);
  }
}

/** The auth header for a request: x-api-key, or a (cached) session id. */
async function authHeader(cfg: MetabaseConfig): Promise<[string, string]> {
  if (cfg.apiKey) return ["x-api-key", cfg.apiKey];
  const key = cacheKey(cfg);
  let p = sessionCache.get(key);
  if (!p) {
    p = login(cfg);
    sessionCache.set(key, p);
    p.catch(() => sessionCache.delete(key));
  }
  return ["X-Metabase-Session", await p];
}

export interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON body (POST only). */
  json?: unknown;
  /** A 404 yields `null` instead of an error. */
  notFoundNull?: boolean;
}

/** Build an API URL from a path below /api and query parameters (empty values dropped). */
export function apiUrl(cfg: MetabaseConfig, path: string, query?: RequestOptions["query"]): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const q = qs.toString();
  return `${cfg.baseUrl}/api${path}${q ? `?${q}` : ""}`;
}

/** Call one Metabase API endpoint and parse the JSON response. */
export async function metabaseRequest(cfg: MetabaseConfig, path: string, opts: RequestOptions = {}): Promise<unknown> {
  const method = opts.method ?? "GET";
  const url = apiUrl(cfg, path, opts.query);
  let reauthed = false;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      const [h, v] = await authHeader(cfg);
      const headers: Record<string, string> = { Accept: "application/json", [h]: v, "User-Agent": USER_AGENT };
      if (opts.json !== undefined) headers["Content-Type"] = "application/json";
      res = await fetch(url, {
        method,
        headers,
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof MetabaseError) throw err;
      if (attempt >= MAX_ATTEMPTS)
        throw new MetabaseError(`${method} ${redact(url)} failed: ${(err as Error).message}`);
      await sleep(250 * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new MetabaseError(`${method} ${redact(url)} returned non-JSON: ${text.slice(0, 200)}`);
      }
    }
    if (res.status === 404 && opts.notFoundNull) {
      await res.body?.cancel();
      return null;
    }
    if (res.status === 401 && !reauthed && !cfg.apiKey) {
      // The session expired or was revoked: log in again once.
      reauthed = true;
      sessionCache.delete(cacheKey(cfg));
      await res.body?.cancel();
      continue;
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      const hint = res.status === 401 ? (cfg.apiKey ? " (check api_key)" : " (check username / password)") : "";
      throw new MetabaseError(
        `${method} ${redact(url)} failed with HTTP ${res.status}${hint}: ${await errorSummary(res)}`,
      );
    }
    await res.body?.cancel();
    const delay = res.status === 429 ? (retryAfterMs(res.headers) ?? 1000 * attempt) : 250 * 2 ** attempt;
    log.debug(`metabase: HTTP ${res.status} for ${redact(url)}; retry ${attempt} in ${delay} ms`);
    await sleep(delay);
  }
}

/** Show the API path + query of a URL in errors (credentials are never in a URL). */
function redact(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}
