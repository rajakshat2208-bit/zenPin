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

CATEGORY_QUERIES = {
    "cars": [
        "sports car ferrari lamborghini photography",
        "supercar automotive luxury vehicle",
        "classic muscle car racing track",
        "exotic car studio shoot",
    ],
    "bikes": [
        "sports motorcycle cafe racer photography",
        "superbike racing motorcycle track",
        "harley davidson custom chopper bike",
        "adventure motorcycle touring ride",
    ],
    "anime": [
        "anime illustration digital art wallpaper",
        "anime aesthetic japan tokyo neon",
        "manga character artwork fan art",
        "studio ghibli fantasy anime scene",
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
    ],
    "fashion": [
        "fashion editorial style outfit photography",
        "streetwear lookbook runway clothing",
        "high fashion designer couture shoot",
        "aesthetic outfit ootd style photo",
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
    ],
    "travel": [
        "travel destination architecture landmark",
        "santorini bali paris travel photography",
        "adventure travel explore mountain city",
        "aerial travel cityscape destination photo",
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
        "superhero comic book batman superman",
        "marvel DC superhero cosplay costume",
        "action figure collectible superhero toy",
        "superhero artwork comic illustration",
    ],
    "drinks": [
        "cocktail craft bar drink photography",
        "coffee latte art espresso barista",
        "whiskey wine champagne beverage",
        "craft beer smoothie drink aesthetic",
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
    +1 if partial/related keyword match
    -3 for each reject keyword found
    Accept if score >= 1
    """
    cat = category.lower()
    accept_kws = CATEGORY_ACCEPT_KEYWORDS.get(cat, [cat])
    reject_kws = CATEGORY_REJECT_KEYWORDS.get(cat, [])

    # Build searchable text from all image metadata
    title = (image.get("title") or "").lower()
    tags  = (image.get("tags")  or "").lower()
    desc  = (image.get("description") or image.get("alt_description") or "").lower()
    combined = f"{title} {tags} {desc}"

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

    # Negative scoring — reject cross-contamination
    for kw in reject_kws:
        kw_l = kw.lower()
        if kw_l in combined:
            score -= 3

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

    # If primary query got few results, try secondary queries
    all_raw = []
    for r in raw_results:
        if isinstance(r, list): all_raw.extend(r)

    if len(all_raw) < limit and len(queries) > 1:
        secondary_results = await asyncio.gather(
            fetch_unsplash(cat, queries[1], page, limit),
            fetch_pexels(  cat, queries[1], page, limit),
            return_exceptions=True
        )
        for r in secondary_results:
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

    # Deduplicate by URL
    seen_urls: set = set()
    filtered: list = []
    for score, img in scored_raw:
        url = img.get("image_url", "")
        if url and url not in seen_urls and score >= 1:
            seen_urls.add(url)
            filtered.append(img)

    print(f"  Filtered: {len(filtered)} (score≥1) → top {limit}")
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
