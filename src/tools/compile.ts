import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { asJson, olPostJson } from "../api/http.js";
import { getActiveProject, setLastCompile } from "../session/activeProject.js";
import type { CompileResponse, OutputFile } from "../api/compileTypes.js";
import { logger } from "../util/logger.js";

const Schema = z.object({
  root_doc: z
    .string()
    .optional()
    .describe("Project-relative path to use as the LaTeX root (e.g. 'main.tex'). Defaults to the project's configured root doc."),
  draft: z
    .boolean()
    .default(false)
    .describe("Draft mode — faster but uses placeholder images for figures."),
  stop_on_first_error: z
    .boolean()
    .default(false)
    .describe("Stop on the first LaTeX error instead of continuing to produce a partial PDF."),
});

function summarizeErrors(log: string | undefined): { errors: string[]; warnings: number } {
  if (!log) return { errors: [], warnings: 0 };
  const errors: string[] = [];
  let warnings = 0;
  for (const line of log.split("\n")) {
    if (/^! /.test(line)) errors.push(line.trim());
    else if (/warning/i.test(line)) warnings++;
  }
  return { errors: errors.slice(0, 20), warnings };
}

export function registerCompile(server: McpServer): void {
  server.registerTool(
    "compile",
    {
      title: "Compile the open Overleaf project",
      description:
        "Triggers a LaTeX compile on Overleaf's CLSI and returns the result summary " +
        "(status, output files, error count). Use `read_log` afterwards to see the full output.log " +
        "if there are errors.",
      inputSchema: Schema.shape,
    },
    async (args) => {
      const ap = getActiveProject();
      if (!ap) {
        return { content: [{ type: "text", text: "No project is open. Call open_project first." }], isError: true };
      }
      try {
        const body = {
          check: "silent",
          draft: args.draft,
          incrementalCompilesEnabled: true,
          rootResourcePath: args.root_doc ?? null,
          stopOnFirstError: args.stop_on_first_error,
        };
        const res = await olPostJson(`project/${ap.projectId}/compile?auto_compile=true`, body);
        const result = await asJson<CompileResponse>(res, `POST project/${ap.projectId}/compile`);
        setLastCompile(result);
        const pdf = result.outputFiles?.find((f) => f.path === "output.pdf");
        const log = result.outputFiles?.find((f) => f.path === "output.log");
        const summary = {
          status: result.status ?? "unknown",
          pdf_available: Boolean(pdf),
          compile_time_ms: result.timings?.compile,
          total_time_ms: result.timings?.compileE2E,
          output_files: (result.outputFiles ?? []).map((f) => f.path),
          log_available: Boolean(log),
        };
        return {
          content: [
            {
              type: "text",
              text:
                `Compile status: ${summary.status}. ` +
                `${summary.pdf_available ? "PDF produced." : "No PDF produced."} ` +
                (summary.compile_time_ms ? `Compile took ${summary.compile_time_ms}ms. ` : "") +
                (summary.log_available ? "Use `read_log` to inspect output.log." : ""),
            },
          ],
          structuredContent: summary,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("compile failed", msg);
        return { content: [{ type: "text", text: `Compile failed: ${msg}` }], isError: true };
      }
    },
  );
}

export function registerReadLog(server: McpServer): void {
  server.registerTool(
    "read_log",
    {
      title: "Read the last compile's output.log",
      description:
        "Returns the LaTeX log from the most recent `compile` call. " +
        "Includes a summary of `!`-prefixed error lines at the top, then the full log (truncated to the last 8000 chars).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const ap = getActiveProject();
      if (!ap) return { content: [{ type: "text", text: "No project is open." }], isError: true };
      const last = ap.lastCompile;
      if (!last) {
        return { content: [{ type: "text", text: "No compile has been run for the open project yet. Call `compile` first." }], isError: true };
      }
      const logFile = last.outputFiles?.find((f: OutputFile) => f.path === "output.log");
      if (!logFile) {
        return { content: [{ type: "text", text: "The last compile produced no output.log (it may have failed before reaching LaTeX)." }], isError: true };
      }
      try {
        // outputFiles[].url is a relative path like
        // `project/<id>/user/<uid>/build/<buildId>/output/output.log`.
        // CLSI needs the worker pinned via ?clsiserverid=... or it returns 404.
        const params = new URLSearchParams();
        if (last.clsiServerId) params.set("clsiserverid", last.clsiServerId);
        if (last.compileGroup) params.set("compileGroup", last.compileGroup);
        const base = logFile.url.replace(/^\/+/, "");
        const sep = base.includes("?") ? "&" : "?";
        const qs = params.toString();
        const path = qs ? `${base}${sep}${qs}` : base;
        const { olGet, expectOk } = await import("../api/http.js");
        const res = await olGet(path);
        await expectOk(res, `GET ${path}`);
        const fullLog = await res.text();
        const { errors, warnings } = summarizeErrors(fullLog);
        const tail = fullLog.length > 8000 ? fullLog.slice(-8000) : fullLog;
        const errorBlock = errors.length
          ? `=== ${errors.length} error line(s) ===\n${errors.join("\n")}\n\n`
          : "=== no '! ' error lines ===\n\n";
        const text =
          errorBlock +
          (fullLog.length > 8000 ? `=== output.log (last 8000 of ${fullLog.length} chars) ===\n` : "=== output.log ===\n") +
          tail;
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            log_bytes: fullLog.length,
            error_lines: errors,
            warning_count: warnings,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("read_log failed", msg);
        return { content: [{ type: "text", text: `Failed to fetch output.log: ${msg}` }], isError: true };
      }
    },
  );
}
