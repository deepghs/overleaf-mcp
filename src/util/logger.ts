// All logging goes to stderr — stdout is reserved for the MCP JSON-RPC channel.

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.OL_MCP_LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

function log(level: Level, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const line = extra === undefined
    ? `[ol-mcp ${level}] ${msg}`
    : `[ol-mcp ${level}] ${msg} ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
  process.stderr.write(line + "\n");
}

export const logger = {
  debug: (m: string, e?: unknown) => log("debug", m, e),
  info: (m: string, e?: unknown) => log("info", m, e),
  warn: (m: string, e?: unknown) => log("warn", m, e),
  error: (m: string, e?: unknown) => log("error", m, e),
};
