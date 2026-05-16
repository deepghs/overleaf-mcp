#!/usr/bin/env node
// Edge T1: stale-version concurrency. Two MCP processes both join the same doc;
// process A edits first (server version bumps); process B tries to edit with its
// now-stale cached version. Observe whether the server transforms B's op,
// rejects it, or corrupts the doc.
//
// Usage: OL_COOKIE='...' node tests/manual/stale-version.mjs <project_id> <doc_path>

import { spawnMcp } from "./_mcp-client.mjs";

const projectId = process.argv[2];
const docPath = process.argv[3] ?? "test.tex";
if (!projectId) { console.error("usage: stale-version.mjs <project_id> [doc_path]"); process.exit(2); }

const ts = new Date().toISOString();
const markerA = `% overleaf-mcp T1 marker A @ ${ts}\n`;
const markerB = `% overleaf-mcp T1 marker B @ ${ts}\n`;

const a = spawnMcp({ label: "A" });
const b = spawnMcp({ label: "B" });
const hardTimeout = setTimeout(() => { console.error("[t1] hard timeout"); a.kill(); b.kill(); process.exit(1); }, 90_000);
try {
  await a.init();
  await b.init();
  console.error("[t1] both clients initialized");

  await a.callTool("open_project", { project_id: projectId });
  await b.callTool("open_project", { project_id: projectId });
  console.error("[t1] both clients opened project");

  // Both clients read the doc to populate their docCaches at the same version.
  const ra = await a.callTool("read_file", { path: docPath });
  const rb = await b.callTool("read_file", { path: docPath });
  const va = ra.structured?.version;
  const vb = rb.structured?.version;
  const aText = ra.text;
  const bText = rb.text;
  console.error(`[t1] A cached version=${va}, B cached version=${vb}`);
  if (va !== vb) console.error("[t1] WARN versions differ at start — may have race with concurrent supervisor edits");

  // ---- A edits first (appends markerA) ----
  console.error("\n== A edits (appends marker A) ==");
  const aEditTxt = aText.replace(/\\end\{document\}$/, markerA + "\\end{document}");
  const aEdit = await a.callTool("edit_file", { path: docPath, new_content: aEditTxt, track: "on" });
  console.error(`A: isError=${aEdit.isError}  ${aEdit.text.split("\n")[0]}`);
  if (aEdit.isError) { console.error("A edit failed; aborting"); process.exit(1); }
  console.error("A structured:", JSON.stringify(aEdit.structured));

  // Small wait so A's op is definitely processed server-side
  await new Promise(r => setTimeout(r, 1200));

  // ---- B edits with its STALE cache (still at version va) ----
  console.error("\n== B edits (appends marker B, with stale cache) ==");
  const bEditTxt = bText.replace(/\\end\{document\}$/, markerB + "\\end{document}");
  const bEdit = await b.callTool("edit_file", { path: docPath, new_content: bEditTxt, track: "on" });
  console.error(`B: isError=${bEdit.isError}  ${bEdit.text.split("\n").slice(0, 2).join(" | ")}`);
  console.error("B structured:", JSON.stringify(bEdit.structured));

  // Wait for server to settle
  await new Promise(r => setTimeout(r, 1500));

  // ---- Verify final state via a fresh read (cache invalidated by killing+restart not needed; B can re-read) ----
  console.error("\n== final state (B re-reads after editing) ==");
  // Kill B and respawn so its cache is fresh. Easier than invalidating in place.
  b.kill();
  const c = spawnMcp({ label: "verify" });
  await c.init();
  await c.callTool("open_project", { project_id: projectId });
  const final = await c.callTool("read_file", { path: docPath });
  const ft = final.text;
  const fv = final.structured?.version;
  console.error(`final version=${fv}`);
  console.error(`final has marker A: ${ft.includes("marker A")}`);
  console.error(`final has marker B: ${ft.includes("marker B")}`);
  console.error(`tail (last 200 chars): ${JSON.stringify(ft.slice(-200))}`);
  c.kill();

  // Verdict
  let verdict;
  if (bEdit.isError) {
    verdict = "B's edit was REJECTED (server returned an error). MCP propagated error cleanly.";
  } else if (ft.includes("marker A") && ft.includes("marker B")) {
    verdict = "Both markers landed — server transformed B's op against A's (ShareJS OT in action). NO corruption.";
  } else if (ft.includes("marker A") && !ft.includes("marker B")) {
    verdict = "Only A's marker is present — B's edit was silently dropped.";
  } else if (!ft.includes("marker A") && ft.includes("marker B")) {
    verdict = "Only B's marker is present — A's edit was overwritten.";
  } else {
    verdict = "Neither marker found — something else happened.";
  }
  console.error("\n== verdict ==");
  console.error(verdict);
  process.exit(0);
} finally {
  clearTimeout(hardTimeout);
  a.kill(); b.kill();
}
