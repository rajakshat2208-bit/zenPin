#!/usr/bin/env python3
"""
ZenPin — Local Image Indexer
============================
Run this ONCE on your own machine (not on Render).
It scans assets/discovery/, captions every image with BLIP,
generates embeddings with sentence-transformers, and writes search_index.json.

Then commit search_index.json to your repo — the ZenPin backend loads it at startup.

Setup (run once):
  pip install torch torchvision transformers sentence-transformers Pillow

Usage:
  python index_images.py
  python index_images.py --assets path/to/assets/discovery
  python index_images.py --limit 50   # cap per category during testing
"""

import os, json, sys, argparse, hashlib, re
from pathlib import Path

# ── CLI args ──────────────────────────────────────────────────
parser = argparse.ArgumentParser(description="ZenPin image indexer")
parser.add_argument("--assets", default="assets/discovery",
                    help="Path to discovery folder (default: assets/discovery)")
parser.add_argument("--out",    default="search_index.json",
                    help="Output path (default: search_index.json)")
parser.add_argument("--limit",  type=int, default=0,
                    help="Max images per category (0 = no limit)")
parser.add_argument("--skip-captions", action="store_true",
                    help="Skip BLIP, use filename-based captions only (faster)")
args = parser.parse_args()

ASSETS_DIR = Path(args.assets)
OUT_FILE   = Path(args.out)
FORMATS    = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}

if not ASSETS_DIR.exists():
    print(f"❌ Assets folder not found: {ASSETS_DIR}")
    sys.exit(1)

# ── Load models ───────────────────────────────────────────────
print("⏳ Loading models…")

from sentence_transformers import SentenceTransformer
embed_model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
print("  ✅ Embeddings: all-MiniLM-L6-v2")

blip_processor = blip_model = None
if not args.skip_captions:
    try:
        from transformers import BlipProcessor, BlipForConditionalGeneration
        import torch
        blip_processor = BlipProcessor.from_pretrained("Salesforce/blip-image-captioning-base")
        blip_model     = BlipForConditionalGeneration.from_pretrained("Salesforce/blip-image-captioning-base")
        blip_model.eval()
        print("  ✅ Captions:   BLIP-base")
    except Exception as e:
        print(f"  ⚠️  BLIP unavailable ({e}) — using filename captions")

# ── Helpers ───────────────────────────────────────────────────
FOLDER_TO_CAT = {
    "cars": "Cars", "bikes": "Bikes", "anime": "Anime",
    "gaming": "Gaming", "scenery": "Scenery", "fashion": "Fashion",
    "accessories": "Ladies Accessories", "workspace": "Workspace",
    "food": "Food", "drinks": "Drinks", "aesthetic": "Art",
    "interior": "Interior Design", "interior_design": "Interior Design",
    "nature": "Nature", "art": "Art", "tech": "Tech",
    "travel": "Travel", "fitness": "Fitness", "flowers": "Flowers",
    "plants": "Plants", "music": "Music", "pets": "Pets",
    "tattoos": "Tattoos", "superheroes": "Superheroes",
    "architecture": "Architecture", "cigarettes": "Cigarettes",
}

def filename_caption(stem: str, category: str) -> str:
    """Generate a human-readable caption from filename + category."""
    # car1 → "car 1", anime_wallpaper_02 → "anime wallpaper 02"
    clean = re.sub(r"[_\-]+", " ", stem)          # underscores → spaces
    clean = re.sub(r"(\D)(\d)", r"\1 \2", clean)  # car1 → car 1
    clean = re.sub(r"\s+", " ", clean).strip()
    return f"{category} — {clean}"

def blip_caption(img_path: Path) -> str:
    """Generate BLIP caption for an image."""
    try:
        from PIL import Image
        import torch
        img  = Image.open(img_path).convert("RGB")
        # Resize to 384px max for speed
        img.thumbnail((384, 384))
        inputs = blip_processor(img, return_tensors="pt")
        with torch.no_grad():
            out = blip_model.generate(**inputs, max_new_tokens=40)
        return blip_processor.decode(out[0], skip_special_tokens=True)
    except Exception as e:
        return ""

def image_uid(path: Path) -> str:
    """Stable ID based on path — survives renames of unrelated files."""
    return hashlib.md5(str(path).encode()).hexdigest()[:12]

# ── Main indexing loop ────────────────────────────────────────
records = []
categories = sorted(ASSETS_DIR.iterdir())

for cat_dir in categories:
    if not cat_dir.is_dir(): continue
    cat_name = FOLDER_TO_CAT.get(cat_dir.name.lower(), cat_dir.name.title())
    images   = sorted(f for f in cat_dir.iterdir() if f.suffix.lower() in FORMATS)
    if args.limit: images = images[:args.limit]
    if not images: continue

    print(f"\n📁 {cat_dir.name} ({len(images)} images)")

    for i, img_path in enumerate(images):
        # Caption
        if blip_model:
            caption = blip_caption(img_path)
            if not caption:
                caption = filename_caption(img_path.stem, cat_name)
        else:
            caption = filename_caption(img_path.stem, cat_name)

        # Embedding text = caption + category keywords
        embed_text = f"{caption} {cat_name} aesthetic photography"

        # Embedding vector
        vector = embed_model.encode(embed_text, normalize_embeddings=True).tolist()

        records.append({
            "id":         image_uid(img_path),
            "url":        str(img_path).replace("\\", "/"),  # forward slashes for web
            "category":   cat_name,
            "caption":    caption,
            "embed_text": embed_text,
            "vector":     vector,
        })

        # Progress
        if (i + 1) % 10 == 0 or (i + 1) == len(images):
            print(f"  {i+1}/{len(images)}  {img_path.name}  → \"{caption[:60]}\"")

# ── Write output ──────────────────────────────────────────────
output = {
    "_info": {
        "total":      len(records),
        "categories": len(set(r["category"] for r in records)),
        "model":      "all-MiniLM-L6-v2",
        "dim":        len(records[0]["vector"]) if records else 0,
    },
    "records": records,
}

OUT_FILE.write_text(json.dumps(output, separators=(",", ":")))
print(f"\n✅ Indexed {len(records)} images → {OUT_FILE}")
print(f"   Commit search_index.json to your repo and push to GitHub Pages + Render.")
