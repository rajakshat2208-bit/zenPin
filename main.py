import os, uuid, json, random
from typing import Optional
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Depends, UploadFile, File, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field
from dotenv import load_dotenv
import database as db
import auth as auth_utils

load_dotenv()

BASE_URL   = os.getenv("BASE_URL", "http://localhost:8000")
UPLOAD_DIR = os.getenv("UPLOAD_DIR", "uploads")
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "10"))
ALLOWED_IMAGE_TYPES = {"image/jpeg","image/png","image/webp","image/gif"}

os.makedirs(UPLOAD_DIR, exist_ok=True)

@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    db.seed_demo_ideas()
    print("ZenPin API v1.3 is live")
    yield

app = FastAPI(title="ZenPin API", version="1.3.0", lifespan=lifespan)

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
    return {"status": "ok", "app": "ZenPin API", "version": "1.3.0", "cors": "open"}

class SignupRequest(BaseModel):
    username: str      = Field(..., min_length=2, max_length=30)
    email:    EmailStr
    password: str      = Field(..., min_length=8, max_length=100)

class LoginRequest(BaseModel):
    email:    EmailStr
    password: str = Field(..., min_length=1, max_length=100)

class UpdateProfileRequest(BaseModel):
    bio: Optional[str] = Field(None, max_length=300)

class CreateIdeaRequest(BaseModel):
    title:       str           = Field(..., min_length=1, max_length=120)
    description: Optional[str] = Field("", max_length=1000)
    category:    str           = Field(..., min_length=1, max_length=50)
    image_url:   str           = Field(..., min_length=5, max_length=500)
    difficulty:  Optional[int] = Field(3, ge=1, le=5)
    creativity:  Optional[int] = Field(3, ge=1, le=5)
    usefulness:  Optional[int] = Field(3, ge=1, le=5)

class CreateBoardRequest(BaseModel):
    name:        str           = Field(..., min_length=1, max_length=80)
    description: Optional[str] = Field("", max_length=300)
    is_collab:   Optional[bool] = False

class AddToBoardRequest(BaseModel):
    idea_id: int = Field(..., gt=0)

class AIGenerateRequest(BaseModel):
    topic: str = Field(..., min_length=1, max_length=200)

@app.post("/auth/signup", status_code=201)
def signup(body: SignupRequest):
    if db.get_user_by_email(body.email):
        raise HTTPException(status_code=409, detail="An account with this email already exists.")
    if db.get_user_by_username(body.username):
        raise HTTPException(status_code=409, detail="That username is already taken.")
    hashed = auth_utils.hash_password(body.password)
    try:
        user = db.create_user(body.username, body.email, hashed)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Signup failed: {str(e)}")
    token = auth_utils.create_token(user["id"], user["username"])
    return {"token": token, "user": {"id": user["id"], "username": user["username"], "email": user["email"]}}

@app.post("/auth/login")
def login(body: LoginRequest):
    user = db.get_user_by_email(body.email)
    if not user or not auth_utils.verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Incorrect email or password.")
    token = auth_utils.create_token(user["id"], user["username"])
    return {"token": token, "user": {"id": user["id"], "username": user["username"], "email": user["email"], "bio": user["bio"], "avatar_url": user["avatar_url"]}}

@app.get("/auth/me")
def get_me(current_user: dict = Depends(auth_utils.get_current_user)):
    saves = db.get_user_saves_set(current_user["id"])
    likes = db.get_user_likes_set(current_user["id"])
    return {**current_user, "saved_idea_ids": list(saves), "liked_idea_ids": list(likes)}

@app.patch("/auth/me")
def update_profile(body: UpdateProfileRequest, current_user: dict = Depends(auth_utils.get_current_user)):
    return db.update_user_profile(current_user["id"], bio=body.bio)

@app.get("/ideas")
def list_ideas(
    category:     Optional[str]  = Query(None, max_length=50),
    search:       Optional[str]  = Query(None, max_length=100),
    sort:         Optional[str]  = Query("newest"),
    limit:        int            = Query(20, ge=1, le=100),
    offset:       int            = Query(0, ge=0),
    current_user: Optional[dict] = Depends(auth_utils.get_optional_user),
):
    ideas = db.get_ideas(category=category, search=search, sort=sort, limit=limit, offset=offset)
    saves = db.get_user_saves_set(current_user["id"]) if current_user else set()
    likes = db.get_user_likes_set(current_user["id"]) if current_user else set()
    for idea in ideas:
        idea["is_saved"] = idea["id"] in saves
        idea["is_liked"] = idea["id"] in likes
    return {"ideas": ideas, "count": len(ideas), "offset": offset}

@app.get("/ideas/{idea_id}")
def get_idea(idea_id: int, current_user: Optional[dict] = Depends(auth_utils.get_optional_user)):
    idea = db.get_idea_by_id(idea_id)
    if not idea:
        raise HTTPException(status_code=404, detail="Idea not found.")
    if current_user:
        saves = db.get_user_saves_set(current_user["id"])
        likes = db.get_user_likes_set(current_user["id"])
        idea["is_saved"] = idea["id"] in saves
        idea["is_liked"] = idea["id"] in likes
    return idea

@app.post("/ideas", status_code=201)
def create_idea(body: CreateIdeaRequest, current_user: dict = Depends(auth_utils.get_current_user)):
    return db.create_idea(user_id=current_user["id"], title=body.title, description=body.description,
        category=body.category, image_url=body.image_url, difficulty=body.difficulty,
        creativity=body.creativity, usefulness=body.usefulness)

@app.delete("/ideas/{idea_id}")
def delete_idea(idea_id: int, current_user: dict = Depends(auth_utils.get_current_user)):
    if not db.delete_idea(idea_id, current_user["id"]):
        raise HTTPException(status_code=404, detail="Idea not found or not yours.")
    return {"message": "Idea deleted."}

@app.post("/ideas/{idea_id}/save")
def toggle_save(idea_id: int, current_user: dict = Depends(auth_utils.get_current_user)):
    if not db.get_idea_by_id(idea_id):
        raise HTTPException(status_code=404, detail="Idea not found.")
    is_saved = db.save_idea(current_user["id"], idea_id)
    return {"saved": is_saved, "saves_count": db.get_idea_by_id(idea_id)["saves_count"]}

@app.post("/ideas/{idea_id}/like")
def toggle_like(idea_id: int, current_user: dict = Depends(auth_utils.get_current_user)):
    if not db.get_idea_by_id(idea_id):
        raise HTTPException(status_code=404, detail="Idea not found.")
    is_liked = db.like_idea(current_user["id"], idea_id)
    return {"liked": is_liked, "likes_count": db.get_idea_by_id(idea_id)["likes_count"]}

@app.get("/users/{user_id}/saves")
def get_saved_ideas(user_id: int, current_user: dict = Depends(auth_utils.get_current_user)):
    if current_user["id"] != user_id:
        raise HTTPException(status_code=403, detail="You can only view your own saves.")
    return {"ideas": db.get_saved_ideas(user_id)}

@app.get("/boards")
def get_my_boards(current_user: dict = Depends(auth_utils.get_current_user)):
    return {"boards": db.get_boards_by_user(current_user["id"])}

@app.post("/boards", status_code=201)
def create_board(body: CreateBoardRequest, current_user: dict = Depends(auth_utils.get_current_user)):
    return db.create_board(user_id=current_user["id"], name=body.name,
        description=body.description, is_collab=body.is_collab)

@app.post("/boards/{board_id}/ideas")
def add_to_board(board_id: int, body: AddToBoardRequest, current_user: dict = Depends(auth_utils.get_current_user)):
    if not db.add_idea_to_board(board_id, body.idea_id, current_user["id"]):
        raise HTTPException(status_code=404, detail="Board not found or not yours.")
    return {"message": "Idea added to board."}

@app.post("/upload")
async def upload_image(file: UploadFile = File(...), current_user: dict = Depends(auth_utils.get_current_user)):
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail=f"File type not allowed.")
    contents = await file.read()
    if len(contents) / (1024*1024) > MAX_UPLOAD_MB:
        raise HTTPException(status_code=400, detail=f"File too large. Max {MAX_UPLOAD_MB}MB.")
    ext = file.filename.rsplit(".",1)[-1].lower() if "." in file.filename else "jpg"
    filename = f"{uuid.uuid4().hex}.{ext}"
    with open(os.path.join(UPLOAD_DIR, filename), "wb") as f:
        f.write(contents)
    return {"url": f"{BASE_URL}/uploads/{filename}", "filename": filename}

@app.post("/ai/generate")
async def ai_generate(body: AIGenerateRequest, current_user: dict = Depends(auth_utils.get_current_user)):
    topic = body.topic.strip()
    openai_key = os.getenv("OPENAI_API_KEY","")
    if openai_key:
        try:
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=openai_key)
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
    all_ideas = db.get_ideas(limit=100)
    KEYWORD_MAP = {
        "wabi":["Interior Design","Nature","Art"],"japandi":["Interior Design","Workspace"],
        "cyber":["Tech","Architecture","Art"],"minimal":["Workspace","Interior Design","Architecture"],
        "cottage":["Nature","Food","Travel"],"brutal":["Architecture","Art"],
        "pastel":["Fashion","Food","Art"],"nature":["Nature","Travel"],
        "food":["Food"],"fashion":["Fashion"],"travel":["Travel"],"tech":["Tech"],
        "art":["Art"],"interior":["Interior Design"],"workspace":["Workspace"],
        "office":["Workspace","Tech"],"kitchen":["Food","Interior Design"],
        "garden":["Nature"],"modern":["Architecture","Interior Design","Workspace"],
    }
    cats = []
    for kw in topic.lower().split():
        for key,c in KEYWORD_MAP.items():
            if key in kw: cats.extend(c)
    if cats:
        filtered = [i for i in all_ideas if i["category"] in cats]
        rest = [i for i in all_ideas if i not in filtered]
        needed = max(0, 6-len(filtered))
        selected = filtered[:6] if len(filtered)>=6 else filtered+random.sample(rest,min(needed,len(rest)))
    else:
        selected = random.sample(all_ideas, min(6,len(all_ideas)))
    return {"topic":topic,"description":f"A curated board for: {topic}","ideas":selected[:6],"powered_by":"mock"}
