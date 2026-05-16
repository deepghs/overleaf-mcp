import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { asJson, olGet, olPostJson } from "../api/http.js";
import { normalizeProject, type ProjectSummary, type RawProject } from "../api/types.js";
import { logger } from "../util/logger.js";

interface ProjectsResponse {
  projects?: RawProject[];
}

async function fetchProjects(): Promise<ProjectSummary[]> {
  // POST /api/project is the dashboard XHR — returns lastUpdated, owner, etc.
  // GET /user/projects exists on older / self-hosted Overleaf but returns a
  // minimal payload (id + name + accessLevel only). Prefer the rich endpoint.
  let raw: RawProject[] | undefined;
  const r1 = await olPostJson("api/project", {});
  if (r1.ok) {
    raw = ((await r1.json()) as ProjectsResponse).projects;
  } else if (r1.status === 404 || r1.status === 405) {
    const r2 = await olGet("user/projects");
    raw = (await asJson<ProjectsResponse>(r2, "GET /user/projects")).projects;
  } else {
    await asJson(r1, "POST /api/project");
  }
  if (!raw) return [];
  return raw.map(normalizeProject).sort((a, b) => {
    const ta = a.lastUpdated ? Date.parse(a.lastUpdated) : 0;
    const tb = b.lastUpdated ? Date.parse(b.lastUpdated) : 0;
    return tb - ta;
  });
}

const FilterSchema = z.object({
  include_archived: z
    .boolean()
    .default(false)
    .describe("Include archived projects in the result (default: false)."),
  include_trashed: z
    .boolean()
    .default(false)
    .describe("Include trashed projects in the result (default: false)."),
  name_contains: z
    .string()
    .optional()
    .describe("Case-insensitive substring filter on project name."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(30)
    .describe("Maximum number of projects to return, after sorting by most recently updated (default: 30)."),
});

export function registerListProjects(server: McpServer): void {
  server.registerTool(
    "list_projects",
    {
      title: "List Overleaf projects",
      description:
        "Lists projects on the configured Overleaf account, sorted by most recently updated. " +
        "Returns each project's id, name, last update time, and owner. " +
        "Use the returned id with `open_project` to start working on a project.",
      inputSchema: FilterSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      try {
        let projects = await fetchProjects();
        const totalBeforeFilter = projects.length;
        if (!args.include_archived) projects = projects.filter((p) => !p.archived);
        if (!args.include_trashed) projects = projects.filter((p) => !p.trashed);
        if (args.name_contains) {
          const needle = args.name_contains.toLowerCase();
          projects = projects.filter((p) => p.name.toLowerCase().includes(needle));
        }
        const truncated = projects.length > args.limit;
        const shown = projects.slice(0, args.limit);
        const payload = { count: shown.length, total_matched: projects.length, total_account: totalBeforeFilter, truncated, projects: shown };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("list_projects failed", msg);
        return {
          content: [{ type: "text", text: `Failed to list projects: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
