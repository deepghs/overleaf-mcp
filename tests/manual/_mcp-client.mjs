// Shared MCP client helper for tests/manual/*. Spawns the overleaf-mcp server as a
// child process and exposes a thin JSON-RPC client over its stdio.
//
// Usage:
//   import { spawnMcp } from "./_mcp-client.mjs";
//   const a = spawnMcp();
//   await a.init();
//   const r = await a.callTool("list_files", {});
//   a.kill();

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVER = resolve(__dirname, "../../dist/index.js");

export function spawnMcp({ server = DEFAULT_SERVER, env = process.env, label = "" } = {}) {
  const child = spawn("node", [server], { stdio: ["pipe", "pipe", "inherit"], env });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  const call = (method, params) => {
    const id = nextId++;
    return new Promise((resolveP) => {
      pending.set(id, { resolve: resolveP });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

  const callTool = async (name, args = {}) => {
    const r = await call("tools/call", { name, arguments: args });
    return {
      isError: Boolean(r.result?.isError),
      text: (r.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n"),
      structured: r.result?.structuredContent,
      raw: r,
    };
  };

  const init = async () => {
    await call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: label || "test", version: "1.0" },
    });
    notify("notifications/initialized");
  };

  const kill = () => { try { child.kill(); } catch {} };

  return { call, notify, callTool, init, kill, child };
}
