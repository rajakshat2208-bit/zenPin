#!/usr/bin/env node
/**
 * ZenPin — Auto Image Manifest Generator
 * ========================================
 * Scans assets/discovery/ and writes CURATED_IMAGES directly into script.js.
 * Run this from the ROOT of your repo (where index.html lives) after adding images.
 *
 * Usage:
 *   node generate-manifest.js
 *
 * What it does:
 *   1. Scans every subfolder in assets/discovery/
 *   2. Finds all .jpg .jpeg .png .webp files
 *   3. Updates the CURATED_IMAGES block in script.js automatically
 *   4. You never need to type paths manually again
 */

const fs   = require("fs");
const path = require("path");

const ASSETS_DIR  = path.join(__dirname, "assets", "discovery");
const SCRIPT_FILE = path.join(__dirname, "script.js");
const FORMATS     = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);

// Folder name  →  ZenPin category key (must match CAT_CONFIG keys in script.js)
const FOLDER_TO_KEY = {
  "cars":          "cars",
  "bikes":         "bikes",
  "anime":         "anime",
  "gaming":        "gaming",
  "scenery":       "scenery",
  "superhero":     "superheroes",   // folder = superhero, key = superheroes
  "superheroes":   "superheroes",
  "workspace":     "workspace",
  "fashion":       "fashion",
  "food":          "food",
  "pets":          "pets",
  "nature":        "nature",
  "travel":        "travel",
  "tech":          "tech",
  "art":           "art",
  "architecture":  "architecture",
  "flowers":       "flowers",
  "plants":        "plants",
  "fitness":       "fitness",
  "music":         "music",
  "tattoos":       "tattoos",
  "drinks":        "drinks",
  "accessories":   "ladies accessories",
  "interior":      "interior design",
  "interior_design": "interior design",
  "cigarettes":    "cigarettes",
};

// ── Scan folders ──────────────────────────────────────────────
if (!fs.existsSync(ASSETS_DIR)) {
  console.error(`❌ Folder not found: ${ASSETS_DIR}`);
  console.error("   Make sure you run this from the root of your repo.");
  process.exit(1);
}

const result = {};
let totalImages = 0;

const folders = fs.readdirSync(ASSETS_DIR)
  .filter(name => fs.statSync(path.join(ASSETS_DIR, name)).isDirectory())
  .sort();

for (const folder of folders) {
  const catKey = FOLDER_TO_KEY[folder.toLowerCase()] || folder.toLowerCase();
  const files  = fs.readdirSync(path.join(ASSETS_DIR, folder))
    .filter(f => FORMATS.has(path.extname(f).toLowerCase()))
    .sort((a, b) => {
      // Natural sort: car2.jpg before car10.jpg
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    })
    .map(f => `assets/discovery/${folder}/${f}`);

  if (files.length === 0) continue;
  result[catKey] = files;
  totalImages += files.length;
  console.log(`  📁 ${folder.padEnd(18)} → "${catKey}"  (${files.length} images)`);
}

// ── Build CURATED_IMAGES block ────────────────────────────────
const entries = Object.entries(result).map(([key, paths]) => {
  const lines = paths.map(p => `    "${p}",`).join("\n");
  return `  "${key}": [\n${lines}\n  ]`;
}).join(",\n\n");

const newBlock = `const CURATED_IMAGES = {\n${entries},\n}`;

// ── Patch script.js ───────────────────────────────────────────
if (!fs.existsSync(SCRIPT_FILE)) {
  console.error(`❌ script.js not found at: ${SCRIPT_FILE}`);
  process.exit(1);
}

let scriptSrc = fs.readFileSync(SCRIPT_FILE, "utf8");

const startMarker = "const CURATED_IMAGES = {";
const startIdx = scriptSrc.indexOf(startMarker);
if (startIdx === -1) {
  console.error("❌ Could not find CURATED_IMAGES in script.js");
  process.exit(1);
}

// Find matching closing brace
let depth = 0, endIdx = startIdx;
for (let i = startIdx; i < scriptSrc.length; i++) {
  if (scriptSrc[i] === "{") depth++;
  else if (scriptSrc[i] === "}") { depth--; if (depth === 0) { endIdx = i + 1; break; } }
}

scriptSrc = scriptSrc.slice(0, startIdx) + newBlock + scriptSrc.slice(endIdx);
fs.writeFileSync(SCRIPT_FILE, scriptSrc, "utf8");

console.log(`\n✅ script.js updated — ${totalImages} images across ${Object.keys(result).length} categories`);
console.log("   Commit and push to GitHub to go live.\n");
