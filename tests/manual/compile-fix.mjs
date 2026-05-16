#!/usr/bin/env node
// Edge T4 — compile fail + auto-fix loop. Forces a LaTeX error via a direct
// (untracked) edit so the compile actually breaks, reads the log, then reverts.
//
// Usage: node tests/manual/compile-fix.mjs <project_id> <doc_path>
// (login first via `node dist/index.js login` so a cookie file exists.)

import { spawnMcp } from "./_mcp-client.mjs";

const projectId = process.argv[2];
const docPath = process.argv[3] ?? "test.tex";
if (!projectId) { console.error("usage: compile-fix.mjs <project_id> [doc_path]"); process.exit(2); }

const c = spawnMcp({ label: "compile-fix" });
const hardTimeout = setTimeout(() => { console.error("[t4] hard timeout"); c.kill(); process.exit(1); }, 90_000);
try {
  await c.init();
  await c.callTool("open_project", { project_id: projectId });

  const before = await c.callTool("read_file", { path: docPath });
  const origText = before.text;
  console.error(`[t4] read ${docPath}, ${origText.length} bytes, version ${before.structured?.version}`);

  // Step 1: introduce a deliberate LaTeX error. Insert "\bogus" right before \end{document}.
  // Use track:off so the compile actually evaluates the broken syntax.
  const endIdx = origText.lastIndexOf("\\end{document}");
  if (endIdx < 0) { console.error("[t4] no \\end{document}"); process.exit(1); }
  const brokenText = origText.slice(0, endIdx) + "\\bogus\n" + origText.slice(endIdx);

  console.error("\n== step 1: inject \\bogus (direct edit) ==");
  const inject = await c.callTool("edit_file", { path: docPath, new_content: brokenText, track: "off" });
  console.error(`isError=${inject.isError}`, inject.text);
  if (inject.isError) process.exit(1);

  console.error("\n== step 2: compile (expect failure) ==");
  const fail = await c.callTool("compile", {});
  console.error(`isError=${fail.isError}`, fail.text);
  console.error("structured:", JSON.stringify(fail.structured));

  console.error("\n== step 3: read_log ==");
  const log = await c.callTool("read_log", {});
  console.error(`isError=${log.isError}, errors=`, JSON.stringify(log.structured?.error_lines));
  console.error("--- log preview ---");
  console.error(log.text.split("\n").slice(0, 25).join("\n"));

  console.error("\n== step 4: revert (direct edit) ==");
  const revert = await c.callTool("edit_file", { path: docPath, new_content: origText, track: "off" });
  console.error(`isError=${revert.isError}`, revert.text);
  if (revert.isError) process.exit(1);

  console.error("\n== step 5: recompile (expect success) ==");
  const ok = await c.callTool("compile", {});
  console.error(`isError=${ok.isError}`, ok.text);
  console.error("structured:", JSON.stringify(ok.structured));

  // Verdict
  const recoveredCleanly = !ok.isError && ok.structured?.status === "success" && fail.structured?.status !== "success";
  console.error("\n== verdict ==");
  console.error(recoveredCleanly ? "OK — compile loop works: error detected, fixed, recompile succeeded." : "FAIL — see logs above.");
  process.exit(recoveredCleanly ? 0 : 1);
} finally {
  clearTimeout(hardTimeout);
  c.kill();
}
