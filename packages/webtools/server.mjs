/**
 * Web Tools — a Marinara Engine capability package that gives the model a `web_fetch` tool.
 *
 * The model sees the tool as `webtools_web_fetch`. The handler asks a Reader service
 * (https://r.jina.ai by default, or a self-hosted reader via WEBTOOLS_READER_BASE) to fetch the
 * page and convert it to readable markdown, then returns it under the Engine's result cap.
 *
 * Why a reader service instead of a plain fetch: pages that need JavaScript, PDFs, and Word/Excel
 * files all need a real renderer. Reader (Apache-2.0, github.com/jina-ai/reader) does that and
 * returns markdown, so the Engine gets content instead of raw HTML.
 *
 * Configuration (Engine environment, all optional):
 *   WEBTOOLS_READER_BASE     Reader root, default "https://r.jina.ai/".
 *                            Self-hosted: "http://127.0.0.1:8081/" (see README).
 *   WEBTOOLS_READER_API_KEY  Bearer token for the hosted reader (raises the rate limit).
 *   WEBTOOLS_MAX_CHARS       Content cap per call, default 16000, max 60000.
 *   WEBTOOLS_TIMEOUT_MS      Handler budget, default 8000. The Engine kills handlers at 10000.
 *   WEBTOOLS_NO_CACHE        "1" asks the reader to bypass its cache.
 */

import dns from "node:dns/promises";
import net from "node:net";

const DEFAULT_READER_BASE = "https://r.jina.ai/";
const DEFAULT_MAX_CHARS = 16_000;
const MAX_ALLOWED_CHARS = 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;
/** The Engine stops waiting at 10 000 ms; a generic "tool failed" is a worse answer than ours. */
const ENGINE_HANDLER_DEADLINE_MS = 10_000;
/** Reader output is text; refuse absurd bodies before buffering them. */
const MAX_READER_BYTES = 4_000_000;

function setting(name, fallback) {
  const raw = typeof process !== "undefined" && process.env ? process.env[name] : undefined;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || fallback;
}

function numberSetting(name, fallback, { min, max }) {
  const parsed = Number(setting(name, String(fallback)));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/* ------------------------------------------------------------------ SSRF guard

The reader service is the thing that opens the connection, so this guard is what stands between
"the model asked for a URL" and "we proxied a request into the private network". It refuses
loopback, RFC1918, link-local (including cloud metadata), ULA, CGNAT (Tailscale's 100.64/10),
multicast/reserved ranges, local mDNS names, non-web ports, and embedded credentials.
DNS is resolved here so a public hostname pointing at a private address is refused too.
A self-hosted reader on 127.0.0.1 is fine as the *service*; it is never the *target*. */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "host.docker.internal",
  "gateway.docker.internal",
]);
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".localdomain", ".lan"];

function blockedIpv4(a, b, c, d) {
  if ([a, b, c, d].some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  if (a === 0) return true; // "this network" + 0.0.0.0/8
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC6598 CGNAT — Tailscale's range
  if (a === 198 && b >= 18 && b <= 19) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function blockedIpv6(ip) {
  const lower = ip.toLowerCase().split("%")[0];
  const mapped = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/.exec(lower);
  if (mapped) return blockedIpv4(...mapped[1].split(".").map(Number));
  if (lower === "::" || lower === "::1") return true; // unspecified + loopback
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
  if (/^ff/.test(lower)) return true; // multicast
  if (/^2002:/.test(lower)) return true; // 6to4 embeds an IPv4, frequently private
  if (/^64:ff9b:/.test(lower)) return true; // IPv4 translation
  if (lower.includes(".")) return true; // any dotted-quad form we did not match above
  return false;
}

function blockedIp(address) {
  const kind = net.isIP(address);
  if (kind === 4) return blockedIpv4(...address.split(".").map(Number));
  if (kind === 6) return blockedIpv6(address);
  return true; // not an address we can reason about, so refuse it
}

/**
 * Hostname verdicts are cached. Resolving is the guard's only expensive step (on a slow resolver it
 * costs seconds, and the handler has a 10 s budget), and an agent that reads several pages on one
 * site should pay it once. Addresses can move, so entries expire.
 */
const HOST_VERDICT_TTL_MS = 5 * 60 * 1000;
const HOST_FAILURE_TTL_MS = 30 * 1000;
const HOST_CACHE_MAX = 256;
const hostVerdicts = new Map();

/** @returns {Promise<string|null>} a refusal reason, or null when the URL is safe to read. */
export async function refusalFor(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "That is not a valid absolute URL.";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "Only http and https URLs can be read.";
  }
  if (parsed.username || parsed.password) {
    return "URLs with embedded credentials are not allowed.";
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "That URL has no host.";
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return "That host is a local network name, which this tool will not read.";
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || port > 65_535) return "That URL has an invalid port.";
  if (port !== 80 && port !== 443) {
    return "Only standard web ports (80 and 443) can be read.";
  }
  if (net.isIP(host)) {
    return blockedIp(host) ? "That address is inside the private network, which this tool will not read." : null;
  }
  const cached = hostVerdicts.get(host);
  if (cached && Date.now() - cached.at < cached.ttl) return cached.reason;
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    if (hostVerdicts.size >= HOST_CACHE_MAX) hostVerdicts.clear();
    const reason = "That hostname does not resolve.";
    hostVerdicts.set(host, { at: Date.now(), ttl: HOST_FAILURE_TTL_MS, reason });
    return reason;
  }
  let reason = addresses.length ? null : "That hostname does not resolve.";
  if (!reason) {
    for (const { address } of addresses) {
      if (blockedIp(address)) {
        reason = "That hostname resolves to a private-network address, which this tool will not read.";
        break;
      }
    }
  }
  if (hostVerdicts.size >= HOST_CACHE_MAX) hostVerdicts.clear();
  hostVerdicts.set(host, { at: Date.now(), ttl: reason ? HOST_FAILURE_TTL_MS : HOST_VERDICT_TTL_MS, reason });
  return reason;
}

/* ------------------------------------------------------------------ reader call */

/**
 * Reader answers in one of two frontmatter dialects:
 *   ---\ntitle: "…"\nurl: "…"\n---\n<body>            (the x-preset dialects)
 *   Title: …\nURL Source: …\n\nMarkdown Content:\n<body>  (the default dialect)
 * Both carry the same facts; take the metadata out and hand back the body.
 */
function splitReaderResponse(body) {
  const yaml = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (yaml) {
    const field = (key) => {
      const match = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(yaml[1]);
      return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
    };
    return {
      title: field("title"),
      finalUrl: field("url"),
      publishedTime: field("publishedTime") || field("published_date"),
      content: body.slice(yaml[0].length),
    };
  }
  const marker = /^Markdown Content:[ \t]*$/m.exec(body);
  return {
    title: /^Title:[ \t]*(.*\S)[ \t]*$/m.exec(body)?.[1]?.trim() || "",
    finalUrl: /^URL Source:[ \t]*(\S+)/m.exec(body)?.[1]?.trim() || "",
    publishedTime: /^Published Time:[ \t]*(.*\S)[ \t]*$/m.exec(body)?.[1]?.trim() || "",
    content: marker ? body.slice(marker.index + marker[0].length).replace(/^\s*\n/, "") : body,
  };
}

/**
 * Read only as much of the reader's answer as we can return. A 240 KB PDF conversion costs real
 * inflate/parse time, and that time is what pushes us into the Engine's 10 s kill; stopping at the
 * cap keeps the tail of the request off the handler's clock.
 */
async function readCappedBody(response, maxChars, deadlineAt = 0) {
  const stopChars = maxChars + 4_096; // frontmatter and the truncation marker live in the margin
  if (!response.body) return (await response.text()).slice(0, stopChars);
  const decoder = new TextDecoder("utf8");
  let text = "";
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_READER_BYTES) return text;
    text += decoder.decode(chunk, { stream: true });
    if (text.length >= stopChars) break;
    // A setTimeout can be starved by a busy stream, so the loop watches the clock itself.
    if (deadlineAt && Date.now() >= deadlineAt) break;
  }
  return text;
}

/**
 * Ask the reader service for one URL.
 * @returns {Promise<{ok: boolean, error?: string, title?: string, finalUrl?: string, content?: string, truncated?: boolean, ms: number}>}
 */
export async function readUrl(rawUrl, { maxChars = numberSetting("WEBTOOLS_MAX_CHARS", DEFAULT_MAX_CHARS, {
  min: 1_000,
  max: MAX_ALLOWED_CHARS,
}),
  timeoutMs = numberSetting("WEBTOOLS_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, { min: 1_000, max: ENGINE_HANDLER_DEADLINE_MS - 1_500 }) } = {}) {
  const started = Date.now();
  const url = rawUrl.trim();
  const refusal = await refusalFor(url);
  if (refusal) return { ok: false, error: refusal, ms: Date.now() - started };

  const base = setting("WEBTOOLS_READER_BASE", DEFAULT_READER_BASE).replace(/\/+$/, "");
  const apiKey = setting("WEBTOOLS_READER_API_KEY", "");
  // The reader's X-Timeout is how long it waits for a page to settle before answering, so asking
  // for our whole budget makes it spend all of it. Leave a margin for the network and our own abort.
  const readerTimeoutSeconds = Math.max(1, Math.floor(timeoutMs / 1000) - 2);
  const headers = {
    Accept: "text/plain, text/markdown;q=0.9",
    "X-Timeout": String(readerTimeoutSeconds),
  };
  if (base.includes("r.jina.ai")) headers["X-Preset"] = "agent";
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (setting("WEBTOOLS_NO_CACHE", "") === "1") headers["X-No-Cache"] = "true";

  const controller = new AbortController();
  const attempt = async () => {
    const response = await fetch(`${base}/${url}`, { headers, redirect: "manual", signal: controller.signal });
    const declaredBytes = Number(response.headers.get("content-length") || 0);
    if (declaredBytes > MAX_READER_BYTES) {
      return { ok: false, error: "The reader returned an implausibly large response.", ms: Date.now() - started };
    }
    if (response.status >= 300 && response.status < 400) {
      // The reader follows redirects itself, so a redirect that reaches us is a loop or a
      // redirect into something it refused. Report the target instead of chasing it.
      const location = response.headers.get("location") || "";
      return {
        ok: false,
        error: `That URL redirected to ${location || "somewhere the reader would not follow"}. Try the final URL directly.`,
        ms: Date.now() - started,
      };
    }
    if (response.status === 429) {
      return {
        ok: false,
        error: "The reader service is rate limiting us. Set WEBTOOLS_READER_API_KEY for a higher limit, or self-host a reader (see the Web Tools README).",
        ms: Date.now() - started,
      };
    }
    if (response.status === 403) {
      return {
        ok: false,
        error: "The reader refused that URL — it blocks private targets, and some sites block readers.",
        ms: Date.now() - started,
      };
    }
    if (response.status === 404) {
      return { ok: false, error: "That page was not found (404).", ms: Date.now() - started };
    }
    if (!response.ok) {
      return { ok: false, error: `The reader reported HTTP ${response.status}.`, ms: Date.now() - started };
    }
    const body = await readCappedBody(response, maxChars, started + timeoutMs);
    if (Date.now() >= started + timeoutMs) return { __deadline: true };
    if (body.length > MAX_READER_BYTES) {
      return { ok: false, error: "The reader returned an implausibly large response.", ms: Date.now() - started };
    }
    const { title, finalUrl, publishedTime, content } = splitReaderResponse(body);
    const truncated = content.length > maxChars;
    return {
      ok: true,
      title,
      finalUrl: finalUrl || url,
      publishedTime,
      content: truncated ? content.slice(0, maxChars) : content,
      truncated,
      ms: Date.now() - started,
    };
  };

  /* The Engine stops waiting at 10 000 ms and reports a bare "tool failed" when it does. Aborting
   * the socket is not enough on its own: an in-flight response can still land after the abort, as
   * measured here at ~9.4s. So the deadline is a hard race — we answer by timeoutMs, every time,
   * with a message the model can act on. */
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __deadline: true }), timeoutMs);
  });
  try {
    const raced = await Promise.race([attempt(), deadline]);
    if (raced?.__deadline) {
      controller.abort();
      return {
        ok: false,
        error: `Reading that URL took longer than ${Math.round(timeoutMs / 1000)}s and was cancelled. A self-hosted reader (WEBTOOLS_READER_BASE) answers faster than the shared public one.`,
        ms: Date.now() - started,
      };
    }
    return raced;
  } catch (error) {
    return {
      ok: false,
      error: `Could not reach the reader service: ${error?.message || String(error)}`,
      ms: Date.now() - started,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ tool registration */

const TOOL_DESCRIPTION = [
  "Read one public web page and get its text as markdown.",
  "Pass a full https:// URL. Works for articles, docs, forum posts, and PDFs.",
  "Long pages are truncated; the result says when.",
  "Cannot read pages behind a login, and refuses private/network-internal addresses.",
  `Returns at most ${MAX_ALLOWED_CHARS} characters.`,
].join(" ");

const TOOL_PARAMETERS = {
  type: "object",
  properties: {
    url: { type: "string", description: "Absolute http(s) URL of the page to read." },
    max_chars: {
      type: "integer",
      minimum: 1_000,
      maximum: MAX_ALLOWED_CHARS,
      description: "Optional cap on returned characters. Defaults to the configured cap.",
    },
  },
  required: ["url"],
  additionalProperties: false,
};

export async function activate({ api }) {
  return api.registerTool({
    name: "web_fetch",
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    handler: async (args) => {
      const url = typeof args?.url === "string" ? args.url : "";
      if (!url.trim()) return { ok: false, error: "url is required." };
      const requested = Number(args?.max_chars) || 0;
      const maxChars = requested
        ? Math.min(MAX_ALLOWED_CHARS, Math.max(1_000, Math.round(requested)))
        : numberSetting("WEBTOOLS_MAX_CHARS", DEFAULT_MAX_CHARS, { min: 1_000, max: MAX_ALLOWED_CHARS });
      const result = await readUrl(url, { maxChars });
      if (!result.ok) return { ok: false, error: result.error, url };
      return {
        ok: true,
        url: result.finalUrl || url,
        title: result.title || undefined,
        publishedTime: result.publishedTime || undefined,
        content: result.content,
        truncated: result.truncated || undefined,
        chars: result.content.length,
      };
    },
  });
}

/** Cheap config sanity check for the Engine's runtime diagnostics. */
export async function selfCheck() {
  const base = setting("WEBTOOLS_READER_BASE", DEFAULT_READER_BASE);
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: "WEBTOOLS_READER_BASE must be http(s)." };
  } catch {
    return { ok: false, error: "WEBTOOLS_READER_BASE is not a valid URL." };
  }
  const timeoutMs = numberSetting("WEBTOOLS_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, { min: 1_000, max: ENGINE_HANDLER_DEADLINE_MS - 1_500 });
  if (timeoutMs >= ENGINE_HANDLER_DEADLINE_MS - 1_500) return { ok: false, error: "WEBTOOLS_TIMEOUT_MS must stay under the Engine's 10s handler deadline." };
  return { ok: true, readerBase: base, timeoutMs };
}
