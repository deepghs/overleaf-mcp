// Review-panel comment threads, ported from the overleaf-workshop 94-review-panel
// branch (extendedBase.ts). Shapes match what Overleaf's HTTP REST API actually
// returns; we keep them loose because field set varies a bit by server version.

export interface CommentUserInfo {
  _id?: string;
  id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
}

export interface CommentMessage {
  id: string;
  content: string;
  timestamp: number;
  user_id?: string;
  user?: CommentUserInfo;
  room_id?: string;
  edited_at?: number;
}

export interface CommentThread {
  messages: CommentMessage[];
  resolved?: boolean;
  resolved_at?: string;
  resolved_by_user_id?: string;
  resolved_by_user?: CommentUserInfo;
  // Filled in client-side by cross-referencing with /ranges.
  doc_id?: string;
}

// `GET /project/{id}/threads` returns `{ [threadId]: CommentThread }`.
export type ThreadsByIdResponse = Record<string, CommentThread>;

// `GET /project/{id}/ranges` returns `[{ id: docId, ranges: { changes, comments } }, ...]`.
export interface DocRange {
  id: string;
  ranges?: {
    changes?: Array<{ id: string; op: { p: number; i?: string; d?: string }; metadata?: { user_id?: string; ts?: string } }>;
    comments?: Array<{ id: string; op: { p: number; c: string; t: string }; metadata?: { user_id?: string; ts?: string } }>;
  };
}

export type RangesResponse = DocRange[];
