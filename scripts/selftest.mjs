#!/usr/bin/env node
/**
 * Self-test for the Web Tools package.
 *
 * Runs the package the way the Engine runs it: activate() with a fake api, then call the handler
 * under the Engine's own limits (capability-tool-registry.service.ts):
 *   name <= 48 chars, qualified name <= 64, description <= 512, schema <= 8 KiB,
 *   result <= 64 KiB, handler deadline 10 000 ms, <= 16 tools per package.
 *
 * Part 1 is offline (SSRF guard + contract). Part 2 hits the live reader service.
 */

import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const HANDLER_TIMEOUT_MS = 10_000;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_SCHEMA_BYTES = 8 * 1024;

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const pkg = await import(pathToFileURL(resolve("packages/webtools/server.mjs")).href);

/* -- 1. registration contract -------------------------------------------------- */

let registration = null;
const cleanup = await pkg.activate({
  api: {
    registerTool(reg) {
      registration = reg;
      return () => {};
    },
  },
});
check("activate registers a tool", !!registration);
check("tool name is web_fetch", registration?.name === "web_fetch", registration?.name);
check("name <= 48 chars", (registration?.name || "").length <= 48);
check("qualified name webtools_web_fetch <= 64", "webtools_web_fetch".length <= 64);
check("description <= 512", (registration?.description || "").length <= MAX_DESCRIPTION_LENGTH, `${(registration?.description || "").length} chars`);
const schemaBytes = Buffer.byteLength(JSON.stringify(registration?.parameters), "utf8");
check("schema <= 8 KiB", schemaBytes <= MAX_SCHEMA_BYTES, `${schemaBytes} bytes`);
check("returns a cleanup function", typeof cleanup === "function");

/* -- 2. SSRF guard (offline) --------------------------------------------------- */

const refusals = [
  ["http://127.0.0.1:8081/admin", "loopback"],
  ["http://localhost/x", "loopback name"],
  ["http://10.0.0.5/", "RFC1918"],
  ["http://192.168.1.1/", "RFC1918"],
  ["http://172.16.0.1/", "RFC1918"],
  ["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
  ["http://100.64.0.1/", "Tailscale CGNAT"],
  ["http://[::1]:8080/", "IPv6 loopback"],
  ["http://[fd00::1]/", "IPv6 unique-local"],
  ["http://[fe80::1]/", "IPv6 link-local"],
  ["http://[::ffff:127.0.0.1]/", "IPv4-mapped loopback"],
  ["http://example.com:6379/", "non-web port"],
  ["ftp://example.com/file", "non-http scheme"],
  ["https://user:pass@example.com/", "embedded credentials"],
  ["http://printer.local/", "mDNS name"],
  ["http://metadata.google.internal/", "metadata host"],
  ["not a url", "garbage"],
  ["http://localhost.localdomain/", "loopback suffix"],
];
for (const [url, label] of refusals) {
  const reason = await pkg.refusalFor(url);
  check(`refuses ${label}`, !!reason, reason || "ALLOWED");
}

const allowed = [
  "https://example.com/",
  "https://en.wikipedia.org/wiki/Artificial_intelligence",
  "https://arxiv.org/pdf/2005.14165",
];
for (const url of allowed) {
  const reason = await pkg.refusalFor(url);
  check(`allows ${new URL(url).hostname}`, !reason, reason || "");
}

/* -- 3. live reader calls ------------------------------------------------------ */

async function callHandler(args) {
  const started = Date.now();
  const result = await pkg.activate === undefined ? null : await registration.handler(args, { chatId: "selftest", packageId: "webtools", toolName: "web_fetch" });
  const serialized = typeof result === "string" ? result : JSON.stringify(result ?? { ok: true });
  return { result, serialized, ms: Date.now() - started };
}

const live = [
  ["https://example.com/", null],
  ["https://en.wikipedia.org/wiki/Artificial_intelligence", "Artificial intelligence"],
  ["https://www.reddit.com/r/LocalLLaMA/", null],
  ["https://arxiv.org/pdf/2005.14165", null],
];
for (const [url, expectIn] of live) {
  const { result, serialized, ms } = await callHandler({ url });
  const bytes = Buffer.byteLength(serialized, "utf8");
  const content = result?.content || "";
  const titleOk = result?.title?.length > 2;
  const ok = result?.ok === true && content.length > 100 && bytes <= MAX_RESULT_BYTES && ms < HANDLER_TIMEOUT_MS;
  const contentOk = expectIn ? content.includes(expectIn) : true;
  check(`reads ${new URL(url).hostname}`, ok && contentOk && titleOk, `${ms}ms, ${content.length} chars, ${bytes} B result, title="${result?.title}"`);
}

/* -- 4. failure paths return structured errors, never throw -------------------- */

const bad = await callHandler({ url: "http://127.0.0.1:8081/admin" });
check("private target returns structured error", bad.result?.ok === false && !!bad.result?.error, bad.result?.error);
const missing = await callHandler({});
check("missing url returns structured error", missing.result?.ok === false, missing.result?.error);
const trunc = await callHandler({ url: "https://en.wikipedia.org/wiki/Artificial_intelligence", max_chars: 1200 });
check("max_chars truncates", trunc.result?.ok === true && trunc.result?.content?.length <= 1200 && trunc.result?.truncated === true, `${trunc.result?.content?.length} chars`);

/* -- 5. selfCheck ------------------------------------------------------------- */

const self = await pkg.selfCheck();
check("selfCheck passes with defaults", self.ok === true, JSON.stringify(self));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("failing:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
