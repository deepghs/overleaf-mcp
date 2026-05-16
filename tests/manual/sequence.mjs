#!/usr/bin/env node
// Drives a multi-step MCP tool sequence against the running overleaf-mcp server, so
// stateful flows (open_project -> list_files -> read_file) actually share a
// session.
//
// Usage:
//   OL_COOKIE='...' node tests/manual/sequence.mjs <project_id> [doc_path]
//   OL_COOKIE='...' node tests/manual/sequence.mjs 61d853bcbf1003100e957034
//   OL_COOKIE='...' node tests/manual/sequence.mjs 61d853bcbf1003100e957034 main.tex

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, "../../dist/index.js");

const projectId = process.argv[2];
const docPath = process.argv[3];
if (!projectId) {
  console.error("usage: sequence.mjs <project_id> [doc_path]");
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
async function callTool(name, args = {}) {
  const r = await call("tools/call", { name, arguments: args });
  const isError = Boolean(r.result?.isError);
  const text = (r.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return { isError, text, structured: r.result?.structuredContent };
}

const timeout = setTimeout(() => {
  console.error("[seq] hard timeout after 30s");
  child.kill();
  process.exit(1);
}, 30_000);

function banner(s) { console.error(`\n========== ${s} ==========`); }
function preview(text, n = 1200) {
  return text.length > n ? `${text.slice(0, n)}\n... (${text.length - n} more chars)` : text;
}

try {
  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "seq", version: "1.0" },
  });
  notify("notifications/initialized");

  banner("open_project");
  const open = await callTool("open_project", { project_id: projectId });
  console.error(`isError=${open.isError}`);
  console.log(open.text);

  banner("list_files (docs only)");
  const list = await callTool("list_files", { kind: "doc" });
  console.error(`isError=${list.isError}`);
  console.log(preview(list.text));

  // Choose a doc path: arg if given, else first .tex from list, else first doc.
  let target = docPath;
  if (!target) {
    const docs = list.structured?.entities ?? [];
    const tex = docs.find((d) => d.path.toLowerCase().endsWith(".tex"));
    target = (tex ?? docs[0])?.path;
  }
  if (target) {
    banner(`read_file ${target}`);
    const read = await callTool("read_file", { path: target });
    console.error(`isError=${read.isError}, structured=`, read.structured);
    console.log(preview(read.text, 2000));
  } else {
    console.error("[seq] no doc found in project");
  }
  process.exit(0);
} finally {
  clearTimeout(timeout);
  child.kill();
}
