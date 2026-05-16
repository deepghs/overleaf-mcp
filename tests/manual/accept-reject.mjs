#!/usr/bin/env node
// Smoke-test the three tracked-change tools end-to-end against a live project:
//   list_tracked_changes -> accept_changes (1 id) -> reject_changes (1 id) -> list_tracked_changes
//
// Usage: OL_COOKIE='...' node tests/manual/accept-reject.mjs <project_id>

import { spawnMcp } from "./_mcp-client.mjs";

const projectId = process.argv[2];
if (!projectId) { console.error("usage: accept-reject.mjs <project_id>"); process.exit(2); }

const c = spawnMcp({ label: "ar" });
const hardTimeout = setTimeout(() => { console.error("[ar] hard timeout"); c.kill(); process.exit(1); }, 60_000);

try {
  await c.init();
  await c.callTool("open_project", { project_id: projectId });

  console.error("\n== list_tracked_changes (mine only, last 6 chars of user_id = 3d2f01) ==");
  const list1 = await c.callTool("list_tracked_changes", {
    author_id_endswith: "3d2f01",
    limit: 50,
  });
  if (list1.isError) { console.error(list1.text); process.exit(1); }
  const all = list1.structured?.changes ?? [];
  console.error(`mine pending: ${list1.structured?.total_matched} (showing ${all.length})`);
  for (const c0 of all.slice(0, 8)) {
    console.error(`  [${c0.kind}] ${c0.doc_path ?? c0.doc_id} p=${c0.position} text=${JSON.stringify(c0.text.slice(0,50))} id=${c0.change_id} ts=${c0.timestamp}`);
  }
  if (all.length < 2) {
    console.error("need >=2 changes to test both accept and reject; aborting");
    process.exit(1);
  }

  // Pick one to ACCEPT (oldest-of-mine — least disruptive)
  // and one to REJECT (different one).
  const sorted = [...all].sort((a, b) => Date.parse(a.timestamp ?? "0") - Date.parse(b.timestamp ?? "0"));
  const toAccept = sorted[0];
  const toReject = sorted.find((c) => c.change_id !== toAccept.change_id);

  console.error(`\n== accept_changes — ${toAccept.change_id} ([${toAccept.kind}] in ${toAccept.doc_path}) ==`);
  const acc = await c.callTool("accept_changes", { change_ids: [toAccept.change_id] });
  console.error(`isError=${acc.isError}  ${acc.text}`);
  console.error("structured:", JSON.stringify(acc.structured));

  if (toReject) {
    console.error(`\n== reject_changes — ${toReject.change_id} ([${toReject.kind}] in ${toReject.doc_path}) ==`);
    const rej = await c.callTool("reject_changes", { change_ids: [toReject.change_id] });
    console.error(`isError=${rej.isError}  ${rej.text}`);
    console.error("structured:", JSON.stringify(rej.structured));
  }

  console.error("\n== list_tracked_changes after (mine only) ==");
  const list2 = await c.callTool("list_tracked_changes", { author_id_endswith: "3d2f01", limit: 5 });
  console.error(`mine pending after: ${list2.structured?.total_matched}`);
  console.error("\n== verdict ==");
  const before = list1.structured?.total_matched ?? 0;
  const after = list2.structured?.total_matched ?? 0;
  const drop = before - after;
  const expected = toReject ? 2 : 1;
  if (drop === expected) console.error(`OK — pending dropped by ${drop} (expected ${expected})`);
  else console.error(`Unexpected drop: before=${before} after=${after} drop=${drop} expected=${expected}`);
  process.exit(0);
} finally {
  clearTimeout(hardTimeout);
  c.kill();
}
