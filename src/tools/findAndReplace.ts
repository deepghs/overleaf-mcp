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
    .describe(
      "Project-relative path of the doc to edit, e.g. 'main.tex'. If omitted, defaults to the project's root doc.",
    ),
  old_string: z
    .string()
    .min(1)
    .describe(
      "Exact substring to find — must match byte-for-byte including whitespace. Must be unique in the doc unless `replace_all` is true.",
    ),
  new_string: z
    .string()
    .describe("Replacement text. May be empty (effectively a delete)."),
  replace_all: z
    .boolean()
    .default(false)
    .describe(
      "If true, replace every occurrence of `old_string`. If false (default), `old_string` must match exactly once — multi-match returns a list of locations so you can disambiguate with a longer `old_string`.",
    ),
  expected_version: z
    .number()
    .int()
    .optional()
    .describe("Optional safety check. If the doc's current version differs, the edit is rejected."),
  track: z
    .enum(["auto", "on", "off"])
    .default("on")
    .describe(
      "Tracked-changes mode. Default 'on' lands the edit as a pending suggestion in the Review panel. 'off' writes directly; 'auto' tracks only when the project has track-changes enabled for this user.",
    ),
  strict_version: z
    .boolean()
    .default(false)
    .describe(
      "If true, re-fetch the doc version before sending the edit and refuse if the cached baseline is stale. Catches races from parallel agents (each MCP process has its own cache) or a concurrently open Overleaf web editor at the cost of one extra round-trip. Without this, the server's OT transform handles stale-version edits silently, which can land the op in an unexpected location or collapse it to a no-op. Recommended when several agents may be editing the same project.",
    ),
});

// Find every non-overlapping start index of `needle` in `haystack`.
export function findAllIndices(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let i = 0;
  while (i <= haystack.length - needle.length) {
    const j = haystack.indexOf(needle, i);
    if (j < 0) break;
    out.push(j);
    i = j + needle.length;
  }
  return out;
}

// Map a char index into (1-based line, 1-based col, the full line text).
export function lineOf(text: string, idx: number): { line: number; col: number; lineText: string } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < idx; i++) {
    if (text.charCodeAt(i) === 0x0a /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  const nextNl = text.indexOf("\n", lineStart);
  const lineEnd = nextNl < 0 ? text.length : nextNl;
  return { line, col: idx - lineStart + 1, lineText: text.slice(lineStart, lineEnd) };
}

export function registerFindAndReplace(server: McpServer): void {
  server.registerTool(
    "find_and_replace",
    {
      title: "Surgical find-and-replace in an Overleaf doc",
      description:
        "Replace one occurrence — or all, with `replace_all: true` — of `old_string` with `new_string` in a doc, without re-emitting the rest of the file. " +
        "By default `old_string` must be unique; ambiguous matches are returned with line:column locations so you can extend the match. " +
        "Submits the minimal OT operation through the same pathway as `edit_file`, so by default it lands as a pending suggestion in Overleaf's Review panel (track:'on'). " +
        "If `path` is omitted, defaults to the project's root doc. " +
        "Prefer this over `edit_file` for targeted edits — it's cheaper in tokens and avoids accidental whitespace drift from re-emitting the surrounding text.",
      inputSchema: Schema.shape,
    },
    async (args) => {
      const ap = getActiveProject();
      if (!ap) {
        return { content: [{ type: "text", text: "No project is open. Call open_project first." }], isError: true };
      }
      const resolvedPath = args.path ?? ap.rootDocPath;
      if (!resolvedPath) {
        return {
          content: [{ type: "text", text: "No path provided and the project has no configured root doc. Pass a `path`." }],
          isError: true,
        };
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
          updateDoc(entity.id, bc.serverText, bc.serverVersion);
          cached = { docId: entity.id, text: bc.serverText, version: bc.serverVersion };
        }
        const indices = findAllIndices(cached.text, args.old_string);
        if (indices.length === 0) {
          return {
            content: [{
              type: "text",
              text:
                `\`old_string\` not found in '${entity.path}' (doc has ${cached.text.length} chars at version ${cached.version}). ` +
                `Check whitespace, line endings, and that you're reading the current text — re-call read_file if unsure.`,
            }],
            isError: true,
          };
        }
        if (indices.length > 1 && !args.replace_all) {
          const sample = indices.slice(0, 10).map((i) => {
            const { line, col, lineText } = lineOf(cached.text, i);
            const trimmed = lineText.trim();
            const preview = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
            return `  line ${line}:${col}  ${preview}`;
          }).join("\n");
          const more = indices.length > 10 ? `\n  ...and ${indices.length - 10} more` : "";
          return {
            content: [{
              type: "text",
              text:
                `\`old_string\` matched ${indices.length} times in '${entity.path}'. ` +
                `Either extend \`old_string\` so it uniquely identifies one occurrence, or pass \`replace_all: true\` to replace every match.\nMatches:\n${sample}${more}`,
            }],
            isError: true,
          };
        }
        const preEditText = cached.text;
        let newContent: string;
        if (args.replace_all) {
          newContent = cached.text.split(args.old_string).join(args.new_string);
        } else {
          const idx = indices[0];
          newContent = cached.text.slice(0, idx) + args.new_string + cached.text.slice(idx + args.old_string.length);
        }
        const ops: ShareJsOp[] = textToOps(cached.text, newContent);
        if (ops.length === 0) {
          return {
            content: [{ type: "text", text: "No-op: old_string is identical to new_string at every match." }],
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
        const update: OtUpdate = { doc: entity.id, op: ops, v: cached.version, meta };
        await applyOtUpdate(entity.id, update);
        const optimisticVersion = cached.version + 1;
        const replacements = args.replace_all ? indices.length : 1;
        const trackingNote = serverWillTrack
          ? (trackOverridden
              ? "Submitted as a tracked change — `track:\"off\"` was overridden because the project has track_changes_on_for_me. The edit lands as a pending suggestion in Overleaf's Review panel."
              : "Submitted as tracked changes — should appear as a pending suggestion in Overleaf's Review panel.")
          : "Submitted as a direct edit (no tracking).";

        let v: Awaited<ReturnType<typeof verifyEdit>> | undefined;
        let verifyError: string | undefined;
        try {
          v = await verifyEdit(entity.id, preEditText, newContent, optimisticVersion);
        } catch (e) {
          verifyError = e instanceof Error ? e.message : String(e);
        }
        if (v) updateDoc(entity.id, v.serverText, v.serverVersion);
        else updateDoc(entity.id, newContent, optimisticVersion);

        if (v && v.silentNoOp) {
          return {
            content: [{ type: "text", text:
              `Server acked the OT update for '${entity.path}' but the doc text is unchanged (silent no-op). ` +
              `\`old_string\` matched in your cached baseline, ops were sent and acked, but the server's doc didn't move — usually because a parallel agent or open editor bumped the version between your last read and this edit, and the server's OT transform collapsed your ops. ` +
              `Cache is now synced to the real server state (v${v.serverVersion}). Re-call read_file and retry; consider \`strict_version: true\` to fail fast on stale baselines.`,
            }],
            isError: true,
            structuredContent: {
              path: entity.path,
              doc_id: entity.id,
              replacements: 0,
              ops_applied: ops.length,
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
            ? ` Note: server text doesn't byte-match the predicted post-edit content (cache synced to actual server state at v${v.serverVersion}); the replace landed but may have been OT-transformed.`
            : "";
        const verifySkippedNote = verifyError ? ` (post-edit verification skipped: ${verifyError})` : "";
        const versionAfter = v ? v.serverVersion : optimisticVersion;

        return {
          content: [{
            type: "text",
            text:
              `Replaced ${replacements} occurrence(s) in '${entity.path}'. Doc version ${cached.version} -> ${versionAfter}. ` +
              trackingNote + concurrentNote + verifySkippedNote,
          }],
          structuredContent: {
            path: entity.path,
            doc_id: entity.id,
            replacements,
            ops_applied: ops.length,
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
        logger.error("find_and_replace failed", msg);
        return {
          content: [{ type: "text", text: `Failed to find_and_replace in '${args.path ?? "(root doc)"}': ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
