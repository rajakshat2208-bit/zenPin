# main.py
# ─────────────────────────────────────────────────────────────
# ZenPin — FastAPI Backend
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
import random
from typing import Optional

from fastapi import (
    FastAPI, HTTPException, Depends, UploadFile, File,
    Query, status
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr
from dotenv import load_dotenv

import database as db
import auth as auth_utils

load_dotenv()

# ── App setup ─────────────────────────────────────────────────
app = FastAPI(
    title="ZenPin API",
    description="Backend for ZenPin — the creative idea discovery platform.",
    version="1.0.0",
)

# CORS — allows your frontend (opened as a local file or different port) to talk to the API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # In production, replace * with your actual domain
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve uploaded images at /uploads/filename.jpg
UPLOAD_DIR = os.getenv("UPLOAD_DIR", "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "10"))
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


# ── Startup ───────────────────────────────────────────────────
@app.on_event("startup")
def startup():
    db.init_db()
    db.seed_demo_ideas()
    print("🚀 ZenPin API running at http://localhost:8000")
    print("📖 API docs at        http://localhost:8000/docs")


# ── Health check ──────────────────────────────────────────────
@app.get("/", tags=["Health"])
def root():
    return {"status": "ok", "app": "ZenPin API", "version": "1.0.0"}


# ══════════════════════════════════════════════════════════════
# PYDANTIC MODELS — these define what shape the request/response JSON has.
# FastAPI validates input automatically against these models.
# ══════════════════════════════════════════════════════════════

class SignupRequest(BaseModel):
    username: str
    email: EmailStr
    password: str

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class UpdateProfileRequest(BaseModel):
    bio: Optional[str] = None

class CreateIdeaRequest(BaseModel):
    title: str
    description: Optional[str] = ""
    category: str
    image_url: str
    difficulty: Optional[int] = 3
    creativity: Optional[int] = 3
    usefulness: Optional[int] = 3

class CreateBoardRequest(BaseModel):
    name: str
    description: Optional[str] = ""
    is_collab: Optional[bool] = False

class AddToBoardRequest(BaseModel):
    idea_id: int

class AIGenerateRequest(BaseModel):
    topic: str


# ══════════════════════════════════════════════════════════════
# AUTH ROUTES
# ══════════════════════════════════════════════════════════════

@app.post("/auth/signup", tags=["Auth"], status_code=201)
def signup(body: SignupRequest):
    """
    Create a new account.
    Returns the user object + a JWT token so they're logged in immediately.
    """
    # Check if email already used
    if db.get_user_by_email(body.email):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists."
        )
    # Hash the password — NEVER store plain text passwords
    hashed = auth_utils.hash_password(body.password)
    user = db.create_user(body.username, body.email, hashed)
    token = auth_utils.create_token(user["id"], user["username"])
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
            "id":       user["id"],
            "username": user["username"],
            "email":    user["email"],
            "bio":      user["bio"],
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
    body: UpdateProfileRequest,
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
    category: Optional[str] = Query(None, description="Filter by category name"),
    search:   Optional[str] = Query(None, description="Search title or category"),
    sort:     Optional[str] = Query("newest", description="newest | saves | trending"),
    limit:    int           = Query(20, ge=1, le=100),
    offset:   int           = Query(0,  ge=0),
    current_user: Optional[dict] = Depends(auth_utils.get_optional_user),
):
    """
    Get a list of ideas. Supports filtering, search, sorting, and pagination.

    Examples:
      GET /ideas                          → first 20 newest ideas
      GET /ideas?category=Architecture   → filtered by category
      GET /ideas?search=japandi          → keyword search
      GET /ideas?sort=trending&limit=10  → top 10 trending
      GET /ideas?limit=20&offset=20      → second page
    """
    ideas = db.get_ideas(category=category, search=search, sort=sort, limit=limit, offset=offset)

    # If user is logged in, mark which ones they've saved/liked
    saves = db.get_user_saves_set(current_user["id"]) if current_user else set()
    likes = db.get_user_likes_set(current_user["id"]) if current_user else set()

    for idea in ideas:
        idea["is_saved"] = idea["id"] in saves
        idea["is_liked"] = idea["id"] in likes

    return {"ideas": ideas, "count": len(ideas), "offset": offset}


@app.get("/ideas/{idea_id}", tags=["Ideas"])
def get_idea(
    idea_id: int,
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
    body: CreateIdeaRequest,
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
    idea_id: int,
    current_user: dict = Depends(auth_utils.get_current_user),
):
    """Delete one of your ideas. Requires login. Returns 404 if not yours."""
    deleted = db.delete_idea(idea_id, current_user["id"])
    if not deleted:
        raise HTTPException(status_code=404, detail="Idea not found or not yours.")
    return {"message": "Idea deleted."}


# ══════════════════════════════════════════════════════════════
# SOCIAL ROUTES — save & like
# ══════════════════════════════════════════════════════════════

@app.post("/ideas/{idea_id}/save", tags=["Social"])
def toggle_save(
    idea_id: int,
    current_user: dict = Depends(auth_utils.get_current_user),
):
    """
    Toggle save on an idea.
    First call → saves it (returns saved: true).
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
    idea_id: int,
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
    user_id: int,
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
    body: CreateBoardRequest,
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
    board_id: int,
    body: AddToBoardRequest,
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
    file: UploadFile = File(...),
    current_user: dict = Depends(auth_utils.get_current_user),
):
    """
    Upload an image file.
    Returns the URL you can use in create_idea's image_url field.

    Accepted types: JPEG, PNG, WebP, GIF
    Max size: 10 MB (configurable in .env)
    """
    # Check file type
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"File type '{file.content_type}' not allowed. Use JPEG, PNG, WebP, or GIF."
        )

    # Read file and check size
    contents = await file.read()
    size_mb = len(contents) / (1024 * 1024)
    if size_mb > MAX_UPLOAD_MB:
        raise HTTPException(
            status_code=400,
            detail=f"File too large ({size_mb:.1f} MB). Max allowed: {MAX_UPLOAD_MB} MB."
        )

    # Save with a unique filename to avoid collisions
    ext      = file.filename.rsplit(".", 1)[-1].lower()
    filename = f"{uuid.uuid4().hex}.{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)

    with open(filepath, "wb") as f:
        f.write(contents)

    image_url = f"http://localhost:8000/uploads/{filename}"
    return {"url": image_url, "filename": filename}


# ══════════════════════════════════════════════════════════════
# AI GENERATION ROUTE
# ══════════════════════════════════════════════════════════════

@app.post("/ai/generate", tags=["AI"])
def ai_generate(
    body: AIGenerateRequest,
    current_user: dict = Depends(auth_utils.get_current_user),
):
    """
    Generate an inspiration board from a topic.

    If OPENAI_API_KEY is set in .env → uses real GPT-4o to pick ideas + write descriptions.
    If not set → uses the built-in mock generator (still works great for demo).
    """
    topic = body.topic.strip()
    if not topic:
        raise HTTPException(status_code=400, detail="Topic cannot be empty.")

    openai_key = os.getenv("OPENAI_API_KEY", "")

    # ── Real OpenAI path ──────────────────────────────────────
    if openai_key:
        try:
            from openai import OpenAI
            client = OpenAI(api_key=openai_key)

            # Ask GPT to recommend categories and ideas from our database
            all_ideas = db.get_ideas(limit=100)
            idea_list = "\n".join(
                f"{i['id']}. {i['title']} ({i['category']})" for i in all_ideas
            )

            response = client.chat.completions.create(
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

            import json
            raw = response.choices[0].message.content.strip()
            # Strip markdown code fences if present
            raw = raw.replace("```json", "").replace("```", "").strip()
            result = json.loads(raw)

            selected = [db.get_idea_by_id(i) for i in result.get("idea_ids", [])]
            selected = [i for i in selected if i]  # filter None

            return {
                "topic":       topic,
                "description": result.get("description", f"An AI-curated board for: {topic}"),
                "ideas":       selected,
                "powered_by":  "openai",
            }

        except Exception as e:
            # If OpenAI fails, fall through to mock
            print(f"⚠️  OpenAI error, using mock: {e}")

    # ── Mock path (no API key needed) ─────────────────────────
    all_ideas = db.get_ideas(limit=100)

    # Try keyword matching first
    keywords = topic.lower().split()
    KEYWORD_MAP = {
        "wabi":        ["Interior Design", "Nature", "Art"],
        "japandi":     ["Interior Design", "Workspace"],
        "cyber":       ["Tech", "Architecture", "Art"],
        "minimal":     ["Workspace", "Interior Design", "Architecture"],
        "cottage":     ["Nature", "Food", "Travel"],
        "brutal":      ["Architecture", "Art"],
        "pastel":      ["Fashion", "Food", "Art"],
        "nature":      ["Nature", "Travel"],
        "food":        ["Food"],
        "fashion":     ["Fashion"],
        "travel":      ["Travel"],
        "tech":        ["Tech"],
        "art":         ["Art"],
        "interior":    ["Interior Design"],
        "workspace":   ["Workspace"],
        "office":      ["Workspace", "Tech"],
        "kitchen":     ["Food", "Interior Design"],
        "garden":      ["Nature"],
        "modern":      ["Architecture", "Interior Design", "Workspace"],
    }

    target_cats = []
    for kw in keywords:
        for key, cats in KEYWORD_MAP.items():
            if key in kw:
                target_cats.extend(cats)

    if target_cats:
        filtered = [i for i in all_ideas if i["category"] in target_cats]
        selected = filtered[:6] if len(filtered) >= 6 else filtered + random.sample(
            [i for i in all_ideas if i not in filtered],
            min(6 - len(filtered), len(all_ideas) - len(filtered))
        )
    else:
        selected = random.sample(all_ideas, min(6, len(all_ideas)))

    return {
        "topic":       topic,
        "description": f"A curated inspiration board for: {topic}",
        "ideas":       selected[:6],
        "powered_by":  "mock",
    }
