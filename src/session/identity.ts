import { loadConfig, type Config } from "../config.js";
import { OverleafAuthError } from "../api/errors.js";
import { logger } from "../util/logger.js";
import { discoverCookie } from "../auth/discover.js";

export interface Identity {
  baseUrl: string;
  cookie: string;
  csrf: string;
  userId: string;
  userEmail: string;
}

// One identity per server, so several Overleaf instances can be logged in
// at once. Keyed by base URL (origin).
const cached = new Map<string, Identity>();
const pending = new Map<string, Promise<Identity>>();

function extractMeta(html: string, name: string): string | undefined {
  const re = new RegExp(`<meta\\s+name=["']${name}["']\\s+content=["']([^"']*)["']`);
  return html.match(re)?.[1];
}

export async function validateCookie(cookie: string, baseUrl: string, config: Config = loadConfig()): Promise<Identity> {
  return resolveIdentity(cookie, baseUrl, config);
}

async function resolveIdentity(cookie: string, baseUrl: string, config: Config): Promise<Identity> {
  const url = `${baseUrl}/project`;
  const res = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: { Cookie: cookie, Connection: "keep-alive" },
  });
  if (res.status === 301 || res.status === 302) {
    const location = res.headers.get("location") ?? "";
    throw new OverleafAuthError(
      `Session cookie for ${new URL(baseUrl).host} rejected (redirected to ${location || "login"}). ` +
        "The cookie is likely expired — run `overleaf-mcp login --server <host>` to refresh.",
    );
  }
  if (!res.ok) {
    throw new OverleafAuthError(`GET ${url} returned HTTP ${res.status}`);
  }
  const html = await res.text();
  const userId = extractMeta(html, "ol-user_id");
  const userEmail = extractMeta(html, "ol-usersEmail") ?? "";
  const csrf = config.csrfOverride ?? extractMeta(html, "ol-csrfToken");
  if (!userId) {
    throw new OverleafAuthError(
      `Could not find ol-user_id meta tag on ${url}. ` +
        "The cookie may be invalid or this is an unsupported Overleaf version.",
    );
  }
  if (!csrf) {
    throw new OverleafAuthError(
      "Could not find ol-csrfToken meta tag and OL_CSRF was not set. " +
        "Pass OL_CSRF as a fallback or check that your Overleaf server emits the meta tag.",
    );
  }
  logger.info(`authenticated on ${new URL(baseUrl).host} as ${userEmail || userId}`);
  return { baseUrl, cookie, csrf, userId, userEmail };
}

export async function getIdentity(baseUrl: string): Promise<Identity> {
  const hit = cached.get(baseUrl);
  if (hit) return hit;
  const inflight = pending.get(baseUrl);
  if (inflight) return inflight;
  const config = loadConfig();
  const p = (async () => {
    const cookie = await discoverCookie(baseUrl);
    return resolveIdentity(cookie, baseUrl, config);
  })()
    .then((id) => {
      cached.set(baseUrl, id);
      return id;
    })
    .finally(() => {
      pending.delete(baseUrl);
    });
  pending.set(baseUrl, p);
  return p;
}

// Drop one server's cached identity, or all of them.
export function clearIdentity(baseUrl?: string): void {
  if (baseUrl === undefined) cached.clear();
  else cached.delete(baseUrl);
}
