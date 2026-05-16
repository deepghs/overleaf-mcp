import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getActiveProject } from "../session/activeProject.js";

const Schema = z.object({
  kind: z
    .enum(["all", "doc", "file", "folder"])
    .default("all")
    .describe("Filter by entity kind. 'doc' = editable .tex/.md files, 'file' = binary assets (images, PDFs), 'folder' = directories."),
  path_contains: z.string().optional().describe("Case-insensitive substring filter on the project-relative path."),
});

export function registerListFiles(server: McpServer): void {
  server.registerTool(
    "list_files",
    {
      title: "List files in the open Overleaf project",
      description:
        "Returns the file tree of the currently open project as a flat list of project-relative paths. " +
        "Cheap — uses cached data from open_project, no network. " +
        "Each entity has a path (e.g. 'chapters/intro.tex'), an id, and a kind ('doc' | 'file' | 'folder').",
      inputSchema: Schema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      const ap = getActiveProject();
      if (!ap) {
        return {
          content: [{ type: "text", text: "No project is open. Call open_project first." }],
          isError: true,
        };
      }
      let entities = ap.entities;
      if (args.kind !== "all") entities = entities.filter((e) => e.kind === args.kind);
      if (args.path_contains) {
        const needle = args.path_contains.toLowerCase();
        entities = entities.filter((e) => e.path.toLowerCase().includes(needle));
      }
      entities = [...entities].sort((a, b) => a.path.localeCompare(b.path));
      const lines = entities.map((e) => `${e.kind.padEnd(6)} ${e.path}`);
      const text = lines.length === 0 ? "(no entities matched)" : lines.join("\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { project_id: ap.projectId, count: entities.length, entities },
      };
    },
  );
}
