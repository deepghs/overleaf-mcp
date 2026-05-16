#!/usr/bin/env node
// End-to-end Phase 3 test: open_project -> read_file -> edit_file -> read_file
// Appends a benign one-line marker to a target doc and verifies the edit
// reflected in a second read.
//
// Usage:
//   node tests/manual/edit-test.mjs <project_id> <doc_path> [marker]
// (login first via `node dist/index.js login` so a cookie file exists.)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, "../../dist/index.js");

const projectId = process.argv[2];
const docPath = process.argv[3];
const marker = process.argv[4] ?? `\n% overleaf-mcp edit test @ ${new Date().toISOString()}\n`;
if (!projectId || !docPath) {
  console.error("usage: edit-test.mjs <project_id> <doc_path> [marker]");
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

const hardTimeout = setTimeout(() => { console.error("[edit-test] hard timeout"); child.kill(); process.exit(1); }, 60_000);

try {
  await call("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "edit-test", version: "1.0" },
  });
  notify("notifications/initialized");

  console.error("\n== open_project ==");
  const open = await callTool("open_project", { project_id: projectId });
  if (open.isError) { console.error(open.text); process.exit(1); }
  console.error(open.text);

  console.error("\n== read_file (before) ==");
  const before = await callTool("read_file", { path: docPath });
  if (before.isError) { console.error(before.text); process.exit(1); }
  console.error("version=", before.structured?.version, "bytes=", before.structured?.byte_count);
  console.error("--- tail (last 200 chars) ---");
  console.error(before.text.slice(-200));

  console.error("\n== edit_file ==");
  const newContent = before.text + marker;
  const edit = await callTool("edit_file", { path: docPath, new_content: newContent });
  if (edit.isError) { console.error(edit.text); process.exit(1); }
  console.error(edit.text);
  console.error("structured=", JSON.stringify(edit.structured));

  console.error("\n== read_file (after) ==");
  const after = await callTool("read_file", { path: docPath });
  if (after.isError) { console.error(after.text); process.exit(1); }
  console.error("version=", after.structured?.version, "bytes=", after.structured?.byte_count);
  console.error("--- tail (last 200 chars) ---");
  console.error(after.text.slice(-200));

  console.error("\n== diff result ==");
  if (after.text.endsWith(marker)) {
    console.error("OK — marker present at end of doc");
    process.exit(0);
  } else {
    console.error("FAIL — marker not detected at end of doc");
    process.exit(1);
  }
} finally {
  clearTimeout(hardTimeout);
  child.kill();
}
