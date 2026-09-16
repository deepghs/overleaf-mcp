// `overleaf-mcp login | logout | status` subcommands. Invoked before the
// MCP stdio server boots. Supports isolated browser or interactive password login.

import { stdin, stdout } from "node:process";

import { loadConfig } from "../config.js";
import { validateCookie, clearIdentity } from "../session/identity.js";
import { OverleafAuthError } from "../api/errors.js";
import { saveStored, clearStored, loadStored, cookieFilePath } from "./cookieStore.js";
import { captureCookie } from "./browserLogin.js";
import { browserLoginAvailable, promptPasswordLogin } from "./passwordLogin.js";

function writeOut(line: string): void {
  stdout.write(`${line}\n`);
}

function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host;
}

async function runLogin(argv: string[]): Promise<number> {
  const config = loadConfig();
  let email: string | undefined;
  let usePassword = false;
  let browser = false;
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === "--password") usePassword = true;
    else if (argv[i] === "--browser") browser = true;
    else if (argv[i] === "--email" && argv[i + 1] && !argv[i + 1].startsWith("--")) email = argv[++i];
    else throw new Error("Usage: login [--password | --browser] [--email EMAIL]. Password values are never accepted as arguments.");
  }
  if (browser && (usePassword || email)) throw new Error("--browser cannot be combined with password login options.");
  usePassword = usePassword || Boolean(email) || (!browser && !browserLoginAvailable());
  if (usePassword) {
    writeOut(`password login for ${hostOf(config.baseUrl)}; only the session cookie will be saved.`);
    try {
      const cookie = await promptPasswordLogin(config.baseUrl, email);
      const id = await validateCookie(cookie);
      await saveStored(config.baseUrl, cookie);
      clearIdentity();
      writeOut(`logged in as ${id.userEmail || id.userId}; saved to ${cookieFilePath()}`);
      return 0;
    } catch {
      writeOut("Password login failed or cancelled. Check credentials, HTTPS connectivity and CSRF support. CAPTCHA/SSO/2FA require browser login. Existing credentials were not changed.");
      return 1;
    }
  }
  writeOut(`opening a Chrome window for ${hostOf(config.baseUrl)} (a profile dedicated to overleaf-mcp).`);
  writeOut("complete login normally — captcha, SSO, 2FA all work because it's a real browser.");
  let cookie: string;
  try {
    cookie = await captureCookie(config.baseUrl);
  } catch (err) {
    writeOut(`login failed: ${(err as Error).message}`);
    return 1;
  }
  await saveStored(config.baseUrl, cookie);
  clearIdentity();
  try {
    const id = await validateCookie(cookie);
    writeOut(`logged in as ${id.userEmail || id.userId} on ${hostOf(config.baseUrl)}`);
    writeOut(`saved to ${cookieFilePath()}`);
    return 0;
  } catch (err) {
    await clearStored(config.baseUrl).catch(() => undefined);
    writeOut(`login failed (cookie rejected): ${(err as Error).message}`);
    return 1;
  }
}

async function runLogout(argv: string[]): Promise<number> {
  const confirmed = argv.includes("--confirm") || stdin.isTTY;
  if (!confirmed) {
    writeOut("logout refused: pass --confirm when stdin is not a TTY (avoids accidental wipes in scripts).");
    return 2;
  }
  const config = loadConfig();
  const removed = await clearStored(config.baseUrl);
  clearIdentity();
  writeOut(removed ? `cleared cookie for ${hostOf(config.baseUrl)}` : `no stored cookie for ${hostOf(config.baseUrl)}`);
  return 0;
}

async function runStatus(): Promise<number> {
  const config = loadConfig();
  const host = hostOf(config.baseUrl);
  const stored = await loadStored(config.baseUrl);
  if (!stored) {
    writeOut(`no cookie for ${host}. Run \`overleaf-mcp login\` first.`);
    return 1;
  }
  const ageMs = Date.now() - stored.savedAt;
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  const hours = Math.floor((ageMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  writeOut(`file: ${cookieFilePath()}`);
  writeOut(`host: ${host}`);
  writeOut(`saved: ${new Date(stored.savedAt).toISOString()} (${days}d ${hours}h ago)`);
  try {
    const id = await validateCookie(stored.cookie);
    writeOut(`identity: ${id.userEmail || id.userId}`);
    return 0;
  } catch (err) {
    if (err instanceof OverleafAuthError) {
      writeOut(`validation failed: ${err.message}`);
    } else {
      writeOut(`validation failed: ${(err as Error).message}`);
    }
    return 1;
  }
}

export async function maybeRunCli(argv: string[]): Promise<boolean> {
  const cmd = argv[2];
  if (cmd !== "login" && cmd !== "logout" && cmd !== "status") return false;
  let code = 0;
  try {
    if (cmd === "login") code = await runLogin(argv);
    else if (cmd === "logout") code = await runLogout(argv);
    else code = await runStatus();
  } catch (err) {
    writeOut(`${cmd} failed: ${(err as Error).message}`);
    code = 1;
  }
  process.exit(code);
}
