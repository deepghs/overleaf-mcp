// Wrap an authenticated call so a single OverleafAuthError triggers a
// re-discovery (which may re-launch a browser in PR2) and exactly one retry.
//
// Lives in its own module to break a would-be cycle: socket.ts imports
// withAuthRetry, but disconnectActive lives in socket.ts. Resolved here via
// a dynamic import.

import { OverleafAuthError } from "../api/errors.js";
import { loadConfig } from "../config.js";
import { logger } from "../util/logger.js";
import { evictAndRediscover } from "../auth/discover.js";
import { clearIdentity } from "./identity.js";

export async function withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof OverleafAuthError)) throw err;
    const config = loadConfig();
    logger.info(`auth error, attempting recovery: ${err.message}`);
    clearIdentity();
    const { disconnectActive } = await import("../api/socket.js");
    disconnectActive();
    await evictAndRediscover(config.baseUrl);
    return await fn();
  }
}
