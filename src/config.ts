export interface Config {
  baseUrl: string;
  csrfOverride: string | undefined;
  browserPath: string | undefined;
  insecure: boolean;
}

export function loadConfig(): Config {
  const rawBase = process.env.OL_BASE_URL ?? "https://www.overleaf.com";
  const baseUrl = rawBase.replace(/\/+$/, "");
  return {
    baseUrl,
    csrfOverride: process.env.OL_CSRF?.trim() || undefined,
    browserPath: process.env.OL_BROWSER?.trim() || undefined,
    insecure: process.env.OL_INSECURE === "1",
  };
}
