import { promises as fs } from "node:fs";
import { isAbsolute, posix } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { olGet, olPostJson, olDelete, expectOk } from "../api/http.js";
import { getIdentity } from "../session/identity.js";
import { getActiveProject, findByPath, refreshTree, socketLive, waitForTree } from "../session/activeProject.js";
import { joinDoc } from "../api/socket.js";
import { buildOutputUrl } from "./compile.js";
import { logger } from "../util/logger.js";

export function remotePath(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0") ||
      value.split("/").some(p => !p || p === "." || p === "..")) {
    throw new Error("Use a project-relative path without empty, dot, or parent segments.");
  }
  return value;
}

export async function saveDownload(destination: string, bytes: Uint8Array): Promise<void> {
  if (!isAbsolute(destination)) throw new Error("output_path must be absolute.");
  // Exclusive creation refuses both existing files and symlink targets.
  await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
}

// How long to wait for the server's tree broadcast (reciveNewDoc, removeEntity,
// reciveEntityRename, ...) to reach the local tree before falling back to a
// full project re-join. The broadcast normally arrives before the HTTP
// response is even parsed, so this only trips on a dropped frame or an
// Overleaf build that does not emit it.
const TREE_EVENT_TIMEOUT_MS = 5_000;

type TreeSync = "event" | "reconnect";

export function registerFileManagement(server: McpServer): void {
  let queue: Promise<unknown> = Promise.resolve();
  const path = z.string().min(1);
  const output = z.string().describe("Absolute local output path; parent must exist. Never overwrites.");
  const register = (name: string, description: string, schema: Record<string, z.ZodType>,
    run: (args: any) => Promise<unknown>, destructive = false) => {
    server.registerTool(name, { description, inputSchema: schema,
      annotations: { destructiveHint: destructive } }, args => {
      const task = queue.then(async () => {
      try {
        if (!name.startsWith("download_")) {
          if (!getActiveProject()) throw new Error("Call open_project first.");
          // The tree is kept current by the socket's tree broadcasts (see
          // activeProject.ts), so collision checks below already see what
          // collaborators did. Only a dead socket needs a real re-join.
          if (!socketLive()) await refreshTree();
        }
        const result = await run(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text" as const, text: String(e) }] };
      }
      });
      queue = task.catch(() => undefined);
      return task;
    });
  };
  const active = () => {
    const ap = getActiveProject();
    if (!ap) throw new Error("Call open_project first.");
    return ap;
  };
  // Confirm a mutation against the local tree: wait for the server's
  // broadcast, and if it never shows, re-join the project once (the pre-0.4
  // behaviour) and check again.
  const confirm = async (check: () => boolean, failure: string): Promise<TreeSync> => {
    if (await waitForTree(check, TREE_EVENT_TIMEOUT_MS)) return "event";
    logger.warn(`no tree broadcast within ${TREE_EVENT_TIMEOUT_MS}ms; re-joining project to confirm`);
    await refreshTree();
    if (!check()) throw new Error(failure);
    return "reconnect";
  };
  const parent = (target: string) => {
    const ap = active();
    const dir = posix.dirname(target);
    const folder = dir === "." ? ap.project.rootFolder[0]._id : findByPath(dir)?.id;
    if (!folder || (dir !== "." && findByPath(dir)?.kind !== "folder")) throw new Error("Parent folder does not exist.");
    if (findByPath(target)) throw new Error("Destination already exists. Use OT editing for existing documents.");
    return folder;
  };
  register("download_file", "Download a document snapshot or binary file from the open project.",
    { path, output_path: output }, async a => {
      const ap = active();
      const entity = findByPath(remotePath(a.path));
      if (!entity || entity.kind === "folder") throw new Error("File not found.");
      const bytes = entity.kind === "doc"
        ? Buffer.from((await joinDoc(entity.id)).docLines.join("\n"))
        : new Uint8Array(await (await expectOk(await olGet(ap.baseUrl, `project/${ap.projectId}/file/${entity.id}`))).arrayBuffer());
      await saveDownload(a.output_path, bytes);
      return { output_path: a.output_path, bytes: bytes.length };
    });
  register("download_project", "Download the open project as a ZIP archive (no extraction).",
    { output_path: output }, async a => {
      const ap = active();
      const bytes = new Uint8Array(await (await expectOk(await olGet(ap.baseUrl, `project/${ap.projectId}/download/zip`))).arrayBuffer());
      await saveDownload(a.output_path, bytes);
      return { output_path: a.output_path, bytes: bytes.length };
    });
  register("download_output", "Download an artifact from the last compile. Run compile first. Defaults to output.pdf.",
    { output_path: output, artifact: z.string().default("output.pdf") }, async a => {
      const ap = active();
      const last = ap.lastCompile;
      const file = last?.outputFiles?.find(f => f.path === a.artifact);
      if (!last || !file) throw new Error("Compile output unavailable. Run compile first.");
      const bytes = new Uint8Array(await (await expectOk(await olGet(ap.baseUrl, buildOutputUrl(file, last)))).arrayBuffer());
      await saveDownload(a.output_path, bytes);
      return { output_path: a.output_path, bytes: bytes.length };
    });
  register("create_folder", "Create one folder in the open project. Parent must exist.", { path }, async a => {
    const target = remotePath(a.path), ap = active();
    await expectOk(await olPostJson(ap.baseUrl, `project/${ap.projectId}/folder`, { name: posix.basename(target), parent_folder_id: parent(target) }));
    const tree_sync = await confirm(() => findByPath(target)?.kind === "folder", "Request completed but folder missing on readback.");
    return { path: target, tree_sync };
  });
  register("create_file", "Create an empty text document. Use edit_file for tracked content insertion.", { path }, async a => {
    const target = remotePath(a.path), ap = active();
    await expectOk(await olPostJson(ap.baseUrl, `project/${ap.projectId}/doc`, { name: posix.basename(target), parent_folder_id: parent(target) }));
    const tree_sync = await confirm(() => findByPath(target)?.kind === "doc", "Request completed but document missing on readback.");
    return { path: target, tree_sync };
  });
  register("upload_file", "Upload a NEW binary asset only. Existing targets and text files are refused; use create_file and OT edits for text. Do not run concurrently with other tree changes.",
    { path, local_path: z.string() }, async a => {
      const target = remotePath(a.path), ap = active();
      if (!/\.(png|jpe?g|gif|webp|pdf|eps|zip)$/i.test(target)) throw new Error("Only binary asset extensions are allowed.");
      const folder = parent(target);
      if (!isAbsolute(a.local_path)) throw new Error("local_path must be absolute.");
      const bytes = await fs.readFile(a.local_path);
      const identity = await getIdentity(ap.baseUrl);
      const form = new FormData();
      form.append("targetFolderId", folder);
      form.append("name", posix.basename(target));
      form.append("qqfile", new Blob([new Uint8Array(bytes)]), posix.basename(target));
      const res = await fetch(`${identity.baseUrl}/project/${ap.projectId}/upload?folder_id=${encodeURIComponent(folder)}`, {
        method: "POST", redirect: "manual", headers: { Cookie: identity.cookie, "X-Csrf-Token": identity.csrf }, body: form,
      });
      await expectOk(res);
      const tree_sync = await confirm(() => findByPath(target)?.kind === "file", "Upload not found on readback.");
      return { path: target, bytes: bytes.length, tree_sync };
    });
  register("rename_entity", "Rename a file or folder within its current parent; refuses existing targets.",
    { path, new_name: z.string() }, async a => {
      const target = remotePath(a.path), name = remotePath(a.new_name), ap = active();
      if (name.includes("/")) throw new Error("new_name must be a basename.");
      const entity = findByPath(target);
      if (!entity) throw new Error("Entity not found.");
      const destination = posix.join(posix.dirname(target), name);
      parent(destination);
      await expectOk(await olPostJson(ap.baseUrl, `project/${ap.projectId}/${entity.kind}/${entity.id}/rename`, { name }));
      const tree_sync = await confirm(() => findByPath(destination)?.id === entity.id, "Rename not confirmed on readback.");
      return { path: destination, tree_sync };
    }, true);
  register("delete_entity", "Delete a file or folder. Requires explicit confirmation; recursive folder deletion is refused.",
    { path, confirm: z.boolean() }, async a => {
      if (!a.confirm) throw new Error("Explicit confirm=true required.");
      const target = remotePath(a.path), ap = active(), entity = findByPath(target);
      if (!entity) throw new Error("Entity not found.");
      if (ap.entities.some(e => e.path.startsWith(target + "/"))) throw new Error("Refusing non-empty folder deletion.");
      await expectOk(await olDelete(ap.baseUrl, `project/${ap.projectId}/${entity.kind}/${entity.id}`));
      const tree_sync = await confirm(() => !findByPath(target), "Deletion not confirmed on readback.");
      return { deleted: target, tree_sync };
    }, true);
}
