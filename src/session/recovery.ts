// Wrap an authenticated call so a single OverleafAuthError triggers a
// re-discovery (which may re-launch a browser) and exactly one retry.
//
// Scoped to one server: only that server's identity, cookie and (if it is
// the one the open project lives on) socket are torn down. A stale cookie on
// server B must not disturb a healthy session on server A.
//
// Lives in its own module to break a would-be cycle: socket.ts imports
// withAuthRetry, but disconnectActiveIf lives in socket.ts. Resolved here via
// a dynamic import.

import { OverleafAuthError } from "../api/errors.js";
import { logger } from "../util/logger.js";
import { evictAndRediscover } from "../auth/discover.js";
import { clearIdentity } from "./identity.js";

export async function withAuthRetry<T>(baseUrl: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof OverleafAuthError)) throw err;
    logger.info(`auth error on ${new URL(baseUrl).host}, attempting recovery: ${err.message}`);
    clearIdentity(baseUrl);
    const { disconnectActiveIf } = await import("../api/socket.js");
    disconnectActiveIf(baseUrl);
    await evictAndRediscover(baseUrl);
    return await fn();
  }
}
