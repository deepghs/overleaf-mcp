import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { joinDoc } from "../api/socket.js";
import { olGet, expectOk } from "../api/http.js";
import { findByPath, getActiveProject } from "../session/activeProject.js";
import { updateDoc } from "../session/docCache.js";
import { logger } from "../util/logger.js";

const Schema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Project-relative path of the file, e.g. 'main.tex' or 'chapters/intro.tex'. List with list_files first."),
});

const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp", "svg",
  "pdf", "eps", "ps", "ai",
  "zip", "tar", "gz", "bz2", "7z",
  "ttf", "otf", "woff", "woff2",
]);
function mimeForName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "bmp": return "image/bmp";
    case "webp": return "image/webp";
    case "tif":
    case "tiff": return "image/tiff";
    case "svg": return "image/svg+xml";
    case "pdf": return "application/pdf";
    case "zip": return "application/zip";
    case "ttf": return "font/ttf";
    case "otf": return "font/otf";
    case "woff": return "font/woff";
    case "woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

export function registerReadFile(server: McpServer): void {
  server.registerTool(
    "read_file",
    {
      title: "Read a file from the open Overleaf project",
      description:
        "Reads the contents of a file by project-relative path. " +
        "For text docs (.tex, .bib, .md, etc.) returns the full text and the current OT version. " +
        "For binary files (images, PDFs) returns base64 + MIME type via HTTP download.",
      inputSchema: Schema.shape,
      annotations: { readOnlyHint: true },
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
      if (entity.kind === "folder") {
        return { content: [{ type: "text", text: `'${args.path}' is a folder, not a file.` }], isError: true };
      }
      try {
        if (entity.kind === "doc") {
          const doc = await joinDoc(entity.id);
          const text = doc.docLines.join("\n");
          // Pin the doc cache to exactly what the agent just saw, so a later
          // edit_file uses the same baseline. If the server has moved on
          // (concurrent edit) between read and edit, the resulting op will be
          // sent with a stale `v` and the server will reject or transform —
          // either is correct behavior, but we no longer silently overwrite.
          updateDoc(entity.id, text, doc.version);
          const ranges = doc.ranges as { changes?: unknown[]; comments?: unknown[] } | undefined | null;
          const changeCount = Array.isArray(ranges?.changes) ? ranges.changes.length : 0;
          const commentCount = Array.isArray(ranges?.comments) ? ranges.comments.length : 0;
          return {
            content: [{ type: "text", text }],
            structuredContent: {
              path: entity.path,
              doc_id: entity.id,
              kind: "doc",
              version: doc.version,
              line_count: doc.docLines.length,
              byte_count: Buffer.byteLength(text, "utf8"),
              has_ranges: doc.ranges !== undefined && doc.ranges !== null,
              tracked_change_count: changeCount,
              comment_count: commentCount,
              // Surface up to the 5 most recent tracked-change entries so the
              // agent (and our tests) can see what's in the review panel.
              recent_changes: Array.isArray(ranges?.changes) ? ranges.changes.slice(-5) : [],
            },
          };
        }
        // Binary fileRef: HTTP download.
        const res = await olGet(`project/${ap.projectId}/file/${entity.id}`);
        await expectOk(res, `GET project/${ap.projectId}/file/${entity.id}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const ext = entity.name.split(".").pop()?.toLowerCase() ?? "";
        const looksText = !BINARY_EXTS.has(ext) && buf.length > 0 && buf.subarray(0, Math.min(2048, buf.length)).every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128);
        if (looksText) {
          return {
            content: [{ type: "text", text: buf.toString("utf8") }],
            structuredContent: { path: entity.path, file_id: entity.id, kind: "file", byte_count: buf.length, encoding: "utf8" },
          };
        }
        return {
          content: [
            { type: "text", text: `(binary file, ${buf.length} bytes, base64 below)` },
            { type: "text", text: buf.toString("base64") },
          ],
          structuredContent: {
            path: entity.path,
            file_id: entity.id,
            kind: "file",
            byte_count: buf.length,
            mime_type: mimeForName(entity.name),
            encoding: "base64",
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("read_file failed", msg);
        return { content: [{ type: "text", text: `Failed to read '${args.path}': ${msg}` }], isError: true };
      }
    },
  );
}
