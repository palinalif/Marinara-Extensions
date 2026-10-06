#!/usr/bin/env node
/**
 * Self-test for the webfetch-proxy webhook sidecar: starts it on a loopback port and drives it
 * with the exact request shape the Engine's custom-tool webhook sends
 * (POST {tool, arguments}, JSON body is the tool result, string `error` => failed call).
 */

import { spawn } from "node:child_process";
import { once } from "node:events";

const PORT = Number(process.env.SELFTEST_PROXY_PORT ?? 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];

function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const child = spawn(process.execPath, ["sidecars/webfetch-proxy/server.mjs"], {
  env: { ...process.env, WEBFETCH_PROXY_PORT: String(PORT), WEBFETCH_PROXY_HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let childLog = "";
child.stdout.on("data", (chunk) => (childLog += chunk));
child.stderr.on("data", (chunk) => (childLog += chunk));

async function post(body, raw = false) {
  const response = await fetch(`${BASE}/fetch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON body, asserted by the caller */
  }
  return { status: response.status, parsed, text };
}

try {
  // Wait for the listen line rather than sleeping.
  for (let i = 0; i < 60 && !childLog.includes("listening"); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  check("sidecar starts and binds loopback", childLog.includes("listening"), childLog.trim().split("\n")[0]);

  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  check("GET /health reports the reader base", health.ok === true && /r\.jina\.ai/.test(health.readerBase), health.readerBase);

  const t0 = Date.now();
  const good = await post({ tool: "web_fetch", arguments: { url: "https://en.wikipedia.org/wiki/Artificial_intelligence" } });
  const ms = Date.now() - t0;
  check(
    "Engine-shaped POST returns markdown for a public URL",
    good.status === 200 && good.parsed?.ok === true && (good.parsed.content ?? "").length > 1000,
    `${ms}ms, ${(good.parsed?.content ?? "").length} chars, title=${JSON.stringify(good.parsed?.title)}`,
  );
  check("result carries the fields the model needs", typeof good.parsed?.url === "string" && typeof good.parsed?.content === "string" && typeof good.parsed?.truncated === "boolean");

  const capped = await post({ tool: "web_fetch", arguments: { url: "https://en.wikipedia.org/wiki/Artificial_intelligence", max_chars: 1200 } });
  check("max_chars is honoured", capped.parsed?.ok === true && capped.parsed.content.length <= 1200, `${capped.parsed?.content?.length} chars`);

  const loopback = await post({ tool: "web_fetch", arguments: { url: "http://127.0.0.1:8081/anything" } });
  check(
    "loopback target is refused with a 200 + error body (Engine marks it failed)",
    loopback.status === 200 && loopback.parsed?.ok === false && typeof loopback.parsed.error === "string",
    loopback.parsed?.error,
  );

  const privateTarget = await post({ tool: "web_fetch", arguments: { url: "http://192.168.1.1/router-config" } });
  check("RFC1918 target is refused", privateTarget.parsed?.ok === false && typeof privateTarget.parsed.error === "string", privateTarget.parsed?.error);

  const metadata = await post({ tool: "web_fetch", arguments: { url: "http://169.254.169.254/latest/meta-data/" } });
  check("cloud metadata target is refused", metadata.parsed?.ok === false, metadata.parsed?.error);

  const noUrl = await post({ tool: "web_fetch", arguments: {} });
  check("missing url yields a readable tool error", noUrl.parsed?.ok === false && /string `url`/.test(noUrl.parsed?.error ?? ""));

  const badUrl = await post({ tool: "web_fetch", arguments: { url: "not a url" } });
  check("unparseable url yields a readable tool error", badUrl.parsed?.ok === false && typeof badUrl.parsed.error === "string", badUrl.parsed?.error);

  const malformed = await post("{not json", true);
  check("malformed body is a 400, not a crash", malformed.status === 400 && malformed.parsed?.ok === false);

  const getOnPostPath = await fetch(`${BASE}/fetch`);
  check("GET on the webhook path is rejected", getOnPostPath.status === 405);

  check("sidecar is still alive after the abuse", (await fetch(`${BASE}/health`)).ok);
} catch (error) {
  check("selftest ran without an unhandled error", false, error.message);
} finally {
  child.kill("SIGTERM");
  await once(child, "exit").catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
