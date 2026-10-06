#!/usr/bin/env node
/**
 * set-tts — point Marinara Engine's Text to Speech at a VoxCPM2 (OpenAI-compatible)
 * server through the Engine's own API, then prove the connection works.
 *
 * Why the API and not the data files: TTS settings live in the Engine's app_settings
 * table, which the running server holds in memory and rewrites on every change. Editing
 * that file under a live server races it. PUT /api/tts/config is the Engine's own
 * validated write path, and loopback requests are exempt from Basic Auth
 * (middleware/basic-auth.ts:323) and from CSRF (middleware/csrf-protection.ts:113),
 * so this runs from inside the Engine container with no credentials.
 *
 * The config is read first and merged, never replaced wholesale: GET /api/tts/config
 * returns the stored config with provider keys masked, and sending that mask back keeps
 * the stored key (routes/tts.routes.ts:1349). Narrator, dialogue, voice-assignment and
 * per-source profile settings therefore survive untouched.
 *
 * Usage:
 *   node set-tts.mjs                      # configure + verify (defaults below)
 *   node set-tts.mjs --show               # show current TTS settings, change nothing
 *   node set-tts.mjs --voices             # list voices the configured provider offers
 *   node set-tts.mjs --speak "Hello."     # synthesize a line, report the audio
 *   node set-tts.mjs --dry-run            # show the intended change, write nothing
 *   node set-tts.mjs --selftest           # run against a built-in mock Engine
 *
 * No dependencies; Node 18+ (global fetch).
 */

import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const DEFAULTS = {
  engine: "http://127.0.0.1:7860",
  baseUrl: "http://host.docker.internal:3042/v1",
  model: "voxcpm",
  voice: "tomori",
  format: "wav",
  source: "openai",
};

const FIELDS = ["enabled", "source", "baseUrl", "model", "voice", "audioFormat", "speed"];

function parseArgs(argv) {
  const opts = { ...DEFAULTS, mode: "configure", out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--engine": opts.engine = next().replace(/\/+$/, ""); break;
      case "--base-url": opts.baseUrl = next(); break;
      case "--model": opts.model = next(); break;
      case "--voice": opts.voice = next(); break;
      case "--format": opts.format = next(); break;
      case "--source": opts.source = next(); break;
      case "--out": opts.out = next(); break;
      case "--show": opts.mode = "show"; break;
      case "--voices": opts.mode = "voices"; break;
      case "--speak": opts.mode = "speak"; opts.text = next(); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--no-verify": opts.noVerify = true; break;
      case "--selftest": opts.mode = "selftest"; break;
      case "--help": case "-h": opts.mode = "help"; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!["wav", "pcm"].includes(opts.format)) {
    throw new Error(
      `--format must be wav or pcm: VoxCPM2's /v1/audio/speech rejects anything else (server.py:674).`,
    );
  }
  return opts;
}

async function request(engine, path, { method = "GET", body, timeoutMs = 60_000 } = {}) {
  let response;
  try {
    response = await fetch(`${engine}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error?.name === "TimeoutError" ? "timed out" : error?.cause?.code || error?.message;
    throw new Error(`${method} ${engine}${path} failed (${reason}). Is the Engine running there?`);
  }
  return response;
}

async function getConfig(engine) {
  const response = await request(engine, "/api/tts/config");
  if (!response.ok) {
    throw new Error(
      `GET /api/tts/config → ${response.status}. ` +
        (response.status === 401 || response.status === 403
          ? "Run this from inside the Engine container (loopback is exempt from auth)."
          : await response.text()),
    );
  }
  return response.json();
}

/** Merge only the provider fields; everything else in the stored config is passed through. */
function buildNextConfig(current, opts) {
  return {
    ...current,
    enabled: true,
    source: opts.source,
    baseUrl: opts.baseUrl,
    model: opts.model,
    voice: opts.voice,
    audioFormat: opts.format,
  };
}

function summarize(config) {
  return FIELDS.map((field) => `${field}=${describe(config[field])}`).join("  ");
}

function describe(value) {
  if (value === undefined) return "(unset)";
  if (value === null) return "(null)";
  if (typeof value === "string") return value === "" ? "(empty)" : value;
  return String(value);
}

function printVoices(payload) {
  const voices = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.voices)
      ? payload.voices
      : Array.isArray(payload?.data)
        ? payload.data
        : [];
  const names = voices.map((v) => (typeof v === "string" ? v : v?.id ?? v?.name ?? "?"));
  console.log(names.length ? `Voices: ${names.join(", ")}` : "Voices: (none returned)");
  return names;
}

async function verifyVoices(engine) {
  const response = await request(engine, "/api/tts/voices", { timeoutMs: 30_000 });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Voice discovery failed (${response.status}): ${detail.slice(0, 300)}\n` +
        `If the message mentions local/private addresses, the Engine needs TTS_LOCAL_URLS_ENABLED=true ` +
        `in the container's environment, then a restart.`,
    );
  }
  return printVoices(await response.json());
}

async function speak(engine, text, voice) {
  const response = await request(engine, "/api/tts/speak", {
    method: "POST",
    body: { text, ...(voice ? { voice } : {}) },
    timeoutMs: 180_000,
  });
  if (!response.ok) {
    throw new Error(`POST /api/tts/speak → ${response.status}: ${(await response.text()).slice(0, 400)}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const type = response.headers.get("content-type") ?? "?";
  if (!bytes.length) throw new Error("The Engine returned audio with no bytes.");
  return { bytes, type };
}

async function run(opts) {
  const current = await getConfig(opts.engine);
  console.log(`Current:  ${summarize(current)}`);

  if (opts.mode === "show") return;

  if (opts.mode === "voices") {
    await verifyVoices(opts.engine);
    return;
  }

  if (opts.mode === "speak") {
    const { bytes, type } = await speak(opts.engine, opts.text, opts.voice);
    console.log(`Audio:    ${bytes.length} bytes, ${type}`);
    if (opts.out) {
      writeFileSync(opts.out, bytes);
      console.log(`Wrote:    ${opts.out}`);
    }
    return;
  }

  const next = buildNextConfig(current, opts);
  const changed = FIELDS.filter((field) => JSON.stringify(current[field]) !== JSON.stringify(next[field]));
  console.log(`Planned:  ${summarize(next)}`);
  if (!changed.length) {
    console.log("Nothing to change — the Engine already points where you asked.");
  }
  if (opts.dryRun) {
    console.log("Dry run: nothing written.");
    return;
  }

  const response = await request(opts.engine, "/api/tts/config", { method: "PUT", body: next });
  if (response.status !== 204) {
    throw new Error(`PUT /api/tts/config → ${response.status}: ${(await response.text()).slice(0, 400)}`);
  }
  console.log(`Saved:    ${changed.length ? changed.join(", ") : "no fields changed"}`);

  const after = await getConfig(opts.engine);
  console.log(`Verified: ${summarize(after)}`);

  if (opts.noVerify) return;

  const names = await verifyVoices(opts.engine);
  if (names.length && !names.includes(opts.voice)) {
    console.log(`Note: "${opts.voice}" is not in that list; pick a voice the server actually offers.`);
  }

  const { bytes, type } = await speak(opts.engine, "Marinara connection test.", opts.voice);
  console.log(`Speech:   ${bytes.length} bytes, ${type}`);
  if (opts.out) {
    writeFileSync(opts.out, bytes);
    console.log(`Wrote:    ${opts.out}`);
  }
  console.log("The Engine can speak through this connection.");
}

/* ------------------------------ mock selftest ------------------------------ */

async function selftest() {
  const { createServer } = await import("node:http");
  let stored = {
    enabled: false,
    source: "elevenlabs",
    baseUrl: "https://api.elevenlabs.io/v1",
    model: "eleven_multilingual_v2",
    apiKey: "SECRET-DO-NOT-LEAK",
    voice: "old-voice",
    voiceMode: "per-character",
    voiceAssignments: { "char-1": { characterName: "Aria", voice: "old-voice" } },
    narrator: { enabled: true, voice: "narrator-voice", style: "calm" },
    dialogue: { enabled: true, minLines: 2 },
    speed: 1,
    audioFormat: "mp3",
  };
  const puts = [];
  const server = createServer(async (req, res) => {
    const url = req.url;
    if (url === "/api/tts/config" && req.method === "GET") {
      const masked = { ...stored, apiKey: stored.apiKey ? "__MASK__" : "" };
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(masked));
    }
    if (url === "/api/tts/config" && req.method === "PUT") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      puts.push(body);
      // Mirrors the Engine: a mask keeps the stored key.
      stored = { ...body, apiKey: body.apiKey === "__MASK__" ? stored.apiKey : body.apiKey };
      res.writeHead(204);
      return res.end();
    }
    if (url === "/api/tts/voices") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: ["aphel", "lilya", "nerine", "rina", "temari", "tomori", "tony"].map((id) => ({ id })) }));
    }
    if (url === "/api/tts/speak" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (stored.audioFormat === "mp3") {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "'response_format' must be one of: 'wav', 'pcm'" }));
      }
      if (body.voice && !["aphel", "lilya", "nerine", "rina", "temari", "tomori", "tony"].includes(body.voice)) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: `Unknown voice: ${body.voice}` }));
      }
      const wav = Buffer.alloc(1024, 0x5a);
      res.writeHead(200, { "content-type": "audio/wav" });
      return res.end(wav);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const engine = `http://127.0.0.1:${server.address().port}`;

  let failures = 0;
  const check = (name, condition, detail = "") => {
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
    if (!condition) failures++;
  };

  // 1. Dry run writes nothing and preserves the stored key.
  await run({ ...DEFAULTS, engine, mode: "configure", dryRun: true });
  check("dry run performs no PUT", puts.length === 0);

  // 2. Configure: provider fields change, unrelated settings survive, key is preserved.
  await run({ ...DEFAULTS, engine, mode: "configure" });
  const after = await getConfig(engine);
  check("source switched to openai", after.source === "openai");
  // GET always masks provider keys, so the stored plaintext is checked server-side.
  check("stored API key preserved through the mask", stored.apiKey === "SECRET-DO-NOT-LEAK");
  check("base URL points at VoxCPM2", after.baseUrl === DEFAULTS.baseUrl);
  check("model is voxcpm", after.model === "voxcpm");
  check("format is wav, not mp3", after.audioFormat === "wav");
  check("enabled", after.enabled === true);
  check("GET masks the key rather than leaking it", after.apiKey === "__MASK__");
  check("voice assignments preserved", JSON.stringify(after.voiceAssignments)?.includes("Aria"));
  check("narrator settings preserved", after.narrator?.voice === "narrator-voice");
  check("voice mode preserved", after.voiceMode === "per-character");
  check("one PUT was sent", puts.length === 1);
  check("PUT carries the mask, never the stored key", puts[0]?.apiKey === "__MASK__");

  // 3. Idempotent re-run.
  const before = puts.length;
  await run({ ...DEFAULTS, engine, mode: "configure" });
  check("re-run reports nothing to change", puts.length === before + 1);

  // 4. Read-only modes.
  await run({ ...DEFAULTS, engine, mode: "voices" });
  await run({ ...DEFAULTS, engine, mode: "show" });
  await run({ ...DEFAULTS, engine, mode: "speak", text: "Hi.", voice: "tomori", out: null });

  // 5. A bad voice surfaces the server's own error.
  let spoke = true;
  try {
    await speak(engine, "Hi.", "not-a-voice");
    spoke = false;
  } catch { /* expected */ }
  check("unknown voice is reported, not swallowed", spoke);

  // 6. mp3 is refused before anything is sent.
  let refused = false;
  try {
    parseArgs(["--format", "mp3"]);
  } catch (error) {
    refused = /wav or pcm/.test(String(error?.message));
  }
  check("mp3 is refused up front", refused);

  // 7. An unreachable Engine explains itself.
  let deadMessage = "";
  try {
    await getConfig("http://127.0.0.1:1");
  } catch (error) {
    deadMessage = String(error?.message);
  }
  check("unreachable Engine reports a helpful message", /Is the Engine running there\?/.test(deadMessage));

  server.close();
  console.log(failures ? `\n${failures} selftest check(s) failed.` : "\nAll selftest checks passed.");
  return failures;
}

const HELP = `set-tts — point Marinara Engine's Text to Speech at a VoxCPM2 server

  node set-tts.mjs [--engine http://127.0.0.1:7860]
      [--base-url http://host.docker.internal:3042/v1] [--model voxcpm]
      [--voice tomori] [--format wav|pcm] [--dry-run] [--no-verify]
  node set-tts.mjs --show | --voices | --speak "text" [--out line.wav]
  node set-tts.mjs --selftest

On Unraid, run it inside the Engine container:
  docker exec marinara node /tmp/set-tts.mjs --base-url http://host.docker.internal:3042/v1`;

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.mode === "help") return console.log(HELP);
    if (opts.mode === "selftest") process.exitCode = await selftest();
    else await run(opts);
  } catch (error) {
    console.error(`Error: ${error?.message ?? error}`);
    process.exit(1);
  }
}

// Runs when invoked directly (file path, `node -`, or a piped stdin script).
const invoked = process.argv[1];
const isMain =
  !invoked || invoked === "-" || invoked === "/dev/stdin" || import.meta.url === pathToFileURL(invoked).href;
if (isMain) {
  await main();
}

export { buildNextConfig, parseArgs, summarize };
