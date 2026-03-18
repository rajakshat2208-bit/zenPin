#!/usr/bin/env node
/**
 * ZenPin — Curated Image Manifest Generator
 * 
 * Run this script after adding images to assets/discovery/:
 *   node generate-manifest.js
 * 
 * It scans every subfolder and writes images.json.
 * The frontend reads images.json at startup to load curated images instantly.
 * 
 * Supported formats: .jpg .jpeg .png .webp .gif .avif
 */

const fs   = require("fs");
const path = require("path");

const ASSETS_DIR = path.join(__dirname, "assets", "discovery");
const OUT_FILE   = path.join(__dirname, "images.json");
const FORMATS    = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);

// Category folder → ZenPin category name mapping
const FOLDER_TO_CAT = {
  "cars":          "Cars",
  "bikes":         "Bikes",
  "anime":         "Anime",
  "gaming":        "Gaming",
  "scenery":       "Scenery",
  "fashion":       "Fashion",
  "accessories":   "Ladies Accessories",
  "workspace":     "Workspace",
  "food":          "Food",
  "drinks":        "Drinks",
  "aesthetic":     "Art",
  "interior":      "Interior Design",
  "interior_design": "Interior Design",
  "nature":        "Nature",
  "art":           "Art",
  "tech":          "Tech",
  "travel":        "Travel",
  "fitness":       "Fitness",
  "flowers":       "Flowers",
  "plants":        "Plants",
  "music":         "Music",
  "pets":          "Pets",
  "tattoos":       "Tattoos",
  "superheroes":   "Superheroes",
  "architecture":  "Architecture",
  "cigarettes":    "Cigarettes",
};

if (!fs.existsSync(ASSETS_DIR)) {
  console.log(`Creating folder: ${ASSETS_DIR}`);
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  // Create all subfolders
  Object.keys(FOLDER_TO_CAT).forEach(f =>
    fs.mkdirSync(path.join(ASSETS_DIR, f), { recursive: true })
  );
  console.log("✅ Created assets/discovery/ with all category subfolders.");
  console.log("   Add your images and run this script again.");
}

const manifest = {
  _readme:  "Run generate-manifest.js to rebuild after adding images.",
  _version: Date.now(),
  _total:   0,
};

let totalImages = 0;

const folders = fs.readdirSync(ASSETS_DIR).filter(name => {
  const full = path.join(ASSETS_DIR, name);
  return fs.statSync(full).isDirectory();
});

folders.forEach(folder => {
  const folderPath = path.join(ASSETS_DIR, folder);
  const files = fs.readdirSync(folderPath)
    .filter(f => FORMATS.has(path.extname(f).toLowerCase()))
    .sort()
    .map(f => `assets/discovery/${folder}/${f}`);

  if (files.length > 0) {
    manifest[folder] = files;
    totalImages += files.length;
    console.log(`  ${folder.padEnd(20)} ${files.length} images`);
  } else {
    manifest[folder] = [];
  }
});

manifest._total = totalImages;

fs.writeFileSync(OUT_FILE, JSON.stringify(manifest, null, 2));
console.log(`\n✅ images.json written — ${totalImages} total images across ${folders.length} categories`);
