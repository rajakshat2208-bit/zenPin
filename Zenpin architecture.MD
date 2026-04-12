# ZenPin — Full Architecture, AI System & MVP Roadmap

---

## 1. Honest Verdict

You can run a **real, working product** for near-zero cost with your stack. Here is what is genuinely free vs what costs money.

### Free (use these)
- **GitHub Pages** — static hosting, unlimited bandwidth
- **Render free tier** — 512 MB RAM, cold starts after 15 min idle
- **Supabase free** — 500 MB PostgreSQL, 2 GB bandwidth
- **Gemini API** — generous free quota (60 req/min on flash model)
- **Gmail SMTP** — free email sending via app password (500/day limit)
- **FAISS** — CPU-only vector search, runs fine in 512 MB if index is small

### Not free (avoid for MVP)
- Twilio SMS — $0.0075/SMS, adds up fast
- Pinecone — vector DB paid after free tier
- OpenAI GPT-4 — expensive per token
- Render paid plan — $7/month, only needed for always-on

### Brutally honest constraints
- Render free tier **sleeps after 15 min**. First request takes 30–60 seconds.
- Your frontend must show a "Server waking up…" message and retry automatically.
- FAISS index must stay under **100 MB** — about 50,000 vectors at 768 dims.
- With 603 images × 768-dim Gemini embeddings = ~3.7 MB. Easily fits.
- No phone OTP for MVP. Gmail SMTP is free and reliable enough.

---

## 2. What Is Possible Free vs Paid

| Feature | Free | Paid alternative |
|---------|------|-----------------|
| Image hosting | GitHub Pages | Cloudflare R2 ($0.015/GB) |
| Backend | Render free | Render starter ($7/mo always-on) |
| Database | Supabase free (500 MB) | Supabase pro ($25/mo) |
| AI chat | Gemini Flash (free quota) | GPT-4o ($5/1M tokens) |
| Vector search | FAISS in-memory | Pinecone ($70/mo) |
| Email OTP | Gmail SMTP (500/day) | Brevo free (300/day), Resend (100/day) |
| SMS OTP | ❌ not free | Twilio ($0.0075/SMS) |
| Image analysis | Gemini Vision (free) | GPT-4 Vision ($0.01/image) |

---

## 3. Recommended Architecture

```
Browser (GitHub Pages)
    │
    │  Static: HTML, CSS, script.js, assets/discovery/*
    │
    ▼
Render Free Tier (FastAPI)
    │  /auth/*          — login, signup, OTP
    │  /ai/chat         — Gemini conversational AI
    │  /ai/analyze      — Gemini Vision image analysis
    │  /ai/search       — FAISS vector search
    │  /ideas/*         — CRUD for saved pins
    │  /boards/*        — board management
    │
    ├──► Supabase PostgreSQL (users, ideas, boards, saves, likes)
    ├──► FAISS index (in-memory, loaded from search_index.json on startup)
    └──► Gemini API (chat, embeddings, vision)
```

### Memory budget on Render 512 MB
| Component | Memory |
|-----------|--------|
| FastAPI + uvicorn | ~60 MB |
| FAISS index (603 images) | ~4 MB |
| numpy + google-generativeai | ~80 MB |
| SQLite (dev) or psycopg2 | ~10 MB |
| Safety headroom | ~358 MB |
| **Total** | **~154 MB** ✅ |

---

## 4. Required Services and Environment Variables

### Render environment variables (set in Render dashboard)
```
JWT_SECRET=<random 64-char string>
GEMINI_API_KEY=<from aistudio.google.com>
OPENAI_API_KEY=<optional — fallback only>

# Email OTP (free Gmail SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=youremail@gmail.com
SMTP_PASS=<16-char Gmail app password>
FROM_EMAIL=youremail@gmail.com

# Supabase (optional — use for production DB)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=<service_role_key>
DATABASE_URL=postgresql://postgres:password@db.xxx.supabase.co:5432/postgres
```

### Gmail App Password setup
1. Go to myaccount.google.com → Security → 2-Step Verification → App passwords
2. Create an app password for "Mail"
3. Use that 16-character password as SMTP_PASS
4. Daily limit: 500 emails. More than enough for MVP.

---

## 5. Database Schema

### Supabase / PostgreSQL tables

```sql
-- Users
CREATE TABLE users (
    id          SERIAL PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    username    TEXT UNIQUE,
    password    TEXT,              -- bcrypt hash (null for OTP-only users)
    bio         TEXT,
    location    TEXT,
    avatar_url  TEXT,
    social_links JSONB DEFAULT '{}',
    favorite_category TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Ideas (pinned images)
CREATE TABLE ideas (
    id          SERIAL PRIMARY KEY,
    user_id     INT REFERENCES users(id),
    title       TEXT NOT NULL,
    description TEXT,
    image_url   TEXT NOT NULL,
    category    TEXT,
    source      TEXT DEFAULT 'user',   -- 'curated'|'user'|'api'
    saves_count INT DEFAULT 0,
    likes_count INT DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Boards
CREATE TABLE boards (
    id          SERIAL PRIMARY KEY,
    user_id     INT REFERENCES users(id),
    name        TEXT NOT NULL,
    description TEXT,
    cover_url   TEXT,
    is_private  BOOL DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Board ↔ Idea junction
CREATE TABLE board_ideas (
    board_id    INT REFERENCES boards(id) ON DELETE CASCADE,
    idea_id     INT REFERENCES ideas(id) ON DELETE CASCADE,
    added_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (board_id, idea_id)
);

-- Saves (bookmarks)
CREATE TABLE saves (
    user_id     INT REFERENCES users(id) ON DELETE CASCADE,
    idea_id     INT REFERENCES ideas(id) ON DELETE CASCADE,
    saved_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, idea_id)
);

-- Likes
CREATE TABLE likes (
    user_id     INT REFERENCES users(id) ON DELETE CASCADE,
    idea_id     INT REFERENCES ideas(id) ON DELETE CASCADE,
    liked_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, idea_id)
);

-- OTP (optional — currently stored in memory for free tier)
CREATE TABLE otp_codes (
    email       TEXT PRIMARY KEY,
    code        TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    attempts    INT DEFAULT 0
);
```

---

## 6. Backend API Routes

```
POST /auth/signup              — email + password
POST /auth/login               — email + password → JWT
GET  /auth/me                  — current user (JWT required)
PATCH /auth/me                 — update profile
POST /auth/otp/send            — send 6-digit code to email
POST /auth/otp/verify          — verify code → JWT
POST /auth/signup-with-otp     — OTP-based registration

GET  /ideas                    — list ideas (paginated, filterable by category)
POST /ideas                    — create idea (JWT required)
GET  /ideas/{id}               — single idea
DELETE /ideas/{id}             — delete (owner only)
POST /ideas/{id}/save          — toggle save
POST /ideas/{id}/like          — toggle like

GET  /boards                   — user's boards
POST /boards                   — create board
POST /boards/{id}/ideas        — add idea to board

POST /upload                   — upload image → returns URL
POST /upload-image             — alias

POST /ai/chat                  — conversational AI (Gemini + FAISS)
POST /ai/analyze               — Gemini Vision image analysis
GET  /ai/search?q=             — semantic search via FAISS
POST /ai/generate              — board generator

GET  /dashboard                — user stats
GET  /images/category          — discovery images by category
GET  /images/aesthetic-mix     — curated aesthetic mix
```

---

## 7. AI Prompt Design

### /ai/chat pipeline (what runs in memory)

```
User message
    │
    ├─ 1. Gemini embed (text-embedding-004, 768 dims)
    │       ↓
    ├─ 2. FAISS cosine search → top 6 matching images
    │
    ├─ 3. Keyword search in Supabase ideas table → top 6 DB hits
    │
    ├─ 4. Merge results, build context string
    │
    └─ 5. Gemini 1.5 Flash:
            system: [SYSTEM PROMPT — see below]
            user: [query + context]
            → answer + image refs
```

### System prompt (what makes the AI useful)
```
You are ZenPin AI — a creative discovery assistant.
You help users find ideas, analyse aesthetics, and get craft/design guidance
from ZenPin's own image library.

Capabilities:
- Answer craft, design and DIY questions with expert depth
- Analyse uploaded images (when a URL is provided)
- Search ZenPin's library (cars, bikes, anime, fashion, interior,
  accessories, nature, architecture, gaming, food, fitness, art, etc.)
- Compare visual options and give direct, opinionated answers

Rules:
- Lead with a direct answer (1-2 sentences), then explanation
- Use **bold** for key terms, bullet points for steps
- Under 220 words — dense and useful, no filler
- Reference the ZenPin cards shown below your answer when relevant
- NEVER invent image URLs — only reference images in the provided context
- If no relevant content exists in ZenPin, say so clearly
- For craft questions: list materials, steps, difficulty (1–5)
```

### /ai/analyze prompt (for uploaded images)
```
Analyse this image for a creative/craft context:
1. What is shown? (1 sentence)
2. Style/aesthetic category (e.g. minimal, industrial, anime, vintage)
3. Colour palette (3-5 colours)
4. Craft/DIY ideas inspired by this image (3 bullet points)
5. Which ZenPin categories match? (list 2-3 from: cars, bikes, anime, fashion,
   interior, accessories, nature, architecture, gaming, food, fitness, art, music)
Keep under 150 words.
```

---

## 8. OTP Auth Flow

### Email OTP (implemented, free)
```
1. User enters email on login.html
2. POST /auth/otp/send { email }
   → Generate 6-digit code (100000–999999)
   → Store in memory: { otp, expires_at (10 min), attempts: 0 }
   → Send via Gmail SMTP (smtplib, free)
   → In demo mode (no SMTP): return demo_otp in response

3. User enters code
4. POST /auth/otp/verify { email, otp }
   → Check code matches and not expired
   → Increment attempts (block after 5)
   → If new user → create account
   → Return JWT token + user object

5. Frontend:
   localStorage.setItem("zenpin_token", data.token)
   localStorage.setItem("zenpin_user", JSON.stringify(data.user))
   updateNavbar()
   navigate("home")
```

### Phone OTP — realistic verdict
**Skip it for MVP.** Twilio costs $0.0075/SMS + $1/month for a number. 
For 100 users = ~$0.75/month. Doable, but adds complexity.
If you want phone OTP in v2:
- Use Twilio Verify ($0.05/verification, includes number)
- Or Vonage (similar pricing)
- Environment variable: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE

---

## 9. Render Deployment Notes

### render.yaml (place in repo root)
```yaml
services:
  - type: web
    name: zenpin-api
    env: python
    buildCommand: pip install -r requirements.txt
    startCommand: uvicorn main:app --host 0.0.0.0 --port $PORT --workers 1
    envVars:
      - key: JWT_SECRET
        generateValue: true
      - key: GEMINI_API_KEY
        sync: false
      - key: SMTP_HOST
        value: smtp.gmail.com
      - key: SMTP_PORT
        value: "587"
      - key: SMTP_USER
        sync: false
      - key: SMTP_PASS
        sync: false
```

### Cold start handling (frontend)
```javascript
// Ping backend on page load — wakes it up before user needs it
fetch("https://zenpin-api.onrender.com/warmup", {
    mode: "cors", credentials: "omit"
}).catch(() => {});
```

### Workers: always use 1 worker on free tier
- Multiple workers = multiple processes = OOM crash
- FAISS index loads per-process — 1 worker = 1 load

### search_index.json
- Commit this file to your backend repo
- Render serves it from disk on startup
- Update it locally with: `python index_images.py --no-ml`
- Re-deploy after updating

---

## 10. Security Checklist

- [x] JWT secret is env var (never hardcoded)
- [x] Passwords are bcrypt hashed (passlib)
- [x] OTP expires in 10 minutes
- [x] OTP locked after 5 wrong attempts
- [x] CORS restricted to github.io domain + localhost
- [x] SQL uses parameterised queries (no raw string interpolation)
- [x] File uploads validate MIME type
- [ ] **TODO**: Add rate limiting on /auth/otp/send (max 3/hour per email)
- [ ] **TODO**: Add HTTPS-only cookie for token (after moving off GitHub Pages)
- [ ] **TODO**: Remove demo_otp from response before launch
- [ ] **TODO**: Rotate JWT_SECRET before launch
- [ ] **TODO**: Enable Supabase Row Level Security

### Rate limiting (add to main.py for OTP)
```python
from collections import defaultdict
import time

_otp_rate: dict = defaultdict(list)  # email → [timestamps]

def check_otp_rate(email: str, max_per_hour: int = 3) -> bool:
    now = time.time()
    times = [t for t in _otp_rate[email] if now - t < 3600]
    _otp_rate[email] = times
    if len(times) >= max_per_hour:
        return False   # blocked
    _otp_rate[email].append(now)
    return True        # allowed
```

---

## 11. MVP Roadmap

### Version 1 (current — ship this week)
- [x] GitHub Pages frontend with 23 image categories
- [x] FastAPI backend on Render free tier
- [x] JWT authentication (email + password)
- [x] OTP login via email (SMTP)
- [x] Image discovery feed with local images first
- [x] Category filtering (all 23 categories working)
- [x] Save / like / board functionality
- [x] AI chat (Gemini + keyword search)
- [x] Edit profile modal
- [x] Floating hero background (three-layer depth)

### Version 2 (next 4 weeks)
- [ ] Supabase PostgreSQL instead of SQLite
- [ ] Image upload with Cloudflare R2 or Supabase Storage
- [ ] FAISS index built from all 603 images (run index_images.py)
- [ ] AI image analysis (Gemini Vision on uploaded photos)
- [ ] Render starter plan ($7/mo) for always-on + custom domain
- [ ] OTP phone via Twilio Verify
- [ ] Email notifications for saves/likes (SendGrid free 100/day)

### Version 3 (month 2–3)
- [ ] Collaborative boards
- [ ] Follow/follower system
- [ ] Trending feed algorithm
- [ ] PWA (installable on mobile)
- [ ] Custom domain + SSL
- [ ] Analytics (Plausible, $9/mo)

---

## 12. How to Build the FAISS Index

### Step 1 — Run the indexer locally
```bash
cd Backend/
pip install google-generativeai numpy faiss-cpu pillow
python index_images.py --no-ml   # uses filename-based embeddings (no API cost)
# OR
python index_images.py           # uses Gemini embeddings (uses API quota)
```

### index_images.py (what it does)
```python
"""
Scans assets/discovery/ on GitHub Pages (or locally).
For each image: generates an embedding vector.
Saves search_index.json: [{url, caption, category, vector}, ...]
"""
```

### Step 2 — Commit search_index.json to backend repo
```bash
cp search_index.json Backend/
cd Backend/
git add search_index.json
git commit -m "feat: add FAISS search index for 603 images"
git push
# Render auto-deploys
```

### Step 3 — Backend loads it at startup
```python
# In main.py startup:
with open("search_index.json") as f:
    data = json.load(f)
# Converts to numpy array, builds FAISS flat L2 index
# Memory: ~4 MB for 603 images at 768 dims
```

---

## 13. metadata.json structure

Store alongside images for richer AI context:

```json
{
  "categories": {
    "bikes": {
      "display": "Bikes",
      "folder": "Bikes",
      "count": 30,
      "tags": ["motorcycle", "sport", "cruiser", "vintage", "racing"],
      "description": "High-quality motorcycle and bike photography",
      "images": [
        {
          "filename": "bike1.jpg",
          "url": "assets/discovery/Bikes/bike1.jpg",
          "caption": "Red sport bike on mountain road",
          "tags": ["red", "sport", "mountain"],
          "color": "#cc2222"
        }
      ]
    },
    "accessories": {
      "display": "Ladies Accessories",
      "folder": "accessories",
      "prefix": "accessory",
      "count": 30,
      "tags": ["jewelry", "bags", "watches", "fashion", "style"],
      "description": "Fashion accessories and jewelry photography"
    }
  }
}
```

---

## 14. Backend Folder Structure

```
Backend/
├── main.py              # FastAPI app, all routes
├── database.py          # DB connection, CRUD functions
├── auth_utils.py        # JWT create/verify, password hash
├── requirements.txt     # dependencies
├── search_index.json    # FAISS vector data (commit this)
├── index_images.py      # script to rebuild search_index.json
├── metadata.json        # category/image metadata for AI context
├── render.yaml          # Render deployment config
└── .env.example         # template for environment variables
```

---

## 15. Exact Deployment Order

```
1. Merge all backend fixes into main branch
2. git push → Render auto-deploys (watch logs for errors)
3. Set all environment variables in Render dashboard
4. Test /auth/otp/send with your own email
5. Push search_index.json to backend repo
6. Test /ai/chat from browser console
7. Push frontend script.js to GitHub Pages
8. Hard refresh (Ctrl+Shift+R) and verify:
   - Anime chip appears and loads 30 images
   - Bikes chip loads 30 images from /Bikes/ folder
   - Ladies Accessories loads 30 images
   - OTP email arrives within 30 seconds
   - AI chat answers a craft question
```

---

## 16. Exact Changes in script.js for Each Issue

### Anime — already correct (no changes needed)
```
_curatedCache["anime"] = seq("anime", "anime", 30)
  → assets/discovery/anime/anime1.jpg ... anime30.jpg ✅

CATEGORY_MAP["anime"] = "anime"  ✅
CATEGORY_MAP["Anime"] = "anime"  ✅
CACHE_KEY_TO_FILTER["anime"] = "Anime"  ✅
```
If anime still doesn't appear → the image files are not committed to GitHub.
Run: `git add assets/discovery/anime/ && git push`

### Edit Profile — fixed this session
```javascript
// OLD: returns on /auth/me failure (closes modal)
} catch (_) {
    epError.textContent = "Could not load profile.";
    return;   ← BUG: closes modal
}

// NEW: keeps modal open for retry
} catch (fetchErr) {
    epError.textContent = "Profile load failed (server waking up). You can still edit and save.";
    // No return — modal stays open ✅
}
```

### Auth tokens — already correct
```javascript
// Logout removes ALL keys:
localStorage.removeItem("zenpin_token");  ✅
localStorage.removeItem("zenpin_user");   ✅
localStorage.removeItem("token");         ✅ (legacy)
localStorage.removeItem("user");          ✅ (legacy)
```

### navigate() alias — already present
```javascript
window.navigate = go;   ✅
```

### DB category contamination — already fixed
```javascript
// When filter active, DB ideas are filtered to matching category:
const filteredDb = cat
  ? dbIdeas.filter(idea => {
      const key = CATEGORY_MAP[raw] || CATEGORY_MAP[raw.toLowerCase()] || raw;
      return key === activeKey;
    })
  : dbIdeas;
```
