import DiffMatchPatch from "diff-match-patch";

export interface ShareJsOp {
  p: number;
  i?: string;
  d?: string;
}

const dmp = new DiffMatchPatch.diff_match_patch();
// diff-match-patch operation constants — exported as instance constants by the lib.
const DIFF_DELETE = -1;
const DIFF_EQUAL = 0;
const DIFF_INSERT = 1;

// Convert (oldText -> newText) into a ShareJS-style op list.
// Each op operates on the result of applying all previous ops in the list,
// matching Overleaf's `applyOtUpdate` semantics.
export function textToOps(oldText: string, newText: string): ShareJsOp[] {
  if (oldText === newText) return [];
  const diffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(diffs);
  const ops: ShareJsOp[] = [];
  let pos = 0;
  for (const [kind, text] of diffs) {
    if (kind === DIFF_EQUAL) {
      pos += text.length;
    } else if (kind === DIFF_INSERT) {
      ops.push({ p: pos, i: text });
      pos += text.length;
    } else if (kind === DIFF_DELETE) {
      ops.push({ p: pos, d: text });
      // pos stays — the next op is at the same cursor position.
    }
  }
  return ops;
}
