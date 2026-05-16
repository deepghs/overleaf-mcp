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
  for (const folder of root.folders) {
    const path = prefix ? `${prefix}/${folder.name}` : folder.name;
    out.push({ kind: "folder", id: folder._id, path, name: folder.name, parentFolderId: root._id });
    out.push(...flattenTree(folder, path));
  }
  for (const doc of root.docs) {
    const path = prefix ? `${prefix}/${doc.name}` : doc.name;
    out.push({ kind: "doc", id: doc._id, path, name: doc.name, parentFolderId: root._id });
  }
  for (const file of root.fileRefs) {
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
