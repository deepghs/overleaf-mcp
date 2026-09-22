// Plaintext cookie persistence keyed by Overleaf host.
//
// Stores a single JSON map at <configDir>/overleaf-mcp/cookie.json with mode
// 0600. Multi-host so the same machine can hold credentials for overleaf.com
// and any number of self-hosted instances side-by-side; every host in here is
// a "known server" for list_servers / list_projects. No encryption — see README.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { logger } from "../util/logger.js";

export interface StoredCookie {
  cookie: string;
  savedAt: number;
  // Origin the cookie was captured for. Entries written before 0.4 lack it;
  // those are assumed to be https://<host>.
  baseUrl?: string;
}

export interface StoredServer {
  host: string;
  baseUrl: string;
  savedAt: number;
}

interface StoreShape {
  hosts: Record<string, StoredCookie>;
}

function configRoot(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  }
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

export function cookieFilePath(): string {
  return path.join(configRoot(), "overleaf-mcp", "cookie.json");
}

function hostKey(baseUrl: string): string {
  return new URL(baseUrl).host;
}

async function readStore(): Promise<StoreShape> {
  try {
    const raw = await fs.readFile(cookieFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    return { hosts: parsed.hosts ?? {} };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { hosts: {} };
    logger.warn(`cookie store unreadable, treating as empty: ${(err as Error).message}`);
    return { hosts: {} };
  }
}

async function writeStore(store: StoreShape): Promise<void> {
  const file = cookieFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

export async function loadStored(baseUrl: string): Promise<StoredCookie | null> {
  const store = await readStore();
  return store.hosts[hostKey(baseUrl)] ?? null;
}

// Every host with a stored cookie, with the origin it was captured for.
export async function listStored(): Promise<StoredServer[]> {
  const store = await readStore();
  return Object.entries(store.hosts).map(([host, entry]) => ({
    host,
    baseUrl: entry.baseUrl ?? `https://${host}`,
    savedAt: entry.savedAt,
  }));
}

export async function saveStored(baseUrl: string, cookie: string): Promise<void> {
  const store = await readStore();
  store.hosts[hostKey(baseUrl)] = { cookie, savedAt: Date.now(), baseUrl: new URL(baseUrl).origin };
  await writeStore(store);
}

export async function clearStored(baseUrl: string): Promise<boolean> {
  const store = await readStore();
  const key = hostKey(baseUrl);
  if (!(key in store.hosts)) return false;
  delete store.hosts[key];
  await writeStore(store);
  return true;
}
