import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getActiveProject } from "../session/activeProject.js";
import { knownServers } from "../session/servers.js";

export function registerListServers(server: McpServer): void {
  server.registerTool(
    "list_servers",
    {
      title: "List known Overleaf servers",
      description:
        "Lists every Overleaf server this MCP knows about: the default (OL_BASE_URL), any pre-declared in OL_SERVERS, " +
        "and every host with a stored login cookie — with whether a cookie is stored, its age, and which server the open project is on. " +
        "No network. Use a listed host as the `server` argument of list_projects / open_project. " +
        "To add a server, pass its host to those tools (a login window opens on desktops) or have the user run " +
        "`overleaf-mcp login --server <host>` in a terminal.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      const known = await knownServers();
      const ap = getActiveProject();
      const now = Date.now();
      const servers = known.map((s) => ({
        server: s.host,
        url: s.baseUrl,
        is_default: s.isDefault,
        logged_in: s.loggedIn,
        cookie_saved_at: s.cookieSavedAt ? new Date(s.cookieSavedAt).toISOString() : undefined,
        cookie_age_hours: s.cookieSavedAt ? Math.round((now - s.cookieSavedAt) / 3_600_000) : undefined,
        active: ap?.baseUrl === s.baseUrl,
        sources: s.sources,
      }));
      const lines = servers.map((s) =>
        `${s.active ? "*" : " "} ${s.server}${s.is_default ? " (default)" : ""} — ` +
        (s.logged_in ? `cookie saved ${s.cookie_age_hours}h ago` : "not logged in"),
      );
      const text =
        lines.join("\n") +
        "\n\n* = server of the open project. 'cookie saved' means a login is stored, not that it is still valid (Overleaf cookies last ~5 days).";
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          count: servers.length,
          default_server: servers.find((s) => s.is_default)?.server,
          active_server: ap?.host,
          servers,
        },
      };
    },
  );
}
