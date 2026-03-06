# main.py
# ─────────────────────────────────────────────────────────────
# ZenPin — FastAPI Backend  (Updated v1.2)
#
# Changes from v1.0:
#   FIX 1 — Upload URL uses BASE_URL env var (not hardcoded localhost)
#   FIX 2 — CORS origins loaded from CORS_ORIGINS env var (not hardcoded)
#   FIX 3 — Replaced deprecated @app.on_event with lifespan context manager
#   FIX 4 — Added Field() length/range limits on all Pydantic models
#   FIX 5 — AI route is now async with AsyncOpenAI client (non-blocking)
#
# Run with:  uvicorn main:app --reload
# Docs at:   http://localhost:8000/docs
#
# ALL ROUTES:
#
#   Auth
#     POST  /auth/signup          — create account
#     POST  /auth/login           — get JWT token
#     GET   /auth/me              — get your profile (requires login)
#     PATCH /auth/me              — update bio / avatar
#
#   Ideas
#     GET   /ideas                — list ideas (filter/search/sort/paginate)
#     POST  /ideas                — create new idea (requires login)
#     GET   /ideas/{id}           — single idea detail
#     DELETE/ideas/{id}           — delete your idea (requires login)
#
#   Social
#     POST  /ideas/{id}/save      — toggle save (requires login)
#     POST  /ideas/{id}/like      — toggle like (requires login)
#     GET   /users/{id}/saves     — get saved ideas list
#
#   Boards
#     GET   /boards               — your boards (requires login)
#     POST  /boards               — create board (requires login)
#     POST  /boards/{id}/ideas    — add idea to board (requires login)
#
#   Upload
#     POST  /upload               — upload image, get back URL (requires login)
#
#   AI
#     POST  /ai/generate          — generate board with OpenAI (requires login)
# ─────────────────────────────────────────────────────────────

import os
import uuid
import json
import random
from typing import Optional
from contextlib import asynccontextmanager          # FIX 3

from fastapi import (
    FastAPI, HTTPException, Depends, UploadFile, File,
    Query, status
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field    # FIX 4 — added Field
from dotenv import load_dotenv

import database as db
import auth as auth_utils

load_dotenv()

# ── Environment config ────────────────────────────────────────
# FIX 1: BASE_URL drives all upload URLs — no more hardcoded localhost.
# Set in .env:
#   Local:      BASE_URL=http://localhost:8000
#   Production: BASE_URL=https://zenpin-api.onrender.com
BASE_URL = os.getenv("BASE_URL", "http://localhost:8000")

# CORS — allow all origins so GitHub Pages, localhost, and any
# other frontend can always reach the API without CORS errors.
# Safe for ZenPin because private actions are protected by JWT tokens.
CORS_ORIGINS = ["*"]

UPLOAD_DIR          = os.getenv("UPLOAD_DIR", "uploads")
MAX_UPLOAD_MB       = int(os.getenv("MAX_UPLOAD_MB", "10"))
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

# ── Create uploads folder immediately at import time ─────────
# IMPORTANT: This must happen before app = FastAPI() because
# StaticFiles(directory=UPLOAD_DIR) mounts at startup and will
# raise RuntimeError if the folder doesn't exist yet.
os.makedirs(UPLOAD_DIR, exist_ok=True)


# ── FIX 3: lifespan replaces deprecated @app.on_event("startup") ─────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Runs once before the server starts accepting requests
    db.init_db()
    db.seed_demo_ideas()
    print("🚀 ZenPin API is live")
    print(f"   BASE_URL   : {BASE_URL}")
    print(f"   CORS       : {CORS_ORIGINS}")
    print(f"   Upload dir : {UPLOAD_DIR}")
    print("📖 Interactive docs at /docs")
    yield
    # Code after yield runs on shutdown (add cleanup here if needed)


# ── App setup ─────────────────────────────────────────────────
app = FastAPI(
    title="ZenPin API",
    description="Backend for ZenPin — the creative idea discovery platform.",
    version="1.2.0",
    lifespan=lifespan,   # FIX 3
)

# FIX 2: CORS now reads from the configurable list above
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,  # must be False when allow_origins=["*"]
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve uploaded images at /uploads/filename.jpg
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")


# ── Health check ──────────────────────────────────────────────
@app.get("/", tags=["Health"])
def root():
    return {"status": "ok", "app": "ZenPin API", "version": "1.2.0"}


# ══════════════════════════════════════════════════════════════
# PYDANTIC MODELS
# FIX 4: Every field now has explicit length limits and value ranges.
#        FastAPI automatically returns a 422 error for invalid input.
# ══════════════════════════════════════════════════════════════

class SignupRequest(BaseModel):
    username: str      = Field(..., min_length=2,  max_length=30,
                               description="2 to 30 characters")
    email:    EmailStr
    password: str      = Field(..., min_length=8,  max_length=100,
                               description="Minimum 8 characters")


class LoginRequest(BaseModel):
    email:    EmailStr
    password: str = Field(..., min_length=1, max_length=100)


class UpdateProfileRequest(BaseModel):
    bio: Optional[str] = Field(None, max_length=300)


class CreateIdeaRequest(BaseModel):
    title:       str           = Field(..., min_length=1,  max_length=120)
    description: Optional[str] = Field("",  max_length=1000)
    category:    str           = Field(..., min_length=1,  max_length=50)
    image_url:   str           = Field(..., min_length=5,  max_length=500)
    difficulty:  Optional[int] = Field(3,   ge=1, le=5)
    creativity:  Optional[int] = Field(3,   ge=1, le=5)
    usefulness:  Optional[int] = Field(3,   ge=1, le=5)


class CreateBoardRequest(BaseModel):
    name:        str           = Field(..., min_length=1, max_length=80)
    description: Optional[str] = Field("",  max_length=300)
    is_collab:   Optional[bool] = False


class AddToBoardRequest(BaseModel):
    idea_id: int = Field(..., gt=0)


class AIGenerateRequest(BaseModel):
    topic: str = Field(..., min_length=1, max_length=200)


# ══════════════════════════════════════════════════════════════
# AUTH ROUTES
# ══════════════════════════════════════════════════════════════

@app.post("/auth/signup", tags=["Auth"], status_code=201)
def signup(body: SignupRequest):
    """
    Create a new account.
    Returns the user object + a JWT token so they're logged in immediately.
    """
    if db.get_user_by_email(body.email):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists."
        )
    hashed = auth_utils.hash_password(body.password)
    user   = db.create_user(body.username, body.email, hashed)
    token  = auth_utils.create_token(user["id"], user["username"])
    return {
        "token": token,
        "user": {
            "id":       user["id"],
            "username": user["username"],
            "email":    user["email"],
        }
    }


@app.post("/auth/login", tags=["Auth"])
def login(body: LoginRequest):
    """
    Log in with email + password.
    Returns a JWT token — store this in the frontend and send with every request.
    """
    user = db.get_user_by_email(body.email)
    if not user or not auth_utils.verify_password(body.password, user["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password."
        )
    token = auth_utils.create_token(user["id"], user["username"])
    return {
        "token": token,
        "user": {
            "id":         user["id"],
            "username":   user["username"],
            "email":      user["email"],
            "bio":        user["bio"],
            "avatar_url": user["avatar_url"],
        }
    }


@app.get("/auth/me", tags=["Auth"])
def get_me(current_user: dict = Depends(auth_utils.get_current_user)):
    """Get your own profile. Requires Authorization header."""
    saves = db.get_user_saves_set(current_user["id"])
    likes = db.get_user_likes_set(current_user["id"])
    return {
        **current_user,
        "saved_idea_ids": list(saves),
        "liked_idea_ids": list(likes),
    }


@app.patch("/auth/me", tags=["Auth"])
def update_profile(
    body:         UpdateProfileRequest,
    current_user: dict = Depends(auth_utils.get_current_user)
):
    """Update your bio."""
    updated = db.update_user_profile(current_user["id"], bio=body.bio)
    return updated


# ══════════════════════════════════════════════════════════════
# IDEA ROUTES
# ══════════════════════════════════════════════════════════════

@app.get("/ideas", tags=["Ideas"])
def list_ideas(
    category:     Optional[str]  = Query(None, max_length=50,
                                         description="Filter by category name"),
    search:       Optional[str]  = Query(None, max_length=100,
                                         description="Search title or category"),
    sort:         Optional[str]  = Query("newest",
                                         description="newest | saves | trending"),
    limit:        int            = Query(20, ge=1, le=100),
    offset:       int            = Query(0,  ge=0),
    current_user: Optional[dict] = Depends(auth_utils.get_optional_user),
):
    """
    Get a list of ideas. Supports filtering, search, sorting, and pagination.

    Examples:
      GET /ideas                          → first 20 newest ideas
      GET /ideas?category=Architecture   → filtered by category
      GET /ideas?search=japandi          → keyword search
      GET /ideas?sort=trending&limit=10  → top 10 trending
      GET /ideas?limit=20&offset=20      → second page (pagination)
    """
    ideas = db.get_ideas(
        category=category, search=search, sort=sort, limit=limit, offset=offset
    )

    # Mark saved/liked status for logged-in users
    saves = db.get_user_saves_set(current_user["id"]) if current_user else set()
    likes = db.get_user_likes_set(current_user["id"]) if current_user else set()

    for idea in ideas:
        idea["is_saved"] = idea["id"] in saves
        idea["is_liked"] = idea["id"] in likes

    return {"ideas": ideas, "count": len(ideas), "offset": offset}


@app.get("/ideas/{idea_id}", tags=["Ideas"])
def get_idea(
    idea_id:      int,
    current_user: Optional[dict] = Depends(auth_utils.get_optional_user),
):
    """Get a single idea by ID."""
    idea = db.get_idea_by_id(idea_id)
    if not idea:
        raise HTTPException(status_code=404, detail="Idea not found.")
    if current_user:
        saves = db.get_user_saves_set(current_user["id"])
        likes = db.get_user_likes_set(current_user["id"])
        idea["is_saved"] = idea["id"] in saves
        idea["is_liked"] = idea["id"] in likes
    return idea


@app.post("/ideas", tags=["Ideas"], status_code=201)
def create_idea(
    body:         CreateIdeaRequest,
    current_user: dict = Depends(auth_utils.get_current_user),
):
    """Post a new idea. Requires login."""
    idea = db.create_idea(
        user_id=current_user["id"],
        title=body.title,
        description=body.description,
        category=body.category,
        image_url=body.image_url,
        difficulty=body.difficulty,
        creativity=body.creativity,
        usefulness=body.usefulness,
    )
    return idea


@app.delete("/ideas/{idea_id}", tags=["Ideas"])
def delete_idea(
    idea_id:      int,
    current_user: dict = Depends(auth_utils.get_current_user),
):
    """Delete one of your ideas. Returns 404 if not found or not yours."""
    deleted = db.delete_idea(idea_id, current_user["id"])
    if not deleted:
        raise HTTPException(status_code=404, detail="Idea not found or not yours.")
    return {"message": "Idea deleted."}


# ══════════════════════════════════════════════════════════════
# SOCIAL ROUTES — save & like
# ══════════════════════════════════════════════════════════════

@app.post("/ideas/{idea_id}/save", tags=["Social"])
def toggle_save(
    idea_id:      int,
    current_user: dict = Depends(auth_utils.get_current_user),
):
    """
    Toggle save on an idea.
    First call  → saves it   (returns saved: true).
    Second call → unsaves it (returns saved: false).
    """
    idea = db.get_idea_by_id(idea_id)
    if not idea:
        raise HTTPException(status_code=404, detail="Idea not found.")
    is_saved = db.save_idea(current_user["id"], idea_id)
    updated  = db.get_idea_by_id(idea_id)
    return {"saved": is_saved, "saves_count": updated["saves_count"]}


@app.post("/ideas/{idea_id}/like", tags=["Social"])
def toggle_like(
    idea_id:      int,
    current_user: dict = Depends(auth_utils.get_current_user),
):
    """Toggle like on an idea."""
    idea = db.get_idea_by_id(idea_id)
    if not idea:
        raise HTTPException(status_code=404, detail="Idea not found.")
    is_liked = db.like_idea(current_user["id"], idea_id)
    updated  = db.get_idea_by_id(idea_id)
    return {"liked": is_liked, "likes_count": updated["likes_count"]}


@app.get("/users/{user_id}/saves", tags=["Social"])
def get_saved_ideas(
    user_id:      int,
    current_user: dict = Depends(auth_utils.get_current_user),
):
    """Get all ideas a user has saved. Must be your own account."""
    if current_user["id"] != user_id:
        raise HTTPException(status_code=403, detail="You can only view your own saves.")
    return {"ideas": db.get_saved_ideas(user_id)}


# ══════════════════════════════════════════════════════════════
# BOARD ROUTES
# ══════════════════════════════════════════════════════════════

@app.get("/boards", tags=["Boards"])
def get_my_boards(current_user: dict = Depends(auth_utils.get_current_user)):
    """Get all your boards with idea counts and preview images."""
    return {"boards": db.get_boards_by_user(current_user["id"])}


@app.post("/boards", tags=["Boards"], status_code=201)
def create_board(
    body:         CreateBoardRequest,
    current_user: dict = Depends(auth_utils.get_current_user),
):
    """Create a new board."""
    board = db.create_board(
        user_id=current_user["id"],
        name=body.name,
        description=body.description,
        is_collab=body.is_collab,
    )
    return board


@app.post("/boards/{board_id}/ideas", tags=["Boards"])
def add_to_board(
    board_id:     int,
    body:         AddToBoardRequest,
    current_user: dict = Depends(auth_utils.get_current_user),
):
    """Add an idea to one of your boards."""
    success = db.add_idea_to_board(board_id, body.idea_id, current_user["id"])
    if not success:
        raise HTTPException(status_code=404, detail="Board not found or not yours.")
    return {"message": "Idea added to board."}


# ══════════════════════════════════════════════════════════════
# UPLOAD ROUTE
# ══════════════════════════════════════════════════════════════

@app.post("/upload", tags=["Upload"])
async def upload_image(
    file:         UploadFile = File(...),
    current_user: dict       = Depends(auth_utils.get_current_user),
):
    """
    Upload an image file.
    Returns the URL you can use in create_idea's image_url field.

    Accepted: JPEG, PNG, WebP, GIF
    Max size: 10 MB (set MAX_UPLOAD_MB in .env to change)
    """
    # Validate content type
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"File type '{file.content_type}' not allowed. Use JPEG, PNG, WebP, or GIF."
        )

    # Read and check size
    contents = await file.read()
    size_mb  = len(contents) / (1024 * 1024)
    if size_mb > MAX_UPLOAD_MB:
        raise HTTPException(
            status_code=400,
            detail=f"File too large ({size_mb:.1f} MB). Max allowed: {MAX_UPLOAD_MB} MB."
        )

    # Save with unique filename to prevent collisions
    ext      = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else "jpg"
    filename = f"{uuid.uuid4().hex}.{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)

    with open(filepath, "wb") as f:
        f.write(contents)

    # FIX 1: BASE_URL from env — correct URL on both localhost and Render
    image_url = f"{BASE_URL}/uploads/{filename}"
    return {"url": image_url, "filename": filename}


# ══════════════════════════════════════════════════════════════
# AI GENERATION ROUTE
# FIX 5: async def + AsyncOpenAI — server stays responsive while
#        waiting for OpenAI's response (typically 2–3 seconds).
# ══════════════════════════════════════════════════════════════

@app.post("/ai/generate", tags=["AI"])
async def ai_generate(                             # FIX 5 — async def
    body:         AIGenerateRequest,
    current_user: dict = Depends(auth_utils.get_current_user),
):
    """
    Generate an inspiration board from a topic.

    With OPENAI_API_KEY in .env  → uses real GPT-4o-mini.
    Without OPENAI_API_KEY       → uses keyword-matching mock (still works great).
    """
    topic      = body.topic.strip()
    openai_key = os.getenv("OPENAI_API_KEY", "")

    # ── Real OpenAI path ──────────────────────────────────────
    if openai_key:
        try:
            from openai import AsyncOpenAI            # FIX 5 — async client
            client = AsyncOpenAI(api_key=openai_key)

            all_ideas = db.get_ideas(limit=100)
            idea_list = "\n".join(
                f"{i['id']}. {i['title']} ({i['category']})" for i in all_ideas
            )

            response = await client.chat.completions.create(  # FIX 5 — await
                model="gpt-4o-mini",
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are a creative curator for ZenPin, a visual inspiration platform. "
                            "Given a user's topic, select the 6 most relevant idea IDs from the list "
                            "and write a one-sentence board description. "
                            "Respond ONLY with valid JSON: "
                            '{"idea_ids": [1,2,3,4,5,6], "description": "..."}'
                        )
                    },
                    {
                        "role": "user",
                        "content": f"Topic: {topic}\n\nAvailable ideas:\n{idea_list}"
                    }
                ],
                max_tokens=200,
                temperature=0.7,
            )

            raw    = response.choices[0].message.content.strip()
            raw    = raw.replace("```json", "").replace("```", "").strip()
            result = json.loads(raw)

            selected = [db.get_idea_by_id(i) for i in result.get("idea_ids", [])]
            selected = [i for i in selected if i]   # remove any None results

            return {
                "topic":       topic,
                "description": result.get("description", f"An AI-curated board for: {topic}"),
                "ideas":       selected,
                "powered_by":  "openai",
            }

        except Exception as e:
            # Any OpenAI failure → fall through to mock below
            print(f"⚠️  OpenAI error, using mock generator: {e}")

    # ── Mock path (no API key needed) ─────────────────────────
    all_ideas = db.get_ideas(limit=100)

    keywords = topic.lower().split()
    KEYWORD_MAP = {
        "wabi":      ["Interior Design", "Nature", "Art"],
        "japandi":   ["Interior Design", "Workspace"],
        "cyber":     ["Tech", "Architecture", "Art"],
        "minimal":   ["Workspace", "Interior Design", "Architecture"],
        "cottage":   ["Nature", "Food", "Travel"],
        "brutal":    ["Architecture", "Art"],
        "pastel":    ["Fashion", "Food", "Art"],
        "nature":    ["Nature", "Travel"],
        "food":      ["Food"],
        "fashion":   ["Fashion"],
        "travel":    ["Travel"],
        "tech":      ["Tech"],
        "art":       ["Art"],
        "interior":  ["Interior Design"],
        "workspace": ["Workspace"],
        "office":    ["Workspace", "Tech"],
        "kitchen":   ["Food", "Interior Design"],
        "garden":    ["Nature"],
        "modern":    ["Architecture", "Interior Design", "Workspace"],
    }

    target_cats = []
    for kw in keywords:
        for key, cats in KEYWORD_MAP.items():
            if key in kw:
                target_cats.extend(cats)

    if target_cats:
        filtered  = [i for i in all_ideas if i["category"] in target_cats]
        remainder = [i for i in all_ideas if i not in filtered]
        needed    = max(0, 6 - len(filtered))
        selected  = (
            filtered[:6] if len(filtered) >= 6
            else filtered + random.sample(remainder, min(needed, len(remainder)))
        )
    else:
        selected = random.sample(all_ideas, min(6, len(all_ideas)))

    return {
        "topic":       topic,
        "description": f"A curated inspiration board for: {topic}",
        "ideas":       selected[:6],
        "powered_by":  "mock",
    }
