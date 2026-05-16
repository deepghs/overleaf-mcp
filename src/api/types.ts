export interface ProjectSummary {
  id: string;
  name: string;
  lastUpdated?: string;
  lastUpdatedBy?: { id?: string; email?: string };
  owner?: { id?: string; email?: string };
  accessLevel?: string;
  archived?: boolean;
  trashed?: boolean;
}

// Raw shape returned by GET /user/projects and POST /api/project — fields vary
// across Overleaf versions, so we narrow only what we display.
export interface RawProject {
  _id?: string;
  id?: string;
  name?: string;
  lastUpdated?: string;
  lastUpdatedBy?: { _id?: string; email?: string };
  owner?: { _id?: string; email?: string };
  accessLevel?: string;
  archived?: boolean;
  trashed?: boolean;
}

export function normalizeProject(p: RawProject): ProjectSummary {
  const id = p.id ?? p._id;
  if (!id) throw new Error("Project record missing id/_id");
  return {
    id,
    name: p.name ?? "(unnamed)",
    lastUpdated: p.lastUpdated,
    lastUpdatedBy: p.lastUpdatedBy
      ? { id: p.lastUpdatedBy._id, email: p.lastUpdatedBy.email }
      : undefined,
    owner: p.owner ? { id: p.owner._id, email: p.owner.email } : undefined,
    accessLevel: p.accessLevel,
    archived: p.archived,
    trashed: p.trashed,
  };
}
