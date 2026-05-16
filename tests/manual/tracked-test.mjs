#!/usr/bin/env node
// Phase 4 test: edit with track:"on" should produce a pending suggestion in
// Overleaf's review panel. After the edit we re-read the doc and report the
// ranges metadata, which should grow by one change entry.
//
// Usage:
//   node tests/manual/tracked-test.mjs <project_id> <doc_path>
// (login first via `node dist/index.js login` so a cookie file exists.)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, "../../dist/index.js");

const projectId = process.argv[2];
const docPath = process.argv[3];
const marker = `\n% overleaf-mcp TRACKED test @ ${new Date().toISOString()}\n`;
if (!projectId || !docPath) {
  console.error("usage: tracked-test.mjs <project_id> <doc_path>");
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

const hardTimeout = setTimeout(() => { console.error("[tracked-test] hard timeout"); child.kill(); process.exit(1); }, 90_000);

try {
  await call("initialize", { protocolVersion:"2024-11-05", capabilities:{}, clientInfo:{ name:"tracked-test", version:"1.0" }});
  notify("notifications/initialized");

  console.error("\n== open_project ==");
  const open = await callTool("open_project", { project_id: projectId });
  if (open.isError) { console.error(open.text); process.exit(1); }
  console.error(open.text);
  console.error("structured:", JSON.stringify(open.structured));

  console.error("\n== read_file (before) ==");
  const before = await callTool("read_file", { path: docPath });
  if (before.isError) { console.error(before.text); process.exit(1); }
  console.error("version=", before.structured?.version, "bytes=", before.structured?.byte_count, "has_ranges=", before.structured?.has_ranges);

  console.error("\n== edit_file (track=on) ==");
  const edit = await callTool("edit_file", { path: docPath, new_content: before.text + marker, track: "on" });
  if (edit.isError) { console.error(edit.text); process.exit(1); }
  console.error(edit.text);
  console.error("structured:", JSON.stringify(edit.structured));

  console.error("\n== read_file (after) ==");
  const after = await callTool("read_file", { path: docPath });
  if (after.isError) { console.error(after.text); process.exit(1); }
  console.error(
    "version=", after.structured?.version,
    "bytes=", after.structured?.byte_count,
    "has_ranges=", after.structured?.has_ranges,
    "tracked_change_count=", after.structured?.tracked_change_count,
  );
  const recent = after.structured?.recent_changes ?? [];
  if (recent.length) {
    console.error(`\n-- last ${recent.length} tracked change(s) on this doc --`);
    for (const c of recent) console.error(JSON.stringify(c));
  }

  console.error("\n== verdict ==");
  const ourMarker = marker.trim();
  const newOne = recent.find((c) => {
    const inserted = typeof c?.op?.i === "string" ? c.op.i : "";
    return inserted.includes(ourMarker);
  });
  if (newOne) {
    console.error("OK — our marker is recorded as a tracked-change entry by user", newOne.metadata?.user_id ?? newOne.userId, "at", newOne.metadata?.ts ?? newOne.ts);
    process.exit(0);
  } else if (after.structured?.has_ranges) {
    console.error("Partial — ranges exist, but the marker text isn't among the last 5 changes. The change may still be tracked; open the project in the Review panel to confirm.");
    process.exit(0);
  } else {
    console.error("FAIL — no ranges metadata after edit. Track-changes likely not honored.");
    process.exit(1);
  }
} finally {
  clearTimeout(hardTimeout);
  child.kill();
}
