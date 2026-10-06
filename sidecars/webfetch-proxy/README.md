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

## Deployment by platform

The proxy is one Node file, so it can run anywhere Node runs. What survives a reboot does not.

| Platform | Durable shape |
| --- | --- |
| systemd host | `webfetch-proxy.service` (below) |
| **Unraid** | a container on a shared Docker network (below) — host processes do not survive reboot |
| pm2 / supervisord host | same file, registered with that supervisor |

### Unraid (no systemd, RAM-based OS filesystem)

Unraid extracts `bzroot` into a RAM filesystem and makes it `/`: `/root`, `/usr`, `/etc`, `/var`
are volatile and rebuilt on every boot. Only `/mnt/user/*` (shares, incl. `appdata`) and
`/boot/config/*` persist. So on Unraid:

- there is no systemd, so a unit file is not an option;
- a clone under `/opt` or `/root` **disappears at reboot**;
- host `node` installed after boot is volatile too, so a host process is not a durable unit.

On Unraid the durable, restart-safe unit is a container, and it needs no new host dependency:

```sh
# 1. Persistent source. Unraid has no git by default, so pull the tarball.
mkdir -p /mnt/user/appdata/webfetch-proxy/Marinara-Extensions
curl -fsSL https://github.com/palinalif/Marinara-Extensions/archive/refs/heads/main.tar.gz \
  | tar xz -C /mnt/user/appdata/webfetch-proxy/Marinara-Extensions --strip-components=1

# 2. The proxy, on the Engine's existing user-defined network. No published port: it is
#    reachable only from that network. (The default `bridge` has no per-container DNS;
#    a user-defined network resolves container names.)
docker run -d --name webfetch-proxy \
  --network marinara-net \
  --restart unless-stopped \
  -v /mnt/user/appdata/webfetch-proxy/Marinara-Extensions:/app:ro \
  -e WEBFETCH_PROXY_HOST=0.0.0.0 \
  -e WEBFETCH_PROXY_ALLOW_PUBLIC=1 \
  -e WEBFETCH_PROXY_PORT=8791 \
  -e WEBTOOLS_READER_BASE=https://r.jina.ai/ \
  --health-cmd 'wget -qO- http://127.0.0.1:8791/health >/dev/null || exit 1' \
  --health-interval 60s --health-timeout 5s --health-retries 3 \
  node:22-alpine node /app/sidecars/webfetch-proxy/server.mjs

# 3. Prove it from inside the Engine container (container DNS, no host port involved)
docker logs --tail=5 webfetch-proxy
docker exec marinara sh -c 'wget -qO- http://webfetch-proxy:8791/health'
```

To update later, re-run step 1 and `docker restart webfetch-proxy`.

`WEBFETCH_PROXY_HOST=0.0.0.0` + `WEBFETCH_PROXY_ALLOW_PUBLIC=1` is deliberate: inside a container
loopback is unreachable from the Engine, so it must bind the container interface. Publishing **no**
port keeps it off the host and LAN — the only clients are containers on `marinara-net`.

Then allow private webhook targets on the Engine. On Unraid that is the Docker tab → `marinara` →
Edit → add an environment variable `WEBHOOK_LOCAL_URLS_ENABLED=1` → **Apply**, which recreates the
container. (With compose it is the same recreate: `env_file` is read at container creation, so a
plain restart does not pick it up.)

```yaml
services:
  marinara:
    environment:
      - WEBHOOK_LOCAL_URLS_ENABLED=1
```

Custom Tool webhook URL becomes `http://webfetch-proxy:8791/fetch` — container DNS, no
`host.docker.internal`, no host port, no collision with the voice backend on 8090.

Verify from the Engine container:

```sh
docker exec marinara sh -c 'wget -qO- http://webfetch-proxy:8791/health'
```

### systemd host

```sh
sudo mkdir -p /opt/marinara-extensions
sudo git clone https://github.com/palinalif/Marinara-Extensions /opt/marinara-extensions
sudo useradd -rs /usr/sbin/nologin marinara 2>/dev/null || true
sudo cp /opt/marinara-extensions/sidecars/webfetch-proxy/webfetch-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now webfetch-proxy
systemctl status webfetch-proxy --no-pager
```

Requires `node` on the host (Node 22+).

## Let the Engine reach it (systemd-host shape)

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
| Webhook URL | `http://webfetch-proxy:8791/fetch` (Unraid) · `http://host.docker.internal:8791/fetch` (systemd host) |
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
curl -s http://127.0.0.1:8791/health   # systemd host
# Unraid: no host port is published, so probe it from the Engine container instead:
#   docker exec marinara sh -c 'wget -qO- http://webfetch-proxy:8791/health'
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
