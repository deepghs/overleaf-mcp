// Concurrency safeguards for OT edits. Both helpers re-`joinDoc` the doc and
// hand the fresh state back to the caller; cache syncing is the caller's job
// so that on failure we don't write potentially-wrong state.
//
// Why these exist: the in-process docCache makes each MCP server instance
// believe it knows the current version, but parallel agents and any open
// Overleaf web editor bump the server's version independently. When our
// `applyOtUpdate` arrives with a stale `v`, the server silently OT-transforms
// our ops against the missed updates — sometimes producing a no-op while
// still acking success. Without verification we'd happily report
// `replacements: 1` for an edit that had zero visible effect.

import { joinDoc } from "../api/socket.js";

export interface BaselineCheck {
  stale: boolean;
  serverVersion: number;
  serverText: string;
}

// Re-fetch and compare to the cached version. Use before `applyOtUpdate` when
// `strict_version: true` is set so we fail fast on a stale baseline instead
// of letting the server transform our ops in surprising ways.
export async function checkBaseline(docId: string, cachedVersion: number): Promise<BaselineCheck> {
  const fresh = await joinDoc(docId);
  return {
    stale: fresh.version !== cachedVersion,
    serverVersion: fresh.version,
    serverText: fresh.docLines.join("\n"),
  };
}

export interface PostEditVerify {
  serverVersion: number;
  serverText: string;
  // The server's text after our op is identical to what it was before. Our
  // ops were either rejected, transformed to a no-op, or applied somewhere
  // that didn't change the visible text. This is the user-reported bug.
  silentNoOp: boolean;
  // The server's text equals what we predicted (the clean, no-race case).
  matchesExpected: boolean;
  // The server's version went higher than our optimistic newVersion, meaning
  // another writer landed at least one update after ours. Our op may have
  // been correctly applied and then the doc moved on.
  hadConcurrentWritesAfter: boolean;
}

// Re-fetch after `applyOtUpdate` and report whether the edit landed as we
// predicted. The caller decides whether to fail loudly or warn based on the
// flags.
export async function verifyEdit(
  docId: string,
  preEditText: string,
  expectedText: string,
  expectedVersion: number,
): Promise<PostEditVerify> {
  const fresh = await joinDoc(docId);
  const serverText = fresh.docLines.join("\n");
  return {
    serverVersion: fresh.version,
    serverText,
    silentNoOp: serverText === preEditText,
    matchesExpected: serverText === expectedText,
    hadConcurrentWritesAfter: fresh.version > expectedVersion,
  };
}
