// `overleaf-mcp login | logout | status` subcommands. Invoked before the
// MCP stdio server boots. `login` always launches a Chrome window pointed
// at Overleaf and captures the session cookie via CDP — no paste path.

import { stdin, stdout } from "node:process";

import { loadConfig } from "../config.js";
import { validateCookie, clearIdentity } from "../session/identity.js";
import { OverleafAuthError } from "../api/errors.js";
import { saveStored, clearStored, loadStored, cookieFilePath } from "./cookieStore.js";
import { captureCookie } from "./browserLogin.js";

function writeOut(line: string): void {
  stdout.write(`${line}\n`);
}

function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host;
}

async function runLogin(): Promise<number> {
  const config = loadConfig();
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
    if (cmd === "login") code = await runLogin();
    else if (cmd === "logout") code = await runLogout(argv);
    else code = await runStatus();
  } catch (err) {
    writeOut(`${cmd} failed: ${(err as Error).message}`);
    code = 1;
  }
  process.exit(code);
}
