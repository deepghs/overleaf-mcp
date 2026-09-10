import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remotePath, saveDownload } from "../../src/tools/fileManagement.js";
import { uniqueAnchor } from "../../src/tools/addComment.js";

test("remote path validation refuses traversal and ambiguous paths", () => {
  for (const p of ["", "/a", "../a", "a/../b", "a//b", "a/./b", "a\\b", "a\0b"]) {
    assert.throws(() => remotePath(p));
  }
  assert.equal(remotePath("figures/a.png"), "figures/a.png");
});
test("anchors use UTF-16 positions and refuse ambiguous overlapping matches", () => {
  assert.equal(uniqueAnchor("\u4e2d\ud83d\ude00 anchor", "anchor"), 4);
  assert.throws(() => uniqueAnchor("aaa", "aa"));
  assert.throws(() => uniqueAnchor("abc", ""));
  assert.throws(() => uniqueAnchor("abc", "missing"));
});
test("downloads do not overwrite files or follow final symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "overleaf-download-test-"));
  try {
    const file = join(dir, "a");
    await saveDownload(file, Buffer.from("original"));
    await assert.rejects(saveDownload(file, Buffer.from("new")));
    await symlink(file, join(dir, "link"));
    await assert.rejects(saveDownload(join(dir, "link"), Buffer.from("new")));
    assert.equal(await readFile(file, "utf8"), "original");
    await assert.rejects(saveDownload("relative", Buffer.from("new")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
