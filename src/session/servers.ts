// Registry of Overleaf servers this MCP can talk to, and the rule for turning
// a user-supplied `server` argument into a base URL.
//
// Known servers are the union of:
//   - OL_BASE_URL (the default, used when no server is named),
//   - OL_SERVERS (pre-declared extras),
//   - every host with a cookie in cookie.json (anything you ever logged into).
// Identity, HTTP and the socket are all keyed by base URL, so several servers
// can be logged in at once; only one project is *open* at a time, and it
// carries its own server (see ActiveProject.baseUrl).

import { loadConfig, normalizeBaseUrl } from "../config.js";
import { listStored } from "../auth/cookieStore.js";

export interface KnownServer {
  baseUrl: string;
  host: string;
  isDefault: boolean;
  // A cookie is stored for this host. Not validated — it may have expired.
  loggedIn: boolean;
  cookieSavedAt?: number;
  sources: Array<"default" | "env" | "cookie">;
}

export function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host;
}

export async function knownServers(): Promise<KnownServer[]> {
  const config = loadConfig();
  const byHost = new Map<string, KnownServer>();
  const add = (baseUrl: string, source: KnownServer["sources"][number]): KnownServer => {
    const host = hostOf(baseUrl).toLowerCase();
    const existing = byHost.get(host);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return existing;
    }
    const entry: KnownServer = { baseUrl, host, isDefault: false, loggedIn: false, sources: [source] };
    byHost.set(host, entry);
    return entry;
  };
  add(config.defaultBaseUrl, "default").isDefault = true;
  for (const s of config.extraServers) add(s, "env");
  for (const stored of await listStored()) {
    const entry = add(stored.baseUrl, "cookie");
    entry.loggedIn = true;
    entry.cookieSavedAt = stored.savedAt;
  }
  return [...byHost.values()];
}

// `input` may be a bare host ("overleaf.example.org"), an origin, or a URL
// with a path. Hosts are matched against known servers case-insensitively so
// the stored scheme/port win (e.g. an http://localhost:3000 dev instance);
// an unknown host is accepted as https://<host> so a first login can happen.
export async function resolveServer(input?: string): Promise<string> {
  const config = loadConfig();
  if (input === undefined || input.trim() === "") return config.defaultBaseUrl;
  const normalized = normalizeBaseUrl(input);
  const host = hostOf(normalized).toLowerCase();
  const match = (await knownServers()).find((s) => s.host === host);
  return match?.baseUrl ?? normalized;
}

// project_id -> baseUrl, filled by list_projects so open_project can omit
// `server` when several servers are logged in.
const projectServers = new Map<string, string>();

export function rememberProjectServer(projectId: string, baseUrl: string): void {
  projectServers.set(projectId, baseUrl);
}

export function projectServer(projectId: string): string | undefined {
  return projectServers.get(projectId);
}
