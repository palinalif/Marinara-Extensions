#!/usr/bin/env node
/**
 * Build + publish artifacts for the Web Tools capability package.
 *
 * Produces, under dist/:
 *   webtools-<version>.zip   flat zip: manifest.json + server.mjs (Engine validates every hash)
 *   catalog.json             the capability catalog the Engine reads (MARINARA_AGENT_CATALOG_URL)
 *
 * The Engine refuses an artifact whose embedded manifest is not JSON.stringify-identical to the
 * catalog entry (package-manager.service.ts, "Artifact manifest does not match the catalog"),
 * so both are serialised from the same object here and never hand-written.
 *
 * Usage: node scripts/build.mjs [--base-url <raw base for artifact hosting>]
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "packages/webtools");
const distDir = join(root, "dist");

const args = process.argv.slice(2);
const baseUrlFlag = args.indexOf("--base-url");
const ARTIFACT_BASE =
  baseUrlFlag >= 0 && args[baseUrlFlag + 1]
    ? args[baseUrlFlag + 1].replace(/\/+$/, "")
    : "https://raw.githubusercontent.com/palinalif/Marinara-Extensions/main/dist";

const ID = "webtools";
const VERSION = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const ENGINE_VERSION = "2.4.6";
const ENGINE_COMMIT = "974faebb683842f5a31be34cee65394d9a47c336";

const serverSource = readFileSync(join(pkgDir, "server.mjs"));
const files = [
  {
    path: "server.mjs",
    sha256: createHash("sha256").update(serverSource).digest("hex"),
    bytes: serverSource.byteLength,
  },
];

const manifest = {
  schemaVersion: 2,
  capabilityApi: { major: 1, minor: 19 },
  builtAgainst: { engineVersion: ENGINE_VERSION, engineCommit: ENGINE_COMMIT },
  id: ID,
  name: "Web Tools",
  version: VERSION,
  description:
    "Gives your agents a web_fetch tool: hand it a public https URL and it returns the page as readable markdown — articles, docs, forum posts, PDFs. Reads through a Reader service (https://r.jina.ai by default, or a self-hosted reader you point at with WEBTOOLS_READER_BASE), so JavaScript-rendered pages and PDFs come back as text. Long pages are truncated, logins are out of reach, and private/network-internal addresses are refused.",
  engine: { min: "2.4.6", maxExclusive: "4.0.0" },
  kind: ["agent"],
  entrypoints: { server: "server.mjs" },
  files,
  permissions: ["tools"],
  restartRequired: false,
};

const manifestJson = JSON.stringify(manifest, null, 2);
const artifactName = `${ID}-${VERSION}.zip`;
const artifactPath = join(distDir, artifactName);

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, "manifest.json"), manifestJson);

// AdmZip (the Engine's reader) accepts store/deflate; python's zipfile gives us both portably.
execFileSync("python3", [
  "-c",
  `import zipfile, sys
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    z.write(sys.argv[2], "manifest.json")
    z.write(sys.argv[3], "server.mjs")`,
  artifactPath,
  join(distDir, "manifest.json"),
  join(pkgDir, "server.mjs"),
]);

const artifactBytes = readFileSync(artifactPath);
const ourEntry = {
  manifest,
  category: "misc",
  artifact: {
    url: `${ARTIFACT_BASE}/${artifactName}`,
    sha256: createHash("sha256").update(artifactBytes).digest("hex"),
    bytes: artifactBytes.byteLength,
  },
  documentationUrl: "https://github.com/palinalif/Marinara-Extensions/tree/main/packages/webtools",
};

// The Engine treats MARINARA_AGENT_CATALOG_URL as the WHOLE catalog
// (package-manager.service.ts: "An explicit override IS the whole catalog"), so pointing it
// here must not cost the official package list. We publish an ADDITIVE catalog: the official
// entries verbatim, plus ours. Re-running this build re-syncs official updates.
const OFFICIAL_CATALOG =
  process.env.OFFICIAL_CATALOG_URL ?? "https://raw.githubusercontent.com/Pasta-Devs/Marinara-Agents/main/catalog/catalog.json";
const OFFICIAL_CATALOG_LOCAL = join(distDir, "official-catalog.json");

let officialPackages = [];
try {
  const response = await fetch(OFFICIAL_CATALOG, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  officialPackages = (await response.json()).packages;
  writeFileSync(OFFICIAL_CATALOG_LOCAL, JSON.stringify({ packages: officialPackages }, null, 2));
} catch (error) {
  // Offline build: reuse the last official snapshot so the published catalog never loses
  // official entries. Losing them is the failure mode this merge exists to prevent.
  const fallback = readFileSync(OFFICIAL_CATALOG_LOCAL, "utf8");
  officialPackages = JSON.parse(fallback).packages;
  console.log(`official catalog fetch failed (${error.message}); reusing the committed snapshot`);
}

const merged = [...officialPackages, ourEntry].filter(
  (entry, index, all) => all.findIndex((other) => other.manifest.id === entry.manifest.id) === index,
);

const catalog = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  packages: merged,
  provenance: { kind: "custom", url: "https://github.com/palinalif/Marinara-Extensions" },
};

writeFileSync(join(distDir, "catalog.json"), JSON.stringify(catalog, null, 2));

console.log(`built  ${artifactName}  ${artifactBytes.byteLength} bytes`);
console.log(`server.mjs sha256 ${files[0].sha256} (${files[0].bytes} bytes)`);
console.log(`artifact sha256 ${catalog.packages[0].artifact.sha256}`);
console.log(`catalog  ${join(distDir, "catalog.json")}  (${merged.length} packages: ${officialPackages.length} official + 1 ours)`);
console.log(`artifact url ${catalog.packages[0].artifact.url}`);
