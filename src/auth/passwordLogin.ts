import { load } from "cheerio";
import { CookieJar } from "tough-cookie";
import { input, password as passwordPrompt } from "@inquirer/prompts";

export function browserLoginAvailable(): boolean {
  return process.env.OL_HEADLESS !== "1" &&
    !(process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
}

export async function passwordLogin(baseUrl: string, email: string, password: string): Promise<string> {
  const origin = new URL(baseUrl);
  if (origin.username || origin.password || origin.protocol !== "https:") {
    throw new Error("Password login requires an HTTPS URL without embedded credentials.");
  }
  const loginUrl = `${baseUrl.replace(/\/+$/, "")}/login`;
  const jar = new CookieJar();
  const remember = async (res: Response) => {
    for (const value of res.headers.getSetCookie()) await jar.setCookie(value, loginUrl);
  };
  const page = await fetch(loginUrl, { redirect: "manual", signal: AbortSignal.timeout(30000) });
  if (!page.ok) throw new Error(`Login page returned HTTP ${page.status}; browser/SSO login may be required.`);
  await remember(page);
  const $ = load(await page.text());
  const csrf = $('meta[name="ol-csrfToken"]').attr("content") ?? $('input[name="_csrf"]').attr("value");
  if (!csrf) throw new Error("Login page has no CSRF token; unsupported login form.");
  const res = await fetch(loginUrl, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: await jar.getCookieString(loginUrl), "X-Csrf-Token": csrf },
    body: new URLSearchParams({ _csrf: csrf, email, password }),
  });
  // Never forward credentials to a redirect or include server bodies in errors.
  if (![200, 302, 303].includes(res.status)) {
    throw new Error(`Password login rejected (HTTP ${res.status}). Check credentials; CAPTCHA, SSO or 2FA may require browser login.`);
  }
  const location = res.headers.get("location");
  if (location && new URL(location, loginUrl).origin !== origin.origin) {
    throw new Error("External login redirect refused; use browser login for SSO.");
  }
  await remember(res);
  const cookie = await jar.getCookieString(`${baseUrl.replace(/\/+$/, "")}/project`);
  if (!cookie) throw new Error("Login returned no session cookie.");
  return cookie;
}

export async function promptPasswordLogin(baseUrl: string, email?: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Password login requires an interactive terminal. Connect with ssh -t and run login --password there.");
  }
  const account = email ?? await input({ message: "Overleaf email:", validate: s => s.trim().length > 0 || "Email is required" });
  let secret = await passwordPrompt({ message: "Overleaf password:", mask: false });
  try {
    if (!secret) throw new Error("Password must not be empty.");
    return await passwordLogin(baseUrl, account.trim(), secret);
  } finally { secret = ""; }
}
