// Build the `meta.tc` ID seed that turns an OT update into a tracked-changes
// suggestion. The format is a Mongo-ObjectId-style 18-hex-char prefix (4 bytes
// timestamp + 3 bytes machine + 2 bytes pid). The server's RangesTracker uses
// this as the seed for generating per-op change ids — see
// https://github.com/overleaf/overleaf/blob/main/libraries/ranges-tracker/index.cjs
// (function `generateIdSeed`). Ported verbatim — when `update.meta.tc` is set,
// RangesManager flips `rangesTracker.track_changes = true` and records each op
// in `ranges.changes[]` instead of applying it directly.

function hexPad(n: number, width: number): string {
  const s = n.toString(16);
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

export function generateIdSeed(): string {
  const pid = hexPad(Math.floor(Math.random() * 32767), 4);
  const machine = hexPad(Math.floor(Math.random() * 16777216), 6);
  const ts = hexPad(Math.floor(Date.now() / 1000), 8);
  return ts + machine + pid;
}

export const TRACK_MODES = ["auto", "on", "off"] as const;
export type TrackMode = typeof TRACK_MODES[number];

// Resolve what the SERVER will do given the caller's `track` request and the
// project's per-user setting. `serverWillTrack` is what we report in `tracked`;
// `trackOverridden` flags the specific case where the caller said "off" but
// the project's `track_changes_on_for_me: true` forced tracking anyway.
export function resolveTracking(
  track: TrackMode,
  trackChangesOnForMe: boolean,
): { shouldTrack: boolean; serverWillTrack: boolean; trackOverridden: boolean } {
  const shouldTrack = track === "on" ? true : track === "off" ? false : trackChangesOnForMe;
  return {
    shouldTrack,
    serverWillTrack: shouldTrack || trackChangesOnForMe,
    trackOverridden: track === "off" && trackChangesOnForMe,
  };
}
