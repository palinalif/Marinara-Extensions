# webfetch-proxy — `web_fetch` as a Custom Tool, no catalog and no new container

Gives agents a `web_fetch` tool through the Engine's **Custom Tools** feature. The Engine's own
scripted custom tools run in QuickJS with no network bindings (`custom-tool-script.worker.ts:14-22`),
so a tool that reads a URL has to run outside the Engine. `executionType: "webhook"` is the
supported shape: the Engine POSTs `{tool, arguments}` to one fixed URL and uses the parsed JSON
body as the tool result (`tool-executor.ts:439-470`).

Why this route exists: it needs **no catalog override** (so official package updates keep working
unaffected), **no Engine restart**, and the model-facing tool name is exactly `web_fetch` — the
fork's original name, not a prefixed one. The Engine's custom-tool budget is 60 s
(`DEFAULT_CUSTOM_TOOL_TIMEOUT_MS`), 6× the capability-package handler deadline.

## One file, no dependencies

`server.mjs` is plain Node 22 ESM. URL validation, the SSRF guard, the reader client, the content
cap and the deadline are imported from `../../packages/webtools/server.mjs`, so the package and the
proxy cannot drift.

```sh
node sidecars/webfetch-proxy/server.mjs   # listens on 127.0.0.1:8791
node scripts/selftest-proxy.mjs           # 13 checks, drives it with the Engine's request shape
```

## Run it without a container (systemd)

```sh
sudo mkdir -p /opt/marinara-extensions
sudo git clone https://github.com/palinalif/Marinara-Extensions /opt/marinara-extensions
sudo useradd -rs /usr/sbin/nologin marinara 2>/dev/null || true
sudo cp /opt/marinara-extensions/sidecars/webfetch-proxy/webfetch-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now webfetch-proxy
systemctl status webfetch-proxy --no-pager
```

Requires `node` on the host (Node 22+). If the host has no Node, the fallback is to run it inside
the Engine container from the image entrypoint — that needs an image patch, which is why systemd is
the recommended shape.

## Let the Engine reach it

On Linux a container's `127.0.0.1` is the container, so give it the host gateway and allow private
webhook targets (`isWebhookLocalUrlsEnabled`, `runtime-config.ts:704`):

```yaml
services:
  marinara:
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      - WEBHOOK_LOCAL_URLS_ENABLED=1
```

`docker compose up -d` (recreate — `env_file` is read at container creation, not on restart).

## Create the custom tool

Engine UI → **Custom Tools** → new tool:

| Field | Value |
| --- | --- |
| Name | `web_fetch` (lowercase snake_case, required by `createCustomToolSchema`) |
| Description | `Read any public URL as markdown (renders JavaScript pages, parses PDFs).` |
| Execution type | `webhook` |
| Webhook URL | `http://host.docker.internal:8791/fetch` |
| Parameters | JSON Schema below |
| Enabled | on |

```json
{
  "type": "object",
  "properties": {
    "url": { "type": "string", "description": "Absolute http(s) URL to read" },
    "max_chars": { "type": "number", "description": "Optional content cap, default 16000" }
  },
  "required": ["url"]
}
```

Then enable the tool for the agents that should have it.

## Verify

```sh
curl -s http://127.0.0.1:8791/health
curl -s -X POST -H 'content-type: application/json' \
  -d '{"tool":"web_fetch","arguments":{"url":"https://en.wikipedia.org/wiki/Artificial_intelligence"}}' \
  http://127.0.0.1:8791/fetch | head -c 300
```

Then in a chat: *"fetch https://en.wikipedia.org/wiki/Artificial_intelligence and summarize it"*.

## Response contract

- The body **is** the tool result. A body containing a string `error` key is classified as a failed
  call (`tool-executor.ts:311-314`), so refusals return **HTTP 200 + `{ok:false, error}`** — a
  non-2xx response discards the message the model needs to choose a different URL.
- Success shape matches the capability package exactly:
  `{ok:true, url, title?, publishedTime?, content, truncated?, chars}`.
- The Engine caps webhook responses at 512 KiB; the content cap is 16 000 chars by default.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEBFETCH_PROXY_HOST` | `127.0.0.1` | Bind address. Anything else needs `WEBFETCH_PROXY_ALLOW_PUBLIC=1` |
| `WEBFETCH_PROXY_PORT` | `8791` | Port. Chosen outside the 80xx range this box's voice/LLM services use — check `ss -ltnp` and pick another if taken |
| `WEBFETCH_PROXY_TIMEOUT_MS` | `20000` | Per-request budget (Engine allows 60 s) |
| `WEBFETCH_PROXY_MAX_CHARS` | `16000` | Default content cap |
| `WEBTOOLS_READER_BASE` | `https://r.jina.ai/` | Reader service root |
| `WEBTOOLS_READER_API_KEY` | — | Free key raises hosted limit 20 → 500 RPM |

Self-host the reader so no third party sees fetched URLs:
`docker run -d --name reader -p 127.0.0.1:8081:8081 ghcr.io/jina-ai/reader:oss` then
`WEBTOOLS_READER_BASE=http://127.0.0.1:8081/` (8081 is the HTTP/1.1 port; 8080 is h2c).

## Security notes

This is a fetch relay, so it is deliberately narrow:

- Binds loopback only and refuses any other bind address unless explicitly overridden.
- Every target passes the same SSRF guard as the package: loopback, RFC1918, link-local and cloud
  metadata (`169.254.169.254`), IPv6 ULA/link-local, CGNAT `100.64/10` (Tailscale), multicast and
  reserved ranges, local mDNS names, non-80/443 ports, embedded credentials, and hostnames that
  resolve to any of those. Hostname verdicts are cached 5 minutes.
- The Engine's `WEBHOOK_LOCAL_URLS_ENABLED` flag opens the Engine to local webhook URLs generally.
  It is a danger-zone flag: with it on, any custom tool can point at any private address, so keep
  the custom-tool list under the same review discipline as the Danger Zone toggle it enables.
- The Engine cannot send an auth header to a webhook (it sends only `Content-Type`), so access
  control is the loopback binding, not a shared secret. Do not expose this port.
