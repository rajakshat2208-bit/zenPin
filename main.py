# main.py — ZenPin API v2.0
# ─────────────────────────────────────────────────────────────
# Features:
#   - Discovery image system (Unsplash API + fallback)
#   - All new categories: Anime, Cars, Bikes, Scenery, Gaming,
#     Ladies Accessories (bangles, earrings, etc.)
#   - Creator post system (user uploads with steps/tools/cost)
#   - Mixed content feed (discovery + creator)
#   - Discovery cache (avoid hammering external APIs)
#   - Pagination on all endpoints
# ─────────────────────────────────────────────────────────────

import os, uuid, json, random, httpx
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

# ── Directory setup — must happen before StaticFiles mounts ──
_upload_dir = os.getenv("UPLOAD_DIR", "uploads")
os.makedirs(_upload_dir, exist_ok=True)

BASE_URL          = os.getenv("BASE_URL", "http://localhost:8000")
UPLOAD_DIR        = _upload_dir
MAX_UPLOAD_MB     = int(os.getenv("MAX_UPLOAD_MB", "10"))
UNSPLASH_KEY      = os.getenv("UNSPLASH_ACCESS_KEY", "")
PEXELS_KEY        = os.getenv("PEXELS_API_KEY", "")
PIXABAY_KEY       = os.getenv("PIXABAY_API_KEY", "")
ALLOWED_IMG_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

# ── Category → search query mapping for external APIs ──────────
CATEGORY_QUERIES = {
    "anime":               "anime aesthetic wallpaper art",
    "cars":                "supercar sports car photography",
    "bikes":               "sports motorcycle bike photography",
    "scenery":             "landscape nature scenery photography",
    "architecture":        "modern architecture building design",
    "gaming":              "gaming setup desk RGB",
    "workspace":           "minimal desk workspace setup",
    "fashion":             "fashion style editorial photography",
    "ladies accessories":  "jewelry accessories fashion",
    "bangles":             "colorful glass bangles jewelry",
    "earrings":            "earrings jewelry fashion",
    "scrunchies":          "scrunchie hair accessories colorful",
    "bracelets":           "bracelets stacked jewelry wrist",
    "rings":               "rings jewelry fingers fashion",
    "necklaces":           "necklace layered gold jewelry",
    "interior design":     "interior design home decor",
    "art":                 "art painting creative abstract",
    "nature":              "nature outdoor beautiful landscape",
    "food":                "food photography aesthetic",
    "travel":              "travel destination photography",
    "tech":                "technology gadgets aesthetic",
}

# ── Keyword-matched fallback via loremflickr (no API key needed) ──
# loremflickr.com returns real Flickr photos by keyword
# ?lock=N = unique consistent photo for that number → infinite variety

CATEGORY_FLICKR_KEYWORDS = {
    "cars":               "car,automobile,supercar",
    "bikes":              "motorcycle,motorbike",
    "anime":              "anime,manga,japan",
    "scenery":            "landscape,mountain,nature",
    "gaming":             "gaming,videogame,controller",
    "fashion":            "fashion,clothing,style",
    "nature":             "nature,forest,wildlife",
    "food":               "food,cuisine,cooking",
    "travel":             "travel,city,destination",
    "tech":               "technology,computer,digital",
    "art":                "art,painting,creative",
    "architecture":       "architecture,building,design",
    "workspace":          "workspace,desk,office",
    "interior design":    "interior,livingroom,homedecor",
    "ladies accessories": "jewelry,accessories,necklace",
    "bangles":            "bangles,bracelets,jewelry",
    "earrings":           "earrings,jewelry",
    "scrunchies":         "scrunchies,hairband",
    "bracelets":          "bracelets,jewelry",
    "rings":              "rings,jewelry",
    "necklaces":          "necklace,jewelry",
}

CATEGORY_TITLES = {
    "cars":               ["Supercar Shot","Classic Garage","Sports Car","Race Track","Luxury Drive","Vintage Car","Midnight Drive","Track Day"],
    "bikes":              ["Sports Bike","Cafe Racer","Adventure Ride","Garage Workshop","Mountain Road","Chopper Build","Night Ride","Supermoto"],
    "anime":              ["Anime Aesthetic","Neon City","Tokyo Streets","Pastel Dream","Cherry Blossom","Cyberpunk","Kawaii Room","Fantasy Scene"],
    "scenery":            ["Mountain Lake","Aurora Night","Misty Forest","Desert Dunes","Ocean Cliff","Lavender Field","Snowy Valley","Tropical Falls"],
    "gaming":             ["RGB Setup","Retro Console","Gaming Desk","Controller Lay","Neon Station","Mech Keyboard","VR Room","Streaming Setup"],
    "fashion":            ["Street Style","Editorial Look","Summer Outfit","Dark Academia","Boho Chic","Runway Look","Vintage Denim","Power Suit"],
    "nature":             ["Forest Path","Desert Dunes","Jungle Canopy","Wildflowers","Snowy Forest","Tide Pool","Rolling Hills","Autumn Trail"],
    "food":               ["Sourdough Art","Japanese Breakfast","Pasta Dish","Matcha Latte","Charcuterie","Dessert","Street Food","Coffee Pour"],
    "travel":             ["Santorini","Bali Terraces","Moroccan Riad","Iceland Falls","Tokyo Crossing","Amalfi Coast","Desert Safari","Venice Canals"],
    "tech":               ["Circuit Board","3D Printer","Drone Shot","Server Room","Robotics Lab","Code Screen","Smart Home","VR Headset"],
    "art":                ["Abstract Canvas","Ink Wash","Oil Painting","Watercolour","Digital Art","Street Mural","Ceramic Work","Collage Art"],
    "architecture":       ["Glass Tower","Spiral Stair","Brutalist Form","White Interior","Modern Bridge","Bamboo Pavilion","Desert House","Cathedral Vault"],
    "workspace":          ["Minimal Desk","Dual Monitor","Creative Studio","Cosy Office","Standing Desk","Bookshelf Wall","Morning Coffee","Plant Desk"],
    "interior design":    ["Japandi Room","Wabi-Sabi Bed","Earthy Lounge","Reading Nook","Modern Kitchen","Boho Living","Scandi Space","Gallery Wall"],
    "ladies accessories": ["Gold Bangles","Pearl Earrings","Scrunchie Set","Layered Necklace","Crystal Bracelets","Statement Rings","Velvet Headband","Charm Bracelet"],
}

_HEIGHTS = [700, 750, 680, 800, 720, 760, 650, 740]

def get_flickr_fallback(cat: str, page: int = 1, limit: int = 12) -> list:
    """Generate loremflickr URLs — keyword-matched, truly infinite."""
    keywords = CATEGORY_FLICKR_KEYWORDS.get(cat, f"{cat},photography")
    titles   = CATEGORY_TITLES.get(cat, [f"{cat.title()} photo"])
    result   = []
    for i in range(limit):
        gidx = (page - 1) * limit + i
        lock = gidx + 1
        h    = _HEIGHTS[gidx % len(_HEIGHTS)]
        result.append({
            "title":     titles[gidx % len(titles)],
            "image_url": f"https://loremflickr.com/500/{h}/{keywords}?lock={lock}",
            "source":    "discovery",
        })
    return result

# Legacy — kept for reference only
FALLBACK_IMAGES = {}

# ── App startup ─────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    db.seed_demo_ideas()
    print("🚀 ZenPin API v2.0 is live")
    yield

app = FastAPI(title="ZenPin API", version="2.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")


# ── Health check ────────────────────────────────────────────────
@app.get("/")
def root():
    return {
        "status": "ok", "app": "ZenPin API", "version": "2.1.0",
        "cors": "open", "ai": "public",
        "categories": list(CATEGORY_QUERIES.keys()),
    }


# ── Pydantic models ─────────────────────────────────────────────
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
    social_links: Optional[dict] = Field(None)   # {"instagram":"...", "twitter":"..."}

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


# ── AUTH ────────────────────────────────────────────────────────
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
    # Check username uniqueness if changing it
    if body.username and body.username != current_user.get("username"):
        if db.get_user_by_username(body.username):
            raise HTTPException(409, "That username is already taken.")
    return db.update_user_profile(
        current_user["id"],
        bio=body.bio,
        username=body.username,
        location=body.location,
        social_links=body.social_links,
    )


# ── DISCOVERY IMAGE SYSTEM ──────────────────────────────────────
@app.get("/images/category")
async def get_discovery_images(
    name:  str = Query(..., min_length=1, max_length=50),
    page:  int = Query(1, ge=1, le=20),
    limit: int = Query(12, ge=1, le=30),
):
    """
    Fetch discovery images for a category.
    Checks cache first (60 min TTL), then tries Unsplash, then Pexels, then fallback.
    """
    cat = name.lower().strip()

    # 1. Check cache
    cached = db.get_cached_discovery(cat, page, max_age_minutes=60)
    if cached:
        print(f"📦 Cache hit: {cat} p{page} ({len(cached)} images)")
        return {"category": cat, "page": page, "source": "cache", "images": cached[:limit]}

    images = []
    print(f"🔍 Fetching: {cat} p{page} | unsplash={'yes' if UNSPLASH_KEY else 'no'} | pexels={'yes' if PEXELS_KEY else 'no'}")

    # 2. Try Unsplash (backend API call — works fine from server)
    if UNSPLASH_KEY:
        query = CATEGORY_QUERIES.get(cat, cat + " photography")
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                r = await client.get(
                    "https://api.unsplash.com/search/photos",
                    params={"query": query, "page": page, "per_page": limit,
                            "orientation": "portrait"},
                    headers={"Authorization": f"Client-ID {UNSPLASH_KEY}"}
                )
            if r.status_code == 200:
                data = r.json()
                images = [
                    {
                        "title":     p.get("alt_description") or p.get("slug","").replace("-", " ").title() or f"{cat} photo",
                        # Use small size for fast loading, regular for modal
                        "image_url": p["urls"].get("regular", p["urls"].get("small", "")),
                        "thumb_url": p["urls"].get("small",   p["urls"].get("thumb",  "")),
                        "source":    "unsplash",
                        "author":    p["user"]["name"],
                        "author_url":p["user"]["links"]["html"],
                    }
                    for p in data.get("results", [])
                    if p.get("urls", {}).get("regular")
                ]
                print(f"✅ Unsplash: got {len(images)} images for '{cat}'")
        except Exception as e:
            print(f"Unsplash error: {e}")

    # 3. Try Pixabay if Unsplash failed (free: 100 req/min, 20 results each)
    if not images and PIXABAY_KEY:
        query = CATEGORY_QUERIES.get(cat, cat + " photography")
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                r = await client.get(
                    "https://pixabay.com/api/",
                    params={
                        "key":          PIXABAY_KEY,
                        "q":            query,
                        "image_type":   "photo",
                        "orientation":  "vertical",
                        "safesearch":   "true",
                        "per_page":     limit,
                        "page":         page,
                        "min_width":    400,
                        "editors_choice": "false",
                    }
                )
            if r.status_code == 200:
                data = r.json()
                images = [
                    {
                        "title":     h.get("tags", "").split(",")[0].strip().title() or f"{cat.title()} photo",
                        "image_url": h["webformatURL"],
                        "thumb_url": h["previewURL"],
                        "source":    "pixabay",
                        "author":    h.get("user", ""),
                        "author_url": f"https://pixabay.com/users/{h.get('user', '')}-{h.get('user_id', '')}/"
                    }
                    for h in data.get("hits", [])
                    if h.get("webformatURL")
                ]
                print(f"✅ Pixabay: got {len(images)} images for '{cat}'")
        except Exception as e:
            print(f"Pixabay error: {e}")

    # 4. Try Pexels if Pixabay also failed
    if not images and PEXELS_KEY:
        query = CATEGORY_QUERIES.get(cat, cat)
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                r = await client.get(
                    "https://api.pexels.com/v1/search",
                    params={"query": query, "page": page, "per_page": limit},
                    headers={"Authorization": PEXELS_KEY}
                )
            if r.status_code == 200:
                data = r.json()
                images = [
                    {
                        "title":     p.get("alt") or f"{cat.title()} photo {i+1}",
                        "image_url": p["src"]["large"],
                        "thumb_url": p["src"]["medium"],
                        "source":    "pexels",
                        "author":    p["photographer"],
                        "author_url":p["photographer_url"],
                    }
                    for i, p in enumerate(data.get("photos", []))
                ]
        except Exception as e:
            print(f"Pexels error: {e}")

    # 5. Fallback — loremflickr keyword-matched (always works, zero key needed)
    if not images:
        print(f"⚡ Using loremflickr fallback for '{cat}' page {page}")
        images = get_flickr_fallback(cat, page, limit)

    # 5. Cache and return
    if images:
        db.set_cached_discovery(cat, page, images)

    return {"category": cat, "page": page, "source": "api", "images": images[:limit]}


# ── IDEAS — CRUD ────────────────────────────────────────────────
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
    """Create a creator post. Requires login."""
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


# ── DASHBOARD ───────────────────────────────────────────────────
@app.get("/dashboard")
def get_dashboard(current_user: dict = Depends(auth_utils.get_current_user)):
    """User stats + activity for the dashboard page."""
    stats = db.get_user_stats(current_user["id"])
    return {"user": current_user, **stats}


# ── BOARDS ──────────────────────────────────────────────────────
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


# ── UPLOAD ──────────────────────────────────────────────────────
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


# ── AI GENERATE ─────────────────────────────────────────────────
@app.post("/ai/generate")
async def ai_generate(
    body: AIGenerateRequest,
    current_user: Optional[dict] = Depends(auth_utils.get_optional_user)
):
    topic = body.topic.strip()

    # Try OpenAI if key is set
    if os.getenv("OPENAI_API_KEY"):
        try:
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
            all_ideas = db.get_ideas(limit=100)
            idea_list = "\n".join(f"{i['id']}. {i['title']} ({i['category']})" for i in all_ideas)
            response = await client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": 'Select 6 relevant idea IDs and write a board description. Respond ONLY with JSON: {"idea_ids":[1,2,3,4,5,6],"description":"..."}'},
                    {"role": "user",   "content": f"Topic: {topic}\n\nIdeas:\n{idea_list}"}
                ],
                max_tokens=200, temperature=0.7,
            )
            raw = response.choices[0].message.content.strip().replace("```json","").replace("```","").strip()
            result = json.loads(raw)
            selected = [i for i in [db.get_idea_by_id(x) for x in result.get("idea_ids", [])] if i]
            return {"topic": topic, "description": result.get("description",""), "ideas": selected, "powered_by": "openai"}
        except Exception as e:
            print(f"OpenAI error: {e}")

    # Smart keyword mock — expanded for new categories
    all_ideas = db.get_ideas(limit=200)
    KEYWORD_MAP = {
        "anime":     ["Anime"], "car":       ["Cars"],  "bike":  ["Bikes"],
        "moto":      ["Bikes"], "scenic":    ["Scenery"],"scenery":["Scenery"],
        "mountain":  ["Scenery","Nature"],   "gam":     ["Gaming"],
        "jewel":     ["Ladies Accessories"], "bangle":  ["Ladies Accessories"],
        "earring":   ["Ladies Accessories"], "necklace":["Ladies Accessories"],
        "bracelet":  ["Ladies Accessories"], "ring":    ["Ladies Accessories"],
        "accessory": ["Ladies Accessories"], "scrunch": ["Ladies Accessories"],
        "wabi":      ["Interior Design","Nature","Art"],
        "japandi":   ["Interior Design","Workspace"],
        "cyber":     ["Tech","Gaming","Architecture"],
        "minimal":   ["Workspace","Interior Design"],
        "cottage":   ["Nature","Food","Travel"],
        "brutal":    ["Architecture","Art"],
        "pastel":    ["Fashion","Food","Art","Ladies Accessories"],
        "nature":    ["Nature","Scenery","Travel"],
        "food":      ["Food"], "fashion":   ["Fashion"],
        "travel":    ["Travel","Scenery"],  "tech":    ["Tech","Gaming"],
        "art":       ["Art"],  "interior":  ["Interior Design"],
        "workspace": ["Workspace","Gaming"],"office":  ["Workspace","Tech"],
        "modern":    ["Architecture","Interior Design","Workspace"],
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
    return {
        "topic": topic,
        "description": f"A curated board for: {topic}",
        "ideas": selected[:6],
        "powered_by": "mock"
    }
