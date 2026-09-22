import {
  ensureSocketForProject,
  disconnectActive,
  getActiveSocket,
  onProjectEvent,
  onReconnected,
} from "../api/socket.js";
import {
  applyTreeEvent,
  flattenTree,
  isTrackChangesOnForUser,
  type FlatEntity,
  type ProjectEntity,
} from "../api/projectTypes.js";
import type { CompileResponse } from "../api/compileTypes.js";
import { getIdentity } from "./identity.js";
import { clearDocCache, dropDoc } from "./docCache.js";
import { hostOf } from "./servers.js";
import { logger } from "../util/logger.js";

export interface ActiveProject {
  // Server this project lives on. All project-scoped HTTP goes here.
  baseUrl: string;
  host: string;
  projectId: string;
  name: string;
  project: ProjectEntity;
  entities: FlatEntity[];
  trackChangesOnForMe: boolean;
  rootDocId?: string;
  rootDocPath?: string;
  lastCompile?: CompileResponse;
}

let active: ActiveProject | null = null;

// Callers waiting for the local tree to reach some state (e.g. "the folder I
// just created is visible"). Re-checked after every applied broadcast.
interface TreeWaiter {
  check: () => boolean;
  resolve: (ok: boolean) => void;
  timer: NodeJS.Timeout;
}
const treeWaiters = new Set<TreeWaiter>();

function reindex(ap: ActiveProject): void {
  const root = ap.project.rootFolder?.[0];
  ap.entities = root ? flattenTree(root) : [];
  ap.rootDocId = ap.project.rootDoc_id ?? undefined;
  ap.rootDocPath = ap.rootDocId
    ? ap.entities.find((e) => e.kind === "doc" && e.id === ap.rootDocId)?.path
    : undefined;
}

function notifyTreeWaiters(): void {
  for (const w of [...treeWaiters]) {
    let ok = false;
    try { ok = w.check(); } catch { ok = false; }
    if (ok) {
      clearTimeout(w.timer);
      treeWaiters.delete(w);
      w.resolve(true);
    }
  }
}

function failTreeWaiters(): void {
  for (const w of treeWaiters) {
    clearTimeout(w.timer);
    w.resolve(false);
  }
  treeWaiters.clear();
}

// Apply a project-room broadcast to the in-memory project. Tree events are
// mirrored into rootFolder and the flat index rebuilt; a few project-level
// settings that affect tool behaviour are tracked too.
function handleProjectEvent(name: string, args: unknown[]): void {
  if (!active) return;
  const root = active.project.rootFolder?.[0];
  if (!root) return;
  let changed = false;
  switch (name) {
    case "removeEntity": {
      // Forget cached text for a deleted doc, or every doc under a deleted
      // folder — before the tree loses the paths we need to find them.
      const id = args[0];
      if (typeof id === "string") {
        const target = active.entities.find((e) => e.id === id);
        if (target?.kind === "doc") dropDoc(id);
        else if (target?.kind === "folder") {
          const prefix = `${target.path}/`;
          for (const e of active.entities) if (e.kind === "doc" && e.path.startsWith(prefix)) dropDoc(e.id);
        }
      }
      break;
    }
    case "rootDocUpdated":
      active.project.rootDoc_id = typeof args[0] === "string" ? args[0] : undefined;
      changed = true;
      break;
    case "projectNameUpdated":
      if (typeof args[0] === "string") {
        active.project.name = args[0];
        active.name = args[0];
      }
      break;
    default:
      break;
  }
  if (applyTreeEvent(root, name, args)) changed = true;
  if (changed) {
    reindex(active);
    logger.debug(`applied ${name}; ${active.entities.length} entities`);
    notifyTreeWaiters();
  }
}

onProjectEvent(handleProjectEvent);
onReconnected((project) => {
  if (!active || !project || project._id !== active.projectId) return;
  active.project = project;
  reindex(active);
  logger.info("re-synced project tree from reconnect");
  notifyTreeWaiters();
});

export function setLastCompile(result: CompileResponse): void {
  if (active) active.lastCompile = result;
}

export function getActiveProject(): ActiveProject | null {
  return active;
}

export async function open(projectId: string, baseUrl: string): Promise<ActiveProject> {
  const { joinedProject } = await ensureSocketForProject(baseUrl, projectId);
  if (!joinedProject) {
    throw new Error("joinProject did not return a project entity");
  }
  // A (re)open may sit on a fresh socket that has no docs joined; cached
  // text would then be submitted against a doc the socket never joined.
  clearDocCache();
  const identity = await getIdentity(baseUrl);
  active = {
    baseUrl,
    host: hostOf(baseUrl),
    projectId,
    name: joinedProject.name ?? "(unnamed)",
    project: joinedProject,
    entities: [],
    trackChangesOnForMe: isTrackChangesOnForUser(joinedProject, identity.userId),
  };
  reindex(active);
  notifyTreeWaiters();
  return active;
}

export function close(): void {
  disconnectActive();
  clearDocCache();
  failTreeWaiters();
  active = null;
}

// Full re-sync by re-joining the project (tears the socket down). Only needed
// when the socket is dead or a broadcast was missed; the normal path keeps
// the tree current from server events at zero cost.
export async function refreshTree(): Promise<ActiveProject> {
  if (!active) throw new Error("No project is open. Call open_project first.");
  const { projectId, baseUrl, lastCompile } = active;
  close();
  const ap = await open(projectId, baseUrl);
  ap.lastCompile = lastCompile;
  return ap;
}

export function socketLive(): boolean {
  return Boolean(getActiveSocket()?.isOpen());
}

// Resolve true as soon as `check()` holds (checked now and after every
// applied broadcast), false after `timeoutMs` or if the project is closed.
export function waitForTree(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  if (check()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const waiter: TreeWaiter = {
      check,
      resolve,
      timer: setTimeout(() => {
        treeWaiters.delete(waiter);
        resolve(false);
      }, timeoutMs),
    };
    treeWaiters.add(waiter);
  });
}

export function findByPath(path: string): FlatEntity | undefined {
  if (!active) return undefined;
  const normalized = path.replace(/^\/+/, "");
  return active.entities.find((e) => e.path === normalized);
}

export function docPathById(ap: ActiveProject): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of ap.entities) if (e.kind === "doc") m.set(e.id, e.path);
  return m;
}
