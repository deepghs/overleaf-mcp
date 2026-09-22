import { test, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeBaseUrl, parseServerList, loadConfig } from "../../src/config.js";
import { saveStored, listStored } from "../../src/auth/cookieStore.js";
import { knownServers, resolveServer, rememberProjectServer, projectServer } from "../../src/session/servers.js";

describe("normalizeBaseUrl", () => {
  it("adds https:// to a bare host", () => {
    assert.equal(normalizeBaseUrl("overleaf.example.org"), "https://overleaf.example.org");
  });
  it("keeps an explicit http scheme and port", () => {
    assert.equal(normalizeBaseUrl("http://localhost:3000"), "http://localhost:3000");
  });
  it("drops trailing slashes and paths", () => {
    assert.equal(normalizeBaseUrl("https://overleaf.example.org/project/"), "https://overleaf.example.org");
  });
  it("lower-cases the host", () => {
    assert.equal(normalizeBaseUrl("HTTPS://Overleaf.Example.ORG"), "https://overleaf.example.org");
  });
  it("rejects empty and non-http input", () => {
    assert.throws(() => normalizeBaseUrl("   "));
    assert.throws(() => normalizeBaseUrl("ftp://x.example"));
  });
});

describe("parseServerList", () => {
  it("splits on commas, semicolons and whitespace and de-duplicates", () => {
    assert.deepEqual(
      parseServerList(" a.example, b.example;https://a.example/ \n c.example "),
      ["https://a.example", "https://b.example", "https://c.example"],
    );
  });
  it("returns [] for undefined", () => {
    assert.deepEqual(parseServerList(undefined), []);
  });
});

// The cookie store honours XDG_CONFIG_HOME only on Linux; elsewhere these
// would touch the real config dir, so skip.
describe("known servers", { skip: process.platform !== "linux" }, () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "overleaf-servers-test-"));
    for (const k of ["XDG_CONFIG_HOME", "OL_BASE_URL", "OL_SERVERS"]) saved[k] = process.env[k];
    process.env.XDG_CONFIG_HOME = dir;
    process.env.OL_BASE_URL = "https://www.overleaf.com";
    process.env.OL_SERVERS = "pre.example.org, www.overleaf.com";
    await saveStored("http://localhost:3000", "overleaf_session2=dev");
    await saveStored("https://ol.example.org/", "overleaf_session2=prod");
  });
  after(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("loadConfig drops the default from extraServers", () => {
    const c = loadConfig();
    assert.equal(c.defaultBaseUrl, "https://www.overleaf.com");
    assert.deepEqual(c.extraServers, ["https://pre.example.org"]);
  });

  it("stored cookies remember their origin", async () => {
    const stored = (await listStored()).sort((a, b) => a.host.localeCompare(b.host));
    assert.deepEqual(stored.map((s) => [s.host, s.baseUrl]), [
      ["localhost:3000", "http://localhost:3000"],
      ["ol.example.org", "https://ol.example.org"],
    ]);
  });

  it("merges default, env and cookie sources", async () => {
    const known = await knownServers();
    const byHost = Object.fromEntries(known.map((s) => [s.host, s]));
    assert.deepEqual(Object.keys(byHost).sort(), ["localhost:3000", "ol.example.org", "pre.example.org", "www.overleaf.com"]);
    assert.equal(byHost["www.overleaf.com"].isDefault, true);
    assert.equal(byHost["www.overleaf.com"].loggedIn, false);
    assert.deepEqual(byHost["www.overleaf.com"].sources, ["default"]);
    assert.equal(byHost["pre.example.org"].loggedIn, false);
    assert.equal(byHost["ol.example.org"].loggedIn, true);
    assert.ok(byHost["ol.example.org"].cookieSavedAt! > 0);
    assert.equal(byHost["localhost:3000"].baseUrl, "http://localhost:3000");
  });

  it("resolveServer: undefined -> default, host -> stored origin, unknown -> https", async () => {
    assert.equal(await resolveServer(undefined), "https://www.overleaf.com");
    assert.equal(await resolveServer(""), "https://www.overleaf.com");
    // Bare host matches the stored entry and inherits its http scheme + port.
    assert.equal(await resolveServer("localhost:3000"), "http://localhost:3000");
    assert.equal(await resolveServer("OL.EXAMPLE.ORG"), "https://ol.example.org");
    assert.equal(await resolveServer("https://ol.example.org/project"), "https://ol.example.org");
    assert.equal(await resolveServer("brand-new.example.org"), "https://brand-new.example.org");
  });
});

test("project -> server index", () => {
  assert.equal(projectServer("abc123"), undefined);
  rememberProjectServer("abc123", "https://ol.example.org");
  assert.equal(projectServer("abc123"), "https://ol.example.org");
});
