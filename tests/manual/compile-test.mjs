#!/usr/bin/env node
// Phase 5 test: open_project -> compile -> read_log.
//
// Usage:
//   node tests/manual/compile-test.mjs <project_id>
// (login first via `node dist/index.js login` so a cookie file exists.)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, "../../dist/index.js");

const projectId = process.argv[2];
if (!projectId) {
  console.error("usage: compile-test.mjs <project_id>");
  process.exit(2);
}

const child = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
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
  return new Promise((resolve) => { pending.set(id, { resolve }); child.stdin.write(JSON.stringify({ jsonrpc:"2.0", id, method, params }) + "\n"); });
}
function notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc:"2.0", method, params }) + "\n"); }
async function callTool(name, args = {}) {
  const r = await call("tools/call", { name, arguments: args });
  return {
    isError: Boolean(r.result?.isError),
    text: (r.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n"),
    structured: r.result?.structuredContent,
  };
}

const hardTimeout = setTimeout(() => { console.error("[compile-test] hard timeout"); child.kill(); process.exit(1); }, 120_000);

try {
  await call("initialize", { protocolVersion:"2024-11-05", capabilities:{}, clientInfo:{ name:"compile-test", version:"1.0" }});
  notify("notifications/initialized");

  console.error("\n== open_project ==");
  const open = await callTool("open_project", { project_id: projectId });
  if (open.isError) { console.error(open.text); process.exit(1); }
  console.error(open.text);

  console.error("\n== compile ==");
  const compile = await callTool("compile", {});
  if (compile.isError) { console.error(compile.text); process.exit(1); }
  console.error(compile.text);
  console.error("structured:", JSON.stringify(compile.structured));

  console.error("\n== read_log ==");
  const log = await callTool("read_log", {});
  if (log.isError) { console.error(log.text); process.exit(1); }
  console.error("structured:", JSON.stringify({
    log_bytes: log.structured?.log_bytes,
    error_lines: log.structured?.error_lines,
    warning_count: log.structured?.warning_count,
  }));
  console.error("--- log preview (first 800 chars of text) ---");
  console.error(log.text.slice(0, 800));
  process.exit(0);
} finally {
  clearTimeout(hardTimeout);
  child.kill();
}
