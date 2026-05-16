# overleaf-mcp

An MCP server for [Overleaf](https://www.overleaf.com) that lets a Claude agent navigate projects, read/edit `.tex` files, compile, and work with review-panel comments — over Overleaf's **real, reverse-engineered web/Socket.IO API**, the same channel the official web editor uses.

The one feature no existing Overleaf MCP can deliver: when a project has **track-changes** enabled, the agent's edits appear as **pending suggestions in the Review panel**, the same way a human collaborator's edits do. Your supervisor can accept or reject each suggestion.

## Why a new MCP

The three existing Overleaf MCPs ([mjyoo2/overleafmcp](https://github.com/mjyoo2/overleafmcp), [YounesBensafia/overleaf-mcp-server](https://github.com/YounesBensafia/overleaf-mcp-server), [GhoshSrinjoy/Overleaf-mcp](https://github.com/GhoshSrinjoy/Overleaf-mcp)) all write through Overleaf's **Git bridge**, which has two crippling problems for collaborative academic work:

1. Commits show up in Overleaf with delay (the bridge polls).
2. Git-bridge writes **bypass tracked changes entirely** — even when track-changes mode is on, edits land as direct overwrites, not as suggestions for review.

The [`overleaf-workshop`](https://github.com/overleaf-workshop/overleaf-workshop) VSCode extension showed the way: speak Overleaf's real Socket.IO API instead of Git. But it doesn't yet emit tracked changes ([issue #94](https://github.com/overleaf-workshop/overleaf-workshop/issues/94)). And its published [`socket.io-client@0.9.17-overleaf-5`](https://github.com/overleaf/socket.io-client) fork has a subtle bug that makes it unusable against cloud Overleaf from a server-side caller — `extraHeaders` is silently dropped on both the XHR polling and WebSocket transports, so the session cookie never reaches the handshake.

`overleaf-mcp` solves both: a minimal Socket.IO 0.9 client over `fetch` + `ws@8` (so cookies actually flow), plus the `meta.tc` ID seed on `applyOtUpdate` that flips Overleaf's server-side `RangesTracker` into track-changes mode.

## Status

Working end-to-end against `overleaf.com` — 13 tools, tracked-changes edits and review-panel comments both verified. Not yet on npm; install from source.

## Requirements

- Node ≥ 20
- An Overleaf account (overleaf.com or self-hosted Community Edition)

## Quick start

```sh
git clone <this-repo>
cd overleaf-mcp
npm install
npm run build
```

Then add to your Claude Desktop / Claude Code MCP config:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "node",
      "args": ["/absolute/path/to/overleaf-mcp/dist/index.js"],
      "env": {
        "OL_BASE_URL": "https://www.overleaf.com",
        "OL_COOKIE": "overleaf_session2=s%3A....; GCLB=..."
      }
    }
  }
}
```

For self-hosted Community Edition: set `OL_BASE_URL` to your server (e.g. `https://overleaf.mylab.edu`). Same cookie capture, same tools.

## Authentication

overleaf-mcp authenticates with a session cookie pasted from your browser. The CSRF token is auto-discovered from the `/project` page after login, so you don't need to copy it separately. (Set `OL_CSRF` only if your Overleaf instance doesn't expose the `ol-csrfToken` meta tag.)

### Capturing the cookie

1. Log into Overleaf in your browser.
2. Open DevTools → **Application** (Chrome/Edge) or **Storage** (Firefox) → **Cookies** → `https://www.overleaf.com`.
3. Copy the **value** of `overleaf_session2` — it starts with `s%3A` and is long. If a `GCLB` cookie is present (commonly on overleaf.com), copy that too.
4. Combine them in one string with `; ` separators: `overleaf_session2=s%3A...; GCLB=...`. That's your `OL_COOKIE`.

> ⚠️ The pasted session cookie grants full account access. Treat it like a password — do not commit it, share it, or paste it into shared configs. Cookies expire periodically; if you see auth errors, re-copy.

### Environment variables

| Var | Required | Default | Notes |
|---|---|---|---|
| `OL_COOKIE` | yes | — | Session cookie, see above. |
| `OL_BASE_URL` | no | `https://www.overleaf.com` | Override for self-hosted Overleaf. |
| `OL_CSRF` | no | auto-discovered | Force a specific CSRF token. Only needed if your server doesn't ship the `ol-csrfToken` meta tag. |
| `OL_MCP_LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, `error`. Goes to stderr; stdout is reserved for MCP JSON-RPC. |

## Tools

| Tool | Description |
|---|---|
| `ping` | Health check. Does not contact Overleaf. |
| `list_projects` | Lists projects on the configured account, sorted by most recently updated. Supports `name_contains`, `include_archived`, `include_trashed`, `limit`. |
| `open_project` | Joins a project's real-time session and caches its file tree. Returns rich metadata: `root_doc_path`, `compiler`, `spell_check_language`, `public_access_level`, owner + members (with privileges), and whether track-changes is on for your user. |
| `list_files` | Lists the file tree of the open project (cached, no network). Filter by `kind` and `path_contains`. |
| `read_file` | Reads a doc (returns text + OT version + a summary of tracked changes / comments) or a binary file (base64 + MIME). `path` is optional — defaults to the project's root doc. |
| `edit_file` | Replaces a doc's contents. Computes a minimal diff via `diff-match-patch`, submits it as an OT operation, and adds `meta.tc` so the edit lands as a pending suggestion in the Review panel by default. Pass `track: "off"` to write directly or `track: "auto"` to honor the project's track-changes setting. `path` is optional — defaults to the project's root doc. |
| `list_tracked_changes` | Enumerates every pending tracked-change suggestion across the open project, with author name + email, doc path, op kind (insert/delete), position, op text, change_id. Filter by `author_email`, `author_id_endswith`, `path_contains`, `kind`, `text_contains`, `limit`. |
| `accept_changes` | Accepts one or more tracked changes by `change_id` (from `list_tracked_changes`). Multi-doc groups are batched automatically. Irreversible. |
| `reject_changes` | Rejects one or more tracked changes by `change_id`. Implemented as `applyOtUpdate` with the inverse op + `u:true` (same pathway Overleaf's web client uses). Irreversible. |
| `compile` | Triggers an Overleaf compile and returns a unified summary: `status`, `built_cleanly` (true iff PDF + zero LaTeX errors), `error_count`, `warning_count`, `first_errors` (sample), `output_files`, timings. Already fetches and parses `output.log` inline — no extra `read_log` call needed for the happy path. Pass `root_doc`, `draft`, `stop_on_first_error` to control. |
| `read_log` | Returns the full `output.log` from the most recent compile, with `!`-prefixed error lines surfaced at the top. Use when `compile`'s inline summary isn't enough context. |
| `list_comments` | Lists review-panel comment threads with doc path, quoted text, author, latest-message preview. Supports `include_resolved`, `path_contains`, `full`. |
| `read_comment_thread` | Returns the full message history of one thread. |
| `reply_comment` | Posts a new message to an existing thread. |
| `resolve_comment` | Marks a thread resolved. |
| `reopen_comment` | Reopens a resolved thread. |

## Typical workflow

Things to ask Claude once `overleaf-mcp` is connected:

- _"Accept every pending tracked change by John Doe that's only adjusting punctuation or whitespace."_ — uses `list_tracked_changes(author_email: "...")` → LLM filters by op text → `accept_changes(...)`.
- _"List my recent Overleaf projects."_
- _"Open my thesis project and show me what comments my supervisor has left."_
- _"Read intro.tex and fix the missing comma in the second paragraph."_  → with track-changes on, this lands as a tracked suggestion.
- _"Compile the project and tell me what the LaTeX errors mean."_  → uses `compile` then `read_log` automatically.
- _"For each open comment thread, suggest a fix and reply with what you did."_  → end-to-end review workflow.

## Troubleshooting

**`OverleafAuthError: Session cookie rejected (redirected to /login)`** — your `OL_COOKIE` has expired. Re-copy `overleaf_session2` from DevTools.

**`Socket.IO handshake returned 502`** — Overleaf's load balancer rejected the WebSocket upgrade. Almost always means the cookie was rejected. Same fix as above.

**`Could not find ol-csrfToken meta tag`** — your Overleaf server doesn't expose the CSRF meta tag (rare; mostly very old Community Edition). Set `OL_CSRF` explicitly.

**Edits land but don't show up as tracked suggestions** — confirm track-changes is on for *your user* on this project (Menu → Settings → Track Changes → "For me" or "For everyone"). `open_project` reports the detected state under `track_changes_on_for_me`. To force tracking regardless, pass `track: "on"` to `edit_file`.

**Compile succeeds but `read_log` returns 404** — Overleaf needs `?clsiserverid=...` to route to the right CLSI worker; we add this automatically from the previous compile response. If you see this, the previous compile may not have completed; re-run `compile` and then `read_log`.

## Architecture

```
src/
├── index.ts                  MCP server + tool registration
├── config.ts                 env var loading
├── api/
│   ├── http.ts               cookie + CSRF wrapper around fetch
│   ├── socket.ts             custom Socket.IO 0.9 client (fetch handshake + ws@8 upgrade)
│   ├── projectTypes.ts       ProjectEntity, FlatEntity, file-tree flattener
│   ├── compileTypes.ts       compile response shape
│   ├── commentTypes.ts       thread / message / range shapes
│   ├── types.ts              project list shape
│   └── errors.ts             OverleafAuthError, OverleafApiError
├── session/
│   ├── identity.ts           singleton: cookie -> userId/csrf/email via /project HTML scrape
│   ├── activeProject.ts      currently-open project + file tree + last compile
│   └── docCache.ts           per-doc text + OT version cache
├── ot/
│   ├── diff.ts               diff-match-patch -> ShareJS ops
│   └── trackedChanges.ts     meta.tc ID seed (port of ranges-tracker generateIdSeed)
└── tools/
    ├── listProjects.ts
    ├── openProject.ts
    ├── listFiles.ts
    ├── readFile.ts
    ├── editFile.ts
    ├── compile.ts
    └── comments.ts
```

## Acknowledgements

- [`overleaf-workshop`](https://github.com/overleaf-workshop/overleaf-workshop) by @iamhyc and contributors — protocol reference for the HTTP + Socket.IO flow, comment thread endpoints. The `94-review-panel` branch was the source for the comment data shapes.
- [`overleaf/overleaf`](https://github.com/overleaf/overleaf) — `libraries/ranges-tracker/index.cjs` and `services/document-updater/RangesManager.js` are the authoritative source for how tracked changes are emitted (the `update.meta.tc` flag and ID seed format).
- [`googlecolab/colab-mcp`](https://github.com/googlecolab/colab-mcp) — UX reference for what an agent-friendly MCP into a hosted editor should feel like.

## License

**AGPL-3.0-or-later** — see [`LICENSE`](./LICENSE).

overleaf-mcp incorporates code ported from two AGPL-3.0 projects (overleaf-workshop and overleaf/overleaf — see Acknowledgements), so the combined work is distributed under the same terms. Practical implications:

- You can use, study, and modify overleaf-mcp freely.
- If you redistribute it, modified or not, recipients must also receive the source under AGPL-3.0.
- If you run a **modified** version as a network service that users interact with, you must make the modified source available to those users. Running unmodified overleaf-mcp as your own personal MCP server is unaffected.
