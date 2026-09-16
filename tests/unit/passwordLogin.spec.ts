import { test } from "node:test";
import assert from "node:assert/strict";
import { passwordLogin } from "../../src/auth/passwordLogin.js";

test("password login carries CSRF and rotates cookies without following redirects", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), "https://example.org/login");
    assert.equal(options?.redirect, "manual");
    if (calls === 1) return new Response('<input value="a&amp;b" name="_csrf">', {
      headers: { "set-cookie": "overleaf.sid=bootstrap; Path=/; Secure; HttpOnly" },
    });
    assert.equal(new Headers(options?.headers).get("cookie"), "overleaf.sid=bootstrap");
    const body = options?.body as URLSearchParams;
    assert.equal(body.get("_csrf"), "a&b");
    assert.equal(body.get("email"), "user@example.org");
    assert.equal(body.get("password"), "test-only-secret");
    return new Response(null, { status: 302, headers: { location: "/project", "set-cookie": "overleaf.sid=authenticated; Path=/; Secure; HttpOnly" } });
  };
  try {
    assert.equal(await passwordLogin("https://example.org", "user@example.org", "test-only-secret"), "overleaf.sid=authenticated");
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test("password login fails closed for HTTP and external redirects", async () => {
  await assert.rejects(passwordLogin("http://example.org", "u", "p"), /HTTPS/);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? new Response('<meta content="token" name="ol-csrfToken">')
    : new Response(null, { status: 302, headers: { location: "https://external.example/login" } });
  try { await assert.rejects(passwordLogin("https://example.org", "u", "p"), /External/); }
  finally { globalThis.fetch = original; }
});

test("login errors do not echo response bodies", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? new Response('<meta name="ol-csrfToken" content="token">')
    : new Response("SECRET SERVER BODY", { status: 401 });
  try {
    await assert.rejects(passwordLogin("https://example.org", "u", "p"), e =>
      e instanceof Error && e.message.includes("401") && !e.message.includes("SECRET"));
  } finally { globalThis.fetch = original; }
});
