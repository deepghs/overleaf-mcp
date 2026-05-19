import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { applyOtUpdate, getActiveSocket, type OtUpdate } from "../api/socket.js";
import { getIdentity } from "../session/identity.js";
import { ensureDocLoaded, updateDoc } from "../session/docCache.js";
import { findByPath, getActiveProject } from "../session/activeProject.js";
import { textToOps, type ShareJsOp } from "../ot/diff.js";
import { generateIdSeed } from "../ot/trackedChanges.js";
import { checkBaseline, verifyEdit } from "../ot/verify.js";
import { logger } from "../util/logger.js";

const Schema = z.object({
  path: z
    .string()
    .min(1)
    .optional()
    .describe("Project-relative path of the doc to edit, e.g. 'main.tex' or 'chapters/intro.tex'. If omitted, defaults to the project's root doc."),
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
    .default("on")
    .describe(
      "Tracked-changes mode. Default is 'on' — every edit lands as a pending suggestion in Overleaf's Review panel, which is what collaborators expect for an agent. Set 'off' explicitly to make a direct (untracked) edit. 'auto' tracks only when the project has track-changes enabled for this user.",
    ),
  strict_version: z
    .boolean()
    .default(false)
    .describe(
      "If true, re-fetch the doc version from the server before sending the edit and refuse if the cached baseline is stale. Catches races from parallel agents (each MCP process has its own cache) or a concurrently open Overleaf web editor at the cost of one extra round-trip. Without this, the server's OT transform handles stale-version edits silently, which can land the op in an unexpected location or collapse it to a no-op. Recommended when several agents may be editing the same project.",
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
        "By default the edit appears as a pending suggestion in the Review panel (track:'on'); pass track:'off' to write directly. " +
        "If `path` is omitted, defaults to the project's root doc. " +
        "Only .tex / .bib / .md / similar text docs are editable — binary files are not.",
      inputSchema: Schema.shape,
    },
    async (args) => {
      const ap = getActiveProject();
      if (!ap) {
        return { content: [{ type: "text", text: "No project is open. Call open_project first." }], isError: true };
      }
      const resolvedPath = args.path ?? ap.rootDocPath;
      if (!resolvedPath) {
        return { content: [{ type: "text", text: "No path provided and the project has no configured root doc. Pass a `path`." }], isError: true };
      }
      const entity = findByPath(resolvedPath);
      if (!entity) {
        return {
          content: [{ type: "text", text: `Path not found in project: '${resolvedPath}'. Use list_files to inspect available paths.` }],
          isError: true,
        };
      }
      if (entity.kind !== "doc") {
        return { content: [{ type: "text", text: `'${resolvedPath}' is a ${entity.kind}, not an editable doc.` }], isError: true };
      }
      try {
        let cached = await ensureDocLoaded(entity.id);
        if (args.expected_version !== undefined && cached.version !== args.expected_version) {
          return {
            content: [{ type: "text", text: `Version mismatch: cached version is ${cached.version}, you provided ${args.expected_version}. Re-read the file and retry.` }],
            isError: true,
          };
        }
        if (args.strict_version) {
          const bc = await checkBaseline(entity.id, cached.version);
          if (bc.stale) {
            updateDoc(entity.id, bc.serverText, bc.serverVersion);
            return {
              content: [{ type: "text", text: `Stale baseline (strict_version): cached v${cached.version}, server is at v${bc.serverVersion}. The doc was modified by another writer since you last read it. Re-call read_file before retrying.` }],
              isError: true,
              structuredContent: {
                path: entity.path,
                doc_id: entity.id,
                stale_baseline: true,
                cached_version: cached.version,
                server_version: bc.serverVersion,
              },
            };
          }
          // Baseline is current; refresh cache to the fresh snapshot we just fetched.
          updateDoc(entity.id, bc.serverText, bc.serverVersion);
          cached = { docId: entity.id, text: bc.serverText, version: bc.serverVersion };
        }
        const preEditText = cached.text;
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
        // The server enforces tracking when the user has track_changes_on_for_me,
        // regardless of meta.tc. So even a track:"off" call lands as tracked on
        // such projects — reflect that in the response so the caller knows.
        const serverWillTrack = shouldTrack || ap.trackChangesOnForMe;
        const trackOverridden = args.track === "off" && ap.trackChangesOnForMe;
        const meta: NonNullable<OtUpdate["meta"]> = {
          source: sock?.publicId ?? "overleaf-mcp",
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
        const optimisticVersion = cached.version + 1;
        const insertedChars = ops.reduce((n, op) => n + (op.i?.length ?? 0), 0);
        const deletedChars = ops.reduce((n, op) => n + (op.d?.length ?? 0), 0);
        const trackingNote = serverWillTrack
          ? (trackOverridden
              ? "Submitted as a tracked change — `track:\"off\"` was overridden because the project has track_changes_on_for_me. The edit lands as a pending suggestion in Overleaf's Review panel."
              : "Submitted as tracked changes — should appear as a pending suggestion in Overleaf's Review panel.")
          : "Submitted as a direct edit (no tracking).";

        let v: Awaited<ReturnType<typeof verifyEdit>> | undefined;
        let verifyError: string | undefined;
        try {
          v = await verifyEdit(entity.id, preEditText, args.new_content, optimisticVersion);
        } catch (e) {
          verifyError = e instanceof Error ? e.message : String(e);
        }
        // Sync the cache to whatever the server actually has now. On verify
        // failure we still want the cache to match the server so the next
        // edit diffs against reality.
        if (v) updateDoc(entity.id, v.serverText, v.serverVersion);
        else updateDoc(entity.id, args.new_content, optimisticVersion);

        if (v && v.silentNoOp) {
          return {
            content: [{ type: "text", text:
              `Server acked the OT update for '${entity.path}' but the doc text is unchanged (silent no-op). ` +
              `This usually means a parallel agent or open editor bumped the version between your last read and this edit, and the server's OT transform collapsed your ops. ` +
              `Cache is now synced to the real server state (v${v.serverVersion}). Re-call read_file and retry; consider \`strict_version: true\` to fail fast on stale baselines.`,
            }],
            isError: true,
            structuredContent: {
              path: entity.path,
              doc_id: entity.id,
              ops_applied: ops.length,
              chars_inserted: insertedChars,
              chars_deleted: deletedChars,
              version_before: cached.version,
              version_after: v.serverVersion,
              tracked: serverWillTrack,
              track_mode: args.track,
              track_overridden: trackOverridden,
              verification_failed: true,
              silent_no_op: true,
            },
          };
        }

        const concurrentNote = v?.hadConcurrentWritesAfter
          ? ` Note: server is at v${v.serverVersion} (> optimistic v${optimisticVersion}) — another writer landed updates after this edit; your op is in but the doc has moved on.`
          : !v?.matchesExpected && v
            ? ` Note: server text doesn't byte-match your new_content (cache synced to actual server state at v${v.serverVersion}); the edit landed but may have been OT-transformed.`
            : "";
        const verifySkippedNote = verifyError ? ` (post-edit verification skipped: ${verifyError})` : "";
        const versionAfter = v ? v.serverVersion : optimisticVersion;

        return {
          content: [
            {
              type: "text",
              text:
                `Applied ${ops.length} op(s) to '${entity.path}' (+${insertedChars} / -${deletedChars} chars). ` +
                `Doc version ${cached.version} -> ${versionAfter}. ` +
                trackingNote + concurrentNote + verifySkippedNote,
            },
          ],
          structuredContent: {
            path: entity.path,
            doc_id: entity.id,
            ops_applied: ops.length,
            chars_inserted: insertedChars,
            chars_deleted: deletedChars,
            version_before: cached.version,
            version_after: versionAfter,
            tracked: serverWillTrack,
            track_mode: args.track,
            track_overridden: trackOverridden,
            verified: v ? v.matchesExpected : false,
            had_concurrent_writes_after: v?.hadConcurrentWritesAfter ?? false,
            verify_skipped: Boolean(verifyError),
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
