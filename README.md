# Marinara Extensions

Marinara Engine **capability packages** that live outside the Engine repo, so Engine updates can
never overwrite them. Built against the Engine's own package seam (`api.registerTool`), installed
through the Engine's catalog UI.

| Package | Gives the model | Backend |
| --- | --- | --- |
| [`webtools`](packages/webtools) | `webtools_web_fetch` — read any public URL as markdown | [Jina Reader](https://github.com/jina-ai/reader) (hosted, or self-hosted) |

| Tool | Gives you | Backend |
| --- | --- | --- |
| [`add-voice`](tools/add-voice) | enrolled TTS voices for the stock voice picker | VoxCPM2 (`voxcpm2-server`) |
| [`set-tts`](tools/set-tts) | the VoxCPM2 connection itself, verified by a real spoken line | the Engine's own `PUT /api/tts/config` |

`web_fetch` ships in two shapes, sharing one implementation:

| | capability package | [webfetch-proxy](sidecars/webfetch-proxy) sidecar |
| --- | --- | --- |
| Engine feature | capability packages + catalog | Custom Tools, `executionType: "webhook"` |
| model-facing name | `webtools_web_fetch` | **`web_fetch`** |
| needs catalog override | yes (published additively, see below) | **no** |
| needs Engine restart | yes (`env_file`) | **no** |
| extra process | none | one loopback Node service (systemd, **no container**) |
| tool budget | 10 s handler deadline | **60 s** (`DEFAULT_CUSTOM_TOOL_TIMEOUT_MS`) |
| tests | `scripts/selftest.mjs` 37/37 | `scripts/selftest-proxy.mjs` 13/13 |

## Why packages and not Engine code

Upstream has `web_search` (DuckDuckGo Lite, scraped inline in `tool-executor.ts`) and **no**
`web_fetch`. The fork's `web_fetch` was Engine-internal code, which is why keeping it meant
re-applying fork patches on every update.

Capability packages are the opposite: they install into `DATA_DIR/capability-packages/`, ship as a
signed-by-hash zip from a catalog, and are plain trusted in-process Node — so `fetch`, `dns`, and
`process.env` all work. The Engine's scripted "custom tools" cannot do this: they run in QuickJS
with no network bindings (`custom-tool-script.worker.ts:14-22`).

## Layout

```
packages/<id>/manifest.json   Engine manifest (hash-pinned files)
packages/<id>/server.mjs      server entrypoint (ESM, exports activate)
sidecars/<name>/server.mjs    standalone webhook service (imports the package module)
scripts/build.mjs             builds dist/<id>-<version>.zip + dist/catalog.json
scripts/selftest.mjs          runs the package under the Engine's real limits
scripts/selftest-proxy.mjs    drives the sidecar with the Engine's webhook request shape
scripts/verify-package.mjs    validates dist/ with the Engine's own schemas
tools/<name>/                 host-side helpers that are not Engine code (see below)
dist/                         publish these two files; the catalog points at them
```

`tools/add-voice` is deliberately **not** a package. VoxCPM2 resolves `voice` to a
directory scan (`/voices/<id>/reference.wav`), so enrolling a voice is a filesystem
write on the host; a package would add a manifest, a route prefix, a panel and a
restart cycle to do that write. See [`tools/add-voice/README.md`](tools/add-voice/README.md).

`tools/set-tts` is not a package for the same reason: the Engine already has a validated
endpoint for its own TTS settings, and loopback calls to it need no credentials.

## The catalog is additive — official packages keep updating

The Engine treats `MARINARA_AGENT_CATALOG_URL` as **the whole catalog**
(`package-manager.service.ts`: "An explicit override IS the whole catalog"), and `POST
/api/capability-packages/:id/install` only installs ids present in that one document. So pointing
the Engine here must not cost the official list.

`dist/catalog.json` is therefore published **additively**: the 39 official entries copied verbatim
from `Pasta-Devs/Marinara-Agents`, plus ours. `scripts/build.mjs` fetches the official catalog at
build time (falling back to the committed `dist/official-catalog.json` snapshot when offline, so a
build can never *lose* official entries), and `.github/workflows/sync-catalog.yml` re-runs the
merge daily so official updates keep flowing. A catalog entry may be `schemaVersion: 1` (official)
or `2` (ours) in the same document — `capabilityCatalogPackageSchema` accepts both, and an entry
this Engine cannot parse is dropped individually rather than failing the document.

The UI's **Import agents** dialog is not an alternative: it takes `importAgentConfigSchema` — agent
config JSON files, an agent folder, or a Game Mode ruleset file — plus `approvedCapabilities`, which
are runtime permissions (`create_characters`, `edit_lorebooks`, …). It carries no server-side code,
so it cannot deliver a tool that needs `fetch`.

## Publishing

```sh
node scripts/build.mjs --base-url https://raw.githubusercontent.com/<you>/<repo>/main/dist
git add -A && git commit -m "webtools <version>" && git push
```

`build.mjs` regenerates `dist/catalog.json` from the same manifest object that goes inside the zip,
which matters: the Engine refuses an artifact whose embedded manifest is not
`JSON.stringify`-identical to the catalog entry.

## Point the Engine at this catalog

The Engine reads one catalog URL, overridable by env (`package-manager.service.ts:137`):

```
MARINARA_AGENT_CATALOG_URL=https://raw.githubusercontent.com/<you>/<repo>/main/dist/catalog.json
```

Put it in `DATA_DIR/.env` (that is `packages/server/data/.env` in Docker mode), restart, then
install **Web Tools** in the Engine's capability-packages UI. No signing key is involved: the
Engine verifies the zip's sha256 from the catalog and every file's sha256 from the manifest.

**Hosting must be public-internet reachable.** Catalog and artifact downloads go through the
Engine's `safeFetch`, which refuses private/loopback addresses — a `file://` path or a LAN URL
will not install. A public GitHub repo (or a secret gist) works; a private repo does not, because
`raw.githubusercontent.com` requires auth.

## webtools

Gives the model one tool, `webtools_web_fetch`:

```
webtools_web_fetch(url, max_chars?)  ->  { ok, url, title, publishedTime?, content, truncated?, chars }
```

- **Backend.** `https://r.jina.ai/` by default. Reader renders JavaScript pages, parses PDFs and
  Office documents, and returns markdown — a plain `fetch` cannot do any of that.
- **Self-host it** (no third party sees your URLs, no rate limit):
  `docker run -d --name reader -p 127.0.0.1:8081:8081 ghcr.io/jina-ai/reader:oss`, then
  `WEBTOOLS_READER_BASE=http://127.0.0.1:8081/`. Port 8081 is the HTTP/1.1 port; 8080 is h2c.
- **SSRF guard.** Refuses loopback, RFC1918, link-local (incl. cloud metadata `169.254.169.254`),
  IPv6 unique-local/link-local, CGNAT `100.64/10` (Tailscale), multicast/reserved, local mDNS
  names, non-80/443 ports, embedded credentials, and hostnames that resolve to any of those.
  Hostname verdicts are cached (5 min) so repeat reads of a site don't re-resolve.
- **Deadline.** The Engine kills package tool handlers at 10 000 ms and reports a bare
  `Tool webtools_web_fetch failed`. The handler races its own 8 000 ms wall-clock deadline
  (`WEBTOOLS_TIMEOUT_MS`) and returns a readable error instead.
- **Size.** The Engine caps a tool result at 64 KiB. Content is capped at 16 000 chars
  (`WEBTOOLS_MAX_CHARS`, max 60 000) and the response stream stops as soon as the cap is reached.

### Engine environment knobs

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEBTOOLS_READER_BASE` | `https://r.jina.ai/` | Reader service root |
| `WEBTOOLS_READER_API_KEY` | — | Bearer token; raises the hosted rate limit (20 → 500 RPM) |
| `WEBTOOLS_MAX_CHARS` | `16000` | Content cap per call |
| `WEBTOOLS_TIMEOUT_MS` | `8000` | Handler budget, hard-capped below the Engine's 10 s |
| `WEBTOOLS_NO_CACHE` | — | `1` asks the reader to bypass its cache |

## Slow DNS is the thing that will make this feel broken

Measured on this dev box, before fixing the container's resolver:

| Resolver | `en.wikipedia.org` |
| --- | --- |
| router DNS `192.168.1.254` | **23 023 ms — ETIMEOUT** |
| Docker embedded DNS `127.0.0.11` (forwards to the router first) | 6 005 ms |
| container default `/etc/resolv.conf` | 9 990 ms |
| `1.1.1.1` / `1.1.2.2` direct | **3–4 ms** |

Docker builds the container's resolver from the host's, which lists the router first; the router
does not answer, so every lookup pays a timeout before falling back. That is a ~4 s tax on the
first read of every hostname, inside a 10 s handler budget.

Fix it at the container, not in the package — add to the Engine's compose service:

```yaml
services:
  marinara:
    dns:
      - 1.1.1.1
      - 1.1.2.2
```

After that, measured end-to-end handler times were 0.3–3.1 s. The package caches hostname verdicts,
which helps repeat reads; it cannot fix a resolver that takes seconds per lookup.

## Tests

```sh
node scripts/selftest.mjs        # 37 checks
node scripts/selftest-proxy.mjs  # 13 checks
node scripts/verify-package.mjs  # 10 checks, Engine's own validators
```

36 checks: the registration contract (name/qualified-name/description/schema byte limits), 18 SSRF
refusals plus public-host allowances, live reads (HTML, JS-rendered Reddit, a 240 KB arXiv PDF),
structured-error paths, truncation, and `selfCheck`. It enforces the Engine's own numbers from
`capability-tool-registry.service.ts` (10 s deadline, 64 KiB result, 8 KiB schema, 512-char
description).
