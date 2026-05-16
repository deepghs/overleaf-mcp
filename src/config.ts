export interface Config {
  baseUrl: string;
  cookie: string;
  csrfOverride: string | undefined;
}

export function loadConfig(): Config {
  const rawBase = process.env.OL_BASE_URL ?? "https://www.overleaf.com";
  const baseUrl = rawBase.replace(/\/+$/, "");
  const cookie = process.env.OL_COOKIE?.trim();
  if (!cookie) {
    throw new Error(
      "Missing OL_COOKIE environment variable. " +
        "Paste your Overleaf session cookie from browser DevTools " +
        "(Application -> Cookies -> https://www.overleaf.com). " +
        "Typical value looks like: 'overleaf_session2=s%3A....; GCLB=...'.",
    );
  }
  return { baseUrl, cookie, csrfOverride: process.env.OL_CSRF?.trim() || undefined };
}
