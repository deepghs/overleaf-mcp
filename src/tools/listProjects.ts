import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { asJson, olGet, olPostJson } from "../api/http.js";
import { normalizeProject, type ProjectSummary, type RawProject } from "../api/types.js";
import { hostOf, knownServers, rememberProjectServer, resolveServer } from "../session/servers.js";
import { logger } from "../util/logger.js";

interface ProjectsResponse {
  projects?: RawProject[];
}

type TaggedProject = ProjectSummary & { server: string; server_url: string };

async function fetchProjects(baseUrl: string): Promise<TaggedProject[]> {
  // POST /api/project is the dashboard XHR — returns lastUpdated, owner, etc.
  // GET /user/projects exists on older / self-hosted Overleaf but returns a
  // minimal payload (id + name + accessLevel only). Prefer the rich endpoint.
  let raw: RawProject[] | undefined;
  const r1 = await olPostJson(baseUrl, "api/project", {});
  if (r1.ok) {
    raw = ((await r1.json()) as ProjectsResponse).projects;
  } else if (r1.status === 404 || r1.status === 405) {
    const r2 = await olGet(baseUrl, "user/projects");
    raw = (await asJson<ProjectsResponse>(r2, "GET /user/projects")).projects;
  } else {
    await asJson(r1, "POST /api/project");
  }
  const host = hostOf(baseUrl);
  return (raw ?? []).map((p) => ({ ...normalizeProject(p), server: host, server_url: baseUrl }));
}

function byRecency(a: ProjectSummary, b: ProjectSummary): number {
  const ta = a.lastUpdated ? Date.parse(a.lastUpdated) : 0;
  const tb = b.lastUpdated ? Date.parse(b.lastUpdated) : 0;
  return tb - ta;
}

// Servers to query when none is named: every known server with a stored
// cookie. If nothing is logged in yet, the default server (which triggers
// the login flow) so first use still works.
async function targetServers(): Promise<string[]> {
  const known = await knownServers();
  const loggedIn = known.filter((s) => s.loggedIn).map((s) => s.baseUrl);
  if (loggedIn.length) return loggedIn;
  return known.filter((s) => s.isDefault).map((s) => s.baseUrl);
}

const FilterSchema = z.object({
  server: z
    .string()
    .optional()
    .describe(
      "Only list projects on this Overleaf server — a host like 'overleaf.example.org' or an origin URL. " +
        "Omit to list every logged-in server at once (see list_servers); each project then carries a `server` field.",
    ),
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
        "Lists projects on the configured Overleaf account(s), sorted by most recently updated. " +
        "Returns each project's id, name, last update time, owner, and the `server` it lives on. " +
        "With no `server` argument every logged-in server is queried and the results merged. " +
        "Use the returned id (and server, if several are logged in) with `open_project` to start working on a project.",
      inputSchema: FilterSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      try {
        const servers = args.server !== undefined ? [await resolveServer(args.server)] : await targetServers();
        const perServer: Array<{ server: string; url: string; project_count?: number; error?: string }> = [];
        let projects: TaggedProject[] = [];
        // Sequential on purpose: an expired cookie triggers the browser-login
        // flow, and two of those at once would fight over the Chrome profile.
        for (const baseUrl of servers) {
          try {
            const list = await fetchProjects(baseUrl);
            projects.push(...list);
            perServer.push({ server: hostOf(baseUrl), url: baseUrl, project_count: list.length });
          } catch (err) {
            if (servers.length === 1) throw err;
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`list_projects: ${hostOf(baseUrl)} failed, continuing with other servers: ${msg}`);
            perServer.push({ server: hostOf(baseUrl), url: baseUrl, error: msg });
          }
        }
        for (const p of projects) rememberProjectServer(p.id, p.server_url);
        projects.sort(byRecency);
        const totalBeforeFilter = projects.length;
        if (!args.include_archived) projects = projects.filter((p) => !p.archived);
        if (!args.include_trashed) projects = projects.filter((p) => !p.trashed);
        if (args.name_contains) {
          const needle = args.name_contains.toLowerCase();
          projects = projects.filter((p) => p.name.toLowerCase().includes(needle));
        }
        const truncated = projects.length > args.limit;
        const shown = projects.slice(0, args.limit);
        const payload = {
          count: shown.length,
          total_matched: projects.length,
          total_account: totalBeforeFilter,
          truncated,
          servers: perServer,
          projects: shown,
        };
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
