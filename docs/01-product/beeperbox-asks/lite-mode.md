# beeperbox feature request: first-class "lite mode" (MCP verbs against an existing Beeper Desktop)

> Upstream ask from **multis** (the driving consumer). Filed per the baresuite migration's lane rule:
> this is *requirements + acceptance* for beeperbox to develop, not an implementation authored from multis.
> Tracked in `docs/01-product/baresuite-migration-prd.md` §7 (2026-06-16).

## Motivation

beeperbox should serve **two customers** from the same verb layer:

- **A — full container** (today): headless Beeper Desktop + MCP in one Docker image.
- **B — lite mode** (this ask): run *only* the MCP verb server against a Beeper Desktop the user **already runs locally** — no Docker, no Electron, no Xvfb.

Driving consumer: **multis**, which is a pure beeperbox-MCP client. Lite mode lets laptop users
(Beeper already open) use beeperbox's verbs without running the whole container, while the container
stays the answer for always-on / VPS deployments.

## What already works today (please don't rebuild — verified in `mcp/server.js`)

- `node mcp/server.js` runs standalone — single file, zero deps, Node 18+.
- `BEEPER_API` env points at any Beeper Desktop API (default `http://127.0.0.1:23373`) — `server.js:12`.
- `BEEPER_TOKEN` is read and sent as `Authorization: Bearer` on every Beeper call, with a clear error if unset — `server.js:14,157,160`.
- `MCP_PORT` (`:23375`), `MCP_AUTH_TOKEN` (optional bearer guard), `MCP_ALLOWED_HOSTS` (DNS-rebind allowlist, loopback default) — all env-driven, all work outside the container — `server.js:12,32,33,134,148`.
- HTTP **and** `--stdio` transports.

So functionally, `BEEPER_API=http://localhost:23373 BEEPER_TOKEN=… node mcp/server.js` **already serves the verbs.**
The ask is to make that a *supported, safe, documented* path.

## The actual gaps to develop

**1. A first-class entry point / distribution.** Today you must clone the repo and run a file by path.
Provide a supported install: an npm package with a `bin` (e.g. `npx @beeperbox/mcp` / `beeperbox-mcp`)
— trivial since it's zero-dep — or, at minimum, a documented, version-pinned standalone invocation.
*(beeperbox's call on npm-bin vs documented-file.)*

**2. 🐛 Sent-ledger path defaults to a container-only location.** `ledgerPath()` returns
`/root/.config/beeperbox-sent-ledger.json` (`server.js:488`). On a normal host (non-root, no `/root`)
that write **fails**, so the `source:"api"` echo-guard's ledger can't persist — the echo-guard silently
degrades (especially across restarts). **This is the one functional defect for lite mode.** Fix: default
to a per-user path (`os.homedir()` / XDG `~/.config/beeperbox/sent-ledger.json`) when not containerized,
create the dir, and keep honoring `BEEPERBOX_SENT_LEDGER`.

**3. Startup preflight (no container healthcheck in lite mode).** The container has a Docker `HEALTHCHECK`
+ supervises `beepertexts`; standalone has neither. Add an optional boot probe: call `/v1/accounts`
(or `/v1/info`) once on startup and log a clear OK (`reachable, N accounts`) or FAIL
(`BEEPER_API unreachable / token rejected`) so a misconfig is obvious immediately instead of at first
tool call.

**4. De-containerize the error copy.** `server.js:157` says "pass it to the container" — make
transport-agnostic ("set `BEEPER_TOKEN`").

**5. Docs — a README "Lite mode" section.** Prereqs (local Beeper Desktop running + Developer API enabled
+ a dev token from Settings → Developers — the same token the container uses); the one command; the env
contract (below); security posture (loopback by default — to expose, set `MCP_AUTH_TOKEN` **and**
`MCP_ALLOWED_HOSTS`, use a tunnel); supervision note (no Docker restart policy → run under systemd/pm2);
and how it differs from the container (you supply Beeper Desktop; beeperbox supplies only the verbs).

**6. Parity guarantee.** Lite and container must expose the **identical** verb surface and
`serverInfo.version` (same file — so just assert it with a test so they can't drift).

## Config contract (lite mode)

| Env | Meaning | Default |
|---|---|---|
| `BEEPER_API` | local Beeper Desktop API base | `http://127.0.0.1:23373` |
| `BEEPER_TOKEN` | Beeper dev token (Settings → Developers) | — (required) |
| `MCP_PORT` | MCP HTTP port | `23375` |
| `MCP_AUTH_TOKEN` | optional bearer guard on the MCP endpoint | unset (open on loopback) |
| `MCP_ALLOWED_HOSTS` | Host/Origin allowlist | `localhost,127.0.0.1,::1` |

## Acceptance criteria

- A documented one-command install/run starts the verb server against a local Beeper Desktop with **no container**.
- `tools/list` returns the **same** tools + version as the container build.
- The echo-guard sent-ledger **persists** to a writable per-user path by default (no `/root` dependency)
  — verified by a send → restart → poll round-trip where the prior send still reads back `source:"api"`.
- Startup logs a clear reachable/unreachable verdict for `BEEPER_API` + token.
- README documents prereqs, the command, the env contract, and the security posture.

## Non-goals

- No bundled/headless Beeper in lite mode (that's the container's job — the user supplies Beeper Desktop).
- No new verbs; no transport changes. Lite mode is the **same** server, just packaged + safe to run standalone.
