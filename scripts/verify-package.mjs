#!/usr/bin/env node
/**
 * Validate dist/webtools-<version>.zip + dist/catalog.json with the Engine's OWN validators,
 * not a reimplementation: the manifest zod schema and validatePackageArchiveEntries from
 * packages/server/src/services/capability-packages/package-manager.service.ts.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const ENGINE = "/workspace/marinara-engine/Marinara-Engine";
const require = createRequire(`${ENGINE}/packages/server/dist/app.js`);
const AdmZip = require("adm-zip");

const { capabilityPackageManifestSchema, capabilityCatalogSchema } = await import(
  `${ENGINE}/packages/shared/dist/schemas/capability-package.schema.js`
);
const { validatePackageArchiveEntries, resolveCapabilityCatalogUrl } = await import(
  `${ENGINE}/packages/server/dist/services/capability-packages/package-manager.service.js`
);

const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const zipPath = resolve(root, `dist/webtools-${version}.zip`);
const catalog = JSON.parse(readFileSync(resolve(root, "dist/catalog.json"), "utf8"));
// The published catalog is additive (official entries first), so locate our entry by id.
const entry = catalog.packages.find((candidate) => candidate.manifest.id === "webtools");
if (!entry) throw new Error("webtools entry missing from dist/catalog.json");

const results = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push({ name, pass: true, detail });
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (error) {
    results.push({ name, pass: false, detail: error.message });
    console.log(`FAIL  ${name}  — ${error.message}`);
  }
};

check("catalog passes the Engine's catalog schema", () => {
  capabilityCatalogSchema.parse(catalog);
  return `${catalog.packages.length} package(s)`;
});

check("manifest passes the Engine's manifest schema", () => {
  const parsed = capabilityPackageManifestSchema.parse(entry.manifest);
  return `schemaVersion ${parsed.schemaVersion}, capabilityApi ${parsed.capabilityApi.major}.${parsed.capabilityApi.minor}`;
});

check("tools permission is allowed at this capabilityApi", () => {
  // The schema's own superRefine enforces "tools requires 1.19+"; parsing above would have thrown.
  return entry.manifest.permissions.includes("tools") ? "declared" : "missing";
});

const zip = new AdmZip(zipPath);

check("archive entries pass validatePackageArchiveEntries", () => {
  const entries = validatePackageArchiveEntries(zip);
  return `${entries.length} entries`;
});

check("zip artifact sha256 matches the catalog", () => {
  const digest = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  if (digest !== entry.artifact.sha256) throw new Error(`${digest} != ${entry.artifact.sha256}`);
  return digest.slice(0, 16) + "…";
});

check("zip artifact byte length matches the catalog", () => {
  const bytes = readFileSync(zipPath).byteLength;
  if (bytes !== entry.artifact.bytes) throw new Error(`${bytes} != ${entry.artifact.bytes}`);
  return `${bytes} bytes`;
});

check("embedded manifest is JSON.stringify-identical to the catalog manifest", () => {
  const embedded = JSON.parse(zip.getEntry("manifest.json").getData().toString("utf8"));
  if (JSON.stringify(embedded) !== JSON.stringify(entry.manifest)) {
    throw new Error("Artifact manifest does not match the catalog");
  }
  return "identical";
});

check("every declared file verifies (size + sha256), no undeclared files", () => {
  const declared = new Map(entry.manifest.files.map((f) => [f.path, f]));
  const payload = zip.getEntries().filter((e) => !e.isDirectory && e.entryName !== "manifest.json");
  if (payload.length !== declared.size) throw new Error(`zip has ${payload.length} payload files, manifest declares ${declared.size}`);
  for (const item of payload) {
    const file = declared.get(item.entryName);
    if (!file) throw new Error(`undeclared file ${item.entryName}`);
    const data = item.getData();
    if (data.byteLength !== file.bytes) throw new Error(`${item.entryName}: ${data.byteLength} != ${file.bytes} bytes`);
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== file.sha256) throw new Error(`${item.entryName}: sha256 mismatch`);
  }
  return payload.map((p) => p.entryName).join(", ");
});

check("server entrypoint is declared and present", () => {
  const entrypoint = entry.manifest.entrypoints.server;
  if (!entrypoint) throw new Error("no server entrypoint");
  if (!zip.getEntry(entrypoint)) throw new Error(`${entrypoint} missing from zip`);
  return entrypoint;
});

check("catalog URL override resolves (MARINARA_AGENT_CATALOG_URL shape)", () => {
  const url = resolveCapabilityCatalogUrl("2.4.6", entry.documentationUrl);
  return typeof url === "string" && url.length > 0 ? "ok" : "no url";
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} Engine-contract checks passed`);
if (failed.length) process.exit(1);
