# ZenPin Backend — How to Run

## What you get

```
zenpin-backend/
├── main.py          ← FastAPI server (all 15 routes)
├── database.py      ← SQLite logic (all queries)
├── auth.py          ← Passwords + JWT tokens
├── api.js           ← Drop into your frontend to talk to the backend
├── requirements.txt ← Python packages to install
├── .env.example     ← Copy to .env and fill in secrets
└── uploads/         ← Uploaded images are saved here
```

---

## Step 1 — Install Python

Download Python 3.11+ from https://python.org/downloads
Make sure to check "Add Python to PATH" during install.

Verify it works:
```bash
python --version
# Should print: Python 3.11.x or higher
```

---

## Step 2 — Create a virtual environment

A virtual environment keeps your project's packages separate from everything else.

```bash
# Go into the backend folder
cd zenpin-backend

# Create the virtual environment
python -m venv venv

# Activate it
# On Windows:
venv\Scripts\activate
# On Mac/Linux:
source venv/bin/activate

# Your terminal prompt should now show (venv) at the start
```

---

## Step 3 — Install packages

```bash
pip install -r requirements.txt
```

This installs:
- **fastapi** — the web framework
- **uvicorn** — the server that runs FastAPI
- **python-jose** — for JWT tokens
- **passlib[bcrypt]** — for password hashing
- **python-multipart** — for file uploads
- **openai** — for AI generation (optional)
- **python-dotenv** — reads your .env file
- **aiofiles** — async file handling

---

## Step 4 — Set up your .env file

```bash
# Copy the template
cp .env.example .env
```

Open `.env` in any text editor and fill in:

```
JWT_SECRET=any_long_random_string_here

# Optional — for real AI generation:
OPENAI_API_KEY=sk-...your-key-here...
```

To generate a strong JWT secret, run:
```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

> Without an OpenAI key the AI generator still works — it uses
> smart keyword matching to pick relevant ideas from your database.

---

## Step 5 — Run the server

```bash
uvicorn main:app --reload
```

`--reload` means the server restarts automatically whenever you save a file.

You should see:
```
✅ Database ready — zenpin.db
✅ Seeded 20 demo ideas
🚀 ZenPin API running at http://localhost:8000
📖 API docs at        http://localhost:8000/docs
```

---

## Step 6 — Test it in your browser

Open: **http://localhost:8000/docs**

This is FastAPI's automatic interactive documentation.
You can test every single route right there — sign up, log in, create ideas, etc.

Try this first:
1. Click **POST /auth/signup** → "Try it out"
2. Fill in username, email, password → Execute
3. Copy the token from the response
4. Click the 🔒 Authorize button at the top
5. Paste `Bearer YOUR_TOKEN_HERE`
6. Now all protected routes work!

---

## Step 7 — Connect your frontend

Copy `api.js` into the same folder as your `index.html`.

Add it to your HTML **before** `script.js`:

```html
<script src="api.js"></script>
<script src="script.js"></script>
```

Now in `script.js`, replace the static IDEAS array with real API calls.

### Replace static data with live data

**Before (static):**
```javascript
function initHome() {
  renderGrid(DOM.homeGrid, filtered(IDEAS.slice(0, S.loaded)));
}
```

**After (from backend):**
```javascript
async function initHome() {
  try {
    const { ideas } = await API.getIdeas({
      category: S.filter !== "all" ? S.filter : undefined,
      search:   S.search || undefined,
      sort:     DOM.homeSort.value,
    });
    renderGrid(DOM.homeGrid, ideas);
  } catch (err) {
    console.error("Failed to load ideas:", err);
  }
}
```

### Replace save/like with real API calls

**Before:**
```javascript
S.savedIds.add(id);
```

**After:**
```javascript
if (API.isLoggedIn()) {
  const { saved, saves_count } = await API.toggleSave(id);
  // update UI
} else {
  showLoginModal(); // prompt user to log in
}
```

### Replace AI generation

**Before:**
```javascript
// keyword matching in script.js
const pool = key ? AI_SEED_MAP[key].map(...) : ...
```

**After:**
```javascript
async function runAI() {
  const topic = DOM.aiInput.value.trim();
  if (!topic) return;
  DOM.aiLoading.style.display = "block";
  try {
    const { ideas, description } = await API.generateBoard(topic);
    renderGrid(DOM.aiGrid, ideas);
    DOM.aiOutput.style.display = "block";
  } catch (err) {
    toast("AI generation failed: " + err.message);
  } finally {
    DOM.aiLoading.style.display = "none";
  }
}
```

---

## All API Endpoints

| Method | URL | What it does | Auth? |
|--------|-----|-------------|-------|
| GET | `/` | Health check | No |
| POST | `/auth/signup` | Create account | No |
| POST | `/auth/login` | Log in, get token | No |
| GET | `/auth/me` | Your profile + saved/liked IDs | Yes |
| PATCH | `/auth/me` | Update bio | Yes |
| GET | `/ideas` | List ideas (filter/search/sort/page) | Optional |
| POST | `/ideas` | Create idea | Yes |
| GET | `/ideas/{id}` | Single idea | Optional |
| DELETE | `/ideas/{id}` | Delete your idea | Yes |
| POST | `/ideas/{id}/save` | Toggle save | Yes |
| POST | `/ideas/{id}/like` | Toggle like | Yes |
| GET | `/users/{id}/saves` | Saved ideas list | Yes |
| GET | `/boards` | Your boards | Yes |
| POST | `/boards` | Create board | Yes |
| POST | `/boards/{id}/ideas` | Add idea to board | Yes |
| POST | `/upload` | Upload image → get URL | Yes |
| POST | `/ai/generate` | AI inspiration board | Yes |

---

## Demo account (auto-created on first run)

```
Email:    admin@zenpin.app
Password: admin123
```

---

## Common problems

**"Module not found" error**
→ Make sure your virtual environment is activated (`venv\Scripts\activate` on Windows)

**"Address already in use"**
→ Another server is running on port 8000. Stop it or use: `uvicorn main:app --reload --port 8001`

**CORS error in browser console**
→ Make sure the server is running and you're calling `http://localhost:8000` not `https://`

**"Token expired"**
→ Log in again. Tokens expire after 7 days by default (change JWT_EXPIRE_DAYS in .env)

**OpenAI not working**
→ Check your OPENAI_API_KEY in .env. The mock generator works without it.
