#!/usr/bin/env python3
"""
ZenPin — Image Search Index Builder
====================================
Scans assets/discovery/ and builds search_index.json for FAISS vector search.

Usage:
    python index_images.py           # Uses Gemini embeddings (API quota used)
    python index_images.py --no-ml   # Uses keyword/filename-based pseudo-embeddings (free)

Output: search_index.json in the same directory (commit this to your backend repo).

Memory: ~4 MB for 603 images at 768 dims.
"""

import os
import sys
import json
import math
import hashlib
import argparse

# ── Category metadata ──────────────────────────────────────────────────────────
CATEGORIES = {
    "cars":         {"display": "Cars",               "prefix": "car",          "count": 30},
    "Bikes":        {"display": "Bikes",              "prefix": "bike",         "count": 30},
    "anime":        {"display": "Anime",              "prefix": "anime",        "count": 30},
    "gaming":       {"display": "Gaming",             "prefix": "gaming",       "count": 28},
    "scenery":      {"display": "Scenery",            "prefix": "scenery",      "count": 30},
    "superhero":    {"display": "Superheroes",        "prefix": "superhero",    "count": 25},
    "workspace":    {"display": "Workspace",          "prefix": "workspace",    "count": 25},
    "fashion":      {"display": "Fashion",            "prefix": "fashion",      "count": 25},
    "food":         {"display": "Food",               "prefix": "food",         "count": 25},
    "pets":         {"display": "Pets",               "prefix": "pet",          "count": 25},
    "nature":       {"display": "Nature",             "prefix": "nature",       "count": 25},
    "architecture": {"display": "Architecture",       "prefix": "architecture", "count": 25},
    "accessories":  {"display": "Ladies Accessories", "prefix": "accessory",    "count": 30},
    "art":          {"display": "Art",                "prefix": "art",          "count": 30},
    "interior":     {"display": "Interior Design",    "prefix": "interior",     "count": 25},
    "travel":       {"display": "Travel",             "prefix": "travel",       "count": 25},
    "tech":         {"display": "Tech",               "prefix": "tech",         "count": 25},
    "flowers":      {"display": "Flowers",            "prefix": "flower",       "count": 25},
    "plants":       {"display": "Plants",             "prefix": "plant",        "count": 25},
    "fitness":      {"display": "Fitness",            "prefix": "fitness",      "count": 25},
    "music":        {"display": "Music",              "prefix": "music",        "count": 25},
    "tattoos":      {"display": "Tattoos",            "prefix": "tattoo",       "count": 25},
    "drinks":       {"display": "Drinks",             "prefix": "drink",        "count": 25},
}

GITHUB_PAGES_BASE = "https://rajakshat2208-bit.github.io/ZenPin"
DIMS = 768  # Gemini text-embedding-004 dimensions


def keyword_vector(category: str, filename: str, dims: int = DIMS) -> list:
    """
    Create a deterministic pseudo-embedding from category + filename.
    Not semantically meaningful but consistent — good enough for category routing.
    Used when Gemini API is not available.
    """
    seed = f"{category}:{filename}"
    h = hashlib.sha256(seed.encode()).digest()
    # Expand hash to 'dims' floats by cycling
    floats = []
    while len(floats) < dims:
        for byte in h:
            floats.append((byte / 127.5) - 1.0)  # normalize to [-1, 1]
    floats = floats[:dims]
    # L2 normalize
    mag = math.sqrt(sum(x * x for x in floats)) or 1.0
    return [x / mag for x in floats]


def gemini_vector(text: str, api_key: str) -> list:
    """Get a real semantic embedding from Gemini."""
    import google.generativeai as genai
    genai.configure(api_key=api_key)
    result = genai.embed_content(
        model="models/text-embedding-004",
        content=text,
        task_type="retrieval_document",
    )
    return result["embedding"]


def build_index(use_gemini: bool = False) -> list:
    api_key = os.getenv("GEMINI_API_KEY", "") if use_gemini else ""
    if use_gemini and not api_key:
        print("⚠  GEMINI_API_KEY not set — falling back to keyword vectors")
        use_gemini = False

    entries = []
    total = sum(info["count"] for info in CATEGORIES.values())
    done = 0

    for folder, info in CATEGORIES.items():
        display  = info["display"]
        prefix   = info["prefix"]
        count    = info["count"]

        for i in range(1, count + 1):
            filename = f"{prefix}{i}.jpg"
            url      = f"assets/discovery/{folder}/{filename}"
            caption  = f"{display} — {filename.replace('.jpg','').replace(prefix,'image ')}"

            if use_gemini:
                try:
                    vec = gemini_vector(f"{display}: {caption}", api_key)
                except Exception as e:
                    print(f"  Gemini embed failed for {url}: {e} — using keyword vector")
                    vec = keyword_vector(folder, filename)
            else:
                vec = keyword_vector(folder, filename)

            entries.append({
                "url":      url,
                "caption":  caption,
                "category": folder,
                "display":  display,
                "vector":   vec,
            })
            done += 1
            if done % 50 == 0:
                print(f"  {done}/{total} indexed…")

    return entries


def main():
    parser = argparse.ArgumentParser(description="Build ZenPin search index")
    parser.add_argument("--no-ml",  action="store_true", help="Use keyword vectors (no API)")
    parser.add_argument("--gemini", action="store_true", help="Use Gemini embeddings")
    parser.add_argument("--out",    default="search_index.json", help="Output file")
    args = parser.parse_args()

    use_gemini = args.gemini and not args.no_ml

    print(f"Building ZenPin search index ({len(CATEGORIES)} categories)")
    print(f"Mode: {'Gemini embeddings' if use_gemini else 'keyword vectors (--no-ml)'}")
    print()

    entries = build_index(use_gemini=use_gemini)
    out_path = args.out

    with open(out_path, "w") as f:
        json.dump(entries, f, separators=(",", ":"))

    size_mb = os.path.getsize(out_path) / 1_000_000
    print(f"\n✅ {len(entries)} entries written to {out_path} ({size_mb:.1f} MB)")
    print(f"   Commit this file to your backend repo and redeploy.")


if __name__ == "__main__":
    main()
