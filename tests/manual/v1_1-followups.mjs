#!/usr/bin/env node
// v1.1 follow-ups verification:
//  - open_project surfaces root_doc_path, compiler, language, members
//  - read_file with no path defaults to root doc
//  - compile includes error_count + first_errors inline

import { spawnMcp } from "./_mcp-client.mjs";

const projectId = process.argv[2];
if (!projectId) { console.error("usage: v1_1-followups.mjs <project_id>"); process.exit(2); }

const c = spawnMcp({ label: "v1_1" });
const hardTimeout = setTimeout(() => { console.error("[v1_1] hard timeout"); c.kill(); process.exit(1); }, 60_000);
try {
  await c.init();

  console.error("\n== open_project (expect rich metadata) ==");
  const open = await c.callTool("open_project", { project_id: projectId });
  if (open.isError) { console.error(open.text); process.exit(1); }
  console.error(open.text);
  console.error("structured:", JSON.stringify(open.structured, null, 2));

  console.error("\n== read_file with NO path (expect root doc) ==");
  const r = await c.callTool("read_file", {});
  if (r.isError) { console.error(r.text); process.exit(1); }
  console.error(`isError=${r.isError}, version=${r.structured?.version}, path=${r.structured?.path}, bytes=${r.structured?.byte_count}`);

  console.error("\n== compile (expect error_count + first_errors inline) ==");
  const cmp = await c.callTool("compile", {});
  if (cmp.isError) { console.error(cmp.text); process.exit(1); }
  console.error(cmp.text);
  console.error("structured:", JSON.stringify(cmp.structured));

  console.error("\n== verdict ==");
  const okA = open.structured?.root_doc_path != null;
  const okB = r.structured?.path === open.structured?.root_doc_path;
  const okC = typeof cmp.structured?.error_count === "number";
  console.error(`A. open_project surfaces root_doc_path: ${okA ? "OK" : "FAIL"}`);
  console.error(`B. read_file with no path -> root doc: ${okB ? "OK" : "FAIL"}`);
  console.error(`C. compile includes error_count: ${okC ? "OK" : "FAIL"}`);
  process.exit(okA && okB && okC ? 0 : 1);
} finally {
  clearTimeout(hardTimeout);
  c.kill();
}
