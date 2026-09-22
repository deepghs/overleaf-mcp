import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { open } from "../session/activeProject.js";
import { knownServers, projectServer, rememberProjectServer, resolveServer } from "../session/servers.js";
import { logger } from "../util/logger.js";

const Schema = z.object({
  project_id: z
    .string()
    .min(8)
    .describe("The Overleaf project id, from list_projects (a hex string like '61d853bcbf1003100e957034')."),
  server: z
    .string()
    .optional()
    .describe(
      "Overleaf server the project lives on — a host like 'overleaf.example.org' or an origin URL (see list_servers). " +
        "Optional when list_projects already returned this project, or when at most one server is logged in.",
    ),
});

// Which server to join. Explicit argument wins; then whatever list_projects
// saw the id on; then the only logged-in server; then the default. With
// several servers logged in and no hint we refuse rather than guess — a
// wrong guess costs a connect + rejection round-trip and a confusing error.
async function pickServer(projectId: string, server: string | undefined): Promise<string> {
  if (server !== undefined) return resolveServer(server);
  const remembered = projectServer(projectId);
  if (remembered) return remembered;
  const known = await knownServers();
  const loggedIn = known.filter((s) => s.loggedIn);
  if (loggedIn.length === 1) return loggedIn[0].baseUrl;
  if (loggedIn.length === 0) return known.find((s) => s.isDefault)!.baseUrl;
  throw new Error(
    `Several Overleaf servers are logged in (${loggedIn.map((s) => s.host).join(", ")}) and project ${projectId} ` +
      "was not seen in list_projects. Pass `server` to say which one to use.",
  );
}

export function registerOpenProject(server: McpServer): void {
  server.registerTool(
    "open_project",
    {
      title: "Open Overleaf project",
      description:
        "Joins the project's real-time Socket.IO session and caches its file tree. " +
        "Must be called before list_files / read_file / edit_file. " +
        "Switching projects (on any server) automatically closes the previous session. " +
        "Pass `server` when the project is on a server other than the default and it was not just returned by list_projects.",
      inputSchema: Schema.shape,
    },
    async (args) => {
      try {
        const baseUrl = await pickServer(args.project_id, args.server);
        const p = await open(args.project_id, baseUrl);
        rememberProjectServer(p.projectId, p.baseUrl);
        const project = p.project;
        const summary = {
          project_id: p.projectId,
          server: p.host,
          server_url: p.baseUrl,
          name: p.name,
          root_doc_path: p.rootDocPath,
          root_doc_id: p.rootDocId,
          entity_count: p.entities.length,
          docs: p.entities.filter((e) => e.kind === "doc").length,
          files: p.entities.filter((e) => e.kind === "file").length,
          folders: p.entities.filter((e) => e.kind === "folder").length,
          track_changes_on_for_me: p.trackChangesOnForMe,
          compiler: project.compiler,
          spell_check_language: project.spellCheckLanguage,
          public_access_level: project.publicAccesLevel,
          owner: project.owner ? { email: project.owner.email, name: [project.owner.first_name, project.owner.last_name].filter(Boolean).join(" ") || undefined } : undefined,
          members: (project.members ?? []).map((m) => ({ email: m.email, name: [m.first_name, m.last_name].filter(Boolean).join(" ") || undefined, privileges: m.privileges })),
        };
        return {
          content: [
            {
              type: "text",
              text:
                `Opened "${p.name}" on ${p.host} (${summary.docs} docs, ${summary.files} files, ${summary.folders} folders). ` +
                `Track changes ${summary.track_changes_on_for_me ? "is ON" : "is OFF"} for this user. ` +
                `Root doc: ${p.rootDocPath ?? "(unset)"}. ` +
                `Compiler: ${summary.compiler ?? "(default)"}. ` +
                `Use list_files to browse, read_file/edit_file to read+write (path defaults to the root doc).`,
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
