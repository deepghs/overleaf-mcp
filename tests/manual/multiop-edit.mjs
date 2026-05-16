#!/usr/bin/env node
// Phase-3 multi-op edge test: open NRM.tex, apply THREE distinct changes
// (beginning insert, middle delete, end insert) in ONE edit_file call, and
// verify that diff-match-patch produced a multi-op update.

import { spawnMcp } from "./_mcp-client.mjs";

const projectId = process.argv[2];
const docPath = process.argv[3] ?? "NRM.tex";
if (!projectId) { console.error("usage: multiop-edit.mjs <project_id> [doc_path]"); process.exit(2); }

const ts = new Date().toISOString();
const beginMarker = `% ol-mcp T3 multi-op begin @ ${ts}\n`;
const endMarker = `% ol-mcp T3 multi-op end @ ${ts}\n`;
const targetDeleteSubstring = "%The Nominal Response Model.... \n";

const c = spawnMcp({ label: "multiop" });
const hardTimeout = setTimeout(() => { console.error("[multiop] hard timeout"); c.kill(); process.exit(1); }, 60_000);
try {
  await c.init();
  await c.callTool("open_project", { project_id: projectId });
  const before = await c.callTool("read_file", { path: docPath });
  if (before.isError) { console.error(before.text); process.exit(1); }
  const origText = before.text;
  console.error(`[multiop] read ${docPath}, ${origText.length} bytes, version ${before.structured?.version}`);

  // Validate our delete target is present
  if (!origText.includes(targetDeleteSubstring)) {
    console.error("[multiop] expected delete-target not found in doc:");
    console.error(JSON.stringify(targetDeleteSubstring));
    process.exit(1);
  }

  // 1. Insert beginMarker right after the first '\documentclass...\n' line.
  let next = origText.replace(/(\\documentclass[^\n]*\n)/, "$1" + beginMarker);
  if (next === origText) { console.error("[multiop] no documentclass line found"); process.exit(1); }
  // 2. Delete the commented placeholder.
  next = next.replace(targetDeleteSubstring, "");
  // 3. Insert endMarker right before '\end{document}'.
  const idx = next.lastIndexOf("\\end{document}");
  if (idx < 0) { console.error("[multiop] no \\end{document}"); process.exit(1); }
  next = next.slice(0, idx) + endMarker + next.slice(idx);

  console.error(`[multiop] new_content is ${next.length} bytes (delta ${next.length - origText.length})`);

  // ---- THE TEST: single edit_file with track:on ----
  const edit = await c.callTool("edit_file", { path: docPath, new_content: next, track: "on" });
  console.error(`[multiop] edit isError=${edit.isError}`);
  console.error(edit.text);
  console.error("structured:", JSON.stringify(edit.structured));

  // Verify
  const after = await c.callTool("read_file", { path: docPath });
  console.error(`[multiop] after: version=${after.structured?.version} tracked_change_count=${after.structured?.tracked_change_count}`);
  const recent = after.structured?.recent_changes ?? [];
  console.error(`[multiop] last ${recent.length} change records:`);
  for (const r of recent) {
    const op = r.op || {};
    const kind = "i" in op ? "INS" : ("d" in op ? "DEL" : "?");
    const txt = (op.i ?? op.d ?? "").slice(0, 60);
    console.error(`  [${kind}] p=${op.p}  text=${JSON.stringify(txt)}  user=${r.metadata?.user_id?.slice(-6)}`);
  }
  process.exit(0);
} finally {
  clearTimeout(hardTimeout);
  c.kill();
}
