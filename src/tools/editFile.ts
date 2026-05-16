import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { applyOtUpdate, getActiveSocket, type OtUpdate } from "../api/socket.js";
import { getIdentity } from "../session/identity.js";
import { ensureDocLoaded, updateDoc } from "../session/docCache.js";
import { findByPath, getActiveProject } from "../session/activeProject.js";
import { textToOps, type ShareJsOp } from "../ot/diff.js";
import { generateIdSeed } from "../ot/trackedChanges.js";
import { logger } from "../util/logger.js";

const Schema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Project-relative path of the doc to edit, e.g. 'main.tex' or 'chapters/intro.tex'."),
  new_content: z
    .string()
    .describe("Desired full content of the file. The server computes a diff against the current content and submits the minimal OT operation."),
  expected_version: z
    .number()
    .int()
    .optional()
    .describe("Optional safety check. If provided and the doc's current version differs, the edit is rejected."),
  track: z
    .enum(["auto", "on", "off"])
    .default("auto")
    .describe(
      "Tracked-changes mode. 'auto' (default) tracks edits when the project has track-changes enabled for this user, otherwise writes directly. 'on' forces tracked changes regardless. 'off' forces a direct edit even if track-changes is enabled.",
    ),
});

export function registerEditFile(server: McpServer): void {
  server.registerTool(
    "edit_file",
    {
      title: "Edit a .tex doc in the open Overleaf project",
      description:
        "Replaces the contents of a doc by computing a minimal diff and submitting it as an OT operation " +
        "over the live Socket.IO connection. The change lands in the web editor in real time. " +
        "In v1 this writes as a direct edit (not yet tracked); Phase 4 will add the meta.tc flag so the " +
        "edit appears as a pending suggestion in the review panel when track-changes is on. " +
        "Only .tex / .bib / .md / similar text docs are editable — binary files are not.",
      inputSchema: Schema.shape,
    },
    async (args) => {
      const ap = getActiveProject();
      if (!ap) {
        return { content: [{ type: "text", text: "No project is open. Call open_project first." }], isError: true };
      }
      const entity = findByPath(args.path);
      if (!entity) {
        return {
          content: [{ type: "text", text: `Path not found in project: '${args.path}'. Use list_files to inspect available paths.` }],
          isError: true,
        };
      }
      if (entity.kind !== "doc") {
        return { content: [{ type: "text", text: `'${args.path}' is a ${entity.kind}, not an editable doc.` }], isError: true };
      }
      try {
        const cached = await ensureDocLoaded(entity.id);
        if (args.expected_version !== undefined && cached.version !== args.expected_version) {
          return {
            content: [{ type: "text", text: `Version mismatch: cached version is ${cached.version}, you provided ${args.expected_version}. Re-read the file and retry.` }],
            isError: true,
          };
        }
        const ops: ShareJsOp[] = textToOps(cached.text, args.new_content);
        if (ops.length === 0) {
          return {
            content: [{ type: "text", text: "No-op: new_content is identical to the current doc." }],
            structuredContent: { path: entity.path, doc_id: entity.id, version: cached.version, ops_applied: 0 },
          };
        }
        const identity = await getIdentity();
        const sock = getActiveSocket();
        const shouldTrack =
          args.track === "on" ? true : args.track === "off" ? false : ap.trackChangesOnForMe;
        const meta: NonNullable<OtUpdate["meta"]> = {
          source: sock?.publicId ?? "ol-mcp",
          ts: Date.now(),
          user_id: identity.userId,
        };
        if (shouldTrack) meta.tc = generateIdSeed();
        const update: OtUpdate = {
          doc: entity.id,
          op: ops,
          v: cached.version,
          meta,
        };
        await applyOtUpdate(entity.id, update);
        const newVersion = cached.version + 1;
        updateDoc(entity.id, args.new_content, newVersion);
        const insertedChars = ops.reduce((n, op) => n + (op.i?.length ?? 0), 0);
        const deletedChars = ops.reduce((n, op) => n + (op.d?.length ?? 0), 0);
        return {
          content: [
            {
              type: "text",
              text:
                `Applied ${ops.length} op(s) to '${entity.path}' (+${insertedChars} / -${deletedChars} chars). ` +
                `Doc version ${cached.version} -> ${newVersion}. ` +
                (shouldTrack
                  ? "Submitted as tracked changes — should appear as a pending suggestion in Overleaf's review panel."
                  : "Submitted as a direct edit (no tracking)."),
            },
          ],
          structuredContent: {
            path: entity.path,
            doc_id: entity.id,
            ops_applied: ops.length,
            chars_inserted: insertedChars,
            chars_deleted: deletedChars,
            version_before: cached.version,
            version_after: newVersion,
            tracked: shouldTrack,
            track_mode: args.track,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("edit_file failed", msg);
        return { content: [{ type: "text", text: `Failed to edit '${args.path}': ${msg}` }], isError: true };
      }
    },
  );
}
