import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asJson, olGet, olPostJson, expectOk } from "../api/http.js";
import { applyOtUpdate, joinDoc } from "../api/socket.js";
import { findByPath, getActiveProject } from "../session/activeProject.js";

export function uniqueAnchor(text: string, selected: string): number {
  const p = text.indexOf(selected);
  if (!selected || p < 0) throw new Error("Selected text not found.");
  if (text.indexOf(selected, p + 1) >= 0) throw new Error("Selected text is ambiguous; provide a longer unique selection.");
  return p;
}

export function registerAddComment(server: McpServer): void {
  server.registerTool("add_comment", {
    description: "Create a native anchored comment on unique selected text. expected_version must come from read_file. Refuses stale versions. Does not change document text.",
    inputSchema: { path: z.string(), selected_text: z.string().min(1), content: z.string().min(1), expected_version: z.number().int().nonnegative() },
  }, async args => {
    let threadId: string | undefined;
    try {
      const ap = getActiveProject(), entity = findByPath(args.path);
      if (!ap || entity?.kind !== "doc") throw new Error("Open project and select an existing text document.");
      const doc = await joinDoc(entity.id);
      if (doc.version !== args.expected_version) throw new Error("Stale version; read_file and locate the anchor again.");
      const p = uniqueAnchor(doc.docLines.join("\n"), args.selected_text);
      threadId = randomBytes(12).toString("hex");
      await expectOk(await olPostJson(`project/${ap.projectId}/thread/${threadId}/messages`, { content: args.content }));
      await applyOtUpdate(entity.id, { doc: entity.id, v: doc.version, op: [{ p, c: args.selected_text, t: threadId }] });
      const updated = await joinDoc(entity.id);
      const ranges = updated.ranges as { comments?: Array<{ op?: { t?: string; p?: number; c?: string } }> };
      const anchor = ranges?.comments?.find(c => c.op?.t === threadId)?.op;
      const threads = await asJson<Record<string, unknown>>(await olGet(`project/${ap.projectId}/threads`));
      if (!anchor || !threads[threadId]) throw new Error("Comment creation could not be verified; inspect the thread before retrying.");
      return { content: [{ type: "text", text: JSON.stringify({ thread_id: threadId, position: anchor.p, selected_text: anchor.c, verified: true }) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: String(e), thread_id: threadId, warning: threadId ? "A message may already exist; inspect before retrying." : undefined }) }] };
    }
  });
}
