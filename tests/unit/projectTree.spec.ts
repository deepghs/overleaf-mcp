import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyTreeEvent, flattenTree, type FolderEntity } from "../../src/api/projectTypes.js";

function fixture(): FolderEntity {
  return {
    _id: "root",
    name: "rootFolder",
    docs: [{ _id: "d-main", name: "main.tex" }],
    fileRefs: [{ _id: "f-logo", name: "logo.png" }],
    folders: [
      {
        _id: "fo-ch",
        name: "chapters",
        docs: [{ _id: "d-intro", name: "intro.tex" }],
        fileRefs: [],
        folders: [],
      },
    ],
  };
}

const paths = (root: FolderEntity) => flattenTree(root).map((e) => `${e.kind}:${e.path}`).sort();

describe("applyTreeEvent", () => {
  it("reciveNewDoc adds a doc under the named folder", () => {
    const root = fixture();
    assert.equal(applyTreeEvent(root, "reciveNewDoc", ["fo-ch", { _id: "d-new", name: "methods.tex" }, "editor", "u1"]), true);
    assert.ok(paths(root).includes("doc:chapters/methods.tex"));
    assert.equal(flattenTree(root).find((e) => e.id === "d-new")?.parentFolderId, "fo-ch");
  });

  it("reciveNewFile adds a fileRef at the root", () => {
    const root = fixture();
    assert.equal(applyTreeEvent(root, "reciveNewFile", ["root", { _id: "f-new", name: "fig.pdf" }, "upload", null, "u1"]), true);
    assert.ok(paths(root).includes("file:fig.pdf"));
  });

  it("reciveNewFolder normalises a folder payload without child arrays", () => {
    const root = fixture();
    assert.equal(applyTreeEvent(root, "reciveNewFolder", ["root", { _id: "fo-fig", name: "figures" }, "u1"]), true);
    assert.ok(paths(root).includes("folder:figures"));
    // A subsequent add into the new folder must work (arrays were created).
    assert.equal(applyTreeEvent(root, "reciveNewDoc", ["fo-fig", { _id: "d-x", name: "x.tex" }]), true);
    assert.ok(paths(root).includes("doc:figures/x.tex"));
  });

  it("adding an entity that already exists is a no-op", () => {
    const root = fixture();
    assert.equal(applyTreeEvent(root, "reciveNewDoc", ["root", { _id: "d-main", name: "main.tex" }]), false);
    assert.equal(flattenTree(root).filter((e) => e.id === "d-main").length, 1);
  });

  it("removeEntity deletes docs, files and whole folders", () => {
    const root = fixture();
    assert.equal(applyTreeEvent(root, "removeEntity", ["d-main", "editor"]), true);
    assert.equal(applyTreeEvent(root, "removeEntity", ["f-logo", "editor"]), true);
    assert.equal(applyTreeEvent(root, "removeEntity", ["fo-ch", "editor"]), true);
    assert.deepEqual(paths(root), []);
    assert.equal(applyTreeEvent(root, "removeEntity", ["nope"]), false);
  });

  it("reciveEntityRename renames in place (nested paths follow)", () => {
    const root = fixture();
    assert.equal(applyTreeEvent(root, "reciveEntityRename", ["fo-ch", "parts"]), true);
    assert.ok(paths(root).includes("doc:parts/intro.tex"));
    assert.equal(applyTreeEvent(root, "reciveEntityRename", ["d-intro", "introduction.tex"]), true);
    assert.ok(paths(root).includes("doc:parts/introduction.tex"));
  });

  it("reciveEntityMove re-parents an entity", () => {
    const root = fixture();
    assert.equal(applyTreeEvent(root, "reciveEntityMove", ["d-main", "fo-ch"]), true);
    assert.ok(paths(root).includes("doc:chapters/main.tex"));
    assert.ok(!paths(root).includes("doc:main.tex"));
    assert.equal(applyTreeEvent(root, "reciveEntityMove", ["d-main", "missing-folder"]), false);
  });

  it("ignores unknown events and malformed payloads", () => {
    const root = fixture();
    const before = paths(root);
    assert.equal(applyTreeEvent(root, "projectNameUpdated", ["x"]), false);
    assert.equal(applyTreeEvent(root, "reciveNewDoc", [42, { _id: "d", name: "n" }]), false);
    assert.equal(applyTreeEvent(root, "reciveNewDoc", ["root", { name: "no id" }]), false);
    assert.equal(applyTreeEvent(root, "reciveEntityRename", ["d-main", 7]), false);
    assert.deepEqual(paths(root), before);
  });
});
