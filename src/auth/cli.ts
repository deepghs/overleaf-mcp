// `overleaf-mcp login | logout | status` subcommands. Invoked before the
// MCP stdio server boots. Supports isolated browser or interactive password
// login, against any number of Overleaf servers (`--server <host|url>`;
// defaults to OL_BASE_URL).

import { stdin, stdout } from "node:process";

import { loadConfig } from "../config.js";
import { validateCookie, clearIdentity } from "../session/identity.js";
import { hostOf, knownServers, resolveServer } from "../session/servers.js";
import { saveStored, clearStored, loadStored, cookieFilePath } from "./cookieStore.js";
import { captureCookie } from "./browserLogin.js";
import { browserLoginAvailable, promptPasswordLogin } from "./passwordLogin.js";

function writeOut(line: string): void {
  stdout.write(`${line}\n`);
}

// Pull `--server X` out of the argument list; everything else is returned
// for the subcommand to parse.
function splitServerFlag(argv: string[]): { server?: string; rest: string[] } {
  let server: string | undefined;
  const rest: string[] = [];
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === "--server") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--server needs a host or URL, e.g. --server overleaf.example.org");
      server = value;
      i++;
    } else {
      rest.push(argv[i]);
    }
  }
  return { server, rest };
}

async function runLogin(argv: string[]): Promise<number> {
  const { server, rest } = splitServerFlag(argv);
  const baseUrl = await resolveServer(server);
  const host = hostOf(baseUrl);
  let email: string | undefined;
  let usePassword = false;
  let browser = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--password") usePassword = true;
    else if (rest[i] === "--browser") browser = true;
    else if (rest[i] === "--email" && rest[i + 1] && !rest[i + 1].startsWith("--")) email = rest[++i];
    else throw new Error("Usage: login [--server HOST|URL] [--password | --browser] [--email EMAIL]. Password values are never accepted as arguments.");
  }
  if (browser && (usePassword || email)) throw new Error("--browser cannot be combined with password login options.");
  usePassword = usePassword || Boolean(email) || (!browser && !browserLoginAvailable());
  if (usePassword) {
    writeOut(`password login for ${host}; only the session cookie will be saved.`);
    try {
      const cookie = await promptPasswordLogin(baseUrl, email);
      const id = await validateCookie(cookie, baseUrl);
      await saveStored(baseUrl, cookie);
      clearIdentity(baseUrl);
      writeOut(`logged in as ${id.userEmail || id.userId} on ${host}; saved to ${cookieFilePath()}`);
      return 0;
    } catch {
      writeOut("Password login failed or cancelled. Check credentials, HTTPS connectivity and CSRF support. CAPTCHA/SSO/2FA require browser login. Existing credentials were not changed.");
      return 1;
    }
  }
  writeOut(`opening a Chrome window for ${host} (a profile dedicated to overleaf-mcp).`);
  writeOut("complete login normally — captcha, SSO, 2FA all work because it's a real browser.");
  let cookie: string;
  try {
    cookie = await captureCookie(baseUrl);
  } catch (err) {
    writeOut(`login failed: ${(err as Error).message}`);
    return 1;
  }
  await saveStored(baseUrl, cookie);
  clearIdentity(baseUrl);
  try {
    const id = await validateCookie(cookie, baseUrl);
    writeOut(`logged in as ${id.userEmail || id.userId} on ${host}`);
    writeOut(`saved to ${cookieFilePath()}`);
    return 0;
  } catch (err) {
    await clearStored(baseUrl).catch(() => undefined);
    writeOut(`login failed (cookie rejected): ${(err as Error).message}`);
    return 1;
  }
}

async function runLogout(argv: string[]): Promise<number> {
  const { server, rest } = splitServerFlag(argv);
  const confirmed = rest.includes("--confirm") || stdin.isTTY;
  if (!confirmed) {
    writeOut("logout refused: pass --confirm when stdin is not a TTY (avoids accidental wipes in scripts).");
    return 2;
  }
  const baseUrl = await resolveServer(server);
  const host = hostOf(baseUrl);
  const removed = await clearStored(baseUrl);
  clearIdentity(baseUrl);
  writeOut(removed ? `cleared cookie for ${host}` : `no stored cookie for ${host}`);
  return 0;
}

function formatAge(savedAt: number): string {
  const ageMs = Date.now() - savedAt;
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  const hours = Math.floor((ageMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  return `${new Date(savedAt).toISOString()} (${days}d ${hours}h ago)`;
}

// One line per server. Returns true when a stored cookie validated.
async function statusOne(baseUrl: string, isDefault: boolean): Promise<boolean> {
  const label = `${hostOf(baseUrl)}${isDefault ? " (default)" : ""}`;
  const stored = await loadStored(baseUrl);
  if (!stored) {
    writeOut(`${label}: no cookie. Run \`overleaf-mcp login --server ${hostOf(baseUrl)}\`.`);
    return false;
  }
  try {
    const id = await validateCookie(stored.cookie, baseUrl);
    writeOut(`${label}: ${id.userEmail || id.userId}, cookie saved ${formatAge(stored.savedAt)}`);
    return true;
  } catch (err) {
    writeOut(`${label}: cookie saved ${formatAge(stored.savedAt)} but validation failed: ${(err as Error).message}`);
    return false;
  }
}

// `status` alone reports every known server (default + OL_SERVERS + every
// host with a cookie); `status --server X` reports just that one.
async function runStatus(argv: string[]): Promise<number> {
  const { server } = splitServerFlag(argv);
  writeOut(`file: ${cookieFilePath()}`);
  if (server !== undefined) {
    const baseUrl = await resolveServer(server);
    return (await statusOne(baseUrl, baseUrl === loadConfig().defaultBaseUrl)) ? 0 : 1;
  }
  let anyOk = false;
  for (const s of await knownServers()) {
    if (await statusOne(s.baseUrl, s.isDefault)) anyOk = true;
  }
  return anyOk ? 0 : 1;
}

export async function maybeRunCli(argv: string[]): Promise<boolean> {
  const cmd = argv[2];
  if (cmd !== "login" && cmd !== "logout" && cmd !== "status") return false;
  let code = 0;
  try {
    if (cmd === "login") code = await runLogin(argv);
    else if (cmd === "logout") code = await runLogout(argv);
    else code = await runStatus(argv);
  } catch (err) {
    writeOut(`${cmd} failed: ${(err as Error).message}`);
    code = 1;
  }
  process.exit(code);
}
