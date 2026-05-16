// Cookie discovery orchestrator: file first, browser-launch as fallback.
// No env-var path — the file is the only persistent store, and a stale
// cookie always recovers by re-launching Chrome. Concurrent callers for
// the same host share one in-flight promise.

import { logger } from "../util/logger.js";
import { loadStored, saveStored, clearStored } from "./cookieStore.js";
import { captureCookie } from "./browserLogin.js";

const pending = new Map<string, Promise<string>>();

function hostKey(baseUrl: string): string {
  return new URL(baseUrl).host;
}

async function runDiscovery(baseUrl: string): Promise<string> {
  const stored = await loadStored(baseUrl);
  if (stored?.cookie) {
    logger.debug(`auth: using stored cookie for ${hostKey(baseUrl)} (saved ${new Date(stored.savedAt).toISOString()})`);
    return stored.cookie;
  }
  logger.info(`auth: no stored cookie for ${hostKey(baseUrl)}, launching browser to capture one`);
  const captured = await captureCookie(baseUrl);
  await saveStored(baseUrl, captured);
  return captured;
}

export async function discoverCookie(baseUrl: string): Promise<string> {
  const key = hostKey(baseUrl);
  const existing = pending.get(key);
  if (existing) return existing;
  const p = runDiscovery(baseUrl).finally(() => {
    pending.delete(key);
  });
  pending.set(key, p);
  return p;
}

export async function evictAndRediscover(baseUrl: string): Promise<string> {
  await clearStored(baseUrl).catch(() => undefined);
  pending.delete(hostKey(baseUrl));
  return discoverCookie(baseUrl);
}
