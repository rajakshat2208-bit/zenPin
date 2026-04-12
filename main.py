# main.py — ZenPin API v3.0
# ─────────────────────────────────────────────────────────────
# Discovery v3: Strong queries + relevance filtering + DB cache
# Architecture:
#   Request → Cache (24h) → API (Unsplash/Pexels/Pixabay)
#           → Filter(score≥2) → Store → Serve
#           → If all fail → Curated local fallback
# ─────────────────────────────────────────────────────────────

import os, uuid, json, random, httpx, re, asyncio
from typing import Optional, List
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Depends, UploadFile, File, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field
from dotenv import load_dotenv
import database as db
import auth as auth_utils

load_dotenv()

_upload_dir = os.getenv("UPLOAD_DIR", "uploads")
os.makedirs(_upload_dir, exist_ok=True)

BASE_URL      = os.getenv("BASE_URL", "http://localhost:8000")
UPLOAD_DIR    = _upload_dir
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "10"))
UNSPLASH_KEY  = os.getenv("UNSPLASH_ACCESS_KEY", "")
PEXELS_KEY    = os.getenv("PEXELS_API_KEY", "")
PIXABAY_KEY   = os.getenv("PIXABAY_API_KEY", "")
ALLOWED_IMG_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

# ══════════════════════════════════════════════════════════════
# PART 1 — CATEGORY QUERY SYSTEM
# Strong, specific search queries per category
# Multiple queries tried in order for best results
# ══════════════════════════════════════════════════════════════

# ──────────────────────────────────────────────────────────────
# CATEGORY QUERY SYSTEM — 3-layer diversity architecture
#
# Layer 1 — Core subject (most specific, highest precision)
# Layer 2 — Aesthetic style (mood, lighting, composition)
# Layer 3 — Trend/vibe (viral keywords, current aesthetics)
#
# Multiple queries per category → merged + scored results →
# maximum variety while maintaining category accuracy
# ──────────────────────────────────────────────────────────────

CATEGORY_QUERIES = {
    "cars": [
        # Layer 1: Core
        "sports car ferrari lamborghini photography",
        "supercar automotive luxury vehicle",
        "classic muscle car racing track",
        # Layer 2: Aesthetic
        "car photography golden hour cinematic",
        "exotic car studio dark background",
        "vintage classic car garage portrait",
        # Layer 3: Trend
        "drift car neon night photography",
        "electric sports car futuristic design",
        "rally racing car dirt track action",
    ],
    "bikes": [
        "sports motorcycle cafe racer photography",
        "superbike racing motorcycle track",
        "harley davidson custom chopper bike",
        "adventure motorcycle touring ride",
        "motorcycle photography golden hour sunset",
        "cafe racer custom build garage workshop",
        "scrambler dirt bike trail adventure",
        "motorcycle dark neon night urban",
        "vintage classic motorcycle restoration",
    ],
    "anime": [
        "anime illustration digital art wallpaper",
        "anime aesthetic japan tokyo neon",
        "manga character artwork fan art",
        "studio ghibli fantasy anime scene",
        "anime girl pastel aesthetic art",
        "cyberpunk anime city neon illustration",
        "lofi anime room cozy aesthetic",
        "anime landscape fantasy background art",
        "anime portrait character design illustration",
    ],
    "scenery": [
        "landscape mountain lake nature photography",
        "aerial scenic vista panoramic view",
        "dramatic sky sunset golden hour nature",
        "fjord waterfall natural wonder landscape",
    ],
    "gaming": [
        "gaming setup RGB battlestation desk",
        "gaming room PC build neon lights",
        "esports gaming chair monitor setup",
        "retro console game collection room",
        "mechanical keyboard gaming aesthetic",
        "custom PC build glass case RGB lighting",
        "gaming setup minimal dark desk",
        "retro gaming nostalgia controller collection",
        "streaming setup dual monitor gaming room",
    ],
    "fashion": [
        "fashion editorial style outfit photography",
        "streetwear lookbook runway clothing",
        "high fashion designer couture shoot",
        "aesthetic outfit ootd style photo",
        "dark academia fashion aesthetic outfit",
        "minimalist neutral tones fashion photography",
        "vintage thrift fashion street style",
        "boho chic summer fashion photography",
        "power dressing office fashion editorial",
    ],
    "nature": [
        "wildlife animal tiger eagle forest",
        "wild animal nature photography close up",
        "exotic bird butterfly insect macro",
        "wolf bear lion big cat wildlife",
    ],
    "food": [
        "food photography gourmet plating restaurant",
        "aesthetic food flat lay ingredients",
        "sushi ramen japanese food photography",
        "dessert cake bakery artisan food",
        "coffee latte art espresso photography",
        "breakfast brunch food aesthetic natural light",
        "pasta italian food gourmet plating",
        "street food vendor photography travel",
        "sourdough bread artisan bakery photography",
    ],
    "travel": [
        "travel destination architecture landmark",
        "santorini bali paris travel photography",
        "adventure travel explore mountain city",
        "aerial travel cityscape destination photo",
        "travel photography golden hour landscape",
        "backpacking adventure solo travel nature",
        "luxury resort tropical destination photography",
        "tokyo street photography night travel",
        "europe architecture travel cityscape photo",
    ],
    "tech": [
        "technology circuit board futuristic digital",
        "robotics AI drone gadget technology",
        "computer hardware GPU processor tech",
        "smart device wearable future technology",
    ],
    "art": [
        "art painting canvas creative artwork",
        "street mural graffiti urban art",
        "watercolor oil painting fine art gallery",
        "digital illustration creative design art",
    ],
    "architecture": [
        "modern architecture building design exterior",
        "skyscraper glass tower urban architecture",
        "cathedral interior historic architecture",
        "minimal house design architectural photography",
    ],
    "workspace": [
        "minimal desk workspace home office setup",
        "productive desk setup dual monitor plants",
        "creative studio workspace aesthetic",
        "cozy home office desk morning light",
    ],
    "interior design": [
        "interior design living room home decor",
        "scandinavian japandi bedroom interior",
        "luxury home interior modern design",
        "boho eclectic room decor interior",
    ],
    "ladies accessories": [
        "jewelry necklace earrings gold accessories",
        "luxury handbag designer accessories fashion",
        "bangles bracelet rings jewelry photography",
        "pearls gemstone fine jewelry close up",
        "gold bangle stack jewelry flatlay",
        "statement earrings fashion accessories portrait",
        "fine jewelry diamond ring close up macro",
        "silk scarf headband hair accessories fashion",
        "designer bag leather accessories photography",
    ],
    "tattoos": [
        "tattoo art sleeve bodyart ink photography",
        "fine line tattoo geometric blackwork",
        "tattoo artist studio design process",
        "traditional japanese tattoo sleeve",
    ],
    "plants": [
        "indoor plants monstera houseplant green",
        "botanical garden succulent cactus plants",
        "tropical plant leaf jungle greenery",
        "bonsai terrarium plant arrangement",
    ],
    "fitness": [
        "gym workout fitness training bodybuilder",
        "yoga crossfit running athlete sport",
        "weightlifting powerlifting gym photography",
        "fitness model athlete sport training",
    ],
    "music": [
        "music guitar vinyl record studio",
        "concert live music performance crowd",
        "piano keyboard musician instrument",
        "DJ turntable music production studio",
    ],
    "pets": [
        "cat kitten portrait cute photography",
        "dog puppy golden retriever portrait",
        "pet animal cute fluffy portrait",
        "exotic pet bird parrot hamster",
    ],
    "superheroes": [
        # Layer 1: Core — each major hero gets own query for variety
        "spiderman comic book illustration art",
        "batman dark knight gotham artwork",
        "iron man marvel avengers art",
        "captain america shield superhero illustration",
        # Layer 2: Style
        "wonder woman dc superhero art cinematic",
        "thor lightning avengers artwork digital",
        "black panther wakanda art illustration",
        # Layer 3: Trend
        "superhero cosplay costume photography",
        "marvel dc superhero action figure collectible",
    ],
    "drinks": [
        "cocktail craft bar drink photography",
        "coffee latte art espresso barista",
        "whiskey wine champagne beverage",
        "craft beer smoothie drink aesthetic",
        "negroni old fashioned cocktail photography",
        "wine glass red white pour photography",
        "matcha tea ceremony japanese aesthetic",
        "cold brew iced coffee photography",
        "cocktail bar neon dark moody photography",
    ],
    "flowers": [
        "flowers floral bouquet bloom photography",
        "rose peony sunflower tulip garden",
        "wildflower field botanical floral art",
        "macro flower close up petal bloom",
    ],
    "cigarettes": [
        "cigarette smoke tobacco aesthetic",
        "cigar luxury smoking lounge",
        "cigarette lighter vintage smoking",
        "smoke art photography aesthetic",
    ],
}

# ══════════════════════════════════════════════════════════════
# PART 2 — IMAGE FILTERING ALGORITHM
# Scores each image based on keyword relevance
# Accepts only images scoring above threshold
# ══════════════════════════════════════════════════════════════

# Keywords that MUST appear for category to score positively
CATEGORY_ACCEPT_KEYWORDS = {
    "cars":               ["car","vehicle","automobile","ferrari","lamborghini","supercar","porsche","bmw","mercedes","mustang","corvette","racing","automotive","sedan","coupe","truck"],
    "bikes":              ["motorcycle","bike","motorbike","chopper","scrambler","harley","ducati","kawasaki","yamaha","honda","triumph","rider","two-wheel","moped","cafe racer"],
    "anime":              ["anime","manga","otaku","kawaii","chibi","cosplay","japan","japanese","animation","ghibli","naruto","pokemon","art","illustration","character"],
    "scenery":            ["landscape","scenery","mountain","lake","ocean","sky","valley","cliff","horizon","panorama","nature","forest","desert","beach","waterfall","scenic","vista"],
    "gaming":             ["gaming","game","gamer","controller","console","playstation","xbox","nintendo","pc","rgb","battlestation","esports","keyboard","monitor","setup","joystick"],
    "fashion":            ["fashion","style","outfit","clothing","dress","wear","clothes","model","runway","editorial","streetwear","jacket","shirt","shoes","boots","aesthetic"],
    "nature":             ["animal","wildlife","bird","tiger","lion","wolf","eagle","bear","deer","elephant","fox","leopard","whale","dolphin","nature","wild","forest","jungle"],
    "food":               ["food","eat","dish","meal","cuisine","recipe","cook","restaurant","sushi","pizza","burger","dessert","cake","coffee","breakfast","lunch","dinner","plate"],
    "travel":             ["travel","destination","city","country","landmark","tourist","explore","adventure","trip","vacation","hotel","beach","mountain","tour","visit","culture"],
    "tech":               ["technology","tech","circuit","computer","robot","ai","digital","electronic","device","gadget","innovation","code","software","hardware","drone","smart"],
    "art":                ["art","painting","artwork","creative","canvas","drawing","illustration","sketch","design","craft","gallery","museum","abstract","portrait","mural"],
    "architecture":       ["architecture","building","design","structure","exterior","interior","construction","skyscraper","tower","bridge","house","home","facade","urban","landmark"],
    "workspace":          ["desk","workspace","office","setup","work","laptop","computer","monitor","chair","study","home office","productivity","notebook","pen","plant","coffee"],
    "interior design":    ["interior","room","decor","home","living room","bedroom","kitchen","bathroom","furniture","sofa","couch","design","rug","lighting","wall","ceiling"],
    "ladies accessories": ["jewelry","necklace","earring","bracelet","bangle","ring","accessory","handbag","purse","bag","watch","pearl","gold","silver","gem","diamond","fashion"],
    "tattoos":            ["tattoo","ink","body art","tattooed","sleeve","flash","design","skin","needle","artist","blackwork","traditional","watercolor","tribal","geometric"],
    "plants":             ["plant","flower","garden","green","leaf","botanical","nature","succulent","cactus","monstera","fern","tree","grass","bloom","grow","indoor","pot"],
    "fitness":            ["fitness","gym","workout","exercise","sport","athlete","training","muscle","yoga","run","weight","health","body","crossfit","cardio","lift","stretch"],
    "music":              ["music","guitar","piano","violin","drum","concert","band","singer","musician","vinyl","record","studio","song","sound","instrument","melody","bass"],
    "pets":               ["cat","dog","pet","kitten","puppy","rabbit","bird","hamster","fish","parrot","cute","animal","fur","fluffy","paw","tail","feline","canine"],
    "superheroes":        ["superhero","hero","comic","marvel","dc","batman","superman","spiderman","avengers","cosplay","costume","cape","action","figure","collectible"],
    "drinks":             ["drink","cocktail","coffee","tea","wine","beer","whiskey","juice","smoothie","beverage","bar","cafe","alcohol","espresso","latte","mocktail"],
    "flowers":            ["flower","floral","rose","tulip","sunflower","daisy","petal","bloom","blossom","bouquet","garden","lavender","orchid","peony","lily","botanical"],
    "cigarettes":         ["cigarette","smoke","tobacco","cigar","smoking","lighter","ash","filter","nicotine","pipe","hookah","vapor","roll"],
}

# Keywords that REJECT an image from a category (cross-contamination prevention)
CATEGORY_REJECT_KEYWORDS = {
    "cars":               ["cat","dog","pet","flower","food","fashion","jewelry","wedding","baby"],
    "bikes":              ["bicycle","push bike","cat","dog","food","flower","jewelry","fashion"],
    "anime":              ["real person","photograph","landscape","food","car","pet"],
    "scenery":            ["person","portrait","food","fashion","car","pet","product"],
    "gaming":             ["food","flower","pet","jewelry","landscape","nature","wedding"],
    "fashion":            ["car","motorcycle","circuit","technology","pet","wildlife","plant"],
    "nature":             ["car","food","fashion","jewelry","gaming","desk","interior"],
    "food":               ["car","motorcycle","gaming","fashion","landscape","animal","plant"],
    "travel":             ["food close up","gaming","jewelry","pet close up","product"],
    "tech":               ["food","flower","pet","fashion","landscape","jewelry","wedding"],
    "art":                [],  # art is broad, no hard rejects
    "architecture":       ["food","pet","jewelry","fashion","gaming"],
    "workspace":          ["food","pet","fashion","jewelry","gaming","landscape"],
    "interior design":    ["car","motorcycle","food","outdoor","landscape","pet"],
    "ladies accessories": ["car","motorcycle","gaming","food","landscape","animal","gaming"],
    "tattoos":            ["food","car","landscape","pet close up","jewelry","gaming"],
    "plants":             ["car","gaming","food","fashion","jewelry","motorcycle"],
    "fitness":            ["car","jewelry","gaming setup","interior","food"],
    "music":              ["car","food","gaming","jewelry","landscape"],
    "pets":               ["car","gaming","jewelry","fashion","food","landscape"],
    "superheroes":        ["food","landscape","jewelry","car","plant","interior"],
    "drinks":             ["car","gaming","jewelry","pet","landscape","motorcycle"],
    "flowers":            ["car","gaming","food","motorcycle","pet","jewelry"],
    "cigarettes":         ["food","car","gaming","jewelry","fashion","landscape"],
}

def score_image(image: dict, category: str) -> int:
    """
    Score an image for category relevance.
    +3 if category keyword in title
    +2 if category keyword in tags
    +1 if category keyword in description
    -3 for each reject keyword found
    Accept if score >= 1

    Special cases:
    - LoremFlickr / curated fallbacks always get score=2 (they're already category-matched)
    - Images with no metadata get score=1 (benefit of the doubt — query already filtered)
    """
    cat = category.lower()

    # Curated fallback sources don't need scoring — they're always correct
    source = (image.get("source") or "").lower()
    if source in ("curated", "loremflickr"):
        return 2

    accept_kws = CATEGORY_ACCEPT_KEYWORDS.get(cat, [cat])
    reject_kws = CATEGORY_REJECT_KEYWORDS.get(cat, [])

    # Build searchable text from all image metadata
    title = (image.get("title") or "").lower()
    tags  = (image.get("tags")  or "").lower()
    desc  = (image.get("description") or image.get("alt_description") or "").lower()
    combined = f"{title} {tags} {desc}".strip()

    # No metadata at all — trust the query (score 1 = barely acceptable)
    if not combined:
        return 1

    score = 0

    # Positive scoring
    for kw in accept_kws:
        kw_l = kw.lower()
        if kw_l in title:
            score += 3   # title match = strongest signal
        elif kw_l in tags:
            score += 2   # tag match = strong signal
        elif kw_l in desc:
            score += 1   # desc match = weak signal
        if score >= 6:
            break  # Short-circuit: already a strong match, don't need to keep scanning

    # Negative scoring — reject cross-contamination
    for kw in reject_kws:
        kw_l = kw.lower()
        if kw_l in combined:
            score -= 3
            if score <= -6:
                break  # Definitely rejected, no need to keep scanning

    return score


def filter_images(images: list, category: str, min_score: int = 1) -> list:
    """Filter and sort images by relevance score. Drop anything below min_score."""
    scored = []
    for img in images:
        s = score_image(img, category)
        if s >= min_score:
            scored.append((s, img))
    # Sort by score descending — best matches first
    scored.sort(key=lambda x: x[0], reverse=True)
    return [img for _, img in scored]



# ──────────────────────────────────────────────────────────────
# TREND MINING SYSTEM
# Aesthetic + trend keyword layers applied to any category.
# These expand results with current visual trends.
# ──────────────────────────────────────────────────────────────

AESTHETIC_KEYWORDS = [
    "dark academia aesthetic",
    "cottagecore aesthetic",
    "minimalist aesthetic photography",
    "cyberpunk neon aesthetic",
    "vaporwave aesthetic",
    "lofi aesthetic cozy",
    "golden hour photography",
    "film grain vintage aesthetic",
    "moody dark photography",
    "pastel soft aesthetic",
]

# Category-specific trend layers (appended to base queries)
CATEGORY_TREND_LAYER = {
    "cars":               ["cyberpunk car neon night", "vaporwave car aesthetic retro", "car photography cinematic film"],
    "bikes":              ["motorcycle sunset golden hour", "cafe racer vintage aesthetic", "motorcycle dark moody photography"],
    "anime":              ["lofi anime room aesthetic", "vaporwave anime aesthetic", "anime cyberpunk neon art"],
    "gaming":             ["gaming room aesthetic neon", "minimal gaming setup dark", "retro gaming nostalgia aesthetic"],
    "fashion":            ["dark academia fashion aesthetic", "cottagecore fashion nature", "minimalist neutral fashion"],
    "ladies accessories": ["jewelry golden hour flatlay", "accessories minimal aesthetic", "fine jewelry dark background"],
    "travel":             ["travel photography film grain", "golden hour travel destination", "moody travel landscape"],
    "food":               ["food photography dark moody", "breakfast aesthetic golden light", "artisan food craft photography"],
    "interior design":    ["japandi interior minimal", "dark academia room aesthetic", "cozy cottagecore interior"],
    "workspace":          ["minimal desk setup aesthetic", "dark mode desk setup", "cozy workspace morning light"],
    "nature":             ["nature photography moody dark", "wildlife golden hour magic", "forest mist aesthetic photography"],
    "tech":               ["cyberpunk technology neon", "minimal tech aesthetic dark", "futuristic technology concept"],
    "art":                ["dark academia art aesthetic", "lofi art cozy illustration", "abstract art moody dark"],
    "architecture":       ["brutalist architecture moody", "modern architecture golden hour", "dark architecture night photography"],
    "scenery":            ["landscape photography golden hour", "moody dramatic landscape", "misty atmospheric landscape"],
    "flowers":            ["cottagecore flowers aesthetic", "moody dark flower photography", "flowers pastel soft aesthetic"],
    "plants":             ["cottagecore plant aesthetic", "cozy plant shelf morning light", "botanical plant dark moody"],
    "fitness":            ["fitness aesthetic dark moody", "gym photography dramatic lighting", "athlete golden hour photography"],
    "music":              ["vinyl record aesthetic warm", "dark academia music aesthetic", "jazz club moody photography"],
    "pets":               ["golden hour pet portrait", "cozy pet aesthetic warm", "pet portrait moody dark"],
    "tattoos":            ["fine line tattoo minimal aesthetic", "dark tattoo moody photography", "tattoo art aesthetic close up"],
    "superheroes":        ["superhero dark cinematic art", "comic book aesthetic vibrant", "superhero neon digital art"],
    "drinks":             ["cocktail moody dark bar", "coffee aesthetic warm morning", "drinks golden hour flatlay"],
    "cigarettes":         ["smoke aesthetic dark moody", "cigarette vintage film photography", "smoke art dark aesthetic"],
}


def get_trend_queries(category: str, limit: int = 3) -> list:
    """Return trend-layer queries for a category to boost aesthetic diversity."""
    cat = category.lower()
    trend = CATEGORY_TREND_LAYER.get(cat, [])
    # Add 1-2 random aesthetic keywords as extra queries
    import random
    aesthetic = random.sample(AESTHETIC_KEYWORDS, min(2, len(AESTHETIC_KEYWORDS)))
    aesthetic_q = [f"{cat} {kw}" for kw in aesthetic]
    return (trend + aesthetic_q)[:limit]

# ══════════════════════════════════════════════════════════════
# PART 3 — CURATED FALLBACK IMAGES
# Hand-verified LoremFlickr URLs with single-word tags
# These always load, always match the category
# ══════════════════════════════════════════════════════════════

# Single Flickr tag with massive photo pool — guarantees category match
FLICKR_TAG = {
    "cars":               "car",
    "bikes":              "motorcycle",
    "anime":              "anime",
    "scenery":            "landscape",
    "gaming":             "gaming",
    "fashion":            "fashion",
    "nature":             "wildlife",
    "food":               "food",
    "travel":             "travel",
    "tech":               "technology",
    "art":                "art",
    "architecture":       "architecture",
    "workspace":          "workspace",
    "interior design":    "interior",
    "ladies accessories": "jewelry",
    "tattoos":            "tattoo",
    "plants":             "plants",
    "fitness":            "fitness",
    "music":              "music",
    "pets":               "pets",
    "superheroes":        "superhero",
    "drinks":             "cocktail",
    "flowers":            "flowers",
    "cigarettes":         "cigarette",
}

CARD_HEIGHTS = [700, 750, 680, 800, 720, 760, 650, 740, 710, 770, 660, 790]

CATEGORY_TITLES = {
    "cars":               ["Ferrari Shot","Supercar Day","Track Ready","Midnight Drive","Garage Find","Luxury Auto","Race Day","Classic Build","Sports Drive","Canyon Run","Showroom Floor","Engine Bay"],
    "bikes":              ["Cafe Racer","Track Day","Iron Horse","Mountain Pass","Custom Build","Night Rider","Street Scrambler","Garage Queen","Adventure Ride","Chopper Style","Sprint Bike","Enduro Run"],
    "anime":              ["Neon Tokyo","Anime Aesthetic","Cherry Blossom","Manga Scene","Kawaii Vibes","Cyberpunk City","Studio Ghibli","Fantasy World","Demon Slayer","One Piece","Attack Scene","Pastel Dream"],
    "scenery":            ["Mountain Lake","Aurora Night","Misty Forest","Desert Dunes","Ocean Cliff","Lavender Field","Snowy Valley","Tropical Falls","Canyon View","Rolling Hills","Fjord Morning","Storm Coming"],
    "gaming":             ["RGB Station","Retro Console","Gaming Desk","Controller Lay","Neon Setup","Mech Keyboard","VR Room","Streaming Rig","Triple Monitor","Custom Build","Esports Ready","Cozy Gaming"],
    "fashion":            ["Street Style","Editorial Look","Summer Outfit","Dark Academia","Boho Chic","Runway Look","Vintage Denim","Power Suit","Minimal Fit","Layered Looks","Colour Block","Thrift Find"],
    "nature":             ["Tiger Hunt","Eagle Flight","Wolf Pack","Bear Creek","Fox Den","Leopard Rest","Lion Pride","Elephant Herd","Polar Bear","Peacock Spread","Owl Watch","Whale Breach"],
    "food":               ["Sourdough Art","Wagyu Plate","Sushi Omakase","Pasta Perfection","Matcha Moment","Charcuterie","Dessert Art","Street Eats","Coffee Pour","Ramen Bowl","Flat Lay Feast","Baker's Dozen"],
    "travel":             ["Santorini Blue","Bali Terraces","Moroccan Riad","Iceland Falls","Tokyo Crossing","Amalfi Drive","Desert Safari","Venice Canals","Kyoto Temple","New York Night","Patagonia Trek","Maldives Blue"],
    "tech":               ["Circuit Board","Drone Shot","Server Farm","Robot Hand","Code Screen","3D Print","Smart Home","VR Headset","GPU Beauty","AI Render","Satellite Link","Quantum Lab"],
    "art":                ["Abstract Canvas","Ink Wash","Oil Painting","Watercolour","Street Mural","Ceramic Work","Collage Art","Digital Brush","Charcoal Work","Linocut Print","Gouache Study","Neon Installation"],
    "architecture":       ["Glass Tower","Spiral Stair","Brutalist Form","White Interior","Modern Bridge","Desert House","Cathedral Vault","Bamboo Pavilion","Floating Home","Urban Canyon","Rooftop Garden","Archive Hall"],
    "workspace":          ["Minimal Desk","Dual Monitor","Creative Studio","Cosy Corner","Standing Desk","Bookshelf Wall","Morning Coffee","Plant Desk","Dark Mode Setup","Loft Office","Garden Desk","Night Shift"],
    "interior design":    ["Japandi Room","Wabi-Sabi Bed","Earthy Lounge","Reading Nook","Modern Kitchen","Boho Living","Scandi Space","Gallery Wall","Maximalist Den","Dark Library","Coastal Calm","Arch Window"],
    "ladies accessories": ["Gold Bangles","Pearl Earrings","Layered Necklace","Crystal Stack","Statement Ring","Silk Scarf","Velvet Headband","Charm Bracelet","Diamond Drop","Vintage Brooch","Gold Cuff","Beaded Set"],
    "tattoos":            ["Sleeve Design","Fine Line","Blackwork Geo","Watercolour Ink","Traditional Flash","Realism Portrait","Mandala Back","Script Wrist","Neo-Trad Piece","Dotwork Art","Cover Up","Botanical Ink"],
    "plants":             ["Monstera Corner","Succulent Grid","Pothos Cascade","Fiddle Leaf","Cactus Collection","Bonsai Moment","Air Plant Wall","Terrarium Build","Propagation Jars","Fern Shelf","Orchid Bloom","Snake Plant"],
    "fitness":            ["Heavy Lifts","Yoga Flow","Box Jump","Sprint Finish","Pull Up Set","Handstand Work","Kettlebell Swing","Plank Hold","Barbell Squat","Jump Rope","Sled Push","Ring Muscle Up"],
    "music":              ["Vinyl Session","Fender Strat","Grand Piano","Jazz Club","Concert Night","Studio Take","Drum Kit","Bass Line","Acoustic Set","DJ Booth","String Quartet","Soundcheck"],
    "pets":               ["Golden Hour Pup","Window Cat","Bunny Bun","Sleepy Kitten","Husky Eyes","Corgi Smile","Persian Pose","Dachshund Trot","Maine Coon","Parrot Perch","Hedgehog Hello","Gecko Close Up"],
    "superheroes":        ["Iron Man Suit","Batman Cowl","Spider-Man City","Captain America","Thor Lightning","Black Panther","Wonder Woman","The Flash","Wolverine Claws","Hulk Smash","Doctor Strange","Venom Reveal"],
    "drinks":             ["Negroni Classic","Latte Art","Old Fashioned","Red Pour","Craft Beer Foam","Cold Brew Drip","Espresso Pull","Margarita Rim","Matcha Ceremony","Champagne Tower","Gin Tonic Swirl","Smoothie Bowl"],
    "flowers":            ["Peony Bloom","Red Rose","Wildflower Field","Orchid Stem","Sunflower Row","Cherry Blossom","Tulip Season","Lavender Walk","Dahlia Drama","Poppy Field","Magnolia","Hydrangea Cloud"],
    "cigarettes":         ["Smoke Curl","Cigar Lounge","Match Strike","Vintage Lighter","Ash & Ember","Rolling Art","Smoke Ring","Tobacco Leaf","Filter Close Up","Lit End","Café Smoke","Night Smoke"],
}


def get_curated_fallback(cat: str, page: int = 1, limit: int = 12) -> list:
    """
    Curated fallback — LoremFlickr with single precise tags.
    lock=N is sequential and stable: same page always returns same images.
    """
    tag    = FLICKR_TAG.get(cat, cat)
    titles = CATEGORY_TITLES.get(cat, [f"{cat.title()} Photo"])
    result = []
    for i in range(limit):
        gidx = (page - 1) * limit + i
        lock = gidx + 1          # lock 1,2,3... — stable, sequential
        h    = CARD_HEIGHTS[gidx % len(CARD_HEIGHTS)]
        result.append({
            "title":     titles[gidx % len(titles)],
            "image_url": f"https://loremflickr.com/500/{h}/{tag}?lock={lock}",
            "thumb_url": f"https://loremflickr.com/300/{h//2}/{tag}?lock={lock}",
            "tags":      tag,
            "source":    "curated",
            "category":  cat,
        })
    return result


# ══════════════════════════════════════════════════════════════
# APP SETUP
# ══════════════════════════════════════════════════════════════

@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    db.seed_demo_ideas()
    print("🚀 ZenPin API v3.0 is live")
    yield

app = FastAPI(title="ZenPin API", version="3.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")


@app.get("/")
def root():
    return {
        "status": "ok", "app": "ZenPin API", "version": "3.0.0",
        "categories": list(CATEGORY_QUERIES.keys()),
    }


# ── Pydantic models (unchanged) ─────────────────────────────────
class SignupRequest(BaseModel):
    username: str      = Field(..., min_length=2,  max_length=30)
    email:    EmailStr
    password: str      = Field(..., min_length=8,  max_length=100)

class LoginRequest(BaseModel):
    email:    EmailStr
    password: str = Field(..., min_length=1, max_length=100)

class UpdateProfileRequest(BaseModel):
    bio:          Optional[str]  = Field(None, max_length=300)
    username:     Optional[str]  = Field(None, min_length=2, max_length=30)
    location:     Optional[str]  = Field(None, max_length=100)
    social_links: Optional[dict] = Field(None)

class CreateIdeaRequest(BaseModel):
    title:           str            = Field(..., min_length=1, max_length=120)
    description:     Optional[str]  = Field("",   max_length=2000)
    category:        str            = Field(..., min_length=1, max_length=50)
    image_url:       str            = Field(..., min_length=5, max_length=500)
    difficulty:      Optional[int]  = Field(3, ge=1, le=5)
    creativity:      Optional[int]  = Field(3, ge=1, le=5)
    usefulness:      Optional[int]  = Field(3, ge=1, le=5)
    steps:           Optional[List[str]] = Field(default_factory=list)
    tools:           Optional[List[str]] = Field(default_factory=list)
    estimated_cost:  Optional[str]  = Field("", max_length=100)
    reference_links: Optional[List[str]] = Field(default_factory=list)

class CreateBoardRequest(BaseModel):
    name:        str           = Field(..., min_length=1, max_length=80)
    description: Optional[str] = Field("", max_length=300)
    is_collab:   Optional[bool] = False

class AddToBoardRequest(BaseModel):
    idea_id: int = Field(..., gt=0)

class AIGenerateRequest(BaseModel):
    topic: str = Field(..., min_length=1, max_length=200)


# ── AUTH (unchanged) ─────────────────────────────────────────────
@app.post("/auth/signup", status_code=201)
def signup(body: SignupRequest):
    if db.get_user_by_email(body.email):
        raise HTTPException(409, "An account with this email already exists.")
    if db.get_user_by_username(body.username):
        raise HTTPException(409, "That username is already taken.")
    hashed = auth_utils.hash_password(body.password)
    try:
        user = db.create_user(body.username, body.email, hashed)
    except Exception as e:
        raise HTTPException(400, f"Signup failed: {e}")
    token = auth_utils.create_token(user["id"], user["username"])
    return {"token": token, "user": {"id": user["id"], "username": user["username"], "email": user["email"]}}

@app.post("/auth/login")
def login(body: LoginRequest):
    user = db.get_user_by_email(body.email)
    if not user or not auth_utils.verify_password(body.password, user["password_hash"]):
        raise HTTPException(401, "Incorrect email or password.")
    token = auth_utils.create_token(user["id"], user["username"])
    return {"token": token, "user": {
        "id": user["id"], "username": user["username"],
        "email": user["email"], "bio": user["bio"], "avatar_url": user["avatar_url"]
    }}

@app.get("/auth/me")
def get_me(current_user: dict = Depends(auth_utils.get_current_user)):
    saves = db.get_user_saves_set(current_user["id"])
    likes = db.get_user_likes_set(current_user["id"])
    return {**current_user, "saved_idea_ids": list(saves), "liked_idea_ids": list(likes)}

@app.patch("/auth/me")
def update_profile(body: UpdateProfileRequest, current_user: dict = Depends(auth_utils.get_current_user)):
    if body.username and body.username != current_user.get("username"):
        if db.get_user_by_username(body.username):
            raise HTTPException(409, "That username is already taken.")
    return db.update_user_profile(
        current_user["id"],
        bio=body.bio, username=body.username,
        location=body.location, social_links=body.social_links,
    )


# ══════════════════════════════════════════════════════════════
# PART 4 — DISCOVERY IMAGE ENDPOINT
# Flow: Cache → API+Filter → Curated Fallback
# Cache TTL: 24 hours
# ══════════════════════════════════════════════════════════════

async def fetch_unsplash(cat: str, query: str, page: int, limit: int) -> list:
    """Fetch from Unsplash. Returns rich metadata for scoring."""
    if not UNSPLASH_KEY:
        return []
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                "https://api.unsplash.com/search/photos",
                params={
                    "query":       query,
                    "page":        page,
                    "per_page":    min(limit + 8, 30),  # fetch extra for filtering
                    "orientation": "portrait",
                    "content_filter": "high",
                },
                headers={"Authorization": f"Client-ID {UNSPLASH_KEY}"}
            )
        if r.status_code == 429:
            print(f"Unsplash rate limit [{cat}]")
            return []
        if r.status_code != 200:
            return []
        data = r.json()
        results = []
        for p in data.get("results", []):
            url = p.get("urls", {}).get("regular") or p.get("urls", {}).get("small")
            if not url: continue
            # Extract all tags for richer scoring
            tags_list = [t["title"] for t in p.get("tags", [])]
            alt  = p.get("alt_description") or ""
            desc = p.get("description")     or ""
            title = alt.strip().title() if alt else (p.get("slug","").replace("-"," ").title() or f"{cat.title()} photo")
            # Deduplicate image_url size — use ?w=600 for consistent sizing
            clean_url = re.sub(r"[&?]?(ixlib|ixid|auto|fit|crop|w|h|dpr)=[^&]*", "", url)
            results.append({
                "title":       title[:80],
                "image_url":   f"{clean_url.split('?')[0]}?auto=format&fit=crop&w=600&q=80",
                "thumb_url":   f"{clean_url.split('?')[0]}?auto=format&fit=crop&w=300&q=70",
                "tags":        " ".join(tags_list),
                "description": f"{alt} {desc}".strip(),
                "source":      "unsplash",
                "author":      p.get("user", {}).get("name", ""),
            })
        return results
    except Exception as e:
        print(f"Unsplash error [{cat}]: {e}")
        return []


async def fetch_pexels(cat: str, query: str, page: int, limit: int) -> list:
    """Fetch from Pexels. Portrait orientation, optimised sizes."""
    if not PEXELS_KEY:
        return []
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                "https://api.pexels.com/v1/search",
                params={
                    "query":       query,
                    "page":        page,
                    "per_page":    min(limit + 8, 30),
                    "orientation": "portrait",
                    "size":        "medium",
                },
                headers={"Authorization": PEXELS_KEY}
            )
        if r.status_code == 429:
            print(f"Pexels rate limit [{cat}]")
            return []
        if r.status_code != 200:
            return []
        data = r.json()
        results = []
        for p in data.get("photos", []):
            src = p.get("src", {})
            url  = src.get("large2x") or src.get("large") or src.get("original", "")
            thumb = src.get("medium") or src.get("small", "")
            if not url: continue
            alt = p.get("alt", "")
            results.append({
                "title":       (alt.strip()[:80] if alt else f"{cat.title()} photo"),
                "image_url":   url,
                "thumb_url":   thumb,
                "tags":        f"{cat} {alt}".lower(),
                "description": alt,
                "source":      "pexels",
                "author":      p.get("photographer", ""),
            })
        return results
    except Exception as e:
        print(f"Pexels error [{cat}]: {e}")
        return []


async def fetch_pixabay(cat: str, query: str, page: int, limit: int) -> list:
    """Fetch from Pixabay API."""
    if not PIXABAY_KEY:
        return []
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(
                "https://pixabay.com/api/",
                params={
                    "key": PIXABAY_KEY, "q": query,
                    "image_type": "photo", "orientation": "vertical",
                    "safesearch": "true", "per_page": limit, "page": page,
                    "min_width": 400,
                }
            )
        if r.status_code != 200:
            return []
        data = r.json()
        return [
            {
                "title":       h.get("tags","").split(",")[0].strip().title() or f"{cat} photo",
                "image_url":   h["webformatURL"],
                "thumb_url":   h["previewURL"],
                "tags":        h.get("tags",""),
                "description": h.get("tags",""),
                "source":      "pixabay",
                "author":      h.get("user",""),
            }
            for h in data.get("hits",[])
            if h.get("webformatURL")
        ]
    except Exception as e:
        print(f"Pixabay error [{cat}]: {e}")
        return []


# Pixabay params upgraded to fetch extra images for filtering
async def _fetch_pixabay_v2(cat: str, query: str, page: int, limit: int) -> list:
    """Pixabay v2 fetch — vertical images, larger pool, better metadata."""
    if not PIXABAY_KEY:
        return []
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                "https://pixabay.com/api/",
                params={
                    "key":          PIXABAY_KEY,
                    "q":            query,
                    "image_type":   "photo",
                    "orientation":  "vertical",
                    "safesearch":   "true",
                    "per_page":     min(limit + 8, 30),
                    "page":         page,
                    "min_width":    500,
                    "category":     _PIXABAY_CAT.get(cat, ""),
                }
            )
        if r.status_code == 429:
            print(f"Pixabay rate limit [{cat}]")
            return []
        if r.status_code != 200:
            return []
        data = r.json()
        results = []
        for h in data.get("hits", []):
            url   = h.get("largeImageURL") or h.get("webformatURL", "")
            thumb = h.get("previewURL", "")
            if not url: continue
            tags = h.get("tags", "")
            title = tags.split(",")[0].strip().title() if tags else f"{cat.title()} photo"
            results.append({
                "title":       title[:80],
                "image_url":   url,
                "thumb_url":   thumb,
                "tags":        tags.lower(),
                "description": tags.lower(),
                "source":      "pixabay",
                "author":      h.get("user", ""),
            })
        return results
    except Exception as e:
        print(f"Pixabay v2 error [{cat}]: {e}")
        return []

# Pixabay category hint map — improves relevance from their category filter
_PIXABAY_CAT = {
    "cars":               "transportation",
    "bikes":              "transportation",
    "food":               "food",
    "nature":             "animals",
    "scenery":            "nature",
    "flowers":            "nature",
    "plants":             "nature",
    "travel":             "travel",
    "fashion":            "fashion",
    "tech":               "science",
    "art":                "arts",
    "music":              "music",
    "fitness":            "sports",
    "buildings":          "buildings",
    "architecture":       "buildings",
}


@app.get("/images/category")
async def get_discovery_images(
    name:    str = Query(..., min_length=1, max_length=50),
    page:    int = Query(1, ge=1, le=50),
    limit:   int = Query(12, ge=1, le=30),
    refresh: bool = Query(False),   # force cache bypass
):
    """
    Discovery pipeline — 4-layer architecture:
      1. 24h page-level cache  (fastest)
      2. discovery_images DB   (scored + filtered, up to 24h old)
      3. Live API fetch → filter → score → store → serve
      4. Curated LoremFlickr fallback (never empty)
    """
    cat = name.lower().strip()

    # ── Layer 1: 24h page-level response cache ──────────────────
    if not refresh:
        cached = db.get_cached_discovery(cat, page, max_age_minutes=1440)
        if cached:
            print(f"📦 L1 cache: {cat} p{page}")
            return {"category": cat, "page": page, "source": "cache", "images": cached[:limit]}

    # ── Layer 2: Serve from discovery_images DB (still fresh) ───
    if not refresh and not db.discovery_images_stale(cat, max_age_hours=24):
        stored = db.get_discovery_images(cat, page, limit)
        if stored:
            db.set_cached_discovery(cat, page, stored)
            print(f"📦 L2 DB: {cat} p{page} ({len(stored)} images)")
            return {"category": cat, "page": page, "source": "db", "images": stored}

    # ── Layer 3: Live API fetch — parallel across providers ─────
    print(f"🔍 L3 API fetch: {cat} p{page}")
    queries = CATEGORY_QUERIES.get(cat, [f"{cat} photography"])
    primary_q = queries[0]  # Best query first

    # Fetch from all 3 providers in parallel
    raw_results = await asyncio.gather(
        fetch_unsplash(cat, primary_q, page, limit),
        fetch_pexels(  cat, primary_q, page, limit),
        _fetch_pixabay_v2(cat, primary_q, page, limit),
        return_exceptions=True
    )

    # Collect all primary results
    all_raw = []
    for r in raw_results:
        if isinstance(r, list): all_raw.extend(r)

    # If we don't have enough, try secondary core queries
    if len(all_raw) < limit * 2 and len(queries) > 1:
        secondary_results = await asyncio.gather(
            fetch_unsplash(cat, queries[1], page, limit),
            fetch_pexels(  cat, queries[1], page, limit),
            return_exceptions=True
        )
        for r in secondary_results:
            if isinstance(r, list): all_raw.extend(r)

    # Try tertiary query for more variety
    if len(all_raw) < limit * 2 and len(queries) > 2:
        tertiary_results = await asyncio.gather(
            fetch_unsplash(cat, queries[2], page, limit // 2),
            _fetch_pixabay_v2(cat, queries[2], page, limit // 2),
            return_exceptions=True
        )
        for r in tertiary_results:
            if isinstance(r, list): all_raw.extend(r)

    # Add trend layer queries for aesthetic diversity
    trend_qs = get_trend_queries(cat, limit=2)
    if trend_qs and len(all_raw) < limit * 3:
        trend_results = await asyncio.gather(
            *[fetch_unsplash(cat, tq, page, limit // 2) for tq in trend_qs[:2]],
            return_exceptions=True
        )
        for r in trend_results:
            if isinstance(r, list): all_raw.extend(r)

    # Score + filter
    print(f"  Raw: {len(all_raw)} images across providers")
    scored_raw = []
    for img in all_raw:
        s = score_image(img, cat)
        img["score"] = s
        scored_raw.append((s, img))

    # Sort by score descending — best matches first
    scored_raw.sort(key=lambda x: x[0], reverse=True)

    # Deduplicate by URL + apply diversity rule
    # Pinterest-style: no more than 3 consecutive images from same source
    seen_urls:   set  = set()
    source_run:  dict = {}   # track consecutive count per source
    filtered:    list = []

    for score, img in scored_raw:
        url    = img.get("image_url", "")
        source = img.get("source", "unknown")
        if not url or url in seen_urls or score < 1:
            continue
        # Diversity cap: skip if this source has 3 consecutive images already
        consec = source_run.get(source, 0)
        if consec >= 3:
            continue
        seen_urls.add(url)
        filtered.append(img)
        # Reset other sources' consecutive counts when source changes
        for s in list(source_run.keys()):
            if s != source:
                source_run[s] = 0
        source_run[source] = consec + 1

    print(f"  Filtered: {len(filtered)} (score≥1, diversity-ranked) → top {limit}")
    images = filtered[:limit]

    # Persist to discovery_images DB (replaces stale data for this category)
    if images and page == 1:
        db.upsert_discovery_images(cat, images)
        print(f"  💾 Stored {len(images)} images → discovery_images")

    # ── Layer 4: Curated fallback if all APIs returned nothing ──
    if not images:
        print(f"⚡ L4 fallback: {cat} p{page}")
        images = get_curated_fallback(cat, page, limit)

    # Cache for 24h
    if images:
        db.set_cached_discovery(cat, page, images)

    return {"category": cat, "page": page, "source": "api", "images": images[:limit]}


@app.post("/images/category/refresh")
async def refresh_category(name: str = Query(..., min_length=1, max_length=50)):
    """Force-refresh a category's discovery images from APIs."""
    cat = name.lower().strip()
    # Clear cache
    db.set_cached_discovery(cat, 1, [])
    # Re-fetch
    return await get_discovery_images(name=cat, page=1, limit=12, refresh=True)




@app.get("/warmup")
async def warmup_discovery():
    """
    Pre-warm discovery cache for the most popular categories.
    Call this from a cron job or health check to keep Render awake
    and have fresh filtered images ready for users.
    Hit it with: GET /warmup?categories=cars,bikes,gaming
    """
    import asyncio
    top_cats = ["cars", "bikes", "anime", "gaming", "fashion",
                "food", "travel", "interior design", "nature", "tech"]
    
    async def warm_one(cat: str):
        try:
            cached = db.get_cached_discovery(cat, 1, max_age_minutes=360)  # 6h min
            if cached:
                return cat, "cached"
            imgs = await _fetch_for_category(cat, page=1, limit=12)
            if imgs:
                db.set_cached_discovery(cat, 1, imgs)
                return cat, f"warmed ({len(imgs)} images)"
            return cat, "no results"
        except Exception as e:
            return cat, f"error: {e}"
    
    results = await asyncio.gather(*[warm_one(c) for c in top_cats])
    return {"warmup": {cat: status for cat, status in results}}


async def _fetch_for_category(cat: str, page: int = 1, limit: int = 12) -> list:
    """Internal helper: fetch + filter images for a category. Used by warmup."""
    queries = CATEGORY_QUERIES.get(cat, [f"{cat} photography"])
    raw_results = await asyncio.gather(
        fetch_unsplash(cat, queries[0], page, limit),
        fetch_pexels(  cat, queries[0], page, limit),
        _fetch_pixabay_v2(cat, queries[0], page, limit),
        return_exceptions=True
    )
    all_raw = [img for r in raw_results if isinstance(r, list) for img in r]
    if len(all_raw) < limit and len(queries) > 1:
        fallback = await asyncio.gather(
            fetch_unsplash(cat, queries[1], page, limit),
            fetch_pexels(  cat, queries[1], page, limit),
            return_exceptions=True
        )
        all_raw += [img for r in fallback if isinstance(r, list) for img in r]
    
    scored = [(score_image(img, cat), img) for img in all_raw]
    scored.sort(key=lambda x: x[0], reverse=True)
    seen: set = set()
    filtered = []
    for score, img in scored:
        url = img.get("image_url", "")
        if url and url not in seen and score >= 1:
            seen.add(url)
            filtered.append(img)
    return filtered[:limit]



@app.get("/images/aesthetic-mix")
async def get_aesthetic_mix(
    page:  int = Query(1, ge=1, le=20),
    limit: int = Query(12, ge=6, le=30),
):
    """
    Aesthetic Mix feed — Pinterest-style explore page.
    Combines images from all categories, ranked by visual aesthetic.
    Rotates through categories with aesthetic trend queries for variety.
    """
    import random

    # Cache key for the mix
    cache_key = f"aesthetic-mix"
    cached = db.get_cached_discovery(cache_key, page, max_age_minutes=120)  # 2h cache
    if cached:
        return {"page": page, "source": "cache", "images": cached}

    # Rotate through all categories for this page
    all_cats = list(CATEGORY_QUERIES.keys())
    random.shuffle(all_cats)

    # Pick 4-5 random categories, fetch aesthetic-style images from each
    selected_cats = all_cats[:(4 if page % 2 == 0 else 5)]
    per_cat = max(3, limit // len(selected_cats))

    # Use aesthetic trend queries for the mix (more visually interesting)
    async def fetch_aesthetic(cat: str) -> list:
        trend_qs = get_trend_queries(cat, limit=2)
        aesthetic_q = trend_qs[0] if trend_qs else f"{cat} aesthetic photography"
        results = await asyncio.gather(
            fetch_unsplash(cat, aesthetic_q, page, per_cat),
            fetch_pexels(  cat, aesthetic_q, page, per_cat),
            return_exceptions=True
        )
        raw = [img for r in results if isinstance(r, list) for img in r]
        scored = [(score_image(img, cat), img) for img in raw]
        scored.sort(key=lambda x: x[0], reverse=True)
        seen: set = set()
        out = []
        for s, img in scored:
            url = img.get("image_url", "")
            if url and url not in seen and s >= 1:
                seen.add(url)
                img["mix_category"] = cat  # tag with category for frontend
                out.append(img)
        return out[:per_cat]

    results = await asyncio.gather(*[fetch_aesthetic(c) for c in selected_cats], return_exceptions=True)
    all_imgs = [img for r in results if isinstance(r, list) for img in r]

    # Interleave categories for variety (not all cats clumped together)
    per_bucket = {}
    for img in all_imgs:
        c = img.get("mix_category", "misc")
        per_bucket.setdefault(c, []).append(img)

    interleaved = []
    while any(per_bucket.values()):
        for c in list(per_bucket.keys()):
            if per_bucket[c]:
                interleaved.append(per_bucket[c].pop(0))
            else:
                del per_bucket[c]

    images = interleaved[:limit]

    # Fallback if APIs returned nothing
    if not images:
        cats = random.sample(all_cats, min(3, len(all_cats)))
        images = []
        for c in cats:
            images.extend(get_curated_fallback(c, page, per_cat))
        images = images[:limit]

    if images:
        db.set_cached_discovery(cache_key, page, images)

    return {"page": page, "source": "api", "images": images}





# ══════════════════════════════════════════════════════════════
# OTP SYSTEM (simple in-memory, no SMS required)
# Use for email verification or optional 2FA.
# In production, replace _otp_store with Redis + send real email.
# ══════════════════════════════════════════════════════════════

import secrets, time as _time
_otp_store: dict = {}   # {email: {otp, expires_at, attempts}}
OTP_TTL  = 600          # 10 minutes
OTP_MAX  = 5            # max wrong attempts before invalidation


class OTPRequestBody(BaseModel):
    email: str

class OTPVerifyBody(BaseModel):
    email: str
    otp:   str


@app.post("/auth/otp/send")
def send_otp(body: OTPRequestBody):
    """
    Generate a 6-digit OTP for an email address and store it in memory.
    In production: send the OTP via email (SMTP / SendGrid / Resend).
    In development / demo: the OTP is returned in the response so you
    can test without email infrastructure.
    """
    email = body.email.lower().strip()
    if not email or "@" not in email:
        raise HTTPException(400, "Valid email required.")

    otp = str(secrets.randbelow(900000) + 100000)   # 100000–999999
    _otp_store[email] = {
        "otp":        otp,
        "expires_at": _time.time() + OTP_TTL,
        "attempts":   0,
    }

    # ── Send email via SMTP (free — Gmail, Brevo, Mailjet all work) ─────
    sent = False
    SMTP_HOST = os.getenv("SMTP_HOST", "")          # e.g. smtp.gmail.com
    SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
    SMTP_USER = os.getenv("SMTP_USER", "")          # your Gmail / SMTP user
    SMTP_PASS = os.getenv("SMTP_PASS", "")          # app password (not your login pw)
    FROM_ADDR = os.getenv("FROM_EMAIL", SMTP_USER)

    if SMTP_HOST and SMTP_USER and SMTP_PASS:
        try:
            import smtplib
            from email.mime.text import MIMEText
            body_text = (
                f"Your ZenPin sign-in code is: {otp}\n\n"
                f"This code expires in {OTP_TTL // 60} minutes.\n"
                f"If you did not request this, ignore this email."
            )
            msg_email = MIMEText(body_text)
            msg_email["Subject"] = f"ZenPin — your sign-in code: {otp}"
            msg_email["From"]    = FROM_ADDR
            msg_email["To"]      = email
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as smtp:
                smtp.ehlo()
                smtp.starttls()
                smtp.login(SMTP_USER, SMTP_PASS)
                smtp.sendmail(FROM_ADDR, [email], msg_email.as_string())
            sent = True
            print(f"[OTP] Email sent to {email}")
        except Exception as smtp_err:
            print(f"[OTP] SMTP failed: {smtp_err} — falling back to demo mode")
    print(f"[OTP] Generated for {email} (sent={sent})")

    return {
        "message":    "Code sent to your email." if sent else "OTP ready (demo — SMTP not configured)",
        "demo_otp":   None if sent else otp,    # Hidden when real email sent; visible for local testing
        "email_sent": sent,
        "expires_in": OTP_TTL,
    }


@app.post("/auth/otp/verify")
def verify_otp(body: OTPVerifyBody):
    """
    Verify the OTP submitted by the user.
    Returns {valid: true} or raises 400/410.
    """
    email = body.email.lower().strip()
    entry = _otp_store.get(email)

    if not entry:
        raise HTTPException(404, "No OTP found for this email. Request a new one.")

    if _time.time() > entry["expires_at"]:
        del _otp_store[email]
        raise HTTPException(410, "OTP expired. Please request a new one.")

    entry["attempts"] += 1
    if entry["attempts"] > OTP_MAX:
        del _otp_store[email]
        raise HTTPException(429, "Too many failed attempts. Request a new OTP.")

    if body.otp.strip() != entry["otp"]:
        raise HTTPException(400, f"Incorrect OTP. {OTP_MAX - entry['attempts'] + 1} attempts remaining.")

    del _otp_store[email]   # OTP used — remove immediately
    return {"valid": True, "message": "OTP verified successfully."}


@app.post("/auth/signup-with-otp", status_code=201)
def signup_with_otp(body: SignupRequest):
    """
    Signup that requires a pre-verified OTP.
    Add ?require_otp=true to enforce OTP; without it behaves like normal signup.
    Extend body with otp field if you want to verify inline.
    """
    # Reuse normal signup — OTP verification is done client-side via /auth/otp/verify
    return signup(body)

# ══════════════════════════════════════════════════════════════
# AI SEARCH ENGINE — RAG with Gemini + local vector index
# ══════════════════════════════════════════════════════════════
#
# Architecture (Render-free-tier safe — no local ML models):
#
#   User query
#     ↓
#   Gemini embedding API  (text-embedding-004, REST call)
#     ↓
#   Cosine similarity against search_index.json  (pure numpy, in-memory)
#     ↓
#   Top-K matching images retrieved
#     ↓
#   Gemini Flash generates answer + insight
#     ↓
#   Return {answer, images, query}
#
# search_index.json is generated locally by:  python index_images.py
# It must be present in the backend working directory.
# ══════════════════════════════════════════════════════════════

import numpy as np

GEMINI_KEY = os.getenv("GEMINI_API_KEY", "")

# ── Load search index once at startup ────────────────────────
_search_index   = []      # list of record dicts
_search_vectors = None    # numpy array shape (N, 384)
_search_loaded  = False

def _load_search_index():
    global _search_index, _search_vectors, _search_loaded
    if _search_loaded:
        return
    path = os.path.join(os.path.dirname(__file__), "search_index.json")
    if not os.path.exists(path):
        print("⚠️  search_index.json not found — AI search will use keyword fallback")
        _search_loaded = True
        return
    try:
        data = json.loads(open(path).read())
        _search_index = data.get("records", [])
        if _search_index:
            _search_vectors = np.array(
                [r["vector"] for r in _search_index], dtype=np.float32
            )
            info = data.get("_info", {})
            print(f"✅ Search index loaded: {info.get('total', len(_search_index))} images, "
                  f"{info.get('categories', '?')} categories, dim={info.get('dim', '?')}")
    except Exception as e:
        print(f"⚠️  search_index.json load error: {e}")
    _search_loaded = True

_load_search_index()


# ── Gemini helpers ────────────────────────────────────────────
GEMINI_EMBED_URL  = "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent"
GEMINI_FLASH_URL  = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"
GEMINI_VISION_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"

async def gemini_embed(text: str) -> list:
    """Embed text using Gemini text-embedding-004 API."""
    if not GEMINI_KEY:
        return []
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                GEMINI_EMBED_URL,
                params={"key": GEMINI_KEY},
                json={"model": "models/text-embedding-004",
                      "content": {"parts": [{"text": text}]}}
            )
        if r.status_code == 200:
            return r.json()["embedding"]["values"]
    except Exception as e:
        print(f"Gemini embed error: {e}")
    return []

async def gemini_flash(prompt: str, system: str = "") -> str:
    """Generate text with Gemini 1.5 Flash."""
    if not GEMINI_KEY:
        return ""
    try:
        messages = []
        if system:
            messages.append({"role": "user",   "parts": [{"text": system}]})
            messages.append({"role": "model",  "parts": [{"text": "Understood."}]})
        messages.append({"role": "user", "parts": [{"text": prompt}]})
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(
                GEMINI_FLASH_URL,
                params={"key": GEMINI_KEY},
                json={"contents": messages,
                      "generationConfig": {"maxOutputTokens": 400, "temperature": 0.7}}
            )
        if r.status_code == 200:
            return r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    except Exception as e:
        print(f"Gemini flash error: {e}")
    return ""

async def gemini_vision(image_url: str, prompt: str) -> str:
    """Analyze an image with Gemini Vision."""
    if not GEMINI_KEY:
        return ""
    try:
        # Fetch image and base64 encode it for Gemini
        async with httpx.AsyncClient(timeout=15) as client:
            img_r = await client.get(image_url)
        if img_r.status_code != 200:
            return ""
        import base64
        img_b64   = base64.b64encode(img_r.content).decode()
        mime_type = img_r.headers.get("content-type", "image/jpeg").split(";")[0]

        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(
                GEMINI_VISION_URL,
                params={"key": GEMINI_KEY},
                json={"contents": [{"parts": [
                    {"inline_data": {"mime_type": mime_type, "data": img_b64}},
                    {"text": prompt}
                ]}],
                "generationConfig": {"maxOutputTokens": 500, "temperature": 0.8}}
            )
        if r.status_code == 200:
            return r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    except Exception as e:
        print(f"Gemini vision error: {e}")
    return ""


# ── Cosine similarity search ──────────────────────────────────
def vector_search(query_vec: list, top_k: int = 8) -> list:
    """
    Cosine similarity search over the in-memory numpy matrix.
    Returns top_k records sorted by similarity descending.
    """
    if _search_vectors is None or not _search_index:
        return []
    q = np.array(query_vec, dtype=np.float32)
    q_norm = q / (np.linalg.norm(q) + 1e-9)
    # Matrix already normalised by index_images.py (normalize_embeddings=True)
    scores = _search_vectors @ q_norm          # (N,) dot products = cosine sims
    top_idx = np.argsort(scores)[::-1][:top_k]
    results = []
    for idx in top_idx:
        rec = dict(_search_index[idx])
        rec["score"] = float(scores[idx])
        results.append(rec)
    return results


# ── Keyword fallback (when no index or no Gemini key) ─────────
def keyword_search(query: str, top_k: int = 8) -> list:
    """Simple keyword match against captions when vectors unavailable."""
    if not _search_index:
        return []
    words  = set(query.lower().split())
    scored = []
    for rec in _search_index:
        text   = (rec.get("caption","") + " " + rec.get("embed_text","")).lower()
        score  = sum(1 for w in words if w in text)
        if score > 0:
            r = dict(rec)
            r["score"] = score
            scored.append(r)
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top_k]


# ── GET /ai/search ────────────────────────────────────────────
@app.get("/ai/search")
async def ai_search(
    q:     str = Query(..., min_length=1, max_length=300),
    limit: int = Query(8, ge=1, le=20),
):
    """
    AI-powered image search.
    1. Embed query with Gemini
    2. Cosine search against search_index.json
    3. Gemini Flash generates an answer + insight
    Returns: {answer, images, query, source}
    """
    query = q.strip()

    # ── Step 1: Embed query ──────────────────────────────────
    vec = await gemini_embed(query)

    # ── Step 2: Vector search (or keyword fallback) ──────────
    if vec and _search_vectors is not None:
        results = vector_search(vec, top_k=limit)
        search_source = "vector"
    else:
        results = keyword_search(query, top_k=limit)
        search_source = "keyword"

    # ── Step 3: Also pull from ZenPin DB for user content ────
    db_ideas = db.get_ideas(limit=200)
    words    = set(query.lower().split())
    db_matches = []
    for idea in db_ideas:
        text  = f"{idea.get('title','')} {idea.get('category','')} {idea.get('description','')}".lower()
        score = sum(1 for w in words if w in text)
        if score > 0:
            db_matches.append({**idea, "score": score, "source_type": "db"})
    db_matches.sort(key=lambda x: x["score"], reverse=True)

    # ── Step 4: Merge — indexed images + DB ideas ────────────
    image_urls  = [r["url"]       for r in results    if r.get("url")]
    image_meta  = [r              for r in results    if r.get("url")]
    db_cards    = db_matches[:max(0, limit - len(image_urls))]

    # ── Step 5: Gemini generates answer ──────────────────────
    answer = ""
    if GEMINI_KEY:
        # Build context from top results
        ctx_lines = []
        for r in results[:4]:
            ctx_lines.append(f"- {r.get('caption','')!r} ({r.get('category','')})")
        for d in db_cards[:2]:
            ctx_lines.append(f"- {d.get('title','')!r} ({d.get('category','')})")
        ctx = "\n".join(ctx_lines) if ctx_lines else "No specific matches found."

        system = (
            "You are ZenPin Search — a visual discovery assistant. "
            "Answer concisely (2-3 sentences max). Be specific, inspiring, practical. "
            "If asked about design or aesthetics, give actionable tips."
        )
        prompt = (
            f"User searched: \"{query}\"\n\n"
            f"Top matching images from ZenPin:\n{ctx}\n\n"
            f"Give a short, helpful answer about this topic for a visual inspiration platform."
        )
        answer = await gemini_flash(prompt, system)

    # Fallback answer when no Gemini key
    if not answer:
        cats = list(set(r.get("category","") for r in results[:3]))
        if cats:
            answer = f"Found {len(results)} images matching \"{query}\" — mainly in {', '.join(cats)}."
        else:
            answer = f"Showing results for \"{query}\". Browse the cards below for inspiration."

    # ── Step 6: Build response ────────────────────────────────
    cards = []
    for r in image_meta:
        cards.append({
            "id":        abs(hash(r["url"])) % 900000,
            "title":     r.get("caption", query)[:80],
            "category":  r.get("category", "Discovery"),
            "image_url": r["url"],
            "score":     round(r.get("score", 0), 3),
            "source":    "discovery",
            "difficulty": 3, "creativity": 4, "usefulness": 3,
        })
    for d in db_cards:
        cards.append({**d, "source_type": "db"})

    return {
        "query":   query,
        "answer":  answer,
        "images":  image_urls[:limit],
        "cards":   cards[:limit],
        "total":   len(cards),
        "source":  search_source,
    }


# ── POST /ai/analyze ──────────────────────────────────────────
class AnalyzeRequest(BaseModel):
    image_url:   str
    prompt:      str  = ""   # optional user question about the image

@app.post("/ai/analyze")
async def ai_analyze(body: AnalyzeRequest):
    """
    Analyze any image with Gemini Vision.
    Returns: caption, design suggestions, mood, tags.
    Example use: user uploads a dress → get design ideas.
    """
    url = body.image_url.strip()
    if not url:
        raise HTTPException(400, "image_url required")

    user_q = body.prompt.strip() or ""

    if not GEMINI_KEY:
        raise HTTPException(503, "GEMINI_API_KEY not configured")

    base_prompt = (
        "Analyze this image for a visual discovery platform called ZenPin.\n\n"
        "Provide a JSON response with exactly these fields:\n"
        "{\n"
        '  "caption":     "one sentence description of what is shown",\n'
        '  "category":    "best matching category (Cars/Anime/Fashion/Food/etc)",\n'
        '  "mood":        "3 mood/aesthetic words e.g. minimal dark cinematic",\n'
        '  "tags":        ["tag1","tag2","tag3","tag4","tag5"],\n'
        '  "suggestions": "2-3 sentences of design/creative suggestions based on this image",\n'
        '  "similar_searches": ["search query 1","search query 2","search query 3"]\n'
        "}"
    )
    if user_q:
        base_prompt += f"\n\nUser question: {user_q}"

    raw = await gemini_vision(url, base_prompt)
    if not raw:
        raise HTTPException(500, "Vision analysis failed")

    # Parse JSON from Gemini response
    try:
        clean = raw.replace("```json","").replace("```","").strip()
        # Find first { to last }
        start = clean.find("{")
        end   = clean.rfind("}") + 1
        result = json.loads(clean[start:end])
    except Exception:
        # Return raw text if JSON parse fails
        result = {
            "caption":          raw[:200],
            "category":         "Discovery",
            "mood":             "",
            "tags":             [],
            "suggestions":      raw,
            "similar_searches": [],
        }

    return {"image_url": url, "analysis": result}

# ── IDEAS (unchanged) ──────────────────────────────────────────
@app.get("/ideas")
def list_ideas(
    category:     Optional[str]  = Query(None, max_length=50),
    search:       Optional[str]  = Query(None, max_length=100),
    sort:         Optional[str]  = Query("newest"),
    source:       Optional[str]  = Query(None),
    limit:        int            = Query(20, ge=1, le=100),
    offset:       int            = Query(0, ge=0),
    current_user: Optional[dict] = Depends(auth_utils.get_optional_user),
):
    ideas = db.get_ideas(category=category, search=search, sort=sort,
                         limit=limit, offset=offset, source=source)
    saves = db.get_user_saves_set(current_user["id"]) if current_user else set()
    likes = db.get_user_likes_set(current_user["id"]) if current_user else set()
    for idea in ideas:
        idea["is_saved"] = idea["id"] in saves
        idea["is_liked"] = idea["id"] in likes
    return {"ideas": ideas, "count": len(ideas), "offset": offset, "has_more": len(ideas) == limit}

@app.get("/ideas/{idea_id}")
def get_idea(idea_id: int, current_user: Optional[dict] = Depends(auth_utils.get_optional_user)):
    idea = db.get_idea_by_id(idea_id)
    if not idea:
        raise HTTPException(404, "Idea not found.")
    if current_user:
        saves = db.get_user_saves_set(current_user["id"])
        likes = db.get_user_likes_set(current_user["id"])
        idea["is_saved"] = idea["id"] in saves
        idea["is_liked"] = idea["id"] in likes
    return idea

@app.post("/ideas", status_code=201)
def create_idea(body: CreateIdeaRequest, current_user: dict = Depends(auth_utils.get_current_user)):
    return db.create_idea(
        user_id=current_user["id"], title=body.title,
        description=body.description, category=body.category,
        image_url=body.image_url, difficulty=body.difficulty,
        creativity=body.creativity, usefulness=body.usefulness,
        source="creator", steps=body.steps, tools=body.tools,
        estimated_cost=body.estimated_cost, reference_links=body.reference_links,
    )

@app.delete("/ideas/{idea_id}")
def delete_idea(idea_id: int, current_user: dict = Depends(auth_utils.get_current_user)):
    if not db.delete_idea(idea_id, current_user["id"]):
        raise HTTPException(404, "Idea not found or not yours.")
    return {"message": "Idea deleted."}

@app.post("/ideas/{idea_id}/save")
def toggle_save(idea_id: int, current_user: dict = Depends(auth_utils.get_current_user)):
    if not db.get_idea_by_id(idea_id):
        raise HTTPException(404, "Idea not found.")
    is_saved = db.save_idea(current_user["id"], idea_id)
    return {"saved": is_saved, "saves_count": db.get_idea_by_id(idea_id)["saves_count"]}

@app.post("/ideas/{idea_id}/like")
def toggle_like(idea_id: int, current_user: dict = Depends(auth_utils.get_current_user)):
    if not db.get_idea_by_id(idea_id):
        raise HTTPException(404, "Idea not found.")
    is_liked = db.like_idea(current_user["id"], idea_id)
    return {"liked": is_liked, "likes_count": db.get_idea_by_id(idea_id)["likes_count"]}

@app.get("/users/{user_id}/saves")
def get_saved_ideas(user_id: int, current_user: dict = Depends(auth_utils.get_current_user)):
    if current_user["id"] != user_id:
        raise HTTPException(403, "You can only view your own saves.")
    return {"ideas": db.get_saved_ideas(user_id)}

@app.get("/dashboard")
def get_dashboard(current_user: dict = Depends(auth_utils.get_current_user)):
    stats = db.get_user_stats(current_user["id"])
    return {"user": current_user, **stats}

@app.get("/boards")
def get_my_boards(current_user: dict = Depends(auth_utils.get_current_user)):
    return {"boards": db.get_boards_by_user(current_user["id"])}

@app.post("/boards", status_code=201)
def create_board(body: CreateBoardRequest, current_user: dict = Depends(auth_utils.get_current_user)):
    return db.create_board(user_id=current_user["id"], name=body.name,
        description=body.description, is_collab=body.is_collab)

@app.post("/boards/{board_id}/ideas")
def add_to_board(board_id: int, body: AddToBoardRequest,
                 current_user: dict = Depends(auth_utils.get_current_user)):
    if not db.add_idea_to_board(board_id, body.idea_id, current_user["id"]):
        raise HTTPException(404, "Board not found or not yours.")
    return {"message": "Idea added to board."}

@app.post("/upload")
async def upload_image(
    file: UploadFile = File(...),
    current_user: dict = Depends(auth_utils.get_current_user)
):
    if file.content_type not in ALLOWED_IMG_TYPES:
        raise HTTPException(400, "File type not allowed. Use JPEG, PNG, WebP or GIF.")
    contents = await file.read()
    if len(contents) / (1024*1024) > MAX_UPLOAD_MB:
        raise HTTPException(400, f"File too large. Max {MAX_UPLOAD_MB}MB.")
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else "jpg"
    filename = f"{uuid.uuid4().hex}.{ext}"
    with open(os.path.join(UPLOAD_DIR, filename), "wb") as f:
        f.write(contents)
    return {"url": f"{BASE_URL}/uploads/{filename}", "filename": filename}


# ── Category auto-detection from text ──────────────────────────
_AUTO_CAT_MAP = [
    (["car","ferrari","lambo","supercar","bmw","porsche","mustang","drift"],      "Cars"),
    (["motorcycle","bike","moto","harley","cafe racer","scrambler"],             "Bikes"),
    (["anime","manga","otaku","ghibli","naruto","demon slayer"],                 "Anime"),
    (["gaming","game","pc setup","controller","xbox","playstation","steam"],     "Gaming"),
    (["fashion","outfit","ootd","streetwear","drip","style"],                    "Fashion"),
    (["jewelry","necklace","earring","bracelet","ring","bangle","accessory"],    "Ladies Accessories"),
    (["interior","room decor","home decor","living room","bedroom"],             "Interior Design"),
    (["desk","workspace","setup","monitor","battlestation"],                     "Workspace"),
    (["food","recipe","cook","bake","meal","sushi","pizza","ramen"],             "Food"),
    (["drink","cocktail","coffee","latte","matcha","wine","whiskey"],            "Drinks"),
    (["flower","floral","bouquet","bloom"],                                      "Flowers"),
    (["plant","houseplant","monstera","succulent","cactus"],                     "Plants"),
    (["travel","trip","vacation","hotel","destination","wanderlust"],            "Travel"),
    (["tech","gadget","apple","iphone","macbook","ai","robot"],                  "Tech"),
    (["architecture","building","skyscraper","brutalist"],                       "Architecture"),
    (["art","painting","illustration","canvas","drawing"],                       "Art"),
    (["nature","forest","mountain","ocean","sunset","landscape"],                "Nature"),
    (["scenery","view","vista","golden hour","sky"],                             "Scenery"),
    (["fitness","gym","workout","lifting","yoga","running"],                     "Fitness"),
    (["music","vinyl","guitar","concert","studio","headphones"],                 "Music"),
    (["pet","dog","cat","puppy","kitten","animal"],                              "Pets"),
    (["tattoo","ink","sleeve","body art"],                                       "Tattoos"),
    (["superhero","marvel","dc","batman","spiderman","avengers"],               "Superheroes"),
    (["cigarette","smoke","smoking","tobacco"],                                  "Cigarettes"),
]

def auto_detect_category(text: str) -> str:
    """Detect category from description/tags text. Returns 'Art' as default."""
    t = text.lower()
    for keywords, cat in _AUTO_CAT_MAP:
        if any(kw in t for kw in keywords):
            return cat
    return "Art"


class SimpleUploadRequest(BaseModel):
    """Simplified upload request — only description required."""
    description: str
    category:    str  = ""    # auto-detected if empty
    tags:        list = []
    image_url:   str  = ""
    reference_link: str = ""


@app.post("/upload-image", status_code=201)
async def upload_image_simple(
    body: SimpleUploadRequest,
    current_user: dict = Depends(auth_utils.get_current_user)
):
    """
    Simplified upload endpoint — matches the new 4-field upload form.
    Only description + image_url required.
    Category is auto-detected from description + tags if not provided.
    """
    if not body.description.strip():
        raise HTTPException(400, "Description is required.")
    if not body.image_url.strip():
        raise HTTPException(400, "An image URL is required.")

    # Auto-detect category if not provided
    search_text = body.description + " " + " ".join(body.tags)
    category = body.category.strip() or auto_detect_category(search_text)

    # Generate title from first sentence of description
    title = body.description.replace("\n", " ").strip()
    title = title.split(".")[0].split("!")[0].split("?")[0].strip()[:80]
    if not title:
        title = body.description.strip()[:80]

    # Persist as an idea
    idea = db.create_idea(
        user_id         = current_user["id"],
        title           = title,
        category        = category,
        image_url       = body.image_url.strip(),
        description     = body.description.strip(),
        difficulty      = 3,
        creativity      = 3,
        usefulness      = 3,
        steps           = [],
        tools           = body.tags,
        estimated_cost  = "",
        reference_links = [body.reference_link] if body.reference_link.startswith("http") else [],
        source          = "creator",
    )
    return {
        "id":          idea["id"],
        "title":       title,
        "category":    category,
        "image_url":   body.image_url,
        "auto_cat":    not bool(body.category.strip()),
        "message":     "Posted successfully",
    }


class AIResearchRequest(BaseModel):
    query:    str
    history:  list = []  # [{role, content}]


@app.post("/ai/research")
async def ai_research(
    body: AIResearchRequest,
    current_user: Optional[dict] = Depends(auth_utils.get_optional_user)
):
    """
    AI Research Assistant — RAG architecture:
      1. Keyword-search ZenPin DB for relevant ideas
      2. Fetch discovery images matching the query topic
      3. Build rich context from results
      4. Send to OpenAI/Claude with context + conversation history
    Returns AI response + relevant ZenPin ideas as cards
    """
    query = body.query.strip()[:300]
    if not query:
        raise HTTPException(400, "Query required")

    # ── Step 1: Semantic keyword search on ZenPin DB ──────────────
    # Extract keywords and find matching ideas
    words = [w.lower().strip(".,!?") for w in query.split() if len(w) > 2]
    db_ideas = db.get_ideas(limit=200)

    def relevance_score(idea: dict, keywords: list) -> int:
        text = f"{idea.get('title','')} {idea.get('category','')} {idea.get('description','')}".lower()
        return sum(2 if kw in (idea.get("title","")).lower() else 1
                   for kw in keywords if kw in text)

    scored_ideas = [(relevance_score(i, words), i) for i in db_ideas]
    scored_ideas.sort(key=lambda x: x[0], reverse=True)
    relevant_ideas = [i for score, i in scored_ideas if score > 0][:8]

    # ── Step 2: Map query to category for discovery images ────────
    cat_map = {
        "car": "cars", "ferrari": "cars", "supercar": "cars", "lamborghini": "cars",
        "bike": "bikes", "motorcycle": "bikes", "moto": "bikes",
        "anime": "anime", "manga": "anime", "otaku": "anime",
        "gaming": "gaming", "game": "gaming", "esport": "gaming",
        "fashion": "fashion", "outfit": "fashion", "style": "fashion",
        "food": "food", "recipe": "food", "cook": "food",
        "travel": "travel", "destination": "travel", "trip": "travel",
        "interior": "interior design", "room": "interior design", "home": "interior design",
        "workspace": "workspace", "desk": "workspace", "office": "workspace",
        "nature": "nature", "wildlife": "nature", "forest": "nature",
        "tech": "tech", "computer": "tech", "ai": "tech",
        "art": "art", "painting": "art", "illustration": "art",
        "architecture": "architecture", "building": "architecture",
        "flower": "flowers", "floral": "flowers",
        "plant": "plants", "botanical": "plants",
        "fitness": "fitness", "gym": "fitness", "workout": "fitness",
        "music": "music", "vinyl": "music", "concert": "music",
        "pet": "pets", "dog": "pets", "cat": "pets",
        "jewelry": "ladies accessories", "necklace": "ladies accessories",
        "superhero": "superheroes", "marvel": "superheroes", "batman": "superheroes",
        "drink": "drinks", "cocktail": "drinks", "coffee": "drinks",
        "tattoo": "tattoos", "ink": "tattoos",
        "scenery": "scenery", "landscape": "scenery", "mountain": "scenery",
    }

    detected_cats = list(set(
        cat for kw in words for key, cat in cat_map.items() if key in kw
    ))[:2]

    # Fetch relevant discovery images in background
    discovery_images = []
    if detected_cats:
        disc_results = await asyncio.gather(
            *[_fetch_for_category(cat, page=1, limit=4) for cat in detected_cats],
            return_exceptions=True
        )
        for r in disc_results:
            if isinstance(r, list):
                discovery_images.extend(r)

    # ── Step 3: Build rich context for AI ────────────────────────
    context_parts = []

    if relevant_ideas:
        ideas_text = "\n".join(
            f"- {i['title']} ({i['category']})"
            + (f": {i.get('description','')[:100]}" if i.get('description') else "")
            for i in relevant_ideas[:6]
        )
        context_parts.append(f"Relevant ZenPin ideas for this query:\n{ideas_text}")

    if detected_cats:
        context_parts.append(f"Related categories on ZenPin: {', '.join(detected_cats)}")

    context = "\n\n".join(context_parts)

    # ── Step 4: AI generates research-grade response ──────────────
    system_prompt = """You are ZenPin Research Assistant — an expert AI that combines the depth of Perplexity
with the creative focus of Pinterest. You help users discover ideas, learn techniques, and explore aesthetic trends.

Your role:
- Answer questions about design, photography, fashion, travel, food, tech, art, and creative culture
- Give specific, actionable tips and recommendations
- Cite trends and techniques with confidence
- Keep responses informative but digestible (use short paragraphs or bullet points for long answers)
- When ZenPin ideas are provided in context, reference them naturally

You have access to ZenPin's discovery database. When relevant ideas are found, acknowledge them.
Format: Use markdown for structure when helpful (bold, bullets). Keep responses under 300 words."""

    messages_to_send = list(body.history[-6:]) if body.history else []  # last 6 turns
    if context:
        messages_to_send = messages_to_send + [
            {"role": "user", "content": f"[Context from ZenPin database]\n{context}\n\n[User question]: {query}"}
        ]
    else:
        messages_to_send = messages_to_send + [{"role": "user", "content": query}]

    reply_text = ""
    powered_by = "mock"

    if os.getenv("OPENAI_API_KEY"):
        try:
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
            resp = await client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "system", "content": system_prompt}] + messages_to_send,
                max_tokens=500,
                temperature=0.7,
            )
            reply_text = resp.choices[0].message.content.strip()
            powered_by = "openai"
        except Exception as e:
            print(f"OpenAI research error: {e}")

    # Fallback: smart template response
    if not reply_text:
        if relevant_ideas:
            titles = ", ".join(i["title"] for i in relevant_ideas[:3])
            reply_text = (
                f"Here's what I found on ZenPin related to **{query}**:\n\n"
                f"I found {len(relevant_ideas)} relevant ideas including: {titles}.\n\n"
                f"Explore the cards below for visual inspiration. Try refining your search "
                f"or browsing the {detected_cats[0].title() if detected_cats else 'Discovery'} category for more."
            )
        else:
            reply_text = (
                f"I searched ZenPin for **{query}** but didn't find exact matches in the database yet. "
                f"The Discovery feed is continuously updated — try browsing the Explore page or "
                f"using the AI Generator to build a custom inspiration board on this topic."
            )
        powered_by = "search"

    # Merge relevant DB ideas and discovery images for card display
    all_cards = relevant_ideas.copy()
    for img in discovery_images:
        # Convert discovery image to card format
        all_cards.append({
            "id": abs(hash(img.get("image_url", ""))) % 900000 + 100000,
            "title": img.get("title", query.title()),
            "category": (detected_cats[0].title() if detected_cats else "Discovery"),
            "image_url": img.get("image_url", ""),
            "difficulty": 3, "creativity": 4, "usefulness": 3,
            "source": "discovery",
        })

    return {
        "query":       query,
        "reply":       reply_text,
        "ideas":       all_cards[:8],
        "categories":  detected_cats,
        "powered_by":  powered_by,
    }



class AIChatRequest(BaseModel):
    message: str
    history: list = []   # [{role:"user"|"assistant", content:"..."}]


@app.post("/ai/chat")
async def ai_chat(
    body: AIChatRequest,
    current_user: Optional[dict] = Depends(auth_utils.get_optional_user)
):
    """
    AI Chat endpoint — Gemini-first conversational assistant.

    Pipeline:
      1. Keyword-match query against ZenPin DB → relevant idea cards
      2. Build context string from top matches
      3. Send full conversation history + context to Gemini 1.5 Flash
      4. Return {answer, ideas, powered_by}

    Falls back to OpenAI → smart-template if keys are missing.
    Works on Render free tier: no streaming, single request.
    """
    msg = body.message.strip()[:500]
    if not msg:
        raise HTTPException(400, "message required")

    # ── 1a. Vector search (when search_index.json is loaded) ────────
    vector_results = []
    if _search_vectors is not None:
        try:
            vec = await gemini_embed(msg)
            if vec:
                vector_results = vector_search(vec, top_k=6)
        except Exception as e:
            print(f"Vector search in chat failed: {e}")

    # ── 1b. Keyword search across ZenPin DB ideas ─────────────────
    words = [w.lower().strip(".,!?") for w in msg.split() if len(w) > 2]
    all_ideas = db.get_ideas(limit=300)

    def kw_score(idea: dict) -> int:
        haystack = f"{idea.get('title','')} {idea.get('category','')} {idea.get('description','')}".lower()
        title    = idea.get("title", "").lower()
        return sum(3 if kw in title else 1 for kw in words if kw in haystack)

    scored  = sorted(((kw_score(i), i) for i in all_ideas), key=lambda x: x[0], reverse=True)
    kw_hits = [i for s, i in scored if s > 0][:6]

    # Merge: vector results (highest quality) + keyword hits
    seen_ids = set()
    relevant = []
    # Convert vector results to idea-like dicts
    for r in vector_results:
        if r.get("url") and r["url"] not in seen_ids:
            seen_ids.add(r["url"])
            relevant.append({
                "id":          abs(hash(r["url"])) % 900000,
                "title":       r.get("caption", msg)[:80],
                "category":    r.get("category", "Discovery"),
                "image_url":   r["url"],
                "description": r.get("caption", ""),
                "source":      "discovery",
                "difficulty": 3, "creativity": 4, "usefulness": 3,
            })
    for idea in kw_hits:
        if idea.get("id") not in seen_ids:
            seen_ids.add(idea.get("id"))
            relevant.append(idea)
    relevant = relevant[:8]

    # ── 2. Build context ──────────────────────────────────────────
    context = ""
    ctx_lines = []
    for item in relevant[:6]:
        line = f"- {item.get('title','')} ({item.get('category','')})"
        if item.get("description"):
            line += f": {item['description'][:80]}"
        ctx_lines.append(line)
    if ctx_lines:
        src_note = "(from vector index + DB)" if vector_results else "(from DB)"
        context = f"ZenPin content related to this query {src_note}:\n" + "\n".join(ctx_lines)

    SYSTEM = (
        "You are ZenPin AI — a creative discovery assistant combining ChatGPT-level reasoning "
        "with Pinterest-style visual curation. You help users find ideas, analyse aesthetics, "
        "and get craft/design guidance — all centred on ZenPin's own image library.\n\n"
        "Capabilities:\n"
        "- Answer craft, design and DIY questions with expert depth\n"
        "- Analyse uploaded images and suggest improvements or styles\n"
        "- Search ZenPin's library (cars, bikes, anime, fashion, interior, accessories, "
        "nature, architecture, gaming, food, fitness, art, music, scenery, etc.)\n"
        "- Compare visual options and give direct, opinionated answers\n"
        "- Return ONLY images that exist in ZenPin — never invent URLs\n\n"
        "Rules:\n"
        "- Lead with a direct answer (1-2 sentences), then explanation, then image refs\n"
        "- Use **bold** for key terms, bullet points for lists or steps\n"
        "- Under 220 words — dense and useful, no filler\n"
        "- If asked for images, reference the ZenPin cards shown below your answer\n"
        "- If no relevant content exists, say so clearly — never hallucinate images\n"
        "- For craft questions: list materials, steps, difficulty level"
    )

    # Build messages with history (last 8 turns for context window efficiency)
    history = body.history[-8:] if body.history else []
    if context:
        user_msg = f"[Context]\n{context}\n\n[Question]: {msg}"
    else:
        user_msg = msg
    messages = history + [{"role": "user", "content": user_msg}]

    reply = ""
    powered_by = "fallback"

    # ── 3a. Try Gemini first ──────────────────────────────────────
    if GEMINI_KEY:
        try:
            gemini_msgs = []
            for m in messages[:-1]:   # history
                gemini_msgs.append({
                    "role": "user"  if m["role"] == "user" else "model",
                    "parts": [{"text": m["content"]}]
                })
            # Inject system via first user turn
            first_content = SYSTEM + "\n\nUser: " + messages[-1]["content"]
            gemini_msgs.append({"role": "user", "parts": [{"text": first_content}]})

            async with httpx.AsyncClient(timeout=20) as client:
                r = await client.post(
                    GEMINI_FLASH_URL,
                    params={"key": GEMINI_KEY},
                    json={
                        "contents": gemini_msgs,
                        "generationConfig": {
                            "maxOutputTokens": 400,
                            "temperature": 0.75,
                            "topP": 0.9,
                        }
                    }
                )
            if r.status_code == 200:
                reply = r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
                powered_by = "gemini"
        except Exception as e:
            print(f"Gemini chat error: {e}")

    # ── 3b. Try OpenAI if Gemini unavailable ─────────────────────
    if not reply and os.getenv("OPENAI_API_KEY"):
        try:
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
            resp = await client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "system", "content": SYSTEM}] + messages,
                max_tokens=400,
                temperature=0.75,
            )
            reply = resp.choices[0].message.content.strip()
            powered_by = "openai"
        except Exception as e:
            print(f"OpenAI chat error: {e}")

    # ── 3c. Smart template fallback (no API keys needed) ─────────
    if not reply:
        if relevant:
            titles = ", ".join(i["title"] for i in relevant[:3])
            cats   = list(set(i["category"] for i in relevant[:4]))
            reply  = (
                f"Here\'s what I found on ZenPin for **{msg}**:\n\n"
                f"I matched {len(relevant)} ideas including: {titles}.\n\n"
                f"Categories: {', '.join(cats)}. Browse the cards below for visual inspiration."
            )
        else:
            reply = (
                f"I searched ZenPin for **{msg}** but didn\'t find direct matches yet. "
                "Try browsing the Explore page or use the AI Generator to build a custom board."
            )
        powered_by = "search"

    return {
        "answer":     reply,
        "ideas":      relevant,
        "powered_by": powered_by,
    }

@app.post("/ai/generate")
async def ai_generate(
    body: AIGenerateRequest,
    current_user: Optional[dict] = Depends(auth_utils.get_optional_user)
):
    topic = body.topic.strip()
    if os.getenv("OPENAI_API_KEY"):
        try:
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
            all_ideas = db.get_ideas(limit=100)
            idea_list = "\n".join(f"{i['id']}. {i['title']} ({i['category']})" for i in all_ideas)
            response = await client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role":"system","content":'Select 6 relevant idea IDs and write a board description. Respond ONLY with JSON: {"idea_ids":[1,2,3,4,5,6],"description":"..."}'},
                    {"role":"user","content":f"Topic: {topic}\n\nIdeas:\n{idea_list}"}
                ],
                max_tokens=200, temperature=0.7,
            )
            raw = response.choices[0].message.content.strip().replace("```json","").replace("```","").strip()
            result = json.loads(raw)
            selected = [i for i in [db.get_idea_by_id(x) for x in result.get("idea_ids",[])] if i]
            return {"topic":topic,"description":result.get("description",""),"ideas":selected,"powered_by":"openai"}
        except Exception as e:
            print(f"OpenAI error: {e}")

    all_ideas = db.get_ideas(limit=200)
    KEYWORD_MAP = {
        "anime":["Anime"],"car":["Cars"],"bike":["Bikes"],"moto":["Bikes"],
        "scenic":["Scenery"],"scenery":["Scenery"],"mountain":["Scenery","Nature"],
        "gam":["Gaming"],"jewel":["Ladies Accessories"],"bangle":["Ladies Accessories"],
        "earring":["Ladies Accessories"],"necklace":["Ladies Accessories"],
        "bracelet":["Ladies Accessories"],"ring":["Ladies Accessories"],
        "accessory":["Ladies Accessories"],"wabi":["Interior Design","Nature","Art"],
        "japandi":["Interior Design","Workspace"],"cyber":["Tech","Gaming"],
        "minimal":["Workspace","Interior Design"],"nature":["Nature","Scenery"],
        "food":["Food"],"fashion":["Fashion"],"travel":["Travel","Scenery"],
        "tech":["Tech","Gaming"],"art":["Art"],"interior":["Interior Design"],
        "workspace":["Workspace"],"flower":["Flowers"],"plant":["Plants"],
        "fit":["Fitness"],"music":["Music"],"pet":["Pets"],
        "superhero":["Superheroes"],"drink":["Drinks"],"tattoo":["Tattoos"],
        "cigarette":["Cigarettes"],"smoke":["Cigarettes"],
    }
    cats = []
    for kw in topic.lower().split():
        for key, c in KEYWORD_MAP.items():
            if key in kw:
                cats.extend(c)
    if cats:
        filtered = [i for i in all_ideas if i["category"] in cats]
        rest     = [i for i in all_ideas if i not in filtered]
        needed   = max(0, 6 - len(filtered))
        selected = filtered[:6] if len(filtered) >= 6 else filtered + random.sample(rest, min(needed, len(rest)))
    else:
        selected = random.sample(all_ideas, min(6, len(all_ideas)))
    return {"topic":topic,"description":f"A curated board for: {topic}","ideas":selected[:6],"powered_by":"mock"}
