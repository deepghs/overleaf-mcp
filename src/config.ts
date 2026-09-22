export interface Config {
  // Server used when a tool call or CLI command does not name one.
  // OL_BASE_URL; defaults to https://www.overleaf.com.
  defaultBaseUrl: string;
  // Additional servers from OL_SERVERS (comma / semicolon / whitespace
  // separated origins or bare hosts). Hosts with a stored cookie are known
  // servers too, so this is only needed to pre-declare servers before login.
  extraServers: string[];
  csrfOverride: string | undefined;
  browserPath: string | undefined;
  insecure: boolean;
}

// Accepts "overleaf.example.org", "https://overleaf.example.org/", or
// "http://localhost:3000". Bare hosts get https://. Paths and trailing
// slashes are dropped — Overleaf is always served from an origin.
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty Overleaf server URL");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Invalid Overleaf server URL: '${raw}'`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported scheme in Overleaf server URL: '${raw}' (use http:// or https://)`);
  }
  return url.origin;
}

export function parseServerList(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    if (!part) continue;
    const normalized = normalizeBaseUrl(part);
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

export function loadConfig(): Config {
  const defaultBaseUrl = normalizeBaseUrl(process.env.OL_BASE_URL ?? "https://www.overleaf.com");
  return {
    defaultBaseUrl,
    extraServers: parseServerList(process.env.OL_SERVERS).filter((s) => s !== defaultBaseUrl),
    csrfOverride: process.env.OL_CSRF?.trim() || undefined,
    browserPath: process.env.OL_BROWSER?.trim() || undefined,
    insecure: process.env.OL_INSECURE === "1",
  };
}
