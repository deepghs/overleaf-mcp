#!/usr/bin/env node
// Manual smoke test for ol-mcp. Runs the server as a child process over stdio,
// drives the MCP initialize handshake, and calls one tool.
//
// Usage:
//   OL_COOKIE='overleaf_session2=s%3A...; GCLB=...' node tests/manual/smoke.mjs list_projects
//   OL_COOKIE='...' node tests/manual/smoke.mjs ping
//   OL_COOKIE='...' OL_BASE_URL='https://your-overleaf.example' node tests/manual/smoke.mjs list_projects '{"name_contains":"thesis"}'
//
// Does NOT require a running Claude Desktop. Reads its env from the shell.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, "../../dist/index.js");

const toolName = process.argv[2];
const argsJson = process.argv[3] ?? "{}";
if (!toolName) {
  console.error("usage: smoke.mjs <tool_name> [args_json]");
  process.exit(2);
}

const child = spawn("node", [SERVER], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

const pending = new Map();
let nextId = 1;
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const timeout = setTimeout(() => {
  console.error("[smoke] timed out after 15s");
  child.kill();
  process.exit(1);
}, 15_000);

try {
  const init = await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1.0" },
  });
  console.error(`[smoke] server: ${init.result.serverInfo.name} v${init.result.serverInfo.version}`);
  notify("notifications/initialized");

  const parsed = JSON.parse(argsJson);
  const result = await call("tools/call", { name: toolName, arguments: parsed });
  if (result.error) {
    console.error("[smoke] JSON-RPC error:", result.error);
    process.exit(1);
  }
  const r = result.result;
  console.error(`[smoke] isError=${Boolean(r.isError)}`);
  for (const c of r.content ?? []) {
    if (c.type === "text") process.stdout.write(c.text + "\n");
  }
  process.exit(r.isError ? 1 : 0);
} finally {
  clearTimeout(timeout);
  child.kill();
}
