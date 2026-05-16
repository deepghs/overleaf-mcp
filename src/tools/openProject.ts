import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { open } from "../session/activeProject.js";
import { logger } from "../util/logger.js";

const Schema = z.object({
  project_id: z
    .string()
    .min(8)
    .describe("The Overleaf project id, from list_projects (a hex string like '61d853bcbf1003100e957034')."),
});

export function registerOpenProject(server: McpServer): void {
  server.registerTool(
    "open_project",
    {
      title: "Open Overleaf project",
      description:
        "Joins the project's real-time Socket.IO session and caches its file tree. " +
        "Must be called before list_files / read_file / edit_file. " +
        "Switching projects automatically closes the previous session.",
      inputSchema: Schema.shape,
    },
    async (args) => {
      try {
        const p = await open(args.project_id);
        const summary = {
          project_id: p.projectId,
          name: p.name,
          entity_count: p.entities.length,
          docs: p.entities.filter((e) => e.kind === "doc").length,
          files: p.entities.filter((e) => e.kind === "file").length,
          folders: p.entities.filter((e) => e.kind === "folder").length,
          track_changes_on_for_me: p.trackChangesOnForMe,
        };
        return {
          content: [
            {
              type: "text",
              text:
                `Opened "${p.name}" (${summary.docs} docs, ${summary.files} files, ${summary.folders} folders). ` +
                `Track changes ${summary.track_changes_on_for_me ? "is ON" : "is OFF"} for this user. ` +
                `Use list_files to browse, read_file to read.`,
            },
          ],
          structuredContent: summary,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("open_project failed", msg);
        return { content: [{ type: "text", text: `Failed to open project: ${msg}` }], isError: true };
      }
    },
  );
}
