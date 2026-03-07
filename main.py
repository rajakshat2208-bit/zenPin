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

# ── Curated fallback images per category ───────────────────
# Uses picsum.photos — completely free, no API key, always works
# /seed/{name}/500/700 gives a consistent beautiful photo for that seed
FALLBACK_IMAGES = {
    "anime": [
        {"title": "Anime Aesthetic Vol.1",      "image_url": "https://picsum.photos/seed/anime1/500/700",   "source": "discovery"},
        {"title": "Neon City Vibes",            "image_url": "https://picsum.photos/seed/anime2/500/750",   "source": "discovery"},
        {"title": "Japanese Street Aesthetic",  "image_url": "https://picsum.photos/seed/anime3/500/680",   "source": "discovery"},
        {"title": "Pastel Dream Scene",         "image_url": "https://picsum.photos/seed/anime4/500/720",   "source": "discovery"},
        {"title": "Night Sky Illustration",     "image_url": "https://picsum.photos/seed/anime5/500/760",   "source": "discovery"},
        {"title": "Cherry Blossom Avenue",      "image_url": "https://picsum.photos/seed/anime6/500/700",   "source": "discovery"},
        {"title": "Cyberpunk Aesthetic",        "image_url": "https://picsum.photos/seed/anime7/500/740",   "source": "discovery"},
        {"title": "Aesthetic Room Setup",       "image_url": "https://picsum.photos/seed/anime8/500/700",   "source": "discovery"},
    ],
    "cars": [
        {"title": "Supercar Street Shot",       "image_url": "https://picsum.photos/seed/car1/500/700",     "source": "discovery"},
        {"title": "Classic Garage Aesthetic",   "image_url": "https://picsum.photos/seed/car2/500/720",     "source": "discovery"},
        {"title": "Sports Car at Dusk",         "image_url": "https://picsum.photos/seed/car3/500/680",     "source": "discovery"},
        {"title": "Luxury Interior Detail",     "image_url": "https://picsum.photos/seed/car4/500/740",     "source": "discovery"},
        {"title": "Race Track Photography",     "image_url": "https://picsum.photos/seed/car5/500/700",     "source": "discovery"},
        {"title": "Vintage Car Restoration",    "image_url": "https://picsum.photos/seed/car6/500/760",     "source": "discovery"},
        {"title": "Midnight Drive Aesthetic",   "image_url": "https://picsum.photos/seed/car7/500/720",     "source": "discovery"},
        {"title": "Engine Bay Detail",          "image_url": "https://picsum.photos/seed/car8/500/700",     "source": "discovery"},
    ],
    "bikes": [
        {"title": "Sports Bike at Sunset",      "image_url": "https://picsum.photos/seed/bike1/500/700",    "source": "discovery"},
        {"title": "Cafe Racer Custom Build",    "image_url": "https://picsum.photos/seed/bike2/500/750",    "source": "discovery"},
        {"title": "Adventure Bike Trail",       "image_url": "https://picsum.photos/seed/bike3/500/680",    "source": "discovery"},
        {"title": "Motorcycle Garage",          "image_url": "https://picsum.photos/seed/bike4/500/720",    "source": "discovery"},
        {"title": "Scrambler Detail",           "image_url": "https://picsum.photos/seed/bike5/500/700",    "source": "discovery"},
        {"title": "Mountain Road Ride",         "image_url": "https://picsum.photos/seed/bike6/500/760",    "source": "discovery"},
        {"title": "Neon Bike Night",            "image_url": "https://picsum.photos/seed/bike7/500/700",    "source": "discovery"},
        {"title": "Chopper Build",              "image_url": "https://picsum.photos/seed/bike8/500/740",    "source": "discovery"},
    ],
    "scenery": [
        {"title": "Mountain Lake Reflection",   "image_url": "https://picsum.photos/seed/scene1/500/700",   "source": "discovery"},
        {"title": "Aurora Borealis Night Sky",  "image_url": "https://picsum.photos/seed/scene2/500/750",   "source": "discovery"},
        {"title": "Misty Forest Morning",       "image_url": "https://picsum.photos/seed/scene3/500/680",   "source": "discovery"},
        {"title": "Desert Sunset Dunes",        "image_url": "https://picsum.photos/seed/scene4/500/720",   "source": "discovery"},
        {"title": "Ocean Cliff at Dusk",        "image_url": "https://picsum.photos/seed/scene5/500/700",   "source": "discovery"},
        {"title": "Lavender Field",             "image_url": "https://picsum.photos/seed/scene6/500/760",   "source": "discovery"},
        {"title": "Himalayan Peaks",            "image_url": "https://picsum.photos/seed/scene7/500/700",   "source": "discovery"},
        {"title": "Tropical Waterfall",         "image_url": "https://picsum.photos/seed/scene8/500/740",   "source": "discovery"},
    ],
    "gaming": [
        {"title": "RGB Gaming Desk Setup",      "image_url": "https://picsum.photos/seed/game1/500/700",    "source": "discovery"},
        {"title": "Retro Console Collection",   "image_url": "https://picsum.photos/seed/game2/500/720",    "source": "discovery"},
        {"title": "Minimal Gaming Room",        "image_url": "https://picsum.photos/seed/game3/500/680",    "source": "discovery"},
        {"title": "Controller Flat Lay",        "image_url": "https://picsum.photos/seed/game4/500/700",    "source": "discovery"},
        {"title": "Mechanical Keyboard",        "image_url": "https://picsum.photos/seed/game5/500/760",    "source": "discovery"},
        {"title": "Neon Battlestation",         "image_url": "https://picsum.photos/seed/game6/500/700",    "source": "discovery"},
        {"title": "Retro Pixel Aesthetic",      "image_url": "https://picsum.photos/seed/game7/500/740",    "source": "discovery"},
        {"title": "VR Setup Room",              "image_url": "https://picsum.photos/seed/game8/500/720",    "source": "discovery"},
    ],
    "workspace": [
        {"title": "Minimal Oak Desk",           "image_url": "https://picsum.photos/seed/work1/500/700",    "source": "discovery"},
        {"title": "Terracotta Accents Desk",    "image_url": "https://picsum.photos/seed/work2/500/720",    "source": "discovery"},
        {"title": "Dual Monitor Setup",         "image_url": "https://picsum.photos/seed/work3/500/680",    "source": "discovery"},
        {"title": "Creative Studio Space",      "image_url": "https://picsum.photos/seed/work4/500/700",    "source": "discovery"},
        {"title": "Bookshelf Aesthetic",        "image_url": "https://picsum.photos/seed/work5/500/760",    "source": "discovery"},
        {"title": "Cosy Home Office",           "image_url": "https://picsum.photos/seed/work6/500/700",    "source": "discovery"},
        {"title": "Standing Desk Setup",        "image_url": "https://picsum.photos/seed/work7/500/740",    "source": "discovery"},
        {"title": "Artist Studio View",         "image_url": "https://picsum.photos/seed/work8/500/720",    "source": "discovery"},
    ],
    "architecture": [
        {"title": "Brutalist Staircase",        "image_url": "https://picsum.photos/seed/arch1/500/700",    "source": "discovery"},
        {"title": "Glass Tower Blue Hour",      "image_url": "https://picsum.photos/seed/arch2/500/750",    "source": "discovery"},
        {"title": "Curved Concrete Form",       "image_url": "https://picsum.photos/seed/arch3/500/680",    "source": "discovery"},
        {"title": "Minimal White Interior",     "image_url": "https://picsum.photos/seed/arch4/500/720",    "source": "discovery"},
        {"title": "Heritage Stone Facade",      "image_url": "https://picsum.photos/seed/arch5/500/700",    "source": "discovery"},
        {"title": "Modern Bridge Design",       "image_url": "https://picsum.photos/seed/arch6/500/760",    "source": "discovery"},
        {"title": "Spiral Staircase",           "image_url": "https://picsum.photos/seed/arch7/500/700",    "source": "discovery"},
        {"title": "Geometric Facade",           "image_url": "https://picsum.photos/seed/arch8/500/740",    "source": "discovery"},
    ],
    "fashion": [
        {"title": "Textural Linen Layering",    "image_url": "https://picsum.photos/seed/fash1/500/700",    "source": "discovery"},
        {"title": "Monochrome Editorial",       "image_url": "https://picsum.photos/seed/fash2/500/750",    "source": "discovery"},
        {"title": "Street Style Moment",        "image_url": "https://picsum.photos/seed/fash3/500/680",    "source": "discovery"},
        {"title": "Minimal Summer Fit",         "image_url": "https://picsum.photos/seed/fash4/500/720",    "source": "discovery"},
        {"title": "Vintage Denim Aesthetic",    "image_url": "https://picsum.photos/seed/fash5/500/700",    "source": "discovery"},
        {"title": "Runway Silhouette",          "image_url": "https://picsum.photos/seed/fash6/500/760",    "source": "discovery"},
        {"title": "Pastel Outfit Flatlay",      "image_url": "https://picsum.photos/seed/fash7/500/700",    "source": "discovery"},
        {"title": "Dark Academia Style",        "image_url": "https://picsum.photos/seed/fash8/500/740",    "source": "discovery"},
    ],
    "ladies accessories": [
        {"title": "Colorful Glass Bangles",     "image_url": "https://picsum.photos/seed/acc1/500/700",     "source": "discovery"},
        {"title": "Gold Hoop Earrings",         "image_url": "https://picsum.photos/seed/acc2/500/720",     "source": "discovery"},
        {"title": "Scrunchie Collection",       "image_url": "https://picsum.photos/seed/acc3/500/680",     "source": "discovery"},
        {"title": "Layered Gold Necklaces",     "image_url": "https://picsum.photos/seed/acc4/500/700",     "source": "discovery"},
        {"title": "Stacked Bracelets",          "image_url": "https://picsum.photos/seed/acc5/500/760",     "source": "discovery"},
        {"title": "Statement Rings",            "image_url": "https://picsum.photos/seed/acc6/500/700",     "source": "discovery"},
        {"title": "Pearl Jewellery Set",        "image_url": "https://picsum.photos/seed/acc7/500/740",     "source": "discovery"},
        {"title": "Boho Bracelet Stack",        "image_url": "https://picsum.photos/seed/acc8/500/720",     "source": "discovery"},
    ],
    "bangles": [
        {"title": "Traditional Glass Bangles",  "image_url": "https://picsum.photos/seed/bng1/500/700",     "source": "discovery"},
        {"title": "Metal Bangle Stack",         "image_url": "https://picsum.photos/seed/bng2/500/720",     "source": "discovery"},
        {"title": "Rainbow Bangle Set",         "image_url": "https://picsum.photos/seed/bng3/500/680",     "source": "discovery"},
        {"title": "Bridal Bangle Collection",   "image_url": "https://picsum.photos/seed/bng4/500/700",     "source": "discovery"},
    ],
    "earrings": [
        {"title": "Gold Drop Earrings",         "image_url": "https://picsum.photos/seed/ear1/500/700",     "source": "discovery"},
        {"title": "Pearl Stud Earrings",        "image_url": "https://picsum.photos/seed/ear2/500/720",     "source": "discovery"},
        {"title": "Statement Hoop Earrings",    "image_url": "https://picsum.photos/seed/ear3/500/680",     "source": "discovery"},
        {"title": "Chandelier Earrings",        "image_url": "https://picsum.photos/seed/ear4/500/700",     "source": "discovery"},
    ],
    "scrunchies": [
        {"title": "Velvet Scrunchie Collection","image_url": "https://picsum.photos/seed/scr1/500/700",     "source": "discovery"},
        {"title": "Silk Scrunchies Flat Lay",   "image_url": "https://picsum.photos/seed/scr2/500/720",     "source": "discovery"},
        {"title": "Floral Scrunchie Set",       "image_url": "https://picsum.photos/seed/scr3/500/680",     "source": "discovery"},
    ],
    "bracelets": [
        {"title": "Gold Chain Bracelets",       "image_url": "https://picsum.photos/seed/brc1/500/700",     "source": "discovery"},
        {"title": "Beaded Friendship Bracelets","image_url": "https://picsum.photos/seed/brc2/500/720",     "source": "discovery"},
        {"title": "Tennis Bracelet",            "image_url": "https://picsum.photos/seed/brc3/500/680",     "source": "discovery"},
    ],
    "rings": [
        {"title": "Stacked Ring Aesthetic",     "image_url": "https://picsum.photos/seed/rng1/500/700",     "source": "discovery"},
        {"title": "Vintage Gold Rings",         "image_url": "https://picsum.photos/seed/rng2/500/720",     "source": "discovery"},
        {"title": "Minimalist Band Rings",      "image_url": "https://picsum.photos/seed/rng3/500/680",     "source": "discovery"},
    ],
    "necklaces": [
        {"title": "Layered Necklace Stack",     "image_url": "https://picsum.photos/seed/nck1/500/700",     "source": "discovery"},
        {"title": "Delicate Gold Necklace",     "image_url": "https://picsum.photos/seed/nck2/500/720",     "source": "discovery"},
        {"title": "Choker Aesthetic",           "image_url": "https://picsum.photos/seed/nck3/500/680",     "source": "discovery"},
    ],
    "interior design": [
        {"title": "Japandi Living Room",        "image_url": "https://picsum.photos/seed/int1/500/700",     "source": "discovery"},
        {"title": "Wabi-Sabi Bedroom",          "image_url": "https://picsum.photos/seed/int2/500/720",     "source": "discovery"},
        {"title": "Curved Plaster Arch",        "image_url": "https://picsum.photos/seed/int3/500/680",     "source": "discovery"},
        {"title": "Earthy Tones Lounge",        "image_url": "https://picsum.photos/seed/int4/500/700",     "source": "discovery"},
        {"title": "Cosy Reading Nook",          "image_url": "https://picsum.photos/seed/int5/500/760",     "source": "discovery"},
        {"title": "Modern Kitchen Design",      "image_url": "https://picsum.photos/seed/int6/500/700",     "source": "discovery"},
        {"title": "Boho Living Space",          "image_url": "https://picsum.photos/seed/int7/500/740",     "source": "discovery"},
        {"title": "Scandi Minimalism",          "image_url": "https://picsum.photos/seed/int8/500/720",     "source": "discovery"},
    ],
    "art": [
        {"title": "Abstract Generative Art",    "image_url": "https://picsum.photos/seed/art1/500/700",     "source": "discovery"},
        {"title": "Ink Wash Painting",          "image_url": "https://picsum.photos/seed/art2/500/750",     "source": "discovery"},
        {"title": "Oil on Canvas Study",        "image_url": "https://picsum.photos/seed/art3/500/680",     "source": "discovery"},
        {"title": "Watercolour Botanical",      "image_url": "https://picsum.photos/seed/art4/500/720",     "source": "discovery"},
        {"title": "Digital Illustration",       "image_url": "https://picsum.photos/seed/art5/500/700",     "source": "discovery"},
        {"title": "Collage Art Piece",          "image_url": "https://picsum.photos/seed/art6/500/760",     "source": "discovery"},
        {"title": "Ceramic Sculpture",          "image_url": "https://picsum.photos/seed/art7/500/700",     "source": "discovery"},
        {"title": "Street Art Mural",           "image_url": "https://picsum.photos/seed/art8/500/740",     "source": "discovery"},
    ],
    "nature": [
        {"title": "Ice Crystal Macro",          "image_url": "https://picsum.photos/seed/nat1/500/700",     "source": "discovery"},
        {"title": "Desert Dunes Golden Hour",   "image_url": "https://picsum.photos/seed/nat2/500/720",     "source": "discovery"},
        {"title": "Dense Jungle Canopy",        "image_url": "https://picsum.photos/seed/nat3/500/680",     "source": "discovery"},
        {"title": "Wildflower Meadow",          "image_url": "https://picsum.photos/seed/nat4/500/700",     "source": "discovery"},
        {"title": "Snowy Forest Path",          "image_url": "https://picsum.photos/seed/nat5/500/760",     "source": "discovery"},
        {"title": "Tide Pool Close-Up",         "image_url": "https://picsum.photos/seed/nat6/500/700",     "source": "discovery"},
        {"title": "Rolling Green Hills",        "image_url": "https://picsum.photos/seed/nat7/500/740",     "source": "discovery"},
        {"title": "Autumn Leaves Trail",        "image_url": "https://picsum.photos/seed/nat8/500/720",     "source": "discovery"},
    ],
    "food": [
        {"title": "Sourdough Scoring Art",      "image_url": "https://picsum.photos/seed/food1/500/700",    "source": "discovery"},
        {"title": "Japanese Breakfast",         "image_url": "https://picsum.photos/seed/food2/500/720",    "source": "discovery"},
        {"title": "Pasta Plating Technique",    "image_url": "https://picsum.photos/seed/food3/500/680",    "source": "discovery"},
        {"title": "Matcha Latte Art",           "image_url": "https://picsum.photos/seed/food4/500/700",    "source": "discovery"},
        {"title": "Charcuterie Board",          "image_url": "https://picsum.photos/seed/food5/500/760",    "source": "discovery"},
        {"title": "Dessert Close-Up",           "image_url": "https://picsum.photos/seed/food6/500/700",    "source": "discovery"},
        {"title": "Street Food Flat Lay",       "image_url": "https://picsum.photos/seed/food7/500/740",    "source": "discovery"},
        {"title": "Coffee Pour Shot",           "image_url": "https://picsum.photos/seed/food8/500/720",    "source": "discovery"},
    ],
    "travel": [
        {"title": "Fjord Ferry at Dusk",        "image_url": "https://picsum.photos/seed/trav1/500/700",    "source": "discovery"},
        {"title": "Old Town Lisbon Streets",    "image_url": "https://picsum.photos/seed/trav2/500/720",    "source": "discovery"},
        {"title": "Salt Flats Mirror",          "image_url": "https://picsum.photos/seed/trav3/500/680",    "source": "discovery"},
        {"title": "Santorini Blue Domes",       "image_url": "https://picsum.photos/seed/trav4/500/700",    "source": "discovery"},
        {"title": "Bali Rice Terraces",         "image_url": "https://picsum.photos/seed/trav5/500/760",    "source": "discovery"},
        {"title": "Moroccan Riad Courtyard",    "image_url": "https://picsum.photos/seed/trav6/500/700",    "source": "discovery"},
        {"title": "Iceland Waterfall",          "image_url": "https://picsum.photos/seed/trav7/500/740",    "source": "discovery"},
        {"title": "Tokyo Intersection",         "image_url": "https://picsum.photos/seed/trav8/500/720",    "source": "discovery"},
    ],
    "tech": [
        {"title": "Circuit Board Abstraction",  "image_url": "https://picsum.photos/seed/tech1/500/700",    "source": "discovery"},
        {"title": "LED Neon Sign Workshop",     "image_url": "https://picsum.photos/seed/tech2/500/720",    "source": "discovery"},
        {"title": "3D Printer in Action",       "image_url": "https://picsum.photos/seed/tech3/500/680",    "source": "discovery"},
        {"title": "Drone Aerial Shot",          "image_url": "https://picsum.photos/seed/tech4/500/700",    "source": "discovery"},
        {"title": "Server Room Lights",         "image_url": "https://picsum.photos/seed/tech5/500/760",    "source": "discovery"},
        {"title": "Robotics Lab",               "image_url": "https://picsum.photos/seed/tech6/500/700",    "source": "discovery"},
        {"title": "Code on Dark Screen",        "image_url": "https://picsum.photos/seed/tech7/500/740",    "source": "discovery"},
        {"title": "Smart Home Setup",           "image_url": "https://picsum.photos/seed/tech8/500/720",    "source": "discovery"},
    ],
}


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

    # 5. Fallback — hardcoded curated images (always works, zero key needed)
    if not images:
        print(f"⚡ Using picsum fallback for '{cat}'")
        fallback = FALLBACK_IMAGES.get(cat, FALLBACK_IMAGES.get("scenery", []))
        # Also pull from sub-categories of ladies accessories
        if not fallback and cat in ("ladies accessories", "accessories"):
            fallback = []
            for sub in ["bangles", "earrings", "scrunchies", "bracelets", "rings", "necklaces"]:
                fallback.extend(FALLBACK_IMAGES.get(sub, []))
        images = fallback[:limit] if fallback else [
            {"title": f"{cat.title()} inspiration {i+1}",
             "image_url": f"https://picsum.photos/seed/{cat.replace(" ","-")}{i}/500/700",
             "source": "discovery"}
            for i in range(6)
        ]

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
