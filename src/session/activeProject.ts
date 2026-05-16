import { ensureSocketForProject, disconnectActive } from "../api/socket.js";
import { flattenTree, isTrackChangesOnForUser, type FlatEntity, type ProjectEntity } from "../api/projectTypes.js";
import type { CompileResponse } from "../api/compileTypes.js";
import { getIdentity } from "./identity.js";

export interface ActiveProject {
  projectId: string;
  name: string;
  project: ProjectEntity;
  entities: FlatEntity[];
  trackChangesOnForMe: boolean;
  lastCompile?: CompileResponse;
}

let active: ActiveProject | null = null;

export function setLastCompile(result: CompileResponse): void {
  if (active) active.lastCompile = result;
}

export function getActiveProject(): ActiveProject | null {
  return active;
}

export async function open(projectId: string): Promise<ActiveProject> {
  const { joinedProject } = await ensureSocketForProject(projectId);
  if (!joinedProject) {
    throw new Error("joinProject did not return a project entity");
  }
  // rootFolder is an array containing the single top-level folder.
  const root = joinedProject.rootFolder?.[0];
  const entities = root ? flattenTree(root) : [];
  const identity = await getIdentity();
  const trackChangesOnForMe = isTrackChangesOnForUser(joinedProject, identity.userId);
  active = {
    projectId,
    name: joinedProject.name ?? "(unnamed)",
    project: joinedProject,
    entities,
    trackChangesOnForMe,
  };
  return active;
}

export function close(): void {
  disconnectActive();
  active = null;
}

export function findByPath(path: string): FlatEntity | undefined {
  if (!active) return undefined;
  const normalized = path.replace(/^\/+/, "");
  return active.entities.find((e) => e.path === normalized);
}
