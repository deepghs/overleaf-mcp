# Overleaf MCP by deepghs

Collaborative LaTeX editing through MCP: native tracked changes, review comments,
compilation, downloads, and file management in one connection.

Based on [netique/overleaf-mcp](https://github.com/netique/overleaf-mcp), with its
Git history and AGPL license preserved. This version adds **ten tools**, for
**27 tools total**. Document edits use Overleaf's Socket.IO OT protocol rather
than whole-file uploads or the Git bridge. This is an unofficial integration,
not an Overleaf-supported API.

## What This Version Adds

- Log in to several Overleaf servers at once (overleaf.com plus any number of
  self-hosted instances) and pick one per `list_projects` / `open_project` call.
- Keep the file tree in sync from the server's real-time broadcasts instead of
  re-joining the project after every file-management call.
- Download document snapshots, binary assets, project ZIPs, PDFs, and compile logs.
- Create empty documents and folders, upload new assets, rename and delete files.
- Create native comments on unique selected text, with version checks and
  message/anchor readback verification.
- Preserve the upstream tracked OT pathway for existing document text.
- Fix self-hosted compilation requests that reject a null root document path.

**Source installation only.** `npx @netique/overleaf-mcp` runs upstream, not this
enhanced version. This repository is not published to npm; build it locally.

## Requirements

- Node.js 20.18.1 or newer and npm (Node 22 LTS recommended).
- A reachable Overleaf deployment and an authorized project account.
- Server support for tracked changes and comments to use those features;
  self-hosting alone does not guarantee they are enabled.
- A supported Chromium-family browser for interactive login.

## Installation

```bash
git clone https://github.com/deepghs/overleaf-mcp.git
cd overleaf-mcp
npm ci
npm run build
npm test
```

If the repository is private, authenticate Git with an account that has access.
Keep the checkout at a stable path. Rebuild after pulling changes and restart
your MCP client to load the new code.

## Authentication

### SSH / Headless Servers

For self-hosted instances with ordinary email/password login:

```bash
export OL_BASE_URL=https://overleaf.example.org
node dist/index.js login --password
# Or prefill the email only:
node dist/index.js login --email user@example.org
node dist/index.js status
```

The interactive terminal prompts for email and a hidden password. `--password`
is a mode switch, NOT a password argument. Never put passwords on the command
line. Only the validated session cookie is saved; passwords are not persisted.
Failed login leaves any existing saved session unchanged. Use `ssh -t` when
your SSH invocation does not allocate a terminal.

On Linux without DISPLAY/WAYLAND_DISPLAY, plain `login` selects password mode
automatically. Set `OL_HEADLESS=1` to disable automatic browser login explicitly.
Missing/expired credentials during MCP calls produce instructions to log in
from SSH; the MCP stdio stream is never used for password prompts.

This requires HTTPS and a server that accepts password login without CAPTCHA,
SSO or 2FA. It does not bypass those challenges. Session expiry still requires
another interactive login; no stored password or automatic password renewal.
For interactive browser authentication use `login --browser` on a desktop.

### Desktop Browser Login

For a self-hosted instance, use the same origin for login and MCP configuration:

```bash
OL_BASE_URL=https://overleaf.example.org node dist/index.js login
OL_BASE_URL=https://overleaf.example.org node dist/index.js status
```

For hosted Overleaf, omit `OL_BASE_URL`. Login opens an isolated browser profile;
sign in there. Missing or expired credentials may trigger the same flow on a
tool call. CSRF tokens are normally discovered automatically.

Cookies are plaintext in `<configDir>/overleaf-mcp/cookie.json`, with mode `0600`
where supported. On Linux, `configDir` is `$XDG_CONFIG_HOME` or `~/.config`; on
macOS it is `~/Library/Application Support`; on Windows it is `%APPDATA%`.
Never commit this store or its dedicated browser profile.

Use a dedicated collaborator account for clear attribution and limited project
access. Otherwise edits and comments use the authenticated human's identity.

### Multiple Overleaf Servers

Cookies are stored per host, so one MCP process can be logged in to overleaf.com
and any number of self-hosted instances at the same time. Every host with a
stored cookie is a *known server*, alongside `OL_BASE_URL` (the default) and
anything pre-declared in `OL_SERVERS`:

```bash
# Log in to each server once; --server takes a host or an origin URL.
node dist/index.js login --server overleaf.example.org
node dist/index.js login --server www.overleaf.com
node dist/index.js login --password --server lab.example.edu   # headless host
node dist/index.js status                                       # every known server
node dist/index.js logout --server overleaf.example.org
```

At run time, `list_servers` shows the known servers and which one the open
project is on. `list_projects` without `server` queries every logged-in server
and tags each project with its `server`; `open_project` accepts the same
`server` argument and may omit it when the project was just listed or only one
server is logged in. One project is open at a time, and every project-scoped
tool acts on that project's server. Naming a server that has no stored cookie
starts the login flow for it (a browser window on desktops; on headless hosts an
error telling you which `login --server` command to run). A wrong server never
logs you out: the real-time service answers with `connectionRejected`, which is
reported as an API error, not treated as an expired cookie.

## MCP Configuration

### Codex

Replace the example origin and absolute path:

```bash
codex mcp add overleaf \
  --env OL_BASE_URL=https://overleaf.example.org \
  -- node /absolute/path/to/overleaf-mcp/dist/index.js
```

Equivalent TOML:

```toml
[mcp_servers.overleaf]
command = "node"
args = ["/absolute/path/to/overleaf-mcp/dist/index.js"]

[mcp_servers.overleaf.env]
OL_BASE_URL = "https://overleaf.example.org"
```

### JSON-Based Clients

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "node",
      "args": ["/absolute/path/to/overleaf-mcp/dist/index.js"],
      "env": { "OL_BASE_URL": "https://overleaf.example.org" }
    }
  }
}
```

Use an absolute Node executable path if the client cannot resolve `node`.
Restart the client after replacing a server configuration.

## Tool Reference

Project-scoped tools use the project selected by `open_project`.

| Group | Tools | Purpose |
| --- | --- | --- |
| Discovery | `ping`, `list_servers`, `list_projects`, `open_project`, `list_files` | Inspect servers, projects and the live tree |
| Editing | `read_file`, `edit_file`, `find_and_replace` | Read text/version and submit minimal tracked OT edits |
| Review | `list_tracked_changes`, `accept_changes`, `reject_changes` | Inspect and review pending suggestions |
| Comments | `list_comments`, `read_comment_thread`, `add_comment`, `reply_comment`, `resolve_comment`, `reopen_comment` | Native review-panel threads |
| Compilation | `compile`, `read_log` | Remote build and diagnostics |
| Downloads | `download_file`, `download_project`, `download_output` | Local snapshots, ZIP, or compile artifacts |
| Files | `create_file`, `create_folder`, `upload_file`, `rename_entity`, `delete_entity` | Tree management without uploading over existing text |

### Added Tool Arguments

| Tool | Required arguments | Constraints / optional arguments |
| --- | --- | --- |
| `list_servers` | — | No network; default, `OL_SERVERS` and every cookie host |
| `list_projects` | — | Optional `server` (host or URL); omitted = every logged-in server |
| `open_project` | `project_id` | Optional `server`; needed only when several servers are logged in and the project was not just listed |
| `download_file` | `path`, `output_path` | Existing text or binary file |
| `download_project` | `output_path` | ZIP only, no extraction |
| `download_output` | `output_path` | Optional `artifact`, default `output.pdf`; compile first |
| `create_file` | `path` | Empty document; parent must exist |
| `create_folder` | `path` | Single folder; parent must exist |
| `upload_file` | `path`, `local_path` | New PNG/JPEG/GIF/WebP/PDF/EPS/ZIP assets only |
| `rename_entity` | `path`, `new_name` | Basename in the same parent; target must not exist |
| `delete_entity` | `path`, `confirm` | Requires `confirm: true`; refuses nonempty folders |
| `add_comment` | `path`, `selected_text`, `content`, `expected_version` | Unique text and the version from `read_file` |

Remote paths are project-relative. `local_path` and `output_path` must be
absolute. Downloads require an existing parent and never overwrite a destination,
including a symlink at the destination path.

## Recommended Workflow

1. Open the project and read the target document and relevant comments.
2. Edit with `track: "on"`, `expected_version` from the read, and
   `strict_version: true` when other writers are active.
3. On stale-version rejection, **read again and recompute the edit**. Upstream
   refreshes its cache on rejection; blindly retrying old `new_content` against
   that cache can remove another writer's new text.
4. Read back the result, compile, inspect diagnostics, and download the PDF.
5. Reply to the relevant thread. Leave suggestions and threads pending until
   the author explicitly requests acceptance or resolution.

Example requests:

> Improve the introduction as tracked changes. Preserve citations and factual
> claims. Re-read and recompute if the document version changes.

> Add a comment on this unique sentence explaining the missing experimental
> detail. Do not change the document text.

> Compile the open project and download output.pdf and output.log to these
> absolute paths without overwriting existing files.

## Safety and Compatibility

- **No upload fallback for text.** Uploads refuse existing targets and text files.
  Create empty documents, then insert their content through tracked OT.
- The file tree follows the server's real-time broadcasts (`reciveNewDoc`,
  `removeEntity`, `reciveEntityRename`, ...), so collaborators' changes and your
  own file-management calls show up without re-joining the project, and cached
  document text survives them (a deleted doc is dropped from the cache). Each
  file-management call waits for its own broadcast and reports
  `tree_sync: "event"`; if none arrives within 5 s it re-joins the project once
  and reports `tree_sync: "reconnect"`, which also clears the document cache.
  File-management calls are serialized with each other within one process, not
  with every upstream tool. Do not overlap them with project switching or text
  edits.
- Remote filename checks are not atomic with server writes. Do not create the
  same filename simultaneously from different clients; cross-client races are
  not covered by the collision guard.
- A comment message and its anchor are separate writes. Partial failures return
  a thread ID to inspect before retrying; creation is not transactional.
- Verification covers the upstream ShareJS path, not history-OT compatibility.
  This fork does not add live cursors or complete browser presence behavior.
- OT preserves independent operations, not semantic agreement about a sentence.
  Reconnection and every possible concurrency failure mode are not certified.
- A PDF may be generated despite LaTeX errors. Inspect `error_count` and the log.
  A missing/unreadable log is not proof of a clean build, even if upstream
  reports `built_cleanly`.
- Cookies grant account access. Use trusted MCP clients, authorized accounts,
  and automation consistent with the deployment's applicable terms.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `OL_BASE_URL` | Default server origin; `https://www.overleaf.com` if unset |
| `OL_SERVERS` | Extra servers to pre-declare (comma/space separated hosts or origins); hosts with a stored cookie are known without this |
| `OL_HEADLESS` | `1` disables browser login; a missing cookie then fails with SSH instructions |
| `OL_BROWSER` | Explicit Chromium-family browser executable |
| `OL_CSRF` | Optional CSRF override |
| `OL_MCP_LOG_LEVEL` | `debug`, `info`, `warn`, `error`; logs go to stderr |
| `OL_INSECURE` | Browser-login certificate exception; avoid normally and do not assume it fixes Node TLS |

## Tests and Development

```bash
npm run typecheck
npm run build
npm test
git diff --check
```

On September 10, 2026, this version passed **25 unit tests** and live MCP stdio
tests against a self-hosted deployment. Coverage included tracked insertion,
anchored comment readback, stale-version rejection, binary byte roundtrips,
file-management protections, PDF/log/ZIP downloads, and two-client OT merging
at different positions. This was not browser visual QA or exhaustive testing of
every upstream tool or every Overleaf version.

On September 22, 2026, the multi-server and tree-sync changes passed **48 unit
tests** plus a live two-client run against a self-hosted deployment: eight
file-management calls (create, rename, edit, delete across two clients) all
confirmed through broadcasts with `tree_sync: "event"`, the second client saw
the first client's changes without re-opening, and the run used exactly one
socket connection per client. Multi-server logic was exercised with one
logged-in server and one without a cookie (aggregate listing, automatic server
pick, fast failure on the cookie-less server without disturbing the open
project). Two servers logged in simultaneously was covered by unit tests only.

The opt-in integration test **modifies its supplied disposable project** and
leaves review evidence there. It imports an existing olcli credential into an
isolated cookie store after checking its origin:

```bash
export OL_BASE_URL=https://overleaf.example.org
export OL_TEST_COOKIE_CONFIG=/absolute/path/to/olcli-nodejs/config.json
export XDG_CONFIG_HOME="$(mktemp -d)"
node tests/manual/extensions.mjs DISPOSABLE_PROJECT_ID
```

Protect that isolated directory: it contains authentication state and downloaded
artifacts. Never run this test against a production manuscript.

Run `npm audit` before deployment. The inherited lockfile had dependency
advisories during verification; this feature branch did not resolve them.
No npm publication or production security certification is implied.

## Troubleshooting

- **Missing tools:** build this checkout and point the client to its entry point,
  not upstream npm or the olcli executable.
- **Login required:** use the same `OL_BASE_URL` for login and MCP configuration.
- **Missing parent / existing destination:** create parents first and choose a
  new filename; edit existing text through OT.
- **Output unavailable:** compile the currently open project, then choose a
  filename listed in `output_files`.
- **No tracked suggestions:** check project/user settings and server feature
  support; do not silently fall back to untracked uploads.

## Attribution and License

**AGPL-3.0-or-later**, see [LICENSE](LICENSE). Preserve notices and comply with
the license when distributing or operating modifications.

- [netique/overleaf-mcp](https://github.com/netique/overleaf-mcp): upstream server,
  authentication, OT editing, tracked-change review, and comment operations.
- [overleaf-workshop](https://github.com/overleaf-workshop/overleaf-workshop) and
  [overleaf/overleaf](https://github.com/overleaf/overleaf): protocol and code
  sources acknowledged by the original project.
- [googlecolab/colab-mcp](https://github.com/googlecolab/colab-mcp): upstream UX reference.

The additions use existing server abstractions; no olcli implementation was
copied. olcli credentials are only an optional input to the integration test.
