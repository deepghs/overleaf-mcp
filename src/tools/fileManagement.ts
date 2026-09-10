import { promises as fs } from "node:fs";
import { isAbsolute, posix } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { olGet, olPostJson, olDelete, expectOk } from "../api/http.js";
import { getIdentity } from "../session/identity.js";
import { close, open, getActiveProject, findByPath } from "../session/activeProject.js";
import { joinDoc } from "../api/socket.js";
import { buildOutputUrl } from "./compile.js";

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
        // Re-read before collision checks; remote collaborators may have changed the tree.
        if (!name.startsWith("download_")) {
          const ap = getActiveProject();
          if (!ap) throw new Error("Call open_project first.");
          await refresh(ap.projectId);
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
  // Tree-changing requests must not leave stale entity IDs in the session.
  const refresh = async (id: string) => { close(); await open(id); };
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
        : new Uint8Array(await (await expectOk(await olGet(`project/${ap.projectId}/file/${entity.id}`))).arrayBuffer());
      await saveDownload(a.output_path, bytes);
      return { output_path: a.output_path, bytes: bytes.length };
    });
  register("download_project", "Download the open project as a ZIP archive (no extraction).",
    { output_path: output }, async a => {
      const bytes = new Uint8Array(await (await expectOk(await olGet(`project/${active().projectId}/download/zip`))).arrayBuffer());
      await saveDownload(a.output_path, bytes);
      return { output_path: a.output_path, bytes: bytes.length };
    });
  register("download_output", "Download an artifact from the last compile. Run compile first. Defaults to output.pdf.",
    { output_path: output, artifact: z.string().default("output.pdf") }, async a => {
      const last = active().lastCompile;
      const file = last?.outputFiles?.find(f => f.path === a.artifact);
      if (!last || !file) throw new Error("Compile output unavailable. Run compile first.");
      const bytes = new Uint8Array(await (await expectOk(await olGet(buildOutputUrl(file, last)))).arrayBuffer());
      await saveDownload(a.output_path, bytes);
      return { output_path: a.output_path, bytes: bytes.length };
    });
  register("create_folder", "Create one folder in the open project. Parent must exist.", { path }, async a => {
    const target = remotePath(a.path), id = active().projectId;
    await expectOk(await olPostJson(`project/${id}/folder`, { name: posix.basename(target), parent_folder_id: parent(target) }));
    await refresh(id);
    if (!findByPath(target)) throw new Error("Request completed but folder missing on readback.");
    return { path: target };
  });
  register("create_file", "Create an empty text document. Use edit_file for tracked content insertion.", { path }, async a => {
    const target = remotePath(a.path), id = active().projectId;
    await expectOk(await olPostJson(`project/${id}/doc`, { name: posix.basename(target), parent_folder_id: parent(target) }));
    await refresh(id);
    if (!findByPath(target)) throw new Error("Request completed but document missing on readback.");
    return { path: target };
  });
  register("upload_file", "Upload a NEW binary asset only. Existing targets and text files are refused; use create_file and OT edits for text. Do not run concurrently with other tree changes.",
    { path, local_path: z.string() }, async a => {
      const target = remotePath(a.path), id = active().projectId;
      if (!/\.(png|jpe?g|gif|webp|pdf|eps|zip)$/i.test(target)) throw new Error("Only binary asset extensions are allowed.");
      const folder = parent(target);
      if (!isAbsolute(a.local_path)) throw new Error("local_path must be absolute.");
      const bytes = await fs.readFile(a.local_path);
      const identity = await getIdentity();
      const form = new FormData();
      form.append("targetFolderId", folder);
      form.append("name", posix.basename(target));
      form.append("qqfile", new Blob([new Uint8Array(bytes)]), posix.basename(target));
      const res = await fetch(`${identity.baseUrl}/project/${id}/upload?folder_id=${encodeURIComponent(folder)}`, {
        method: "POST", redirect: "manual", headers: { Cookie: identity.cookie, "X-Csrf-Token": identity.csrf }, body: form,
      });
      await expectOk(res);
      await refresh(id);
      if (!findByPath(target)) throw new Error("Upload not found on readback.");
      return { path: target, bytes: bytes.length };
    });
  register("rename_entity", "Rename a file or folder within its current parent; refuses existing targets.",
    { path, new_name: z.string() }, async a => {
      const target = remotePath(a.path), name = remotePath(a.new_name), id = active().projectId;
      if (name.includes("/")) throw new Error("new_name must be a basename.");
      const entity = findByPath(target);
      if (!entity) throw new Error("Entity not found.");
      const destination = posix.join(posix.dirname(target), name);
      parent(destination);
      await expectOk(await olPostJson(`project/${id}/${entity.kind}/${entity.id}/rename`, { name }));
      await refresh(id);
      if (!findByPath(destination)) throw new Error("Rename not confirmed on readback.");
      return { path: destination };
    }, true);
  register("delete_entity", "Delete a file or folder. Requires explicit confirmation; recursive folder deletion is refused.",
    { path, confirm: z.boolean() }, async a => {
      if (!a.confirm) throw new Error("Explicit confirm=true required.");
      const target = remotePath(a.path), ap = active(), entity = findByPath(target);
      if (!entity) throw new Error("Entity not found.");
      if (ap.entities.some(e => e.path.startsWith(target + "/"))) throw new Error("Refusing non-empty folder deletion.");
      await expectOk(await olDelete(`project/${ap.projectId}/${entity.kind}/${entity.id}`));
      await refresh(ap.projectId);
      if (findByPath(target)) throw new Error("Deletion not confirmed on readback.");
      return { deleted: target };
    }, true);
}
