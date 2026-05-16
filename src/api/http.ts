import { getIdentity } from "../session/identity.js";
import { OverleafApiError } from "./errors.js";

function joinUrl(base: string, path: string): string {
  return `${base}/${path.replace(/^\/+/, "")}`;
}

export async function olGet(path: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const id = await getIdentity();
  return fetch(joinUrl(id.baseUrl, path), {
    method: "GET",
    redirect: "manual",
    headers: { Cookie: id.cookie, Connection: "keep-alive", ...extraHeaders },
  });
}

export async function olPostJson(
  path: string,
  body: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const id = await getIdentity();
  return fetch(joinUrl(id.baseUrl, path), {
    method: "POST",
    redirect: "manual",
    headers: {
      Cookie: id.cookie,
      Connection: "keep-alive",
      "Content-Type": "application/json",
      "X-Csrf-Token": id.csrf,
      ...extraHeaders,
    },
    body: JSON.stringify({ _csrf: id.csrf, ...body }),
  });
}

export async function olDelete(path: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const id = await getIdentity();
  return fetch(joinUrl(id.baseUrl, path), {
    method: "DELETE",
    redirect: "manual",
    headers: {
      Cookie: id.cookie,
      Connection: "keep-alive",
      "X-Csrf-Token": id.csrf,
      ...extraHeaders,
    },
  });
}

export async function expectOk(res: Response, hint?: string): Promise<Response> {
  if (res.ok) return res;
  const body = await res.text().catch(() => "");
  throw new OverleafApiError(res.status, body, hint);
}

export async function asJson<T = unknown>(res: Response, hint?: string): Promise<T> {
  await expectOk(res, hint);
  return (await res.json()) as T;
}
