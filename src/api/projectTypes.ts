// Shapes returned by Overleaf's joinProject / joinDoc Socket.IO events.
// Field names match what the server emits — keep raw, normalize in tools.

export interface MemberEntity {
  _id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  privileges?: string;
}

export interface DocEntity {
  _id: string;
  name: string;
}

export interface FileRefEntity {
  _id: string;
  name: string;
  created?: string;
  linkedFileData?: unknown;
}

export interface FolderEntity {
  _id: string;
  name: string;
  docs: DocEntity[];
  fileRefs: FileRefEntity[];
  folders: FolderEntity[];
}

export interface ProjectEntity {
  _id: string;
  name: string;
  rootDoc_id?: string;
  rootFolder: FolderEntity[];
  owner?: MemberEntity;
  members?: MemberEntity[];
  invites?: unknown[];
  publicAccesLevel?: string;
  spellCheckLanguage?: string;
  compiler?: string;
  features?: { trackChanges?: boolean; trackChangesVisible?: boolean } & Record<string, unknown>;
  // Track-changes state. Shape varies between Overleaf versions; can be:
  //   - boolean (all-on/off for everyone)
  //   - object keyed by userId or '__guests__' with boolean values
  // We surface the raw value and a normalized "is on for me" flag in the tool.
  track_changes_state?: unknown;
  // Some versions emit this instead/in addition:
  trackChangesState?: unknown;
}

export type EntityKind = "doc" | "file" | "folder";

export interface FlatEntity {
  kind: EntityKind;
  id: string;
  path: string;
  name: string;
  parentFolderId: string;
}

export function flattenTree(root: FolderEntity, prefix = ""): FlatEntity[] {
  const out: FlatEntity[] = [];
  for (const folder of root.folders ?? []) {
    const path = prefix ? `${prefix}/${folder.name}` : folder.name;
    out.push({ kind: "folder", id: folder._id, path, name: folder.name, parentFolderId: root._id });
    out.push(...flattenTree(folder, path));
  }
  for (const doc of root.docs ?? []) {
    const path = prefix ? `${prefix}/${doc.name}` : doc.name;
    out.push({ kind: "doc", id: doc._id, path, name: doc.name, parentFolderId: root._id });
  }
  for (const file of root.fileRefs ?? []) {
    const path = prefix ? `${prefix}/${file.name}` : file.name;
    out.push({ kind: "file", id: file._id, path, name: file.name, parentFolderId: root._id });
  }
  return out;
}

export function isTrackChangesOnForUser(project: ProjectEntity, userId: string): boolean {
  const state = project.track_changes_state ?? project.trackChangesState;
  if (state === undefined || state === null) return false;
  if (typeof state === "boolean") return state;
  if (typeof state === "object") {
    const m = state as Record<string, unknown>;
    if (m[userId] === true) return true;
    if (m["__guests__"] === true) return true;
    // Some Overleaf builds use the value true on key '__everyone__' or 'all'.
    if (m["__everyone__"] === true) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Incremental tree maintenance.
//
// The web service broadcasts every file-tree mutation to the project room
// (services/web/app/src/Features/Editor/EditorController.mjs), including to
// the client that caused it:
//   reciveNewDoc        (folderId, doc, source, userId)
//   reciveNewFile       (folderId, fileRef, source, linkedFileData, userId)
//   reciveNewFolder     (folderId, folder, userId)
//   removeEntity        (entityId, source)
//   reciveEntityRename  (entityId, newName)
//   reciveEntityMove    (entityId, folderId)
// Applying these keeps ActiveProject.entities current without re-joining the
// project (modern real-time has no explicit joinProject; refreshing the tree
// otherwise means tearing down and re-opening the socket).
// ---------------------------------------------------------------------------

export const TREE_EVENTS = [
  "reciveNewDoc",
  "reciveNewFile",
  "reciveNewFolder",
  "removeEntity",
  "reciveEntityRename",
  "reciveEntityMove",
] as const;

type Located = { parent: FolderEntity; kind: EntityKind; index: number };

function listFor(folder: FolderEntity, kind: EntityKind): Array<DocEntity | FileRefEntity | FolderEntity> {
  if (kind === "folder") return (folder.folders ??= []);
  if (kind === "doc") return (folder.docs ??= []);
  return (folder.fileRefs ??= []);
}

function locate(root: FolderEntity, id: string): Located | undefined {
  for (const kind of ["folder", "doc", "file"] as const) {
    const index = listFor(root, kind).findIndex((e) => e._id === id);
    if (index >= 0) return { parent: root, kind, index };
  }
  for (const folder of root.folders ?? []) {
    const hit = locate(folder, id);
    if (hit) return hit;
  }
  return undefined;
}

export function findFolderById(root: FolderEntity, id: string): FolderEntity | undefined {
  if (root._id === id) return root;
  for (const folder of root.folders ?? []) {
    const hit = findFolderById(folder, id);
    if (hit) return hit;
  }
  return undefined;
}

function isEntity(v: unknown): v is { _id: string; name: string } {
  return typeof v === "object" && v !== null
    && typeof (v as { _id?: unknown })._id === "string"
    && typeof (v as { name?: unknown }).name === "string";
}

// Insert under `parentId`. Idempotent: an entity already present anywhere in
// the tree is left alone (returns false — nothing changed).
export function addToTree(root: FolderEntity, parentId: string, kind: EntityKind, entity: { _id: string; name: string }): boolean {
  const parent = findFolderById(root, parentId);
  if (!parent || locate(root, entity._id)) return false;
  const value = kind === "folder"
    ? {
        ...(entity as Partial<FolderEntity>),
        _id: entity._id,
        name: entity.name,
        docs: (entity as Partial<FolderEntity>).docs ?? [],
        fileRefs: (entity as Partial<FolderEntity>).fileRefs ?? [],
        folders: (entity as Partial<FolderEntity>).folders ?? [],
      }
    : entity;
  listFor(parent, kind).push(value as DocEntity | FileRefEntity | FolderEntity);
  return true;
}

export function removeEntityFromTree(root: FolderEntity, id: string): boolean {
  const hit = locate(root, id);
  if (!hit) return false;
  listFor(hit.parent, hit.kind).splice(hit.index, 1);
  return true;
}

export function renameEntityInTree(root: FolderEntity, id: string, newName: string): boolean {
  const hit = locate(root, id);
  if (!hit) return false;
  listFor(hit.parent, hit.kind)[hit.index].name = newName;
  return true;
}

export function moveEntityInTree(root: FolderEntity, id: string, newParentId: string): boolean {
  const hit = locate(root, id);
  const target = findFolderById(root, newParentId);
  if (!hit || !target) return false;
  const [entity] = listFor(hit.parent, hit.kind).splice(hit.index, 1);
  listFor(target, hit.kind).push(entity);
  return true;
}

// Apply one server broadcast to the tree. Returns true when the tree changed.
// Unknown events and malformed payloads are ignored (false).
export function applyTreeEvent(root: FolderEntity, name: string, args: unknown[]): boolean {
  switch (name) {
    case "reciveNewDoc":
      return typeof args[0] === "string" && isEntity(args[1]) && addToTree(root, args[0], "doc", args[1]);
    case "reciveNewFile":
      return typeof args[0] === "string" && isEntity(args[1]) && addToTree(root, args[0], "file", args[1]);
    case "reciveNewFolder":
      return typeof args[0] === "string" && isEntity(args[1]) && addToTree(root, args[0], "folder", args[1]);
    case "removeEntity":
      return typeof args[0] === "string" && removeEntityFromTree(root, args[0]);
    case "reciveEntityRename":
      return typeof args[0] === "string" && typeof args[1] === "string" && renameEntityInTree(root, args[0], args[1]);
    case "reciveEntityMove":
      return typeof args[0] === "string" && typeof args[1] === "string" && moveEntityInTree(root, args[0], args[1]);
    default:
      return false;
  }
}
