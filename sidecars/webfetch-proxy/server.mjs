#!/usr/bin/env node
/**
 * webfetch-proxy — the webhook sidecar for the Engine's Custom Tool `web_fetch`.
 *
 * The Engine's custom tools run in QuickJS with no network bindings, so a tool that fetches a
 * URL has to run outside the Engine. `executionType: "webhook"` is the Engine's supported shape:
 * it POSTs {tool, arguments} to one fixed URL and treats the parsed JSON body as the tool result
 * (tool-executor.ts:439-470). A body containing a string `error` key is classified as a failed
 * call (tool-executor.ts:311-314), which is why refusals come back as 200 + {ok:false, error}.
 *
 * No dependencies, no build step: node server.mjs. The URL validation, SSRF guard, reader client,
 * content cap and deadline all come from packages/webtools/server.mjs, so the package and this
 * proxy cannot drift apart.
 *
 * Deployment (pick one, neither needs a new container):
 *   A. inside the Engine container, launched by the image entrypoint  -> WEBHOOK URL
 *      http://127.0.0.1:8791/
 *   B. systemd on the host, Engine reaches it via extra_hosts host.docker.internal
 *      -> http://host.docker.internal:8791/
 * Both need WEBHOOK_LOCAL_URLS_ENABLED=1 (runtime-config.ts:704), because the webhook target is
 * a private address and safeFetch's default policy is https-only.
 *
 * Security: this is a fetch relay. It binds to loopback by default and refuses to bind anywhere
 * else unless WEBFETCH_PROXY_ALLOW_PUBLIC=1, and every target passes the same SSRF guard the
 * package uses (loopback, RFC1918, link-local + cloud metadata, IPv6 ULA, CGNAT 100.64/10,
 * mDNS names, non-80/443 ports). Do not expose it.
 */

import { createServer } from "node:http";
import { readUrl } from "../../packages/webtools/server.mjs";

const HOST = process.env.WEBFETCH_PROXY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.WEBFETCH_PROXY_PORT ?? 8791);
// The Engine's own custom-tool budget is 60s (DEFAULT_CUSTOM_TOOL_TIMEOUT_MS), 6x the capability-
// package handler deadline, so this proxy can afford a slower reader than the package allows.
const TIMEOUT_MS = Number(process.env.WEBFETCH_PROXY_TIMEOUT_MS ?? 20_000);
const MAX_CHARS = Number(process.env.WEBFETCH_PROXY_MAX_CHARS ?? 16_000);
const MAX_BODY_BYTES = 64 * 1024;

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const started = Date.now();

  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    json(res, 200, {
      ok: true,
      service: "webfetch-proxy",
      readerBase: process.env.WEBTOOLS_READER_BASE ?? "https://r.jina.ai/",
      timeoutMs: TIMEOUT_MS,
      maxChars: MAX_CHARS,
    });
    return;
  }

  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "webfetch-proxy accepts POST" });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    json(res, 400, { ok: false, error: `webfetch-proxy could not parse the request body: ${error.message}` });
    return;
  }

  const args = payload?.arguments ?? {};
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) {
    json(res, 200, { ok: false, error: "web_fetch needs a string `url` argument" });
    return;
  }

  const requestedChars = Number(args.max_chars ?? args.maxChars ?? MAX_CHARS);
  const result = await readUrl(url, {
    maxChars: Number.isFinite(requestedChars) ? requestedChars : MAX_CHARS,
    timeoutMs: TIMEOUT_MS,
  });

  // Normalised to the exact shape the capability package's handler returns, so the model sees the
  // same fields whichever path a deployment uses.
  const toolResult = result.ok
    ? {
        ok: true,
        url: result.finalUrl || url,
        title: result.title || undefined,
        publishedTime: result.publishedTime || undefined,
        content: result.content,
        truncated: result.truncated || undefined,
        chars: result.content.length,
      }
    : { ok: false, error: result.error, url };

  log(
    `${result.ok ? "ok" : "refused"} ${url} ${result.ms}ms ${toolResult.chars ?? 0}chars${result.ok ? "" : ` ${result.error}`}`,
  );
  // Always 200: the Engine reads `error` in the body to mark the call failed, and a non-2xx
  // response discards the message the model needs in order to pick a different URL.
  json(res, 200, toolResult);
});

if (HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1") {
  if (process.env.WEBFETCH_PROXY_ALLOW_PUBLIC !== "1") {
    console.error(
      `refusing to bind ${HOST}: this is a fetch relay. Set WEBFETCH_PROXY_ALLOW_PUBLIC=1 to override.`,
    );
    process.exit(1);
  }
}

server.listen(PORT, HOST, () => {
  log(`webfetch-proxy listening on http://${HOST}:${PORT}/ reader=${process.env.WEBTOOLS_READER_BASE ?? "https://r.jina.ai/"}`);
});

/* A silent crash here is the worst outcome: systemd restarts the unit, the Engine keeps pointing at
 * a port owned by something else, and every web_fetch call fails with a bare "tool failed". Say so
 * in the log, in the first line a journalctl reader sees. */
server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `webfetch-proxy cannot start: ${HOST}:${PORT} is already in use by another service. Pick a free port (ss -ltnp) and set WEBFETCH_PROXY_PORT.`,
    );
  } else {
    console.error(`webfetch-proxy listen failed: ${error?.message ?? String(error)}`);
  }
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log(`webfetch-proxy shutting down (${signal})`);
    server.close(() => process.exit(0));
  });
}
