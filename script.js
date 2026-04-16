// ============================================================
// script.js — ZenPin SPA Core
// Fully wired to https://zenpin-api.onrender.com
// ============================================================

const API_URL = "https://zenpin-api.onrender.com";

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────
const S = {
  page:          "home",
  filter:        "all",
  search:        "",
  sort:          "newest",
  loaded:        20,
  savedIds:      new Set(),
  likedIds:      new Set(),
  modalId:       null,
  profileTab:    "saved",
  aiHistory:     [],
  ideas:         [],      // live from backend
  allIdeas:      [],      // full cache for offline fallback
  discoveryPage: {},      // tracks current discovery page per category e.g. {anime: 3}
};

// ════════════════════════════════════════════════════════════
// UserPrefs — lightweight personalization engine
//
// Tracks which categories the user engages with (click, save,
// like, filter) and stores interest weights in localStorage.
// These weights feed directly into scoreIdea() so the feed
// surfaces preferred categories more often.
//
// Storage key: "zenpin_prefs"
// Format: { "cars": 8, "anime": 3, "fashion": 1, ... }
// Max weight per category: 50 (prevents runaway domination)
// ════════════════════════════════════════════════════════════
const UserPrefs = (() => {
  const KEY     = "zenpin_prefs";
  const MAX_W   = 50;

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || "{}"); }
    catch { return {}; }
  }

  function save(prefs) {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); }
    catch {}
  }

  function bump(category, delta = 1) {
    if (!category) return;
    const key   = category.toLowerCase().trim();
    const prefs = load();
    prefs[key]  = Math.min((prefs[key] || 0) + delta, MAX_W);
    save(prefs);
  }

  function getWeight(category) {
    if (!category) return 0;
    const prefs = load();
    return prefs[category.toLowerCase().trim()] || 0;
  }

  function getAll() { return load(); }

  // Returns top N categories by weight — used for feed mix
  function topCategories(n = 3) {
    const prefs = load();
    return Object.entries(prefs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([cat]) => cat);
  }

  // Decay all weights slightly each session (prevents stale prefs
  // from dominating forever). Called once on page load.
  function decay() {
    const prefs = load();
    let changed = false;
    for (const k in prefs) {
      if (prefs[k] > 0) { prefs[k] = Math.max(0, prefs[k] - 1); changed = true; }
    }
    if (changed) save(prefs);
  }

  // Reset — accessible from console: UserPrefs.reset()
  function reset() { localStorage.removeItem(KEY); }

  return { bump, getWeight, getAll, topCategories, decay, reset };
})();


// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmt = n => n >= 1000 ? (n/1000).toFixed(1).replace(".0","")+"k" : String(n||0);

// Debounce — prevent search/filter firing on every keystroke
function debounce(fn, ms = 300) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function escHtml(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function escAttr(s) { return String(s||"").replace(/'/g,"\'").replace(/"/g,"\&quot;"); }

function token()     { return localStorage.getItem("zenpin_token"); }
function isLoggedIn(){ return !!token(); }

function getUser() {
  try { return JSON.parse(localStorage.getItem("zenpin_user") || "null"); }
  catch { return null; }
}

// ─────────────────────────────────────────────────────────────
// API WRAPPER
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// API RESPONSE CACHE
// Caches GET responses in memory for the current session.
// TTL varies by endpoint type:
//   ideas / discovery  → 3 minutes  (content changes slowly)
//   dashboard stats    → 1 minute   (user-specific, more volatile)
//   AI responses       → not cached (always fresh)
// Cache is keyed by full URL path so filters / pagination work
// correctly (each unique query string = separate cache entry).
// ─────────────────────────────────────────────────────────────
const _apiCache = new Map();   // key → {data, expiresAt}

function _cacheGet(key) {
  const entry = _apiCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _apiCache.delete(key); return null; }
  return entry.data;
}

function _cacheSet(key, data, ttlMs) {
  _apiCache.set(key, { data, expiresAt: Date.now() + ttlMs });
  // Evict oldest entries if cache grows beyond 80 items
  if (_apiCache.size > 80) {
    const oldest = [..._apiCache.entries()]
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0][0];
    _apiCache.delete(oldest);
  }
}

const _CACHE_TTL = {
  "/ideas":             3 * 60 * 1000,   // 3 min
  "/images/category":   3 * 60 * 1000,   // 3 min
  "/dashboard":         1 * 60 * 1000,   // 1 min
};
function _ttlFor(path) {
  for (const [prefix, ttl] of Object.entries(_CACHE_TTL)) {
    if (path.startsWith(prefix)) return ttl;
  }
  return 0;   // 0 = do not cache
}

async function apiFetch(method, path, body = null, isForm = false) {
  const headers = {};
  if (token()) headers["Authorization"] = `Bearer ${token()}`;
  if (body && !isForm) headers["Content-Type"] = "application/json";

  // Only cache cacheable GET requests with no body
  const ttl       = method === "GET" && !body ? _ttlFor(path) : 0;
  const cacheKey  = path;   // path already includes query string

  if (ttl > 0) {
    const cached = _cacheGet(cacheKey);
    if (cached) return cached;
  }

  const res  = await fetch(`${API_URL}${path}`, {
    method,
    mode: "cors",
    credentials: "omit",
    headers,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

  if (ttl > 0) _cacheSet(cacheKey, data, ttl);
  return data;
}

// Expose for manual cache busting (e.g. after a user posts)
function clearApiCache(prefix) {
  if (!prefix) { _apiCache.clear(); return; }
  for (const k of _apiCache.keys()) {
    if (k.startsWith(prefix)) _apiCache.delete(k);
  }
}

// ─────────────────────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────────────────────
let _toastTimer;
function toast(msg = "Done!", isError = false) {
  const bar  = $("toastBar");
  const text = $("toastText");
  if (!bar || !text) return;
  text.textContent = msg;
  bar.style.background = isError ? "#dc2626" : "#1a1714";
  bar.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => bar.classList.remove("show"), 2800);
}

// ─────────────────────────────────────────────────────────────
// AUTH GUARD
// ─────────────────────────────────────────────────────────────
function requireLogin(action) {
  if (!isLoggedIn()) {
    // show the auth-required modal from auth.js if available
    if (window.Auth?.showLoginModal) {
      Auth.showLoginModal(action || "Sign in to continue");
    } else {
      window.location.href = "login.html";
    }
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────
// NAVBAR — auth state
// ─────────────────────────────────────────────────────────────
function updateNavbar() {
  const loginBtn   = $("navLoginBtn");
  const userMenu   = $("navUserMenu");
  const usernameEl = $("navUsername");
  const avatarEl   = $("navAvatar");
  const logoutBtn  = $("navLogoutBtn");
  const user       = getUser();

  if (isLoggedIn() && user) {
    if (loginBtn)   loginBtn.style.display  = "none";
    if (userMenu)   { userMenu.style.display = "flex"; }
    if (usernameEl) usernameEl.textContent   = user.username || "You";
    if (avatarEl) {
      avatarEl.textContent = (user.username || "Y")[0].toUpperCase();
      if (user.avatar_url) {
        avatarEl.style.backgroundImage = `url(${user.avatar_url})`;
        avatarEl.style.backgroundSize  = "cover";
        avatarEl.textContent = "";
      }
    }
    if (logoutBtn) logoutBtn.onclick = () => {
      // Remove ALL possible token keys (old + new) to ensure clean logout
      localStorage.removeItem("zenpin_token");
      localStorage.removeItem("zenpin_user");
      localStorage.removeItem("token");   // legacy key
      localStorage.removeItem("user");    // legacy key
      S.savedIds.clear();
      S.likedIds.clear();
      updateNavbar();
      navigate("home");
      toast("Logged out. See you soon! 👋");
    };
  } else {
    if (loginBtn) loginBtn.style.display = "flex";
    if (userMenu) userMenu.style.display = "none";
  }
}

// ─────────────────────────────────────────────────────────────
// LOAD USER STATE (saves + likes) from backend
// ─────────────────────────────────────────────────────────────
async function loadUserState() {
  if (!isLoggedIn()) {
    console.log("[ZenPin] no token found, skipping /auth/me");
    return;
  }
  try {
    const me = await apiFetch("GET", "/auth/me");
    localStorage.setItem("zenpin_user", JSON.stringify(me));
    S.savedIds = new Set(me.saved_idea_ids  || []);
    S.likedIds = new Set(me.liked_idea_ids  || []);
    updateNavbar();
  } catch (e) {
    const msg = e?.message || "";
    if (msg.includes("401") || msg.includes("403") || msg.includes("expired")) {
      // Invalid token — clear all keys
      localStorage.removeItem("zenpin_token");
      localStorage.removeItem("zenpin_user");
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      updateNavbar();
      console.log("[ZenPin] invalid token cleared");
    }
  }
}

// ─────────────────────────────────────────────────────────────
// CARD BUILDER — single source of truth
// ─────────────────────────────────────────────────────────────
function stars(val, cls) {
  return Array.from({length:5}, (_,i) =>
    `<div class="rb-star ${i < val ? "on-"+cls : ""}"></div>`
  ).join("");
}

function cardHTML(idea, idx) {
  if (!idea) return "";
  const saved = S.savedIds.has(idea.id);
  const liked = S.likedIds.has(idea.id);
  const diff  = idea.difficulty  || idea.diff  || 3;
  const creat = idea.creativity  || idea.creat || 3;
  const use   = idea.usefulness  || idea.use   || 3;
  const saves = (idea.saves_count || idea.saves || 0);
  const catKey = (idea.category||"scenery").toLowerCase();

  // Image resolution priority:
  //   1. Local curated file  (assets/discovery/{folder}/)  — via getLocalImage()
  //   2. idea.image_url       (user upload or backend image)
  //   3. LoremFlickr          (always category-correct fallback)
  //   4. Picsum               (onerror data-fb1)
  //   5. SVG gradient         (onerror data-fb2, never fails)
  const stableSlot = Math.abs(idea.id) % 50;
  const imgSrc     = getLocalImage(idea);                     // local-first
  const picsumFb   = idea.thumb_url || getPicsumUrl(catKey, stableSlot);
  const svgFb      = makePlaceholder(catKey, stableSlot, idea.title);

  const sourceBadge = idea.source === "creator"
    ? `<div class="card-source-badge creator">Creator</div>`
    : idea.source === "discovery"
    ? `<div class="card-source-badge discovery">Discovery</div>`
    : "";

  return `
<div class="idea-card" data-id="${idea.id}" style="--i:${idx}">
  <div class="card-img-wrap">
    <img class="card-img lazy-img"
      src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="
      data-src="${imgSrc}"
      alt="${escHtml(idea.title)}"
      data-fb1="${picsumFb}"
      data-fb2="${svgFb}"
      onerror="(function(el){if(!el._e1){el._e1=1;el.src=el.dataset.fb1||el.dataset.fb2;}else if(!el._e2){el._e2=1;el.src=el.dataset.fb2;el.onerror=null;}else{var c=el.closest('.idea-card');if(c)c.style.display='none';}})(this)"
    />
    ${sourceBadge}
    <div class="card-static-cat">${idea.category}</div>
    <div class="card-overlay">
      <div class="card-top-row">
        <button class="card-ico-btn ${liked?"heart-on":""}" data-action="like" data-id="${idea.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="${liked?"currentColor":"none"}" stroke="currentColor" stroke-width="2">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
        </button>
        <button class="card-ico-btn ${saved?"save-on":""}" data-action="save" data-id="${idea.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="${saved?"currentColor":"none"}" stroke="currentColor" stroke-width="2">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
          </svg>
        </button>
      </div>
      <div class="card-bot-row">
        <div class="card-cat-pill">${idea.category}</div>
        <div class="card-title">${idea.title}</div>
      </div>
    </div>
  </div>
  <div class="card-footer">
    <div class="card-saves">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
      ${fmt(saves)}
    </div>
    <div class="card-author">${idea.username || ""}</div>
  </div>
</div>`;
}

function renderGrid(container, ideas) {
  if (!container) return;
  resetImageVariety();

  // Use DocumentFragment for a single DOM insertion (fewer reflows)
  // No incremental skip guard — always render what we're given.
  // The guard was causing silent failures when the first-N IDs
  // matched a previous render but the full dataset had changed.
  const frag = document.createDocumentFragment();
  const tmp  = document.createElement("div");
  tmp.innerHTML = ideas.map((idea, i) => cardHTML(idea, i)).join("");
  while (tmp.firstChild) frag.appendChild(tmp.firstChild);
  container.innerHTML = "";
  container.appendChild(frag);

  console.log(`[ZenPin] renderGrid: ${ideas.length} ideas → #${container.id || "grid"}`);
  window.dispatchEvent(new CustomEvent("zenpin:gridupdate"));

  // Preload first 6 above-the-fold images immediately
  ideas.slice(0, 6).forEach(idea => {
    const url = getLocalImage(idea);
    if (url && !url.includes("picsum")) {
      const img   = new Image();
      img.loading = "eager";
      img.src     = url;
    }
  });
}

function appendGrid(container, ideas, startIdx) {
  if (!container) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = ideas.map((idea, i) => cardHTML(idea, startIdx + i)).join("");
  while (tmp.firstChild) container.appendChild(tmp.firstChild);
  // Notify lazy observers about new cards
  window.dispatchEvent(new CustomEvent("zenpin:gridupdate"));
}

// ─────────────────────────────────────────────────────────────
// TYPOGRAPHY SETTINGS
// Fonts stored in localStorage, applied on page load + change
// ─────────────────────────────────────────────────────────────
const FONT_PRESETS = {
  default:     { name: "ZenPin Default", css: "'Inter', 'DM Sans', sans-serif" },
  serif:       { name: "Elegant Serif",  css: "'Playfair Display', 'Georgia', serif" },
  minimal:     { name: "Minimal Modern", css: "'DM Mono', 'Fira Code', monospace" },
  handwritten: { name: "Creative Script",css: "'Caveat', 'Dancing Script', cursive" },
};

// ─────────────────────────────────────────────────────────────
// PIXABAY KEY SETTINGS — user enters free key for infinite images
// Get free key at: https://pixabay.com/api/docs/
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// UNSPLASH KEY SETTINGS — direct browser API, best image quality
// Get free key at: https://unsplash.com/developers
// ─────────────────────────────────────────────────────────────
const UnsplashSettings = {
  STORAGE_KEY: "zenpin_unsplash_key",

  get() { return localStorage.getItem(this.STORAGE_KEY) || ""; },

  set(key) {
    key ? localStorage.setItem(this.STORAGE_KEY, key.trim())
        : localStorage.removeItem(this.STORAGE_KEY);
  },

  renderInput(containerId) {
    const el = $(containerId);
    if (!el) return;
    const current = this.get();
    el.innerHTML = `
      <div class="pixabay-setting">
        <div class="pixabay-setting-head">
          <span class="pixabay-label">📸 Unsplash Images</span>
          <a href="https://unsplash.com/developers" target="_blank" class="pixabay-get-key">Get free key →</a>
        </div>
        <p class="pixabay-hint">Best image quality. Free Unsplash Access Key gives perfect category-matched photos.</p>
        <div class="pixabay-input-row">
          <input type="password" id="unsplashKeyInput" class="pixabay-input"
            placeholder="Paste Unsplash Access Key…"
            value="${current}" autocomplete="off" spellcheck="false"/>
          <button class="pixabay-save-btn" onclick="
            const v = document.getElementById('unsplashKeyInput').value.trim();
            UnsplashSettings.set(v);
            this.textContent = '✓ Saved';
            setTimeout(()=> this.textContent = 'Save', 1500);
          ">Save</button>
        </div>
        ${current
          ? '<div class="pixabay-status active">✅ Active — Unsplash images enabled</div>'
          : '<div class="pixabay-status">No key set</div>'}
      </div>`;
  }
};

const PixabaySettings = {
  STORAGE_KEY: "zenpin_pixabay_key",

  get() { return localStorage.getItem(this.STORAGE_KEY) || ""; },

  set(key) {
    if (key) {
      localStorage.setItem(this.STORAGE_KEY, key.trim());
      // Reload PIXABAY_KEY runtime variable
      window._pixabayKey = key.trim();
    } else {
      localStorage.removeItem(this.STORAGE_KEY);
      window._pixabayKey = "";
    }
  },

  renderInput(containerId) {
    const el = $(containerId);
    if (!el) return;
    const current = this.get();
    el.innerHTML = `
      <div class="pixabay-setting">
        <div class="pixabay-setting-head">
          <span class="pixabay-label">🖼️ Infinite Images</span>
          <a href="https://pixabay.com/api/docs/" target="_blank" class="pixabay-get-key">Get free key →</a>
        </div>
        <p class="pixabay-hint">Add a free Pixabay API key to unlock infinite unique photos in every category.</p>
        <div class="pixabay-input-row">
          <input type="password" id="pixabayKeyInput" class="pixabay-input"
            placeholder="Paste your Pixabay API key…"
            value="${current}" autocomplete="off" spellcheck="false"/>
          <button class="pixabay-save-btn" onclick="
            const v = document.getElementById('pixabayKeyInput').value.trim();
            PixabaySettings.set(v);
            this.textContent = v ? '✓ Saved' : '✓ Cleared';
            setTimeout(()=> this.textContent = 'Save', 1500);
          ">Save</button>
        </div>
        ${current ? '<div class="pixabay-status active">✅ Active — infinite unique photos enabled</div>' : '<div class="pixabay-status">No key — using curated photos</div>'}
      </div>`;
  }
};

const TypographySettings = {
  STORAGE_KEY: "zenpin_font",

  getCurrent() {
    return localStorage.getItem(this.STORAGE_KEY) || "default";
  },

  apply(key) {
    const preset = FONT_PRESETS[key] || FONT_PRESETS.default;
    document.documentElement.style.setProperty("--font-body", preset.css);
    // Update active state in any open font picker
    document.querySelectorAll(".font-opt-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.font === key);
    });
  },

  set(key) {
    localStorage.setItem(this.STORAGE_KEY, key);
    this.apply(key);
    toast(`Font: ${FONT_PRESETS[key]?.name || key}`);
  },

  init() {
    this.apply(this.getCurrent());
  },

  renderPicker(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const current = this.getCurrent();
    el.innerHTML = Object.entries(FONT_PRESETS).map(([key, p]) => `
      <button class="font-opt-btn ${current === key ? "active" : ""}" data-font="${key}"
              style="font-family:${p.css}">
        ${p.name}
        <span class="font-preview" style="font-family:${p.css}">Aa Bb Cc</span>
      </button>`).join("");
    el.addEventListener("click", e => {
      const btn = e.target.closest(".font-opt-btn");
      if (btn) TypographySettings.set(btn.dataset.font);
    });
  },
};

// ─────────────────────────────────────────────────────────────
// ROUTER
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// PAGE: DASHBOARD
// ─────────────────────────────────────────────────────────────
async function initDashboard() {
  // ── Not logged in: show global trending + prompt ─────────────
  const user = getUser();
  if (!user) {
    const inner = document.querySelector("#page-dashboard .page-inner");
    if (inner) inner.innerHTML = `
      <div style="text-align:center;padding:60px 20px 32px">
        <div style="font-size:3rem;margin-bottom:16px">📊</div>
        <h2 style="font-size:1.4rem;font-weight:700;margin-bottom:8px">Your Dashboard</h2>
        <p style="color:var(--text-3);margin-bottom:24px">Sign in to track your posts, saves, and creative activity.</p>
        <button class="btn-primary" onclick="window.location.href='login.html'">Sign In</button>
      </div>
      <div style="padding:0 0 40px">
        <h3 style="font-size:1rem;font-weight:700;margin-bottom:16px;padding:0 4px">🔥 Trending Discoveries</h3>
        <div class="ideas-grid" id="dashTrendingGrid"></div>
      </div>`;
    // Load trending discovery for logged-out users
    const trendGrid = document.getElementById("dashTrendingGrid");
    if (trendGrid) {
      const cats = Object.keys(CAT_CONFIG).sort(() => Math.random() - 0.5).slice(0, 3);
      const ideas = cats.flatMap(c => getCuratedForCategory(c, 8)).slice(0, 24);  // use local curated, no slice(0,12)
      renderGrid(trendGrid, ideas);
    }
    return;
  }

  // ── Show loading skeletons ──────────────────────────────────
  ["dashPosts","dashSaves","dashLikes","dashBoards"].forEach(id => {
    const el = $(id); if (el) el.textContent = "…";
  });
  const uploadGrid = $("dashUploadsGrid");
  const savesGrid  = $("dashSavesGrid");
  const catWrap    = $("dashCategoryList");
  if (uploadGrid) uploadGrid.innerHTML = skeletonHTML(3);
  if (savesGrid)  savesGrid.innerHTML  = skeletonHTML(3);
  if (catWrap)    catWrap.innerHTML    = `<div class="empty-state-sm">Loading…</div>`;

  try {
    const data = await apiFetch("GET", "/dashboard");

    // ── Stats ── (handle both flat and nested formats from backend)
    const stats = data.stats || data;
    if ($("dashPosts"))  $("dashPosts").textContent  = fmt(stats.posts  || 0);
    if ($("dashSaves"))  $("dashSaves").textContent  = fmt(stats.saves  || 0);
    if ($("dashLikes"))  $("dashLikes").textContent  = fmt(stats.likes  || 0);
    if ($("dashBoards")) $("dashBoards").textContent = fmt(stats.boards || 0);

    // ── Recent uploads ──
    if (uploadGrid) {
      const uploads = data.recent_uploads || [];
      if (uploads.length) {
        renderGrid(uploadGrid, uploads);
      } else {
        uploadGrid.innerHTML = `
          <div class="empty-state-sm">
            No posts yet.
            <button class="link-btn" id="dashCreateBtn">Share your first idea →</button>
          </div>`;
        $("dashCreateBtn")?.addEventListener("click", () => {
          const fn = document.querySelector && typeof openCreatorPost !== "undefined"
            ? openCreatorPost : null;
          if (fn) fn(); else $("creatorPostModal")?.classList.add("open");
        });
      }
    }

    // ── Recent saves ──
    if (savesGrid) {
      const saves = data.recent_saves || [];
      if (saves.length) {
        renderGrid(savesGrid, saves);
      } else {
        savesGrid.innerHTML = `
          <div class="empty-state-sm">
            Nothing saved yet.
            <button class="link-btn" data-page="explore">Explore ideas →</button>
          </div>`;
      }
    }

    // ── Top categories ──
    if (catWrap) {
      const cats = data.top_categories || [];
      if (cats.length) {
        catWrap.innerHTML = cats.map((c, i) => `
          <div class="dash-cat-row">
            <span class="dash-cat-rank">#${i+1}</span>
            <span class="dash-cat-name">${c.category}</span>
            <span class="dash-cat-count">${c.count} save${c.count !== 1 ? "s" : ""}</span>
            <button class="dash-cat-btn chip" data-filter="${c.category}" data-page="explore">Explore</button>
          </div>`).join("");
      } else {
        catWrap.innerHTML = `
          <div class="empty-state-sm">
            Save some ideas to see your trending categories here.
          </div>`;
      }
    }

  } catch (e) {
    console.error("Dashboard error:", e);
    // Show error state with retry
    const inner = document.querySelector("#page-dashboard .page-inner");
    if (inner) {
      // Restore header
      const head = inner.querySelector(".page-head");
      if (!head) {
        inner.insertAdjacentHTML("afterbegin", `
          <div class="page-head">
            <h2 class="page-title">Your Dashboard</h2>
            <p class="page-subtitle">Track your creative activity</p>
          </div>`);
      }
    }
    ["dashPosts","dashSaves","dashLikes","dashBoards"].forEach(id => {
      const el = $(id); if (el) el.textContent = "—";
    });
    if (uploadGrid) uploadGrid.innerHTML = `
      <div class="empty-state-sm">
        Could not load. 
        <button class="link-btn" onclick="initDashboard()">Retry →</button>
      </div>`;
    if (savesGrid)  savesGrid.innerHTML  = "";
    if (catWrap)    catWrap.innerHTML    = "";
  }
}

function go(page) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const el = document.getElementById("page-" + page);
  if (el) el.classList.add("active");
  initAmbientForPage(page);
  document.querySelectorAll(".nav-link").forEach(l =>
    l.classList.toggle("active", l.dataset.page === page)
  );
  $("navProfileBtn")?.classList.toggle("active", page === "profile");
  S.page = page;
  window.scrollTo({ top:0, behavior:"smooth" });
  const inits = { home:initHome, explore:initExplore, boards:initBoards,
                  collab:initCollab, ai:initAI, profile:initProfile, trends:initTrends,
                  dashboard:initDashboard };
  (inits[page] || (() => {}))();
}
window.navigate = go;  // alias — some code uses navigate(), others use go()

// ─────────────────────────────────────────────────────────────
// DISCOVERY — real category-matched images (no API key needed)
// Uses verified Unsplash photo IDs that load directly as <img src>
// 30+ photos per category, infinite scroll cycles through them
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// CAT_CONFIG — titles, descriptions, and search queries per category
// ─────────────────────────────────────────────────────────────
const CAT_CONFIG = {
  "cars":              { q:"sports+car+automobile",        titles:["Supercar Shot","Classic Garage","Sports Car","Race Track","Luxury Drive","Vintage Muscle","Midnight Cruise","Track Day","Grand Tourer","Rally Stage"],descs:["Golden hour light wraps a low-slung sports car — the shot that makes you want to drive with no destination in mind.","A vintage muscle car waxed to a mirror finish. Every curve a reminder of when cars were built to be noticed.","Hand-stitched leather, brushed aluminium trim. The cockpit of a grand tourer designed for effortless long distances.","Carbon fibre, aerodynamic splitters, engineering obsession made physical. A hypercar that reveals craft photos barely capture.","Vibrant bodywork against a blurred cityscape — a street-legal race car turning every drive into a lap record attempt.","Tyre marks on tarmac, hot rubber, high-octane fuel. This is what cars were truly built for — total focus, nothing else.","Parked under workshop lights, this classic muscle car waits for the weekend. Restoration — the best kind of Saturday.","City lights streak past at speed. Long-exposure capturing the pure joy of driving at night when roads are finally clear.","Sculpted bodywork that looks fast standing still. A modern coupe blending performance and refinement equally.","Gravel flying, suspension fully loaded, flat out between tree-lined stages. Rally is the most raw form of motorsport."] },
  "bikes":             { q:"motorcycle+motorbike+cafe+racer",titles:["Sports Bike Sunset","Adventure Touring","Cafe Racer Build","Workshop Build","Mountain Road","Custom Chopper","Scrambler Style","Street Tracker","Naked Roadster","Dirt Track"],descs:["A sportsbike silhouetted against a burning sunset — the evening ride that resets everything, helmet on, mind empty.","Loaded for long-distance adventure. The open road ahead promises landscapes and freedom nothing else delivers.","Stripped-back, low-slung, purposeful. This hand-built cafe racer is motorcycle minimalism at its absolute finest.","Mid-restoration in a cluttered garage. Tools laid out, engine on the bench — the satisfying chaos of a build in progress.","High altitude switchbacks, crisp air, stunning views at every bend. Mountain roads are why motorcycles exist.","Long forks, stretched frame, custom paint. This chopper is a rolling sculpture — built to be looked at as much as ridden.","High pipes, knobbly tyres, upright bars. The scrambler bridges road and dirt — versatile, rugged, genuinely cool.","Flat track aesthetics brought to the street. Minimal, fast-looking, satisfying to ride hard through the bends.","All the performance, none of the fairing. A naked roadster exposes its engineering proudly — nothing to hide.","Sideways into a dirt corner, both wheels sliding. Flat track strips motorcycling to its absolute essentials."] },
  "anime":             { q:"anime+japan+tokyo+neon",         titles:["Anime Aesthetic","Tokyo Neon Night","Japan Street Life","Tokyo Lights","Neon Signs","Cherry Blossom","Sakura Avenue","Tokyo Skyline","Anime City Vibes","Japan Night Scene"],descs:["Soft pastels and dreamy lighting — a visual aesthetic where ordinary scenes become quietly magical.","Neon kanji, glowing convenience stores, rain. Tokyo at night is the real backdrop to a thousand anime stories.","A quiet alley somewhere between Shinjuku and a Studio Ghibli background. Japan makes the everyday cinematic.","The electric chaos of a Tokyo intersection at night — layered signage, crowds, light trails. Overwhelming and beautiful.","Stacked lanterns, flickering neon, hand-painted kanji. Tokyo's back streets are a typographer's dream.","Sakura season transforms Japan into something from another world — petals lasting just long enough to feel precious.","A long avenue canopied in cherry blossom. This is the Japan that stays with you long after you leave.","The Tokyo skyline stretching endlessly — so vast every new visit reveals a neighbourhood you've never seen before.","Long shadows, warm ambient light — that specific feeling of a quiet evening in a dense urban neighbourhood.","Rain-slicked streets reflecting storefronts, a lone figure under an umbrella. The atmospheric night scene anime taught us to love."] },
  "scenery":           { q:"landscape+mountain+nature+scenic",titles:["Mountain Lake","Aurora Borealis","Misty Forest","Ocean Sunset","Snowy Mountain","Green Valley","Waterfall","Lavender Field","Desert Dunes","Autumn Forest"],descs:["A still alpine lake reflecting peaks in perfect symmetry. The silence you find only above the treeline.","Curtains of green and violet light across an arctic sky. The Northern Lights exceed every expectation.","Morning mist threading between ancient trees, filtering light into cathedral beams. A forest at dawn barely fits in a photo.","Warm light dissolving into the horizon, waves catching the last gold of the day. The simplest scenes are often most profound.","A peak buried in fresh snow, the world reduced to white and blue. High altitude emptiness puts everything in perspective.","Lush valley floor stretching between protective ridges. The kind of landscape that makes you want to slow down and stay.","A waterfall throwing cold mist into a sunlit gorge. The roar and spray of falling water is primal and energising.","Rows of lavender stretching to the horizon — purple geometry under a blue sky, the air thick with scent.","Wind-sculpted dunes casting long shadows at golden hour. The desert teaches patience and simplicity.","Blazing oranges and reds crowding a woodland path in peak autumn. For a few weeks forests transform completely."] },
  "gaming":            { q:"gaming+setup+rgb+battlestation",  titles:["RGB Battlestation","Controller Collection","Neon Setup","Gaming Chair","Retro Console","Mechanical Keyboard","Gaming Monitor","Custom PC Build","Streaming Setup","VR Gaming"],descs:["A fully dialled battlestation — triple monitors, RGB fans synced, mechanical keyboard perfectly positioned.","Gaming controllers spanning three generations. Each one a portal to hundreds of hours of worlds and stories.","Neon strips casting purple and cyan across a minimalist desk. Aesthetic and functional — art installation as workstation.","Ergonomic chair, monitor at eye level, headset on stand. Built for marathon sessions without compromise.","A vintage console and cartridges displayed with collector's pride. Every scratched label a memory.","Hot-swappable switches, custom keycaps, satisfying feedback. The mechanical keyboard rabbit hole is completely worth it.","High refresh rate, low response time, pixel-perfect. A gaming monitor is the window between you and the world.","Glass-sided case showing cable management, water cooling, GPU lighting. A build as satisfying as the games it runs.","Ring light, quality microphone, camera positioned just so. Where gaming meets broadcasting — the modern studio.","Headset on, controllers ready, completely transported. VR gaming's moments of genuine presence are unlike anything else."] },
  "fashion":           { q:"fashion+style+outfit+clothing",   titles:["Street Style","Editorial Fashion","Fashion Week","Minimal Outfit","Summer Lookbook","Boho Style","Dark Academia","Bold Summer","Vintage Style","Power Dressing"],descs:["Fashion at its most honest — not a runway but a pavement. Street style captures how real people interpret trends.","High contrast, strong silhouette, deliberate styling. An editorial shoot where clothing becomes the vehicle for a mood.","Front row energy, unprecedented silhouettes. What you see here filters to the high street in eighteen months.","One clean silhouette, premium fabric, nothing superfluous. Minimalist dressing is harder — every choice is visible.","Lightweight linen, warm tones, unhurried energy. A summer wardrobe built around ease — comfort and style united.","Layered textures, earthy palette, silver jewellery. Bohemian dressing is a lifestyle as much as an aesthetic.","Plaid coats, turtlenecks, leather satchels. Dark academia borrows from the libraries of old universities.","Bold colour, confident cut, the outfit that arrives before you do. Summer fashion at its most unapologetic.","Thrifted finds styled with modern sensibility. Vintage dressing is sustainability with soul.","Structured shoulders, sharp tailoring, complete confidence. Arriving ready for whatever the day requires."] },
  "nature":            { q:"nature+forest+wildlife+outdoor",  titles:["Forest Path","Sunset Meadow","Sunflower Field","Wildflower Meadow","Jungle Canopy","Mountain Wildlife","Autumn Colours","Ocean Waves","Snowy Trees","Tropical Plants"],descs:["Dappled light filtering through a canopy onto a trail. Old woodland slows the mind like nothing else.","A meadow catching the last warm light. Simple and ancient — grass, light, air — extraordinary every time.","A field of sunflowers all facing the same direction. There's something deeply optimistic about them.","Wildflowers colonising a hillside with joyful randomness. Nature's chaos produces its own perfect composition.","Looking up through layers of tropical canopy — green upon green, light fragmenting as it descends.","A high-altitude habitat where only the most determined species survive. Mountain ecosystems are extraordinary.","Deciduous trees in full autumn display — the season of endings that somehow always feels like abundance.","Waves building and collapsing in an endless cycle. The ocean operates on timescales that put concerns in perspective.","Trees carrying fresh snow in absolute silence. A winter woodland after snowfall is one of earth's most peaceful places.","Dense tropical foliage in layered greens — how lush the natural world is when left entirely to itself."] },
  "food":              { q:"food+photography+cuisine+dish",   titles:["Food Photography","Gourmet Plating","Artisan Pizza","Morning Breakfast","Healthy Bowl","Coffee Art","Stacked Pancakes","Plated Dessert","Craft Cocktails","Sushi Platter"],descs:["Natural light, considered composition, ingredients at their best. Great food photography captures taste and smell.","A restaurant plate where every element has been placed with a painter's intention. Fine dining as visual art.","Wood-fired, charred crust, quality ingredients. A great pizza is one of life's genuinely reliable pleasures.","The considered morning ritual — good coffee, bread, warm light. Breakfast eaten slowly is a radical act.","A grain bowl assembled with colour and nutrition in mind — proof healthy eating just needs good ingredients.","A flat white with latte art pulled by someone treating their craft seriously. Good coffee done properly.","Thick, fluffy pancakes stacked with syrup. Weekend breakfast energy — no rush, nowhere to be.","A restaurant dessert with pastry chef precision — textures, temperatures, flavours in one perfect composition.","A bartender's considered creation — spirits, modifiers, garnish all chosen deliberately. Craft at its finest.","Pristine fish on perfectly seasoned rice. Sushi requires years of practice to achieve its apparent simplicity."] },
  "art":               { q:"art+painting+creative+gallery",   titles:["Abstract Study","Oil Painting","Watercolour Work","Art Gallery","Digital Illustration","Street Mural","Ceramic Sculpture","Collage Art","Ceramic Art","Sketch Study"],descs:["Form and colour liberated from representation. Abstract art asks viewers to bring their own meaning — every reading is personal.","Layers of oil paint building texture, depth, and light over weeks. The accumulation is inseparable from the presence.","Pigment blooming through wet paper in controlled accidents. Watercolour rewards lightness of touch.","White walls, careful lighting, objects given space to speak. A gallery creates conditions for genuine encounter.","The digital canvas has no constraints — unlimited undo, infinite layers. New artists building new visual languages.","Large-scale mural reclaiming urban surfaces. The best street art transforms neglected walls into landmarks.","Clay shaped, fired, glazed — one of humanity's oldest art forms still producing new possibilities.","Found images cut and recombined into something new. Collage has always been democratic — all materials welcome.","Thrown on a wheel or hand-built — ceramics carries the maker's mark in every surface. No two pieces identical.","A sketchbook of observational drawings — the most honest document of how an artist sees the world."] },
  "architecture":      { q:"architecture+building+modern+design",titles:["Modern Building","Glass Tower","Interior Arch","Urban Architecture","Concrete Design","White Architecture","Spiral Staircase","Minimalist House","City Skyline","Bridge Design"],descs:["Bold geometric forms, honest materials, natural light as a primary design element. Architecture that genuinely improves lives.","A high-rise curtain wall reflecting sky and cloud — simultaneously transparent and opaque depending on the light.","A dramatic interior where structure becomes ornament. The best spaces create a physical sensation as you move through them.","Buildings in conversation across a city block — styles, periods, scales creating an accidental composition.","Raw concrete finished with craft — material honesty making brutalism warm rather than cold.","White rendered surfaces, deep shadows, flat roofs. Mediterranean modernism where every building is a sculpture.","A staircase that becomes the architecture. Spiral stairs concentrate engineering and beauty into one element.","A house reduced to essentials — shelter, light, view. Minimalist architecture is hardest because nothing can hide.","A skyline built over decades by competing ambitions, each tower expressing its economic moment.","A bridge spanning impossible distances — engineering and aesthetics inseparable at this scale."] },
  "workspace":         { q:"workspace+desk+office+minimal",   titles:["Home Office","Minimal Desk","Cosy Workspace","Creative Desk","Coffee & Work","Morning Setup","Standing Desk","Bookshelf Workspace","Plant Office","Laptop Setup"],descs:["A home office built around what helps you think — natural light, clear surfaces, the right tools within reach.","A desk with only what you need today. The minimal workspace is a daily commitment worth maintaining.","Warm light, a good chair, a candle, a plant. A workspace you want to be in changes everything about how you work.","The creative desk tells a story — sketches pinned up, references spread out, works in progress visible.","A laptop, good coffee, morning light. The simplest and most reliable combination for getting something done.","Everything in its place before the work begins. Five minutes of preparation pays back every single time.","A height-adjustable desk letting you choose how to work. Standing for part of the day changes your energy.","Books behind the monitor, books on the desk. A workspace surrounded by books knows where ideas come from.","A desk next to a window with plants on the sill. Natural light and living things make workspaces genuinely better.","Work from anywhere — a laptop made location a choice rather than a constraint. The workspace is wherever you decide."] },
  "interior design":   { q:"interior+design+home+living+room",titles:["Japandi Bedroom","Minimal Kitchen","Cosy Living Room","Boho Interior","Scandi Living","Earthy Tones","Reading Nook","Modern Dining","Gallery Wall","Modern Living Room"],descs:["Japanese restraint meeting Scandinavian warmth — Japandi spaces feel deeply calm and completely considered.","A kitchen where every surface has earned its place — clean lines, quality materials, cooking as pleasure.","Layered textiles, warm light, a sofa you don't want to leave. The living room designed for actual living.","Rattan, macrame, layered rugs, trailing plants. Every object chosen for meaning as much as aesthetics.","White walls, natural wood, clean lines. Scandinavian design takes making home feel good very seriously.","Terracotta, warm ochre, sand, olive. An earthy palette grounds a space and connects it to the natural world.","A window seat with cushions, good light, a shelf of books. Perhaps the single best addition to any home.","A dining table at the centre of home — generous in scale, designed for long meals and longer conversations.","A collection of artworks and objects on a wall. A gallery wall is a portrait of the people who live there.","A contemporary living room where every decision has been considered. Good design is invisible until you try to replicate it."] },
  "ladies accessories":{ q:"jewelry+accessories+necklace+bracelet",titles:["Gold Jewellery","Pearl Earrings","Layered Necklaces","Bracelet Stack","Ring Collection","Luxury Handbag","Designer Bag","Fine Jewellery","Gold Bangles","Statement Earrings"],descs:["Delicate gold chains, fine settings, considered design. Quality jewellery is investment dressing that improves with age.","Classic pearl earrings bridging every occasion. Pearls make the wearer look more considered, not more dressed up.","Multiple fine chains at different lengths — layered necklaces work with almost everything and tell a personal story.","Bracelets collected over years — bought, gifted, found. A stacked wrist tells stories a single piece never could.","Rings chosen for meaning rather than convention — which finger they belong on is entirely up to you.","A well-made handbag in quality leather — the accessory that ties an outfit together while being genuinely useful.","Clean lines, quality hardware, a silhouette unchanged for decades. The investment bag as wardrobe foundation.","Stones set with precision, metal worked into forms that look effortless but required extraordinary skill.","Stacked gold bangles catching light with every gesture. Among jewellery's most ancient forms — worn the same way for millennia.","Earrings large enough to be the entire statement — worn with confidence, they transform a simple outfit completely."] },
  // ── 5 New Categories ────────────────────────────────────────
  "pets":              { q:"pets+dogs+cats+animals",          titles:["Golden Morning","Cat Window Watch","Puppy Chaos","Senior Dog Portrait","Cat Nap","Dog at Beach","Kitten Play","Dog Training","Cat Curiosity","Dog Walk Ritual"],descs:["A golden retriever in morning light — no photograph better communicates uncomplicated joy than a happy dog.","A cat positioned in a window, monitoring the outside world with the focused attention of a naturalist.","Puppy energy: everything interesting, nothing dangerous, the world a continuous source of wonder and things to chew.","The senior dog's portrait — grey muzzle, wise eyes, the accumulated trust of a decade of companionship.","A cat in the deepest phase of a nap, completely surrendered to sleep in a patch of afternoon sun.","A dog at the beach with wet fur and salt-crusted ears, running back with a stick as if it's the most important thing.","Kittens playing — rapid movement, sudden stops, the exaggerated seriousness of creatures that haven't yet learned what's dangerous.","Dog training session: focus, reward, the building of communication between two species through patience and consistency.","A cat inspecting something invisible at floor level with complete scientific seriousness and slightly narrowed eyes.","The morning dog walk ritual — the same route every day, always somehow new to the dog, which makes it new to you too."] },
  "superheroes":       { q:"superhero+comic+book+hero",
    titles:["Iron Man Armour","Batman Cowl","Spider-Man City","Wonder Woman","Captain America","Thor Lightning","Black Panther","Superman Cape","The Flash","Wolverine Claws"],
    descs:["Tony Stark's armour as engineering fantasy — the suit as the ultimate expression of applied intelligence.","Batman on a Gotham rooftop: discipline and will as the superpower, no origin required.","Spider-Man swinging between towers — the most kinetic superhero, the city itself his gymnasium.","Wonder Woman in battle — representing justice and the price of peace with equal conviction.","Captain America: the super soldier whose actual power is stubborn moral clarity.","Thor summoning lightning — Norse myth colliding with cosmic Marvel universe.","Black Panther in Wakanda: a superhero inseparable from the civilization he protects.","Superman in flight — the original, the one every other superhero is measured against.","The Flash as pure speed — a hero whose power collapses the gap between decision and action.","Wolverine's claws extended — the berserker with regeneration as burden, not gift."] },
  "cigarettes":        { q:"cigarette+smoke+tobacco+cigar",
    titles:["Smoke Ritual","Hand-Rolled Cigar","Cigarette Aesthetic","Tobacco Leaf","Smoke Rings","Vintage Lighter","Rolling Tobacco","Cigar Lounge","Match Strike","Ash & Ember"],
    descs:["The pause between tasks — a cigarette as punctuation in the day, slow and deliberate.","A hand-rolled cigar, the craft of it visible in every inch — patience compressed into a ritual object.","The aesthetics of smoke: light through haze, curling patterns, the visual poetry of combustion.","Cured tobacco leaf — the raw material before it becomes something carried, shared, and remembered.","Smoke rings expanding and dissolving — a casual trick that looks effortless and takes weeks to master.","A vintage lighter, worn smooth with use — the object that starts every ritual, reliable and tactile.","Rolling tobacco by hand — the slow preparation as part of the experience, not preamble to it.","A cigar lounge at evening — leather chairs, good company, conversation slowed by the pace of the smoke.","A match struck in low light — the brief flare as the moment before stillness, warmth before the exhale.","Ash at the tip, ember glowing — the consumable nature of the thing making the moment more present."] },
};

// Unsplash search queries (used when API key is available)
const UNSPLASH_QUERIES = {
  "cars":               "sports car automobile",
  "bikes":              "motorcycle motorbike",
  "anime":              "anime aesthetic japan tokyo",
  "scenery":            "scenic landscape nature",
  "gaming":             "gaming setup rgb desk",
  "fashion":            "fashion style outfit editorial",
  "nature":             "nature wildlife landscape",
  "food":               "food photography cuisine",
  "art":                "art painting creative",
  "architecture":       "architecture building modern",
  "workspace":          "workspace desk minimal office",
  "interior design":    "interior design home decor",
  "ladies accessories": "jewelry accessories necklace",
  "pets":                "pets dogs cats animals",
  "superheroes":         "superhero comic book hero",
  "cigarettes":          "cigarette smoke tobacco cigar",
};

// ── Direct Unsplash API call from browser ────────────────────
async function fetchUnsplash(category, page = 1) {
  const key = localStorage.getItem("zenpin_unsplash_key") || "";
  if (!key) return null;
  const query = UNSPLASH_QUERIES[category.toLowerCase()] || category;
  try {
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&page=${page}&per_page=20&orientation=portrait`,
      { headers: { "Authorization": `Client-ID ${key}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.results?.length) return null;
    return data.results.map((p, i) => ({
      id:          -(Date.now() + i + page * 50000),
      title:       p.alt_description?.split(" ").slice(0,5).join(" ") || query,
      image_url:   p.urls.regular,
      thumb_url:   p.urls.small,
      category:    category.charAt(0).toUpperCase() + category.slice(1),
      source:      "unsplash",
      saves_count: 0, likes_count: 0,
      difficulty:  2, creativity: 4, usefulness: 3,
      description: `Photo by ${p.user.name}`,
    }));
  } catch { return null; }
}

const IMG_HEIGHTS = [700, 750, 680, 800, 720, 760, 650, 740];

// ═══════════════════════════════════════════════════════════════
// IMAGE SYSTEM v4 — Backend-filtered + LoremFlickr fallback
// Flow: /images/category (filtered, cached 24h) → LoremFlickr → SVG
// ─────────────────────────────────────────────────────────────

// Single-tag LoremFlickr map — large Flickr pools = reliable category match
const FLICKR_TAG = {
  "cars":"car","bikes":"motorcycle","anime":"anime","scenery":"landscape",
  "gaming":"gaming","fashion":"fashion","nature":"wildlife","food":"food",
  "travel":"travel","tech":"technology","art":"art","architecture":"architecture",
  "workspace":"workspace","interior design":"interior","ladies accessories":"jewelry",
  "tattoos":"tattoo","plants":"plants","fitness":"fitness","music":"music",
  "pets":"pets","superheroes":"superhero","drinks":"cocktail","flowers":"flowers",
  "cigarettes":"cigar",
};

const CARD_HEIGHTS = [680,750,700,820,660,780,720,800,640,760,710,770];

// Cache: category → array of backend-fetched image objects
// Avoids re-fetching same category on filter change
const _imgCache = {};

// Fetch filtered images from backend for a category+page
// Backend has Unsplash/Pexels/Pixabay keys — gives real category-matched photos
// Render free tier sleeps → first request takes up to 30s to wake up
async function fetchCategoryImages(category, page = 1) {
  const key = `${category}:${page}`;
  if (_imgCache[key]) return _imgCache[key];

  try {
    // 25s timeout: Render free tier takes up to 30s to wake from sleep
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 25000);
    const res  = await fetch(
      `${API_URL}/images/category?name=${encodeURIComponent(category)}&page=${page}&limit=12`,
      { signal: ctrl.signal }
    );
    clearTimeout(tid);
    if (!res.ok) throw new Error("backend error");
    const data = await res.json();
    if (data.images?.length) {
      _imgCache[key] = data.images;
      return data.images;
    }
  } catch (e) {
    // Timeout or network failure — use local fallback
    console.warn("Backend unavailable, using local images:", e.message);
  }
  return null;
}

// Build LoremFlickr URL — single tag = reliable category match, lock=N = stable
function getPhotoUrl(category, idx) {
  const key  = (category || "scenery").toLowerCase();
  const tag  = FLICKR_TAG[key] || "nature";
  const h    = CARD_HEIGHTS[idx % CARD_HEIGHTS.length];
  const lock = (idx % 100) + 1;
  return `https://loremflickr.com/500/${h}/${encodeURIComponent(tag)}?lock=${lock}`;
}

// Picsum — only used as last resort onerror fallback
function getPicsumUrl(category, idx) {
  const seeds = {"cars":10,"bikes":25,"anime":40,"scenery":55,"gaming":70,"fashion":85,
    "nature":100,"food":115,"travel":130,"tech":145,"art":160,"architecture":175,
    "workspace":190,"interior design":205,"ladies accessories":220,"tattoos":235,
    "plants":250,"fitness":265,"music":280,"pets":295,"superheroes":310,
    "drinks":325,"flowers":340,"cigarettes":355};
  const base = seeds[(category||"scenery").toLowerCase()] || 50;
  const h    = CARD_HEIGHTS[idx % CARD_HEIGHTS.length];
  return `https://picsum.photos/seed/${base + idx * 3}/500/${h}`;
}

// SVG gradient — absolute last resort, never fails
function makePlaceholder(category, idx, title) {
  const ICON = {"cars":"🚗","bikes":"🏍","anime":"🎌","scenery":"🌄","gaming":"🎮",
    "fashion":"👗","nature":"🌿","food":"🍜","travel":"✈️","tech":"⚡","art":"🎨",
    "architecture":"🏛","workspace":"💻","interior design":"🏠","ladies accessories":"💎",
    "tattoos":"🖊️","plants":"🪴","fitness":"💪","music":"🎵","pets":"🐾",
    "superheroes":"🦸","drinks":"🥃","flowers":"🌸","cigarettes":"🚬"};
  const GRAD = {"cars":"#0f3460,#e94560","bikes":"#11998e,#38ef7d","anime":"#f093fb,#f5576c",
    "scenery":"#4facfe,#43e97b","gaming":"#302b63,#7c3aed","fashion":"#f7971e,#ffd200",
    "nature":"#134e5e,#71b280","food":"#f46b45,#eea849","travel":"#2980b9,#6dd5fa",
    "tech":"#7c3aed,#06b6d4","art":"#ec008c,#fc6767","architecture":"#2c3e50,#4ca1af",
    "workspace":"#3498db,#2c3e50","interior design":"#d4a574,#6b4c3b",
    "ladies accessories":"#b8860b,#ffd700","tattoos":"#1a1a1a,#8b0000",
    "plants":"#1a4731,#56ab2f","fitness":"#232526,#ff6b6b","music":"#6f0000,#df73ff",
    "pets":"#614385,#516395","superheroes":"#b22222,#1a1a2e","drinks":"#c94b4b,#4b134f",
    "flowers":"#f953c6,#b91d73","cigarettes":"#2c2c2c,#8b8b8b"};
  const key  = (category||"scenery").toLowerCase();
  const icon = ICON[key]||"✦";
  const [c1,c2] = (GRAD[key]||"#7c3aed,#db2777").split(",");
  const h    = CARD_HEIGHTS[idx % CARD_HEIGHTS.length];
  const lbl  = (title||"").slice(0,22).replace(/[<>&]/g,"");
  const gid  = "g"+((idx*31+(key.charCodeAt(0)||0))%9999);
  const svg  = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="${h}"><defs><linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs><rect width="500" height="${h}" fill="url(#${gid})"/><text x="250" y="${Math.floor(h*.43)}" font-size="88" text-anchor="middle" dominant-baseline="middle">${icon}</text><text x="250" y="${Math.floor(h*.61)}" font-size="18" fill="rgba(255,255,255,0.85)" text-anchor="middle" dominant-baseline="middle" font-family="system-ui,sans-serif">${lbl}</text></svg>`;
  return "data:image/svg+xml;base64,"+btoa(unescape(encodeURIComponent(svg)));
}

// ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════
// CATEGORY_MAP
// Maps every idea.category string → _curatedCache key.
// null = no folder uploaded yet → Picsum fallback.
// ════════════════════════════════════════════════════════════
const CATEGORY_MAP = {
  // ── Cars ───────────────────────────────────────────────────
  "cars": "cars", "car": "cars", "Cars": "cars",

  // ── Bikes (folder on disk is "Bikes" with capital B) ───────
  "bikes": "bikes", "bike": "bikes", "Bikes": "bikes",
  "motorcycle": "bikes", "Motorbike": "bikes",

  // ── Anime ──────────────────────────────────────────────────
  "anime": "anime", "Anime": "anime", "manga": "anime",

  // ── Gaming ─────────────────────────────────────────────────
  "gaming": "gaming", "game": "gaming", "Gaming": "gaming",

  // ── Food ───────────────────────────────────────────────────
  "food": "food", "Food": "food",

  // ── Fashion ────────────────────────────────────────────────
  "fashion": "fashion", "Fashion": "fashion",

  // ── Nature ─────────────────────────────────────────────────
  "nature": "nature", "Nature": "nature", "wildlife": "nature",

  // ── Architecture ───────────────────────────────────────────
  "architecture": "architecture", "Architecture": "architecture",
  "building": "architecture",

  // ── Workspace ──────────────────────────────────────────────
  "workspace": "workspace", "Workspace": "workspace", "desk": "workspace",

  // ── Pets ───────────────────────────────────────────────────
  "pets": "pets", "Pets": "pets", "pet": "pets",

  // ── Scenery ────────────────────────────────────────────────
  "scenery": "scenery", "Scenery": "scenery",
  "landscape": "scenery",

  // ── Art ────────────────────────────────────────────────────
  "art": "art", "Art": "art",

  // ── Interior Design ────────────────────────────────────────
  "interior design": "interior", "Interior Design": "interior",
  "interior": "interior", "Interior": "interior",

  // ── Ladies Accessories ─────────────────────────────────────
  "ladies accessories": "accessories",
  "Ladies Accessories": "accessories",
  "accessories": "accessories", "Accessories": "accessories",
  "accessory": "accessories",

  // ── Superheroes ────────────────────────────────────────────
  "superheroes": "superhero", "Superheroes": "superhero",
  "superhero": "superhero", "Superhero": "superhero",
  "hero": "superhero",

  // ── Additional folders ─────────────────────────────────────
};

// ════════════════════════════════════════════════════════════
// FEATURED_IMAGES
// Hand-picked "best of" indexes per category.
// These surface more often (70% of the time) so the feed
// always leads with the strongest images.
//
// To update: just change the index numbers.
// Indexes are 1-based, matching your filenames (car5.jpg = 5).
// ════════════════════════════════════════════════════════════
const FEATURED_IMAGES = {
  "cars":         [3,7,12,15,20,24,28],
  "bikes":        [2,5,9,14,18,22],
  "anime":        [1,4,8,13,17,21,25,29],
  "gaming":       [2,6,10,15,19,24],
  "scenery":      [3,7,11,16,20,25,29],
  "superhero":    [1,5,9,13,17,21],
  "workspace":    [2,5,9,13,18,22],
  "fashion":      [1,4,8,12,17,21],
  "food":         [3,6,10,14,19,23],
  "pets":         [2,5,9,12,18,22],
  "nature":       [1,4,8,13,17,22,26],
  "architecture": [2,6,10,15,19,23],
  "accessories":  [1,4,7,11,15,20],
  "art":          [2,5,9,14,18,23,28],
  "interior":     [2,5,8,12,16,20],
};

// ════════════════════════════════════════════════════════════
// AESTHETIC_IMAGES
// "Best of the best" — the most visually striking images in
// each category.  These are shown exclusively to trending
// ideas (saves > 1000 or likes > 500) so high-engagement
// cards always look premium.
//
// Curate these yourself: scroll through each folder and pick
// the most cinematic / neon / editorial shots.
// ════════════════════════════════════════════════════════════
const AESTHETIC_IMAGES = {
  "cars":         [5, 12, 20],
  "bikes":        [3, 9, 18],
  "anime":        [4, 13, 21],
  "gaming":       [6, 15, 24],
  "scenery":      [7, 16, 25],
  "superhero":    [1, 9, 17],
  "workspace":    [5, 13, 22],
  "fashion":      [4, 12, 21],
  "food":         [6, 14, 23],
  "pets":         [5, 12, 22],
  "nature":       [4, 13, 22],
  "architecture": [2, 10, 19],
  "accessories":  [4, 11, 20],
  "art":          [5, 14, 23],
  "interior":     [5, 12, 20],
};

// ════════════════════════════════════════════════════════════
// FEED STATE — persists across renderGrid + appendGrid calls
// ════════════════════════════════════════════════════════════

// URLs seen in the current session — used by infinite scroll
// to prefer images the user hasn't been shown yet.
const _seenUrls = new Set();

// Last URL used per category in the current render pass —
// prevents the same image appearing back-to-back in a grid.
const _lastUsed = {};

// ════════════════════════════════════════════════════════════
// scoreIdea — engagement score for an idea
//
// Higher score → trending boost → aesthetic image pool used.
// ════════════════════════════════════════════════════════════
function scoreIdea(idea) {
  const saves      = idea.saves_count || idea.saves || 0;
  const likes      = idea.likes_count || idea.likes || 0;
  const creativity = idea.creativity  || idea.creat || 3;
  const prefWeight = UserPrefs.getWeight(idea.category);

  // Base engagement score + personalisation bonus.
  // prefWeight 0–50 → bonus 0–5000 (scaled × 100 so even light
  // interest meaningfully promotes a category in the feed).
  return (saves * 2) + likes + creativity + (prefWeight * 100);
}

// ════════════════════════════════════════════════════════════
// getLocalImage — single source of truth for card images.
//
// SELECTION TIERS (applied in order):
//
//  TIER 1 — Trending (score > 1000 OR saves > 1000 OR likes > 500)
//    → 90% aesthetic pool  (most cinematic / premium images)
//    → 10% featured pool
//
//  TIER 2 — Popular (score 200–999)
//    → 80% featured pool
//    → 20% full pool
//
//  TIER 3 — Standard (score < 200)
//    → 70% featured pool
//    → 30% full pool
//
//  INFINITE SCROLL boost:
//    If candidate URL is already in _seenUrls, step forward
//    through the array until an unseen image is found.
//
//  VARIETY GUARD:
//    If candidate URL == _lastUsed[key], step forward once.
//
// FALLBACK (no local folder):
//    user upload → Picsum (stable seed, never breaks)
// ════════════════════════════════════════════════════════════
function getLocalImage(idea) {
  // Always return a valid string — never undefined or null
  if (!idea) return `https://picsum.photos/seed/0/400/600`;

  const raw = String(idea.category || "").trim();

  // Resolve category → cache key.
  // Try exact match first (handles title-case like "Bikes"), then lowercase.
  const key =
    CATEGORY_MAP[raw] ||
    CATEGORY_MAP[raw.toLowerCase()] ||
    null;

  if (key) {
    const urls = _curatedCache[key];
    if (urls && urls.length > 0) {
      // Filter out Windows copy-artefacts (e.g. "bike13 (2).jpg")
      const safeUrls = urls.filter(u =>
        u &&
        !u.includes(" (1)") &&
        !u.includes(" (2)") &&
        !u.includes(" copy") &&
        !u.toLowerCase().includes("copy")
      );

      if (safeUrls.length > 0) {
        // Variety guard — avoid back-to-back repeats of the same image
        const base = Math.abs(Number(idea.id) || 0);
        let idx = base % safeUrls.length;

        if (_lastUsed[key] === safeUrls[idx] && safeUrls.length > 1) {
          idx = (idx + 1) % safeUrls.length;
        }

        // Prefer unseen images during infinite scroll
        if (_seenUrls.size > 0 && safeUrls.length > _seenUrls.size) {
          let attempts = 0;
          while (_seenUrls.has(safeUrls[idx]) && attempts < safeUrls.length) {
            idx = (idx + 1) % safeUrls.length;
            attempts++;
          }
        }

        const chosen = safeUrls[idx];
        _lastUsed[key] = chosen;
        _seenUrls.add(chosen);
        return chosen;
      }
    }
  }

  // Creator post with a real image URL (not an API/placeholder URL)
  const existing = idea.image_url || "";
  if (
    existing &&
    !existing.includes("loremflickr") &&
    !existing.includes("unsplash")    &&
    !existing.includes("pexels")      &&
    !existing.includes("pixabay")     &&
    !existing.includes("picsum")
  ) {
    return existing;
  }

  // Final fallback — stable Picsum per-idea (never a broken path)
  return `https://picsum.photos/seed/${Math.abs(Number(idea.id) || 0)}/400/600`;
}

// Called by renderGrid before each full repaint.
// Does NOT clear _seenUrls — that persists for the whole session
// so infinite scroll can keep surfacing fresh images.
function resetImageVariety() {
  for (const k in _lastUsed) delete _lastUsed[k];
}

// ════════════════════════════════════════════════════════════
// applyFeedIntelligence — re-ranks an ideas array before render.
//
// Mix target:
//   60% personalized  — ideas from user's top categories
//   30% trending      — highest raw engagement score
//   10% discovery     — everything else (serendipity)
//
// Category rotation guard: no more than 3 consecutive cards
// from the same category in the final order.
//
// Usage: ideas = applyFeedIntelligence(ideas);
//        renderGrid(grid, ideas);
// ════════════════════════════════════════════════════════════
function applyFeedIntelligence(ideas) {
  if (!ideas || ideas.length === 0) return ideas;

  // ── Split by source ────────────────────────────────────────
  // "curated" = local assets/discovery/ images (always primary)
  // everything else = creator posts from DB (supplementary)
  const curated   = ideas.filter(x => x.source === "curated" || x.source === "discovery");
  const dbPosts   = ideas.filter(x => x.source !== "curated" && x.source !== "discovery");

  // ── Sort each bucket by preference weight only (NOT saves/likes) ──
  // Local images are not penalised by having 0 engagement metrics.
  const prefSort = (a, b) => {
    const pa = UserPrefs.getWeight(a.category);
    const pb = UserPrefs.getWeight(b.category);
    return pb - pa;
  };
  curated.sort(prefSort);
  dbPosts.sort((a, b) => {
    // DB posts: sort by engagement + preference
    const sa = (a.saves_count||0)*2 + (a.likes_count||0) + UserPrefs.getWeight(a.category)*10;
    const sb = (b.saves_count||0)*2 + (b.likes_count||0) + UserPrefs.getWeight(b.category)*10;
    return sb - sa;
  });

  // ── Interleave: 1 DB post every 5 curated cards ────────────
  // This guarantees local images are always visible in the feed.
  const result = [];
  let ci = 0, di = 0;
  while (ci < curated.length || di < dbPosts.length) {
    // Add up to 5 curated cards
    for (let k = 0; k < 5 && ci < curated.length; k++, ci++) {
      result.push(curated[ci]);
    }
    // Then 1 DB post (if any)
    if (di < dbPosts.length) {
      result.push(dbPosts[di++]);
    }
  }

  // ── Category rotation guard — max 3 consecutive same-category ─
  const final    = [];
  let   runCat   = null, runLen = 0;
  const deferred = [];
  for (const idea of result) {
    const ck = (idea.category || "").toLowerCase();
    if (ck === runCat) {
      runLen++;
      if (runLen > 3) { deferred.push(idea); continue; }
    } else {
      runCat = ck; runLen = 1;
    }
    final.push(idea);
  }
  final.push(...deferred);

  return final;
}

// ─────────────────────────────────────────────────────────────
// Category folder map — maps category key → folder name
// Handles mismatches like "superheroes" → "superhero" folder
// ─────────────────────────────────────────────────────────────
const CAT_FOLDER = {
  "cars":               "cars",
  "bikes":              "bikes",
  "anime":              "anime",
  "gaming":             "gaming",
  "scenery":            "scenery",
  "superheroes":        "superhero",
  "superhero":          "superhero",
  "workspace":          "workspace",
  "fashion":            "fashion",
  "food":               "food",
  "pets":               "pets",
  "nature":             "nature",
  "travel":             "travel",
  "tech":               "tech",
  "art":                "art",
  "architecture":       "architecture",
  "flowers":            "flowers",
  "plants":             "plants",
  "fitness":            "fitness",
  "music":              "music",
  "tattoos":            "tattoos",
  "drinks":             "drinks",
  "cigarettes":         "cigarettes",
  "interior design":    "interior",
  "ladies accessories": "accessories",
};

// Build local discovery cards using LoremFlickr
// Each card gets image_url stamped at creation (stable slot = stableSlot from id)
function getLocalDiscovery(category, page = 1) {
  const key      = (category || "scenery").toLowerCase();
  const cfg      = CAT_CONFIG[key] || CAT_CONFIG["scenery"];
  const PER      = 12;
  const catLabel = key.split(" ").map(w=>w[0].toUpperCase()+w.slice(1)).join(" ");
  return Array.from({length:PER}, (_,i) => {
    const gIdx = (page-1)*PER + i;
    const tIdx = gIdx % cfg.titles.length;
    const id   = -(700000+(key.charCodeAt(0)||65)*10000+gIdx*7+page*300);
    // Stamp with local curated image if available, otherwise LoremFlickr
    const localUrls = _curatedCache[key] || [];
    const localImg  = localUrls.length
      ? localUrls[Math.abs(id) % localUrls.length]   // stable index per card
      : getPhotoUrl(key, gIdx);                       // LoremFlickr fallback
    return {
      id,
      title:       cfg.titles[tIdx],
      image_url:   localImg,
      thumb_url:   getPicsumUrl(key, gIdx),           // picsum stays as onerror fb
      category:    catLabel,
      source:      "discovery",
      saves_count: 0, likes_count: 0,
      difficulty:  (gIdx%3)+1, creativity: (gIdx%3)+3, usefulness: (gIdx%3)+2,
      description: cfg.descs[tIdx],
    };
  });
}




// ═══════════════════════════════════════════════════════════════
// PAGE FUNCTIONS — init, events, modals, DOMContentLoaded
// ═══════════════════════════════════════════════════════════════

// Map backend discovery images into idea-like card objects
function discoveryToIdeas(images, category) {
  return images.map((img, i) => ({
    id:          -(Date.now() + i),
    title:       img.title || category + " Inspiration",
    image_url:   img.image_url,
    thumb_url:   img.thumb_url || img.image_url,
    category:    category.charAt(0).toUpperCase() + category.slice(1),
    source:      "discovery",
    saves_count: 0,
    likes_count: 0,
    difficulty:  2,
    creativity:  4,
    usefulness:  3,
    description: img.author ? `Photo by ${img.author}` : (img.description || ""),
  }));
}

async function loadDiscoveryImages(category, page = 1) {
  // Step 1: Always return local discovery first (instant — no network)
  const local = getLocalDiscovery(category, page);

  // Step 2: Try backend (filtered, category-correct photos from Unsplash/Pexels/Pixabay)
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 20000);
    const res  = await fetch(
      `${API_URL}/images/category?name=${encodeURIComponent(category)}&page=${page}&limit=12`,
      { signal: ctrl.signal }
    );
    clearTimeout(tid);
    if (!res.ok) return local;
    const data = await res.json();
    if (data.images?.length) {
      return discoveryToIdeas(data.images, category);
    }
  } catch (e) {
    // Render sleeping or network error — local fallback serves the grid
    console.warn("Backend discovery failed, using local:", e.message);
  }
  return local;
}


// ─────────────────────────────────────────────────────────────
// CURATED IMAGE LIBRARY — images.json manifest system
//
// Priority order for discovery feed:
//   1. Curated images (assets/discovery/) — instant, always correct
//   2. User uploaded content (from DB)
//   3. API discovery images (Unsplash / Pexels / Pixabay)
//
// images.json is generated by running: node generate-manifest.js
// ─────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════
// CURATED IMAGES — add your images here directly
//
// ─────────────────────────────────────────────────────────────
// _curatedCache is defined below and populated at parse time.
// Images load from assets/discovery/{folder}/ on GitHub Pages.
// ─────────────────────────────────────────────────────────────

// CURATED_IMAGES removed — _curatedCache is now the direct source (see below);



// ═══════════════════════════════════════════════════════════════
// _curatedCache — THE authoritative local image registry
//
// Keys = lowercase category name (must match CAT_CONFIG keys).
// Values = arrays of paths relative to index.html.
//
// Array.from() generates sequential filenames automatically.
// Change the length number to match however many files you have.
// The folder/prefix mapping handles every naming convention used.
//
// LOAD ORDER: this runs synchronously at parse time, so it is
// populated before the first card ever renders.
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// HOW TO ADD NEW LOCAL IMAGES TO ZENPIN
// ═══════════════════════════════════════════════════════════════
//
// STEP 1 — Add image files to GitHub repo
//   Folder:  assets/discovery/<category>/
//   Naming:  <prefix>1.jpg, <prefix>2.jpg, ... <prefix>N.jpg
//   Example: assets/discovery/tattoos/tattoo1.jpg … tattoo25.jpg
//   ⚠️  GitHub Pages is case-sensitive — folder name must match exactly.
//   ⚠️  Use .jpg extension (not .jpeg or .jfif). No spaces in filenames.
//
// STEP 2 — Add ONE LINE to _curatedCache below:
//   "newcategory": seq("folderName", "prefix", count),
//   Example:  "tattoos": seq("tattoos", "tattoo", 25),
//   → generates: assets/discovery/tattoos/tattoo1.jpg … tattoo25.jpg
//
// STEP 3 — Add CATEGORY_MAP entries (for filter chip label matching):
//   "Tattoos": "tattoos",
//   "tattoo":  "tattoos",
//
// STEP 4 — Done. Chip, filter bar, and AI brain all update automatically.
//
// ACTIVE CATEGORIES (15): cars bikes anime gaming scenery
//   superhero workspace fashion food pets nature
//   architecture accessories art interior
// ═══════════════════════════════════════════════════════════════

const _curatedCache = (() => {
  // ── Helper: generate sequential image paths ──────────────────
  function seq(folder, prefix, count, ext = "jpg") {
    return Array.from({ length: count }, (_, i) =>
      `assets/discovery/${folder}/${prefix}${i + 1}.${ext}`
    );
  }

  // ════════════════════════════════════════════════════════
  // Keys MUST match the values in CATEGORY_MAP exactly.
  // Folder names MUST match what is on disk (case-sensitive).
  // Prefix is the filename base: "car" → car1.jpg, car2.jpg…
  // Adjust the count to match how many files you have.
  // ════════════════════════════════════════════════════════
  const cache = {
    // ── Uploaded folders (active) ──────────────────────────
    "cars":         seq("cars",         "car",          30),
    "bikes":        seq("Bikes",        "bike",         30), // folder=Bikes (capital B on GitHub Pages)
    "anime":        seq("anime",        "anime",        27), // 27 confirmed files (anime28-30 not present)
    "gaming":       seq("gaming",       "gaming",       28),
    "scenery":      seq("scenery",      "scenery",      30),
    "superhero":    seq("superhero",    "superhero",    25), // key=superhero (matches CATEGORY_MAP)
    "workspace":    seq("workspace",    "workspace",    25),
    "fashion":      seq("fashion",      "fashion",      25),
    "food":         seq("food",         "food",         25),
    "pets":         seq("pets",         "pet",          25),
    "nature":       seq("nature",       "nature",       25),
    "architecture": seq("architecture", "architecture", 25),
    "accessories":  seq("accessories",  "accessory",   30), // files: accessory1.jpg…accessory30.jpg
    "art":          seq("art",          "art",          30), // art/ folder
    "interior":     seq("interior",     "interior",     25), // Interior Design → interior
    // ── Activate additional folders as you upload them ─────
    // Set count to match actual files in each folder.
    // If a folder doesn't exist yet, set count to 0.
  };

  const total = Object.values(cache).reduce((s, a) => s + a.length, 0);
  console.log(`📸 _curatedCache ready — ${total} local images across ${Object.keys(cache).length} categories`);
  return cache;
})();

// ── Convert URL array → card objects that renderGrid understands ─
function curatedUrlsToIdeas(urls, category, startId = 0) {
  const catKey = category.toLowerCase();
  const cfg    = CAT_CONFIG[catKey] || {};
  const titles = cfg.titles || [];
  const descs  = cfg.descs  || [];
  return urls.map((url, i) => ({
    id:          -(startId + i + 1),  // negative = curated, never clashes with DB IDs
    title:       titles[i % titles.length] || `${category} ${i + 1}`,
    category:    category,
    image_url:   url,
    description: descs[i % descs.length] || "",
    difficulty:  3,
    creativity:  4,
    usefulness:  3,
    source:      "curated",
    saves_count: 0,
    username:    "",
  }));
}

// ─────────────────────────────────────────────────────────────
// Fisher-Yates shuffle — unbiased, O(n), run once per session
// ─────────────────────────────────────────────────────────────
function fisherYates(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ════════════════════════════════════════════════════════════
// HERO — Anti-Gravity Floating Image Gallery
//
// Populates #heroFloatingGallery with 28 images drawn from
// local assets/discovery/ folders.  Each image gets:
//   • a randomised position on a sparse grid (avoids clumping)
//   • a random size between 110px and 185px wide
//   • individual CSS custom props for animation timing and rotation
//   • staggered animationDelay for a natural wave start
//
// Mouse parallax: each image moves at a unique speed (depth
// layers 1–5) toward the cursor centre, capped at ±18px.
// ════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════
// HERO — Three-layer depth gallery (replaces flat single-layer)
//
// Layer config:
//   back  (layer=0): 10 cards, 200-240px, opacity 0.07-0.09,
//                    heavy blur, placed ONLY in corners + outer edges
//   mid   (layer=1): 10 cards, 140-170px, opacity 0.11-0.13,
//                    slight blur, left/right bands (never center)
//   front (layer=2):  8 cards, 100-130px, opacity 0.15-0.18,
//                    sharp, strictly at edges
//
// SAFE ZONE: x 28%–72%, y 15%–85% → NO cards placed here
// This keeps the hero title + buttons fully readable.
//
// Parallax uses CSS custom props --px / --py on each card's
// inline style so it composites with the keyframe transform.
// ════════════════════════════════════════════════════════════
function initHeroGallery() {
  const gallery = document.getElementById("heroFloatingGallery");
  if (!gallery) return;

  // ── Image pool per visual theme ───────────────────────────
  const POOL = {
    editorial: [
      "assets/discovery/fashion/fashion3.jpg",
      "assets/discovery/fashion/fashion13.jpg",
      "assets/discovery/accessories/accessory3.jpg",
      "assets/discovery/accessories/accessory12.jpg",
      "assets/discovery/interior/interior4.jpg",
    ],
    action: [
      "assets/discovery/cars/car1.jpg",
      "assets/discovery/cars/car7.jpg",
      "assets/discovery/cars/car14.jpg",
      "assets/discovery/cars/car22.jpg",
      "assets/discovery/Bikes/bike2.jpg",
      "assets/discovery/Bikes/bike10.jpg",
      "assets/discovery/Bikes/bike20.jpg",
    ],
    atmosphere: [
      "assets/discovery/scenery/scenery4.jpg",
      "assets/discovery/scenery/scenery16.jpg",
      "assets/discovery/scenery/scenery26.jpg",
      "assets/discovery/nature/nature5.jpg",
      "assets/discovery/nature/nature15.jpg",
      "assets/discovery/architecture/architecture4.jpg",
      "assets/discovery/architecture/architecture14.jpg",
    ],
    culture: [
      "assets/discovery/anime/anime1.jpg",
      "assets/discovery/anime/anime8.jpg",
      "assets/discovery/anime/anime16.jpg",
      "assets/discovery/superhero/superhero5.jpg",
      "assets/discovery/gaming/gaming6.jpg",
    ],
  };

  // ALL images flattened for general use
  const ALL = [
    ...POOL.editorial, ...POOL.action,
    ...POOL.atmosphere, ...POOL.culture,
  ];

  // Safe zone: cards must NOT overlap x 28%-72%, y 15%-85%
  function inSafeZone(x, y) {
    return x > 24 && x < 72 && y > 12 && y < 84;
  }

  // Generate a position that avoids the safe zone
  function safePos(region) {
    // region: 'left'|'right'|'top'|'bottom'|'topleft'|'topright'|'botleft'|'botright'
    const configs = {
      left:     () => ({ x: 1  + Math.random() * 18, y: 10 + Math.random() * 70 }),
      right:    () => ({ x: 77 + Math.random() * 18, y: 10 + Math.random() * 70 }),
      topleft:  () => ({ x: 2  + Math.random() * 22, y: 1  + Math.random() * 18 }),
      topright: () => ({ x: 74 + Math.random() * 22, y: 1  + Math.random() * 18 }),
      botleft:  () => ({ x: 2  + Math.random() * 22, y: 78 + Math.random() * 16 }),
      botright: () => ({ x: 74 + Math.random() * 22, y: 78 + Math.random() * 16 }),
      top:      () => ({ x: 20 + Math.random() * 55, y: 0  + Math.random() * 10 }),
      bottom:   () => ({ x: 20 + Math.random() * 55, y: 86 + Math.random() * 10 }),
    };
    const fn = configs[region] || configs.left;
    return fn();
  }

  // ── Layer definitions ─────────────────────────────────────
  const layers = [
    // BACK LAYER — 10 large blurred cards in far corners
    {
      cls:     'hfg-back',
      count:   10,
      regions: ['topleft','topright','botleft','botright','left','right','top','bottom','topleft','topright'],
      imgPool: ALL,
      minW: 190, maxW: 240,
      ratio: 1.30,
      minOp: 0.18,  maxOp: 0.26,
      blur:  '2px',
      radius: '30px',
      minDur: 26, maxDur: 34,
      parallaxScale: 0.006,
    },
    // MID LAYER — 10 medium cards on left/right bands
    {
      cls:     'hfg-mid',
      count:   10,
      regions: ['left','right','left','right','topleft','topright','botleft','botright','left','right'],
      imgPool: ALL,
      minW: 140, maxW: 175,
      ratio: 1.30,
      minOp: 0.22, maxOp: 0.30,
      blur:  '0.5px',
      radius: '22px',
      minDur: 20, maxDur: 26,
      parallaxScale: 0.010,
    },
    // FRONT LAYER — 8 small sharp edge cards
    {
      cls:     'hfg-front',
      count:   8,
      regions: ['topleft','topright','botleft','botright','left','right','top','bottom'],
      imgPool: ALL,
      minW: 96, maxW: 126,
      ratio: 1.32,
      minOp: 0.28, maxOp: 0.38,
      blur:  '0px',
      radius: '16px',
      minDur: 16, maxDur: 21,
      parallaxScale: 0.015,
    },
  ];

  const allCards = [];

  layers.forEach(layer => {
    for (let i = 0; i < layer.count; i++) {
      const img   = document.createElement("img");
      const iSrc  = layer.imgPool[i % layer.imgPool.length];
      img.src     = iSrc;
      img.alt     = "";
      img.loading = "lazy";
      img.className = layer.cls;

      const region  = layer.regions[i % layer.regions.length];
      const pos     = safePos(region);
      const w       = layer.minW + Math.random() * (layer.maxW - layer.minW);
      const h       = Math.round(w * layer.ratio);
      const opacity = layer.minOp + Math.random() * (layer.maxOp - layer.minOp);
      const dur     = layer.minDur + Math.random() * (layer.maxDur - layer.minDur);
      const del     = Math.random() * 12;
      const ra      = -(3 + Math.random() * 4);
      const rb      =   2 + Math.random() * 4;

      img.style.cssText = [
        `left:${pos.x.toFixed(1)}%`,
        `top:${pos.y.toFixed(1)}%`,
        `width:${Math.round(w)}px`,
        `height:${Math.round(h)}px`,
        `opacity:${opacity.toFixed(3)}`,
        `filter:blur(${layer.blur}) saturate(0.88)`,
        `border-radius:${layer.radius}`,
        `--d:${dur.toFixed(1)}s`,
        `--dl:${del.toFixed(1)}s`,
        `--ra:${ra.toFixed(1)}deg`,
        `--rb:${rb.toFixed(1)}deg`,
        `--px:0px`,
        `--py:0px`,
      ].join(';');

      img.dataset.pscale = layer.parallaxScale;
      gallery.appendChild(img);
      allCards.push(img);
    }
  });

  // ── Parallax via CSS custom props ─────────────────────────
  // Set --px / --py instead of overriding transform directly,
  // so keyframe animation composites correctly.
  let _mx = 0, _my = 0, _raf = false;
  window.addEventListener("mousemove", e => {
    _mx = e.clientX; _my = e.clientY;
    if (_raf) return;
    _raf = true;
    requestAnimationFrame(() => {
      const cx = window.innerWidth  / 2;
      const cy = window.innerHeight / 2;
      const dx = cx - _mx;
      const dy = cy - _my;
      allCards.forEach(img => {
        const s  = parseFloat(img.dataset.pscale) || 0.008;
        const px = Math.max(-20, Math.min(20, dx * s));
        const py = Math.max(-20, Math.min(20, dy * s));
        img.style.setProperty('--px', `${px.toFixed(1)}px`);
        img.style.setProperty('--py', `${py.toFixed(1)}px`);
      });
      _raf = false;
    });
  });

  // On mobile: 3 mid + 3 back cards — visible and premium
  if (window.matchMedia("(max-width: 640px)").matches) {
    const allMobile = Array.from(gallery.querySelectorAll(".hfg-back, .hfg-mid, .hfg-front"));
    const midM  = Array.from(gallery.querySelectorAll(".hfg-mid")).slice(0, 3);
    const backM = Array.from(gallery.querySelectorAll(".hfg-back")).slice(0, 3);
    const keepM = new Set([...midM, ...backM]);
    allMobile.forEach(img => { if (!keepM.has(img)) img.remove(); });
    midM.forEach(img  => { img.style.cssText += ";width:84px;height:110px;opacity:0.28;filter:blur(0px) saturate(0.9)"; });
    backM.forEach(img => { img.style.cssText += ";width:100px;height:130px;opacity:0.18;filter:blur(1px) saturate(0.85)"; });
  }
}

// ════════════════════════════════════════════════════════════
// AUTH PAGES — Themed floating gallery builder
//
// Called from login.html / signup.html inline scripts.
// theme: 'login'  → darker cyber palette, action images
//        'signup' → softer warm palette, editorial images
// ════════════════════════════════════════════════════════════
window.buildAuthGallery = function(theme) {
  const container = document.querySelector(".auth-floating-gallery");
  if (!container) return;

  // Add theme-specific overlay class
  const overlay = document.querySelector(".auth-bg-overlay");
  if (overlay) {
    overlay.classList.add(theme === 'login' ? 'auth-overlay-login' : 'auth-overlay-signup');
  }

  // Themed image pools
  const POOLS = {
    login: [
      "assets/discovery/cars/car3.jpg",   "assets/discovery/cars/car9.jpg",
      "assets/discovery/cars/car17.jpg",  "assets/discovery/cars/car25.jpg",
      "assets/discovery/Bikes/bike5.jpg", "assets/discovery/Bikes/bike14.jpg",
      "assets/discovery/Bikes/bike23.jpg",
      "assets/discovery/gaming/gaming2.jpg","assets/discovery/gaming/gaming10.jpg",
      "assets/discovery/anime/anime4.jpg", "assets/discovery/anime/anime12.jpg",
      "assets/discovery/anime/anime22.jpg",
      "assets/discovery/superhero/superhero2.jpg",
      "assets/discovery/scenery/scenery8.jpg",
    ],
    signup: [
      "assets/discovery/fashion/fashion2.jpg",  "assets/discovery/fashion/fashion10.jpg",
      "assets/discovery/fashion/fashion20.jpg",
      "assets/discovery/accessories/accessory5.jpg",
      "assets/discovery/accessories/accessory16.jpg",
      "assets/discovery/accessories/accessory24.jpg",
      "assets/discovery/scenery/scenery3.jpg",  "assets/discovery/scenery/scenery14.jpg",
      "assets/discovery/scenery/scenery24.jpg",
      "assets/discovery/interior/interior2.jpg","assets/discovery/interior/interior10.jpg",
      "assets/discovery/nature/nature8.jpg",    "assets/discovery/nature/nature18.jpg",
      "assets/discovery/art/art6.jpg",
    ],
  };
  const images = POOLS[theme] || POOLS.signup;

  // Edge-only positions — safe zone is the card area (center 50%)
  function edgePos(i) {
    const regions = [
      { x: () =>  2 + Math.random()*16, y: () =>  5 + Math.random()*80 },  // far left
      { x: () => 82 + Math.random()*14, y: () =>  5 + Math.random()*80 },  // far right
      { x: () =>  5 + Math.random()*20, y: () =>  2 + Math.random()*20 },  // top-left
      { x: () => 75 + Math.random()*20, y: () =>  2 + Math.random()*20 },  // top-right
      { x: () =>  5 + Math.random()*20, y: () => 72 + Math.random()*22 },  // bot-left
      { x: () => 75 + Math.random()*20, y: () => 72 + Math.random()*22 },  // bot-right
      { x: () => 20 + Math.random()*55, y: () =>  0 + Math.random()* 8 },  // top strip
      { x: () => 20 + Math.random()*55, y: () => 88 + Math.random()*10 },  // bottom strip
    ];
    return regions[i % regions.length];
  }

  const cards = [];
  const total = 20;

  for (let i = 0; i < total; i++) {
    const img   = document.createElement("img");
    img.src     = images[i % images.length];
    img.alt     = "";
    img.loading = "lazy";
    img.className = "afg-card";

    const posGen = edgePos(i);
    const x   = posGen.x();
    const y   = posGen.y();
    const w   = 100 + Math.random() * 80;
    const h   = Math.round(w * 1.30);
    // depth tiers
    const isFar = i < 7;
    const opacity = isFar
      ? (0.14 + Math.random() * 0.08)
      : (0.22 + Math.random() * 0.10);
    const blur    = isFar ? '2px' : '0px';
    const dur     = 22 + Math.random() * 12;
    const del     = Math.random() * 14;
    const ra      = -(3 + Math.random() * 5);
    const rb      =   2 + Math.random() * 5;
    const radius  = isFar ? '28px' : '20px';

    img.style.cssText = [
      `left:${x.toFixed(1)}%`,
      `top:${y.toFixed(1)}%`,
      `width:${Math.round(w)}px`,
      `height:${Math.round(h)}px`,
      `opacity:${opacity.toFixed(3)}`,
      `filter:blur(${blur}) saturate(0.85)`,
      `border-radius:${radius}`,
      `--d:${dur.toFixed(1)}s`,
      `--dl:${del.toFixed(1)}s`,
      `--ra:${ra.toFixed(1)}deg`,
      `--rb:${rb.toFixed(1)}deg`,
      `--px:0px`,
      `--py:0px`,
    ].join(';');

    img.dataset.pscale = (0.004 + (i % 4) * 0.002).toFixed(3);
    container.appendChild(img);
    cards.push(img);
  }

  // Parallax for auth pages (gentler than hero)
  let _mx = 0, _my = 0, _raf = false;
  window.addEventListener("mousemove", e => {
    _mx = e.clientX; _my = e.clientY;
    if (_raf) return;
    _raf = true;
    requestAnimationFrame(() => {
      const cx = window.innerWidth  / 2;
      const cy = window.innerHeight / 2;
      cards.forEach(img => {
        const s  = parseFloat(img.dataset.pscale) || 0.005;
        const px = Math.max(-12, Math.min(12, (cx - _mx) * s));
        const py = Math.max(-12, Math.min(12, (cy - _my) * s));
        img.style.setProperty('--px', `${px.toFixed(1)}px`);
        img.style.setProperty('--py', `${py.toFixed(1)}px`);
      });
      _raf = false;
    });
  });
};

// Keep backward-compat name
window.initAuthParallax = window.buildAuthGallery;

// ── All curated ideas for one category (every image, no cap) ──
// IDs use a hash of the URL so they are globally unique and
// never collide across categories, even if char codes match.
function getAllCuratedIdeas(cacheKey) {
  const urls = _curatedCache[cacheKey] || [];
  if (!urls.length) return [];
  const label  = cacheKey.split(" ").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
  const cfg    = CAT_CONFIG[cacheKey] || {};
  const titles = cfg.titles || [];
  return urls.map((url, i) => {
    // Stable negative ID from URL hash — guaranteed unique
    let h = 0;
    for (let c = 0; c < url.length; c++) h = (Math.imul(31, h) + url.charCodeAt(c)) | 0;
    return {
      id:          h < 0 ? h : -h - 1,   // always negative
      title:       titles[i % titles.length] || `${label} ${i + 1}`,
      category:    label,
      image_url:   url,
      source:      "curated",
      saves_count: 0,
      likes_count: 0,
      username:    "",
    };
  });
}

// ── All curated ideas across every category ────────────────────
// Deduplicates by URL, applies Fisher-Yates shuffle once,
// then balances categories so no folder clusters together.
// Result is cached in _localDataset for the session.
let _localDataset = null;

function getAllLocalIdeas() {
  if (_localDataset) return _localDataset;

  // Build flat array, deduplicate by URL
  const seenUrls = new Set();
  const raw = Object.keys(_curatedCache).flatMap(key => {
    return getAllCuratedIdeas(key).filter(idea => {
      if (seenUrls.has(idea.image_url)) return false;
      seenUrls.add(idea.image_url);
      return true;
    });
  });

  // Fisher-Yates shuffle for unbiased random order
  const shuffled = fisherYates(raw);

  // Category balance pass: space out same-category cards
  // by interleaving from per-category buckets
  const buckets = {};
  for (const idea of shuffled) {
    const k = idea.category;
    if (!buckets[k]) buckets[k] = [];
    buckets[k].push(idea);
  }
  const balanced = [];
  const queues   = Object.values(buckets);
  let   round    = 0;
  while (queues.some(q => q.length > 0)) {
    for (const q of queues) {
      if (q.length > 0) balanced.push(q.shift());
    }
    round++;
  }

  _localDataset = balanced;
  return _localDataset;
}

// Call this when filter changes so the dataset is rebuilt
function resetLocalDataset() {
  _localDataset = null;
}

// Deduplicate an array of idea objects by image_url.
// Local images (listed first) are always kept; duplicates dropped.
function dedupe(arr) {
  const seen = new Set();
  return arr.filter(idea => {
    const url = idea.image_url || idea.img || "";
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

// Normalise any category string to a _curatedCache key.
// Delegates to CATEGORY_MAP so all the edge cases are handled in one place.
function normalizeCategory(cat) {
  return CATEGORY_MAP[(cat || "").toLowerCase().trim()] || (cat || "").toLowerCase().trim();
}

// ── Generate category filter chips from _curatedCache ──────────
// Replaces the static HTML chips with a live list driven by which
// folders actually have images. Run once on DOMContentLoaded.
// Preserves the "All" chip and the sort selector.
const CAT_ICONS = {
  "cars":"🚗","bikes":"🏍","anime":"🎌","gaming":"🎮","scenery":"🌄",
  "superhero":"🦸","workspace":"💻","fashion":"👗","food":"🍜","pets":"🐾",
  "nature":"🌿","architecture":"🏛","accessories":"💎","art":"🎨","interior":"🏠",
  "cigarettes":"🚬"
};

// Map from cacheKey → display label → chip data-filter value
// The data-filter value must round-trip through CATEGORY_MAP correctly.
const CACHE_KEY_TO_FILTER = {
  "cars":         "Cars",
  "bikes":        "Bikes",
  "anime":        "Anime",
  "gaming":       "Gaming",
  "scenery":      "Scenery",
  "superhero":    "Superheroes",
  "workspace":    "Workspace",
  "fashion":      "Fashion",
  "food":         "Food",
  "pets":         "Pets",
  "nature":       "Nature",
  "architecture": "Architecture",
  "accessories":  "Ladies Accessories",
  "art":          "Art",
  "interior":     "Interior Design",
  // Newly activated categories
};

function generateCategoryChips(containerId) {
  const container = $(containerId);
  if (!container) return;

  // Collect chips already in DOM (preserves "All" + any custom chips)
  // Remove all data-filter chips except "all" — we'll regenerate them
  container.querySelectorAll(".chip[data-filter]:not([data-filter='all'])").forEach(el => el.remove());

  // Insert a chip for every cacheKey that has images, in a stable order
  const allChip = container.querySelector(".chip[data-filter='all']");
  const keys    = Object.keys(_curatedCache)
    .filter(k => (_curatedCache[k] || []).length > 0)
    .sort();

  for (const key of keys) {
    const filterVal = CACHE_KEY_TO_FILTER[key] || key;
    const label     = filterVal;
    const icon      = CAT_ICONS[key] || "✦";
    const btn       = document.createElement("button");
    btn.className   = "chip";
    btn.dataset.filter = filterVal;
    btn.textContent = `${icon} ${label}`;
    // Insert after the "All" chip (or append if not found)
    if (allChip) allChip.after(btn);
    else container.appendChild(btn);
  }

  console.log(`[ZenPin] Generated ${keys.length} category chips in #${containerId}`);
}

// ── Paginated slice from one category ─────────────────────────
// Used by infinite scroll to feed pages of cards for a category.
function getCuratedForCategory(category, limit = 12, page = 1) {
  const raw = category.toLowerCase().trim();
  const key = CATEGORY_MAP[raw] || raw;
  const all = getAllCuratedIdeas(key);
  if (!all.length) return [];

  // Strict slice — no wrap-around, no duplicates.
  // Page 1 → [0..limit), Page 2 → [limit..2*limit), etc.
  // Returns empty array when the page is beyond the dataset end.
  const start = (page - 1) * limit;
  if (start >= all.length) return [];
  return all.slice(start, start + limit);
}

// ── Check if any curated images exist for a category ──────────
function hasCurated(category) {
  const raw = category.toLowerCase().trim();
  const key = CATEGORY_MAP[raw] || raw;
  return (_curatedCache[key] || []).length > 0;
}

// ─────────────────────────────────────────────────────────────
// PAGE: HOME
// ─────────────────────────────────────────────────────────────
function _updateEndSentinel() {
  const btn      = $("loadMoreBtn");
  const sentinel = $("endOfFeedMsg");
  const atEnd    = S.loaded >= S.allIdeas.length;
  if (btn) btn.style.display = atEnd ? "none" : "";
  if (sentinel) sentinel.style.display = atEnd && S.allIdeas.length > 0 ? "block" : "none";
}

async function initHome() {
  const grid = $("homeGrid");
  if (!grid) return;

  const cat = S.filter && S.filter !== "all" ? S.filter.toLowerCase() : null;

  // Reset scroll pointer, cached dataset, and image variety state on every init.
  S.loaded = 0;
  resetLocalDataset();
  resetImageVariety();  // clear _lastUsed so variety guard doesn't repeat images
  _seenUrls.clear();    // clear seen-URL set so infinite scroll gets fresh images

  // ── Step 1: Build local dataset ──────────────────────────────
  let localIdeas;
  if (cat) {
    const cacheKey = CATEGORY_MAP[cat] || cat;
    localIdeas = getAllCuratedIdeas(cacheKey);
    if (!localIdeas.length) localIdeas = getLocalDiscovery(cat);
  } else {
    localIdeas = getAllLocalIdeas();   // pre-shuffled, balanced, deduplicated
  }

  // Personalization re-ranks without changing the URL-dedup guarantee
  S.ideas    = applyFeedIntelligence(localIdeas);
  S.allIdeas = S.ideas;

  // ── Debug logging ─────────────────────────────────────────────
  const _t0 = performance.now();
  console.log(`[ZenPin] Total ideas in dataset: ${S.allIdeas.length}`);

  // Render the first page immediately — no network required
  // 48 cards = ~3 viewport heights, enough to fill the screen
  // on any device without waiting for scroll.
  const INIT_BATCH = 48;
  const firstPage  = S.allIdeas.slice(0, INIT_BATCH);
  renderGrid(grid, firstPage);
  S.loaded = firstPage.length;

  console.log(`[ZenPin] Initially rendered: ${firstPage.length} ideas (${(performance.now()-_t0).toFixed(0)}ms)`);

  // Show/hide end-of-feed sentinel based on dataset size
  _updateEndSentinel();

  // ── Step 2: Blend creator posts from DB (non-blocking) ────────
  try {
    const params = buildParams();
    const { ideas: dbIdeas } = await apiFetch("GET", `/ideas?${params}`);

    if (dbIdeas.length) {
      // Stamp missing images
      for (const idea of dbIdeas) {
        if (!idea.image_url || idea.image_url.includes("loremflickr")) {
          idea.image_url = getLocalImage(idea);
        }
      }
      // When a category filter is active, only blend DB ideas for that category.
      // This prevents wrong-category DB ideas from appearing in filtered views.
      const filteredDb = cat
        ? dbIdeas.filter(idea => {
            const raw = String(idea.category || "").trim();
            const key = CATEGORY_MAP[raw] || CATEGORY_MAP[raw.toLowerCase()] || raw.toLowerCase();
            const activeKey = CATEGORY_MAP[cat] || cat;
            return key === activeKey;
          })
        : dbIdeas;

      const merged = dedupe([...S.allIdeas, ...filteredDb]);

      console.log(`[ZenPin] Local: ${S.allIdeas.length}, DB: ${dbIdeas.length}, Final: ${merged.length}`);

      S.ideas    = applyFeedIntelligence(merged);
      S.allIdeas = S.ideas;
      applySkillFilter();

      // Re-render with the enriched dataset
      const newFirst = S.allIdeas.slice(0, INIT_BATCH);
      renderGrid(grid, newFirst);
      S.loaded = newFirst.length;
      console.log(`[ZenPin] Rendering ${newFirst.length} of ${S.allIdeas.length} ideas`);
      _updateEndSentinel();
    }
  } catch (e) {
    console.warn("initHome DB fetch failed (non-critical):", e.message);
  }

  if (window.Trends) Trends.renderTrendingStrip("trendingStrip");
  if (window.SkillLevel) SkillLevel.renderSelector("skillLevelWrap");
}

function buildParams(extra = {}) {
  const p = new URLSearchParams({
    sort:   S.sort || "newest",
    limit:  S.loaded,
    offset: 0,
    ...extra,
  });
  if (S.filter && S.filter !== "all") p.set("category", S.filter);
  if (S.search) p.set("search", S.search);
  return p.toString();
}

function applySkillFilter() {
  if (window.SkillLevel) {
    S.ideas = SkillLevel.filterIdeas(S.allIdeas);
  }
}

// Heights for skeleton cards — mirrors CARD_HEIGHTS for authentic masonry feel
const SKEL_HEIGHTS = [680, 750, 700, 820, 660, 780, 720, 800, 640, 760, 710, 770];

function skeletonHTML(n) {
  return Array.from({length: n}, (_, i) => {
    const h = SKEL_HEIGHTS[i % SKEL_HEIGHTS.length];
    return `
    <div class="idea-card skeleton-card" style="--i:${i}; --h:${h}px">
      <div class="skeleton-img" style="height:${h}px"></div>
      <div class="skeleton-footer">
        <div class="skeleton-badge"></div>
        <div class="skeleton-line short"></div>
        <div class="skeleton-line long"></div>
      </div>
    </div>`;
  }).join("");
}

// Show backend wake-up toast (only once per session, only when backend is slow)
let _wakeupToasted = false;
function maybeShowWakeupToast(delayMs = 5000) {
  if (_wakeupToasted) return;
  const timer = setTimeout(() => {
    _wakeupToasted = true;
    const bar = document.createElement("div");
    bar.className = "toast-bar";
    bar.style.cssText = "background:linear-gradient(135deg,#7c3aed,#06b6d4)";
    bar.innerHTML = "⚡ Waking up server… showing local previews for now";
    document.body.appendChild(bar);
    requestAnimationFrame(() => bar.classList.add("show"));
    setTimeout(() => { bar.classList.remove("show"); setTimeout(() => bar.remove(), 400); }, 5000);
  }, delayMs);
  return () => clearTimeout(timer); // call to cancel if backend responds quickly
}

// ─────────────────────────────────────────────────────────────
// PAGE: EXPLORE
// ─────────────────────────────────────────────────────────────
async function initExplore() {
  const grid = $("exploreGrid");
  if (!grid) return;

  const ALL_CATEGORIES = Object.keys(CAT_CONFIG);
  const cat = S.filter && S.filter !== "all" ? S.filter.toLowerCase() : null;

  // ── Step 1: Show ALL local images instantly ─────────────────
  const isMix = cat === "mix" || cat === "aesthetic mix";
  let localIdeas;
  if (isMix) {
    // Aesthetic mix: all images shuffled
    localIdeas = getAllLocalIdeas().sort(() => Math.random() - 0.5);
  } else if (cat) {
    // Category filter — resolve to cache key
    const cacheKey = CATEGORY_MAP[cat] || cat;
    localIdeas = getAllCuratedIdeas(cacheKey);
    if (!localIdeas.length) localIdeas = getLocalDiscovery(cat); // legacy fallback
  } else {
    // All-feed: every image from every folder, shuffled
    localIdeas = getAllLocalIdeas().sort(() => Math.random() - 0.5);
  }
  renderGrid(grid, localIdeas);

  // ── Step 2: Upgrade with backend discovery images ───────────
  try {
    let backendDisc = [];

    if (isMix) {
      // Aesthetic Mix — hit the dedicated endpoint
      const mixData = await apiFetch("GET", `/images/aesthetic-mix?page=1&limit=24`).catch(() => null);
      if (mixData?.images?.length) {
        backendDisc = discoveryToIdeas(mixData.images, "mix");
      } else {
        // fallback: multi-category local mix
        const cats = [...ALL_CATEGORIES].sort(() => Math.random() - 0.5).slice(0, 4);
        backendDisc = cats.flatMap(c => getLocalDiscovery(c, 1)).sort(() => Math.random() - 0.5);
      }
      if (backendDisc.length) renderGrid(grid, backendDisc);
      return; // aesthetic mix doesn't need DB ideas interleaved
    }

    const p = new URLSearchParams({ limit: 40, sort: "trending" });
    if (cat) p.set("category", cat);
    if (S.search) p.set("search", S.search);
    const { ideas: dbIdeas } = await apiFetch("GET", `/ideas?${p}`);

    if (cat) {
      backendDisc = await loadDiscoveryImages(cat);
    } else {
      const shuffled = [...ALL_CATEGORIES].sort(() => Math.random() - 0.5).slice(0, 4);
      const results  = await Promise.all(shuffled.map(c => loadDiscoveryImages(c)));
      backendDisc = results.flat().sort(() => Math.random() - 0.5);
    }

    const final = backendDisc.length ? backendDisc : localIdeas;
    // Interleave DB and discovery
    const merged = [];
    let di = 0;
    for (const idea of dbIdeas) {
      merged.push(idea);
      if (merged.length % 5 === 0 && di < final.length) merged.push(final[di++]);
    }
    while (di < final.length) merged.push(final[di++]);

    if (merged.length) renderGrid(grid, merged);
  } catch (e) {
    // Local images already showing — that's a fine fallback
    console.warn("Explore backend failed:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// PAGE: BOARDS
// ─────────────────────────────────────────────────────────────
const BOARD_COLORS = ["var(--grad-brand)","linear-gradient(135deg,#f97316,#ec4899)","linear-gradient(135deg,#06b6d4,#7c3aed)","linear-gradient(135deg,#10b981,#3b82f6)"];

async function initBoards() {
  const grid = $("boardsGrid");
  const collabList = $("collabBoardsList");
  if (!grid) return;

  // Project panel
  if (window.ProjectMode) {
    const projPanel = $("projectsPanel");
    if (projPanel) ProjectMode.renderProjectList("projectsPanel");
  }

  if (!isLoggedIn()) {
    grid.innerHTML = `<div class="boards-login-prompt">
      <p>Sign in to see your boards</p>
      <a href="login.html" class="btn-primary" style="margin-top:12px">Sign In</a>
    </div>`;
    return;
  }

  grid.innerHTML = `<div class="loading-spinner-wrap"><div class="loading-spin"></div></div>`;
  try {
    const { boards } = await apiFetch("GET", "/boards");
    if (!boards.length) {
      grid.innerHTML = `<div class="boards-empty">
        <p>No boards yet.</p>
        <button class="btn-primary" id="firstBoardBtn" style="margin-top:12px">Create your first board</button>
      </div>`;
      $("firstBoardBtn")?.addEventListener("click", showNewBoardModal);
      return;
    }
    grid.innerHTML = boards.map((b, i) => {
      const imgs = (b.preview_images || []).slice(0, 4);
      while (imgs.length < 4) imgs.push(null);
      return `
        <div class="board-card" data-bid="${b.id}" style="--i:${i}">
          <div class="board-mosaic">
            ${imgs.map((img, j) => `
              <div class="bm-img"${j===0?" style='grid-row:1/3'":""}>
                ${img ? `<img src="${img}" alt="" loading="lazy"/>` : `<div class="bm-placeholder" style="background:${BOARD_COLORS[j%4]};opacity:0.15"></div>`}
              </div>`).join("")}
          </div>
          <div class="board-info">
            <div class="board-name">${b.name}</div>
            <div class="board-cnt">${b.idea_count || 0} ideas</div>
          </div>
        </div>`;
    }).join("");
  } catch (e) {
    grid.innerHTML = `<div class="load-error">Could not load boards.</div>`;
  }

  // Collab boards (static demo — extend with backend later)
  if (collabList) {
    collabList.innerHTML = DEMO_COLLAB_BOARDS.map((cb, i) => {
      const avs = cb.members.map((m, j) => `<div class="cboard-av" style="background:${BOARD_COLORS[j%4]}">${m}</div>`).join("");
      return `<div class="cboard-card" style="--i:${i}">
        <div class="cboard-header">
          <div class="cboard-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>
          <div class="cboard-name">${cb.name}</div>
        </div>
        <p class="cboard-desc">${cb.desc}</p>
        <div class="cboard-members">${avs}<span class="cboard-member-cnt">${cb.members.length} collaborators</span></div>
      </div>`;
    }).join("");
  }
}

const DEMO_COLLAB_BOARDS = [
  { name:"Studio Redesign 2025",  desc:"Collaborative moodboard for our studio refresh.",         members:["Y","A","S","M"] },
  { name:"Brand Campaign Q3",     desc:"Visual direction for upcoming campaign assets.",           members:["Y","J","K"]     },
  { name:"Product Launch Vibes",  desc:"Gathering references for the new product identity.",      members:["Y","A","L","P"] },
];

function showNewBoardModal() {
  if (!requireLogin("Sign in to create boards")) return;
  let modal = $("newBoardModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "newBoardModal";
    modal.className = "simple-modal-backdrop";
    modal.innerHTML = `
      <div class="simple-modal-card">
        <h3 class="simple-modal-title">New Board</h3>
        <input class="simple-modal-input" id="nbName" type="text" placeholder="Board name…"/>
        <input class="simple-modal-input" id="nbDesc" type="text" placeholder="Description (optional)"/>
        <div class="simple-modal-btns">
          <button class="btn-primary" id="nbCreate">Create Board</button>
          <button class="btn-ghost"   id="nbCancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    $("nbCancel").onclick = () => modal.classList.remove("open");
    modal.addEventListener("click", e => { if (e.target === modal) modal.classList.remove("open"); });
  }
  $("nbCreate").onclick = async () => {
    const name = $("nbName").value.trim();
    if (!name) { $("nbName").focus(); return; }
    try {
      await apiFetch("POST", "/boards", { name, description: $("nbDesc").value.trim() });
      modal.classList.remove("open");
      toast("Board created! 🎉");
      initBoards();
    } catch (e) { toast(e.message, true); }
  };
  requestAnimationFrame(() => modal.classList.add("open"));
}

// ─────────────────────────────────────────────────────────────
// PAGE: COLLAB
// ─────────────────────────────────────────────────────────────
async function initCollab() {
  const pinList = $("pinIdeaList");
  if (pinList) {
    try {
      const { ideas } = await apiFetch("GET", "/ideas?limit=12");
      pinList.innerHTML = ideas.map(idea => `
        <div class="pin-idea-item" data-pin-id="${idea.id}">
          <img class="pin-idea-thumb" src="${idea.image_url || idea.img}" alt="${idea.title}" loading="lazy"/>
          <span class="pin-idea-name">${idea.title}</span>
        </div>`).join("");
    } catch {
      pinList.innerHTML = `<p class="empty-note">Could not load ideas.</p>`;
    }
  }

  // Pre-seed canvas with a few pins
  try {
    const { ideas } = await apiFetch("GET", "/ideas?limit=4");
    const canvas = $("collabCanvas");
    const hint   = $("canvasHint");
    if (hint) hint.style.display = "none";
    const positions = [
      {top:"10%",left:"6%"},{top:"35%",left:"30%"},
      {top:"12%",left:"55%"},{top:"52%",left:"10%"},
    ];
    ideas.forEach((idea, i) => addPin(idea, positions[i]?.top || "20%", positions[i]?.left || "20%"));
  } catch {}

  // Voting UI
  setupVoting();
}

function addPin(idea, top, left) {
  const canvas = $("collabCanvas");
  if (!canvas) return;
  const pin = document.createElement("div");
  pin.className = "pinned-card";
  pin.style.top = top; pin.style.left = left;
  pin.innerHTML = `
    <img src="${idea.image_url || idea.img}" alt="${idea.title}" loading="lazy"/>
    <div class="pinned-card-label">${idea.title.substring(0, 26)}…</div>
    <div class="pin-vote-row">
      <button class="pin-vote-btn" data-vote="up">👍 <span class="pin-vote-cnt">0</span></button>
      <button class="pin-vote-btn" data-vote="down">👎</button>
    </div>`;
  canvas.appendChild(pin);
  makeDraggable(pin);

  // Vote handlers
  pin.querySelectorAll(".pin-vote-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      if (btn.dataset.vote === "up") {
        const cnt = btn.querySelector(".pin-vote-cnt");
        cnt.textContent = String(parseInt(cnt.textContent) + 1);
        btn.style.background = "rgba(124,58,237,0.15)";
      }
    });
  });
}

function makeDraggable(el) {
  let ox, oy, drag = false;
  el.addEventListener("mousedown", e => {
    if (e.target.closest(".pin-vote-btn")) return;
    drag = true;
    const r = el.getBoundingClientRect();
    ox = e.clientX - r.left; oy = e.clientY - r.top;
    el.style.transition = "none"; el.style.zIndex = 99; el.style.cursor = "grabbing";
    e.preventDefault();
  });
  document.addEventListener("mousemove", e => {
    if (!drag) return;
    const pr = el.parentElement.getBoundingClientRect();
    el.style.left = Math.max(0, Math.min(pr.width  - el.offsetWidth,  e.clientX - pr.left - ox)) + "px";
    el.style.top  = Math.max(0, Math.min(pr.height - el.offsetHeight, e.clientY - pr.top  - oy)) + "px";
  });
  document.addEventListener("mouseup", () => { if (!drag) return; drag = false; el.style.transition = ""; el.style.zIndex = ""; el.style.cursor = ""; });
}

function setupVoting() {
  // Wire pin-idea-list click to add to canvas
  const pinList = $("pinIdeaList");
  const canvas  = $("collabCanvas");
  const hint    = $("canvasHint");
  if (!pinList) return;
  pinList.addEventListener("click", e => {
    const item = e.target.closest(".pin-idea-item");
    if (!item) return;
    const img   = item.querySelector("img");
    const name  = item.querySelector(".pin-idea-name").textContent;
    const idea  = { id: item.dataset.pinId, image_url: img?.src, img: img?.src, title: name };
    if (hint) hint.style.display = "none";
    addPin(idea, (10 + Math.random() * 55) + "%", (5 + Math.random() * 65) + "%");
    toast("Pinned to board!");
  });
}

// Chat

// ════════════════════════════════════════════════════════════
// ZENPIN AI FALLBACK KNOWLEDGE BASE
// 100 trigger → answer pairs, used when Gemini/backend fails.
// Matching is fuzzy: lowercased + punctuation-stripped.
// If a user message contains any trigger word/phrase, this
// answer fires. Ordered by priority (more specific first).
// ════════════════════════════════════════════════════════════
const FALLBACK_KB = [
  // ── Greetings & small talk ────────────────────────────────
  { t: ["hello","hi","hey","greetings","good morning","good evening"],
    a: "Hello! 👋 I'm ZenPin AI. Ask me about bikes, cars, anime, fashion, interior design, and more!" },
  { t: ["how are you","how r you","how're you","you okay","you good"],
    a: "I'm doing great and ready to help! What creative ideas are you exploring today?" },
  { t: ["who are you","what are you","tell me about yourself","introduce yourself"],
    a: "I'm **ZenPin AI** — your creative discovery assistant. I can search ZenPin's image library, answer design questions, give craft ideas, and help you find inspiration across 15 categories." },
  { t: ["what can you do","your features","what do you know","help me","capabilities"],
    a: "I can: 🔍 Search ZenPin images by category • 🎨 Give design and craft advice • 💡 Suggest creative ideas • 🖼 Show matching images • 💬 Answer questions about fashion, bikes, anime, architecture and more." },
  { t: ["thanks","thank you","thx","ty","cheers"],
    a: "You're welcome! Let me know if you need more ideas or inspiration. 😊" },
  { t: ["bye","goodbye","see you","later","cya"],
    a: "Take care! Come back anytime for more creative inspiration. 🌟" },
  { t: ["good","nice","cool","amazing","awesome","great","love it","perfect"],
    a: "Glad you like it! Want me to show you more ideas on that theme?" },
  { t: ["ok","okay","alright","sure","got it","understood"],
    a: "Got it! What else can I help you discover?" },
  { t: ["yes","yeah","yep","yup","absolutely","definitely"],
    a: "Excellent! Let me know what you'd like to explore next." },
  { t: ["no","nope","not really","nah"],
    a: "No worries! Ask me anything else — I'm here to help." },

  // ── Identity & purpose ────────────────────────────────────
  { t: ["zenpin","what is zenpin","about zenpin","tell me about zenpin"],
    a: "**ZenPin** is a Pinterest-style creative discovery platform. Browse 15 curated image categories, save your favorites, create boards, and get AI-powered inspiration." },
  { t: ["how does zenpin work","how to use zenpin","getting started"],
    a: "Browse the home feed → click a category chip to filter → save images to boards → use AI chat (that's me!) for personalized suggestions. Sign up to save your favorites." },

  // ── Auth & login help ─────────────────────────────────────
  { t: ["cannot login","can't login","login not working","sign in not working","login failed","login issue"],
    a: "Login troubleshooting: 1️⃣ Check your email/password. 2️⃣ Try the OTP option (email code). 3️⃣ Clear browser cache (Ctrl+Shift+Delete). 4️⃣ Try a different browser. Still stuck? Refresh the page and try again." },
  { t: ["forgot password","reset password","lost password"],
    a: "Use the **OTP sign-in** option on the login page — enter your email, get a code, and sign in without needing your password." },
  { t: ["sign up","register","create account","new account"],
    a: "Click **Sign In** in the top-right navbar, then choose **Create Account**. You can sign up with email + password, or use the OTP (one-time code) option." },
  { t: ["logout","sign out","log out","logged in wrong account"],
    a: "Click your profile avatar in the top-right corner, then select **Logout**. Your session will be fully cleared." },
  { t: ["otp","one time password","verification code","code not received","code expired"],
    a: "OTP codes expire in 10 minutes. If you didn't receive it: 1️⃣ Check spam/junk folder. 2️⃣ Click Resend Code. 3️⃣ Make sure you typed your email correctly." },

  // ── Bikes ─────────────────────────────────────────────────
  { t: ["show bike","bike ideas","bike inspiration","bike images","motorcycle","sport bike","motorbike"],
    a: "Here are some **Bikes** picks from ZenPin! From sleek sport bikes to vintage cruisers. 🏍", cat: "bikes" },
  { t: ["black bike","dark bike","matte black motorcycle"],
    a: "**Matte black** bikes are a classic choice — they look aggressive, hide scratches, and pair well with dark riding gear. Here are matching bikes from ZenPin:", cat: "bikes" },
  { t: ["cafe racer","vintage bike","retro motorcycle","classic bike"],
    a: "Café racers and retro motorcycles have a timeless appeal. Low-slung seats, round headlights, and stripped-down frames. Here are some from ZenPin:", cat: "bikes" },
  { t: ["best bike color","bike color","what color bike"],
    a: "**Black** hides wear best. **Red** is most visible in traffic (safety). **White** looks cleanest but shows grime. **Matte grey** is currently trending. What's your use case — commuting, track, or touring?" },

  // ── Cars ──────────────────────────────────────────────────
  { t: ["show car","car ideas","car images","car inspiration","supercar","sports car"],
    a: "Here are some **Cars** from ZenPin's collection! 🚗", cat: "cars" },
  { t: ["black car","dark car","matte car"],
    a: "**Matte black** cars are peak automotive style — no reflections, ultra-aggressive stance. Here are dark car picks from ZenPin:", cat: "cars" },
  { t: ["best car color","car color tips","what color car"],
    a: "**White** stays coolest in sun + easiest to clean. **Black** looks most premium but shows dust. **Silver/grey** hides scratches best. **Red** retains value better at resale." },
  { t: ["sports car","fast car","racing car","track car","ferrari","lamborghini","porsche"],
    a: "Here are high-performance car inspirations from ZenPin 🏎:", cat: "cars" },
  { t: ["car interior","car dashboard","car cockpit"],
    a: "Great car interior tips: premium stitched leather, ambient lighting strips, digital cockpit displays, and minimal clutter. Here are car interior ideas:", cat: "interior" },

  // ── Anime ─────────────────────────────────────────────────
  { t: ["show anime","anime images","anime ideas","anime inspiration"],
    a: "Here are some **Anime** picks from ZenPin! 🎌", cat: "anime" },
  { t: ["anime wallpaper","anime background","anime desktop","anime phone wallpaper"],
    a: "**Anime wallpaper ideas:** dark neon city scenes, cherry blossom silhouettes, lone character on rooftop, minimal aesthetic with soft gradients, studio ghibli-style landscapes. Here are some from ZenPin:", cat: "anime" },
  { t: ["anime room","anime bedroom","anime decor","otaku room"],
    a: "**Anime room essentials:** 1) Wall scroll or tapestry of favorite character 2) LED strip lights (purple/blue) 3) Figurines on floating shelves 4) Matching bedding set 5) Poster frames with key art. Here are ideas:", cat: "anime" },
  { t: ["best anime","top anime","anime recommendation","what anime"],
    a: "For **visual aesthetics**: Attack on Titan (dark/epic), Demon Slayer (vivid colors), Your Name (romantic scenery), Violet Evergarden (emotional + beautiful), Spy x Family (cozy+fun). What mood are you going for?" },
  { t: ["manga","manga art","manga style"],
    a: "**Manga** art style tips: clean line art, screentone textures, dramatic lighting, expressive eyes, speed lines for action. Here are anime-style images from ZenPin:", cat: "anime" },

  // ── Fashion ───────────────────────────────────────────────
  { t: ["fashion tips","style tips","what to wear","outfit ideas","fashion advice"],
    a: "**Quick fashion rules:** 1) One statement piece per outfit 2) Match metals (gold OR silver, not both) 3) Shoes = bag color family 4) Fit > brand 5) Neutral base + one bold color. What's the occasion?" },
  { t: ["show fashion","fashion ideas","fashion inspiration","fashion images"],
    a: "Here are some **Fashion** ideas from ZenPin 👗", cat: "fashion" },
  { t: ["casual outfit","everyday style","street style","casual look"],
    a: "**Casual essentials:** quality white tee + well-fitted jeans + clean sneakers = always works. Add a minimal watch or bracelet. Here are casual fashion images:", cat: "fashion" },
  { t: ["summer outfit","summer fashion","summer look","summer style"],
    a: "**Summer style:** linen shirts stay cool, light colours reflect heat, wide-leg trousers are both stylish and breathable. Sandals > closed shoes. Here are summer fashion picks:", cat: "fashion" },
  { t: ["winter outfit","winter fashion","winter look","layering"],
    a: "**Winter layering:** base layer (thermal/moisture-wicking) → mid layer (fleece/sweater) → outer layer (coat). Stick to 2-3 colors. A great coat elevates any outfit." },
  { t: ["color combination","color matching","what colors go together","color palette outfit"],
    a: "**Winning combos:** Navy + white | Black + camel | Olive + rust | Grey + burgundy | Cream + sage. Avoid matching top + bottom in the same color unless it's a suit." },

  // ── Accessories ───────────────────────────────────────────
  { t: ["accessories","jewelry","earrings","necklace","bracelet","rings","handbag","bag","purse"],
    a: "Here are some **Ladies Accessories** from ZenPin 💎", cat: "accessories" },
  { t: ["accessory tips","how to wear jewelry","jewelry tips","jewelry advice"],
    a: "**Jewelry rules:** Less is more for formal. More is better for bohemian. Stack delicate necklaces (not chunky). One statement ring per hand. Earrings = face-framing, pick based on face shape." },
  { t: ["statement jewelry","bold jewelry","big earrings","chunky necklace"],
    a: "**Statement pieces** work best with minimal clothing — let the accessory be the hero. Solid-colour dresses or plain tops are the ideal base. Here are bold accessories:", cat: "accessories" },

  // ── Interior Design & Architecture ────────────────────────
  { t: ["interior design","room design","home decor","room ideas","living room","bedroom ideas"],
    a: "Here are some **Interior Design** ideas from ZenPin 🏠", cat: "interior" },
  { t: ["anime room","gaming room","gaming setup","battle station"],
    a: "**Gaming setup essentials:** ultrawide monitor, RGB lighting (consistent color), cable management, ergonomic chair, ambient lighting behind desk. Here are gaming room ideas:", cat: "gaming" },
  { t: ["minimalist room","minimalist design","minimal interior","clean room"],
    a: "**Minimalist design principles:** remove anything you don't use weekly, neutral palette (white/beige/grey), surfaces clear by default, one quality piece per room. Here are minimalist spaces:", cat: "interior" },
  { t: ["luxury interior","luxury room","luxury home","high end design","premium interior"],
    a: "**Luxury interior hallmarks:** statement lighting (chandelier/pendant), marble or stone surfaces, velvet or bouclé textiles, symmetry, bespoke furniture. Here are luxury interior ideas:", cat: "interior" },
  { t: ["architecture","building design","modern architecture","architectural"],
    a: "Here are some stunning **Architecture** images from ZenPin 🏛", cat: "architecture" },
  { t: ["workspace","home office","desk setup","office ideas","productive workspace"],
    a: "Here are some **Workspace** setups from ZenPin 💻", cat: "workspace" },
  { t: ["workspace tips","productive office","how to design workspace","office setup tips"],
    a: "**Productive workspace:** natural light on your left (if right-handed), monitor at eye level, one plant for air/calm, minimal desk items, cable tray underneath. 90-minute focus blocks work best." },

  // ── Art & Creativity ──────────────────────────────────────
  { t: ["art ideas","art inspiration","show art","creative art","artwork"],
    a: "Here are some **Art** images from ZenPin's collection 🎨", cat: "art" },
  { t: ["digital art","illustration","drawing tips","how to draw"],
    a: "**Digital art starter tips:** tablet > mouse (Wacom Intuus is great entry-level), start with basic shapes, study lighting before complex scenes, practice perspective daily. Software: Procreate (iPad), Clip Studio Paint (PC/Mac)." },
  { t: ["watercolor","watercolour","painting tips","acrylic painting"],
    a: "**Watercolor basics:** wet-on-wet for soft backgrounds, wet-on-dry for sharp edges, always mix more paint than you need, light to dark layers, use 100% cotton paper (not copy paper)." },

  // ── Food & Photography ────────────────────────────────────
  { t: ["food ideas","food inspiration","food photography","show food","food images"],
    a: "Here are some **Food** images from ZenPin 🍴", cat: "food" },
  { t: ["food photography tips","how to photograph food","food photo"],
    a: "**Food photography tips:** 1) Natural side-light (not flash) 2) 45° angle for most dishes 3) Garnish intentionally 4) Negative space matters 5) Use a simple background (white/wood/slate). Shoot in RAW." },
  { t: ["recipe","what to cook","meal ideas","dinner ideas","lunch ideas"],
    a: "For recipe inspiration, try browsing ZenPin's Food category! Also recommend: NYT Cooking, Serious Eats for detailed recipes. What cuisine style interests you?" },

  // ── Nature & Scenery ──────────────────────────────────────
  { t: ["nature images","nature inspiration","nature ideas","show nature","outdoor"],
    a: "Here are beautiful **Nature** images from ZenPin 🌿", cat: "nature" },
  { t: ["scenery","landscape","scenic","scenic photography","travel scenery"],
    a: "Here are stunning **Scenery** images from ZenPin 🌄", cat: "scenery" },
  { t: ["photography tips","how to take photos","better photos","photo composition"],
    a: "**Photography composition rules:** Rule of thirds, leading lines, frame within frame, negative space, golden hour (1hr after sunrise/before sunset). Always shoot more than you think you need." },

  // ── Pets ──────────────────────────────────────────────────
  { t: ["pets","animals","cute animals","show pets","cat photos","dog photos"],
    a: "Here are adorable **Pets** images from ZenPin 🐾", cat: "pets" },
  { t: ["pet care","caring for pets","pet tips"],
    a: "**Pet care basics:** consistent feeding schedule, vet check-up 1-2×/year, daily exercise/play, dental health (often overlooked!), and enrichment toys prevent boredom." },

  // ── Superhero & Gaming ────────────────────────────────────
  { t: ["superhero","marvel","dc comics","comic hero","hero images","superhero ideas"],
    a: "Here are some **Superhero** images from ZenPin! 🦸", cat: "superhero" },
  { t: ["gaming","games","game ideas","gaming inspiration","esports","gaming setup"],
    a: "Here are some **Gaming** images from ZenPin 🎮", cat: "gaming" },
  { t: ["best games","game recommendation","what game to play"],
    a: "**Top picks by mood:** Chill → Stardew Valley, Minecraft | Action → Elden Ring, Doom | Story → Last of Us, God of War | Competitive → Valorant, CS2 | Indie gem → Hades, Celeste" },

  // ── Craft & DIY ──────────────────────────────────────────
  { t: ["craft ideas","diy ideas","handmade","how to make","crafting","creative project"],
    a: "**Craft project ideas:** 1) Macramé wall hanging (beginner-friendly) 2) Resin coaster set 3) Hand-painted ceramic mugs 4) Embroidery hoop art 5) Pressed flower frames. Which interests you?" },
  { t: ["how to design clothes","design clothing","fashion design","diy clothes","clothing design"],
     r:"Designing clothes from an image: 1) Sketch silhouette 2) Identify fabric type 3) Note key details 4) Choose colour palette 5) Start with beginner pattern 6) Mock-up in muslin first."},
  { t: ["sewing tips","how to sew","beginner sewing","learn sewing"],
    a: "**Sewing starter path:** 1) Learn straight stitch on scrap fabric 2) Make a pillowcase 3) Make a tote bag 4) Make elastic-waist shorts 5) Attempt a simple dress. Use YouTube + a seam ripper (you'll need it!)." },
  { t: ["upcycle","repurpose","thrift","sustainable fashion","eco fashion","zero waste"],
    a: "**Upcycling ideas:** Denim jacket → painted/patched art piece | Old shirt → tote bag | Worn jeans → shorts with frayed hem | Oversized shirt → cropped top. Thrift first, buy new only if needed." },

  // ── Motivation & wellbeing ────────────────────────────────
  { t: ["motivate me","i need motivation","inspire me","feeling stuck","creative block"],
    a: "Creative block tip: **change input, not output**. Read something unrelated, take a 10-min walk, browse ZenPin's Scenery or Art categories for fresh visual stimulation. Constraints also help — try: 'design something using only 3 colors'." },
  { t: ["productivity tips","how to be productive","focus tips","work better"],
    a: "**Productivity essentials:** 90-minute deep work blocks (not 25-min Pomodoro for creative work), phone in another room, one task on screen at a time, review tomorrow's priorities tonight before sleeping." },
  { t: ["sad","feeling down","not okay","depressed","anxious","stressed"],
    a: "I hear you 💙 Sometimes creativity helps — try browsing the Nature or Scenery category for a calming visual reset. If you're struggling, please reach out to someone you trust." },

  // ── Technical / ZenPin help ──────────────────────────────
  { t: ["image not loading","images broken","blank card","white card","missing images"],
    a: "If images aren't loading: 1️⃣ Hard refresh (Ctrl+Shift+R / Cmd+Shift+R) 2️⃣ Clear browser cache 3️⃣ Check internet connection 4️⃣ Try a different browser. The server may be waking up — wait 30 seconds and try again." },
  { t: ["site slow","loading slow","website slow","server sleeping"],
    a: "ZenPin runs on a free server that sleeps when idle. The first load may take 20–30 seconds. After that, it's fast! If it stays slow, try refreshing or coming back in a minute." },
  { t: ["save image","how to save","pin image","bookmark image"],
    a: "Click the **heart/save icon** on any image card to save it. You need to be signed in first. Saved images appear in your Profile under Saved." },
  { t: ["create board","make board","new board","organize boards"],
    a: "Go to the **Boards** section in the navbar → click **New Board** → name it → start adding images. You can add any ZenPin image to a board from its card menu." },
  { t: ["how to upload","upload image","share my image","post image"],
    a: "Click **+ Create** in the navbar → Upload your image → Add title, category, and description → Post. Your image appears in the feed and your profile." },

  // ── Fallback catch-alls ───────────────────────────────────
  { t: ["what else","something else","other ideas","more ideas","show more"],
    a: "Sure! Tell me a category or topic — I can show bikes, cars, anime, fashion, accessories, architecture, interior design, gaming, art, food, nature, scenery, superheroes, or workspace inspiration." },
  { t: ["i don't know","not sure","confused","help","what should i choose"],
    a: "No worries! Here are some popular starting points: 🏍 Bikes | 🚗 Cars | 🎌 Anime | 👗 Fashion | 💎 Accessories | 🏛 Architecture | 🏠 Interior | 🎮 Gaming. Which sounds interesting?" },
  { t: ["random","surprise me","show anything","anything","whatever","pick for me"],
    a: "Here's a random pick for you! 🎲", cat: "scenery" },
];

/**
 * queryFallbackKB(msg)
 * --------------------
 * Fuzzy-match user message against FALLBACK_KB.
 * Returns { answer, category } or null if no match.
 * Matching: lowercase + strip punctuation, any trigger word/phrase found.
 */
function queryFallbackKB(msg) {
  const clean = msg.toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim();
  // Score each entry by number of trigger phrases found
  let bestScore = 0, bestEntry = null;
  for (const entry of FALLBACK_KB) {
    let score = 0;
    for (const trigger of entry.t) {
      if (clean.includes(trigger)) score += trigger.split(" ").length; // longer phrase = higher score
    }
    if (score > bestScore) { bestScore = score; bestEntry = entry; }
  }
  return bestScore > 0 ? bestEntry : null;
}


// ════════════════════════════════════════════════════════════
// ZENPIN AI — BUILT-IN FALLBACK BRAIN
// Responds instantly without needing backend or API.
// Matched loosely: strips punctuation, lowercases, keyword scan.
// Format: { t: [trigger keywords...], a: "answer", cat: "optional_category" }
// ════════════════════════════════════════════════════════════
const FALLBACK_BRAIN = [

  // ── Greetings & small talk ────────────────────────────────
  { t: ["hello","hi","hey","hiya","howdy","greetings"],
    a: "Hey there! 👋 I'm ZenPin AI — your creative discovery assistant. Ask me about bikes, fashion, anime, interior design, or anything creative!" },
  { t: ["how are you","how r u","how are u","you okay","you good","hows it going","how do you do"],
    a: "I'm doing great, thanks for asking! ✦ Ready to help you discover ideas, find inspiration, and explore everything creative. What's on your mind?" },
  { t: ["who are you","what are you","tell me about yourself","introduce yourself","what is zenpin ai"],
    a: "I'm **ZenPin AI** — your creative companion on ZenPin. I can find image ideas, answer design questions, give fashion advice, explain craft techniques, and help you explore our discovery library. What would you like to explore?" },
  { t: ["what can you do","your abilities","your features","capabilities","help me","what do you know"],
    a: "I can **find images** from ZenPin's library, **answer design & craft questions**, give **fashion tips**, explain **anime styles**, suggest **room ideas**, help with **bike or car photography**, and much more. Just ask!" },
  { t: ["thanks","thank you","thx","ty","appreciate it","cheers"],
    a: "You're very welcome! 😊 Let me know if you need anything else — I'm here to help you discover great ideas." },
  { t: ["bye","goodbye","see you","later","cya","take care"],
    a: "Goodbye! Come back anytime for more inspiration. Happy creating! ✨" },
  { t: ["good morning","gm","morning"],
    a: "Good morning! ☀️ Ready to discover something beautiful today? Ask me about any category or creative topic." },
  { t: ["good night","goodnight","gn","night"],
    a: "Good night! 🌙 Sweet creative dreams. Come back when inspiration strikes!" },
  { t: ["lol","haha","hehe","funny","lmao"],
    a: "Ha! Glad to keep it light. 😄 Now, anything creative I can help you discover?" },
  { t: ["boring","bored","nothing to do"],
    a: "Let's fix that! Browse the Explore page for fresh ideas, or ask me: **'show me anime room ideas'** or **'what are trending fashion styles?'**" },

  // ── ZenPin-specific questions ─────────────────────────────
  { t: ["what is zenpin","about zenpin","tell me about zenpin"],
    a: "**ZenPin** is a visual discovery platform — like Pinterest but focused on curated, high-quality images across bikes, anime, fashion, cars, interior design, food, nature, and more. Save ideas, build boards, and get AI-powered inspiration." },
  { t: ["how do i save","how to save","bookmark","pin it","save post","save image"],
    a: "Click the **Save** button (bookmark icon) on any image card. You'll need to be signed in. Saved ideas appear in your profile under **Saved Posts**." },
  { t: ["how do i create board","create a board","make a board","new board"],
    a: "Go to the **Boards** page from the navbar, then click **Create Board**. Give it a name, and start adding ideas to it from the Explore feed." },
  { t: ["how do i upload","upload image","post image","share my image"],
    a: "Click the **+ Create** button in the navbar. You can upload an image, add a title, description, and category. It'll appear in the Discovery feed." },
  { t: ["premium","pro","subscription","paid"],
    a: "ZenPin is currently **free to use**! Create an account to save ideas, build boards, and use AI search." },

  // ── Auth & account help ───────────────────────────────────
  { t: ["cannot login","can't login","login not working","sign in not working","login failed","forgot password"],
    a: "**Login troubleshooting:** 1) Check your email/OTP code 2) Try clearing browser cache (Ctrl+Shift+Delete) 3) Use the **Sign in with code** option for OTP login 4) Try a different browser. Still stuck? Email us." },
  { t: ["sign up","create account","register","new account","join zenpin"],
    a: "Click **Sign In** in the top-right navbar → then choose **Create account**. You can register with email + password or use an OTP code sent to your email." },
  { t: ["otp","one time password","verification code","code not received","otp not working"],
    a: "**OTP troubleshooting:** 1) Check your spam/junk folder 2) Wait 30 seconds — free email can be slow 3) Click 'Resend Code' 4) Make sure you typed the exact email address used to sign up." },
  { t: ["delete account","remove account","close account"],
    a: "To delete your account, please contact us via the support email found in the Settings page. We'll process it within 24 hours." },
  { t: ["edit profile","change username","update profile","change my name"],
    a: "Click your **avatar** in the top-right navbar → select **Edit Profile**. You can update username, bio, location, and social links. Changes save immediately." },

  // ── Bikes ──────────────────────────────────────────────────
  { t: ["show bike","bike ideas","motorcycle ideas","bike images","motorbike","show me bikes"],
    a: "Here are some **bike and motorcycle** ideas from ZenPin! Explore sport bikes, vintage cruisers, café racers, and off-road adventure bikes.", cat: "bikes" },
  { t: ["best bike color","bike colour","motorcycle color","what color bike"],
    a: "**Best bike colors:** 1) **Matte black** — timeless, premium, hides scratches 2) **Candy red** — classic, high-visibility 3) **Pearl white** — clean, modern 4) **Forest green** — unique, earthy 5) **Metallic blue** — sporty and stylish. Dark colors look best at night." },
  { t: ["cafe racer","café racer","vintage bike","retro motorcycle"],
    a: "**Café Racer style:** Low handlebars, single seat, round headlight, stripped-down aesthetic. Key brands: Triumph Bonneville, Honda CB series, Royal Enfield. Great for urban riding with classic style.", cat: "bikes" },
  { t: ["bike photography","motorcycle photography","photo bike"],
    a: "**Bike photography tips:** 1) Shoot at **golden hour** for warm tones 2) Use a **low angle** to emphasise the machine 3) **Motion blur** at 1/30s gives speed feel 4) Find **industrial/urban backgrounds** 5) Remove unnecessary objects from frame." },
  { t: ["superbike","sports bike","racing bike","track bike"],
    a: "**Sport/superbikes to explore:** Ducati Panigale, Honda CBR series, Kawasaki Ninja, Yamaha YZF-R1, BMW S1000RR. All about aerodynamics, power-to-weight, and aggressive styling.", cat: "bikes" },

  // ── Cars ──────────────────────────────────────────────────
  { t: ["show car","car ideas","car images","black car","car photography","show me cars"],
    a: "Here are stunning **car** images from ZenPin — sports cars, classic muscle, luxury sedans, and more!", cat: "cars" },
  { t: ["car color","best car color","what color car","car colour"],
    a: "**Most popular car colors:** 1) **Pearl white** — resale value king 2) **Midnight black** — sleek, premium 3) **Silver/grey** — practical, hides dirt 4) **Racing red** — passionate, sporty 5) **Navy blue** — understated luxury. White and grey hold value best." },
  { t: ["classic car","vintage car","old car","retro car","muscle car"],
    a: "**Classic car icons:** Ford Mustang (1965–70), Chevrolet Camaro, Dodge Challenger, Jaguar E-Type, Porsche 911 (air-cooled). Great for collectors and photoshoots.", cat: "cars" },
  { t: ["sports car","supercar","ferrari","lamborghini","luxury car"],
    a: "**Supercar aesthetics:** Low roofline, wide stance, air intakes, carbon fiber details. Brands: Ferrari, Lamborghini, McLaren, Bugatti, Koenigsegg. Perfect for automotive photography.", cat: "cars" },

  // ── Anime ────────────────────────────────────────────────
  { t: ["show anime","anime ideas","anime images","anime art","anime wallpaper"],
    a: "Here are beautiful **anime** artworks from ZenPin — from minimal character posters to vibrant city scapes!", cat: "anime" },
  { t: ["anime room","anime bedroom","otaku room","weeb room"],
    a: "**Anime room design ideas:** 1) Dark walls + neon accents (cyberpunk) 2) Pastel kawaii aesthetic 3) Wall scroll + figure shelves 4) LED backlighting 5) Tokyo street mural. Mix functional furniture with collectibles.", cat: "interior" },
  { t: ["anime wallpaper","desktop wallpaper anime","phone wallpaper anime"],
    a: "**Best anime wallpaper styles:** Dark neon city scenes, cherry blossom sakura, minimal silhouette art, Studio Ghibli landscapes, lofi-style aesthetics. Try 4K for crisp detail." },
  { t: ["anime art style","draw anime","learn anime","anime illustration"],
    a: "**Anime art fundamentals:** 1) Large expressive eyes 2) Simplified anatomy with dynamic poses 3) Speed lines for motion 4) Flat cell-shading with gradients 5) Consistent line weight. Tools: Clip Studio Paint, Procreate." },
  { t: ["favorite anime","best anime","top anime","recommend anime"],
    a: "**Genre-based picks:** Action: Demon Slayer, Jujutsu Kaisen | Mecha: Code Geass, Gurren Lagann | Fantasy: Made in Abyss, Frieren | Slice-of-life: Your Lie in April, Violet Evergarden." },

  // ── Fashion & Accessories ─────────────────────────────────
  { t: ["fashion tips","style tips","how to dress","dressing tips","outfit ideas","style advice"],
    a: "**Quick fashion rules:** 1) Fit > brand — tailored cheap clothes beat ill-fitting expensive ones 2) One bold statement piece per outfit 3) Neutral base + one accent color 4) Shoes and bag should coordinate 5) Dress for the occasion, then add personality.", cat: "fashion" },
  { t: ["show fashion","fashion ideas","fashion images","outfit images","style images"],
    a: "Here is fresh **fashion** inspiration from ZenPin — editorial looks, street style, and minimalist aesthetics!", cat: "fashion" },
  { t: ["accessories ideas","jewelry ideas","show accessories","ladies accessories"],
    a: "Here are curated **accessories** from ZenPin — earrings, necklaces, bags, watches, and statement pieces!", cat: "accessories" },
  { t: ["capsule wardrobe","minimal wardrobe","basic wardrobe","essential clothes"],
    a: "**Capsule wardrobe essentials (15 pieces):** 2 white shirts, 1 striped top, 2 quality tees, 1 blazer, 1 denim jacket, 2 trousers (black + navy), 1 jeans, 1 dress, 1 skirt, 2 shoes (white sneaker + ankle boot)." },
  { t: ["color combination","colour combo","what colors go together","outfit colors"],
    a: "**Winning color combos:** Black + white + one accent | Navy + camel | Burgundy + grey | Olive + rust | Blush + camel. Use the 60-30-10 rule: 60% dominant, 30% secondary, 10% accent." },
  { t: ["street style","streetwear","urban fashion","hypebeast"],
    a: "**Streetwear essentials:** Oversized tees, cargo pants, hoodies, chunky sneakers (New Balance, Nike Dunks, Jordan 1s), beanies. Mix high and low brands. Less is more — let one piece speak." },

  // ── Interior Design & Rooms ───────────────────────────────
  { t: ["room ideas","bedroom ideas","interior ideas","home decor","room design","room inspo"],
    a: "Here is beautiful **interior design** inspiration from ZenPin — minimal, cosy, modern and maximalist styles!", cat: "interior" },
  { t: ["minimal room","minimalist interior","minimalist design","clean room"],
    a: "**Minimalist room principles:** 1) Only keep what you need and love 2) Neutral palette (white, grey, beige, black) 3) One texture per layer 4) Quality over quantity 5) Hidden storage 6) Single statement furniture piece.", cat: "interior" },
  { t: ["cozy room","cosy bedroom","warm room","hygge","comfy room"],
    a: "**Cosy room elements:** Layered textiles (throw blankets, cushions), warm lighting (amber LEDs), candles, wood accents, plants, a reading nook, and soft rugs. Hygge is about warmth and presence." },
  { t: ["small room","small bedroom","tiny room","small space ideas","studio apartment"],
    a: "**Small space hacks:** 1) Mirrors create depth 2) Bed with storage underneath 3) Vertical shelving 4) Light colours expand the room visually 5) Multi-function furniture (sofa-bed, ottoman with storage) 6) Declutter monthly." },
  { t: ["workspace ideas","home office","desk setup","work from home","gaming setup","battle station"],
    a: "**Desk setup essentials:** Wide monitor or dual screens, ergonomic chair, cable management, ambient lighting (RGB or warm lamp), plants, and a clean background for video calls.", cat: "workspace" },

  // ── Architecture & Scenery ────────────────────────────────
  { t: ["architecture ideas","building design","show architecture","architectural photography"],
    a: "Here is stunning **architecture** photography from ZenPin — modern towers, historic buildings, and geometric marvels!", cat: "architecture" },
  { t: ["scenery ideas","landscape images","nature scenery","beautiful places","travel scenery"],
    a: "Here are breathtaking **scenery** images from ZenPin — mountains, coastlines, forests, and golden hour landscapes!", cat: "scenery" },
  { t: ["photography tips","photo tips","how to take photos","better photos","camera tips"],
    a: "**Photography fundamentals:** 1) Rule of thirds — subject off-centre 2) Golden hour light (1hr after sunrise/before sunset) 3) Leading lines 4) Clean background 5) Shoot in RAW 6) Move your feet before zooming." },

  // ── Food & Styling ────────────────────────────────────────
  { t: ["food ideas","food photography","food styling","show food","food images"],
    a: "Here is delicious **food photography** from ZenPin — styled dishes, flat lays, and restaurant aesthetics!", cat: "food" },
  { t: ["food styling tips","how to style food","food photo tips","flat lay food"],
    a: "**Food styling tips:** 1) Natural side lighting (window, no direct sun) 2) Rule of odds — 3 or 5 items 3) Add texture (linen napkin, herbs) 4) Height variation 5) Shoot from 45° or overhead 6) Keep it fresh — shoot fast." },
  { t: ["recipe ideas","what to cook","meal ideas","cooking inspiration"],
    a: "**Quick inspiration:** Try a **shakshuka** (Middle Eastern eggs in tomato sauce), **Buddha bowl** (roasted veg + grain + sauce), or **miso glazed aubergine**. All photogenic and delicious!" },

  // ── Craft & DIY ───────────────────────────────────────────
  { t: ["craft ideas","diy ideas","handmade","how to make","crafting","creative project"],
    a: "**Craft project ideas:** 1) Macramé wall hanging 2) Resin coaster set 3) Hand-painted ceramic mugs 4) Embroidery hoop art 5) Pressed flower frames. Which interests you?" },
  { t: ["how to design clothes","design clothing","fashion design","diy clothes"],
    a: "**Designing clothes from an image:** 1) Sketch the silhouette 2) Identify fabric type 3) Note key details (collar, hem, seams) 4) Choose a matching colour palette 5) Start with a commercial pattern 6) Mock-up in muslin first." },
  { t: ["origami","paper craft","paper folding"],
    a: "**Origami beginner path:** Crane → Jumping frog → Lotus flower → Modular star. Use 15×15cm square paper. YouTube channels: Jo Nakashima, Tadashi Mori." },
  { t: ["macrame","wall hanging","knot art","fibre art","fiber art"],
    a: "**Macramé starter:** You need single-strand cotton rope, wooden dowel, scissors. Basic knots: Square knot, Half hitch, Lark's head. Make a small wall hanging first, then expand to plant hangers." },

  // ── Pets ─────────────────────────────────────────────────
  { t: ["show pets","pet images","pet ideas","cute animals","pet photography"],
    a: "Here are adorable **pet** photos from ZenPin — dogs, cats, and other companions captured beautifully!", cat: "pets" },
  { t: ["pet photography tips","how to photograph pets","cat photos","dog photos"],
    a: "**Pet photography tips:** 1) Get at their eye level 2) Use natural light 3) Burst mode for action 4) Patience — let them come to you 5) Treats as focus tool 6) Catch them mid-action or mid-yawn for character." },

  // ── Nature ───────────────────────────────────────────────
  { t: ["show nature","nature images","nature photos","show me nature"],
    a: "Here is stunning **nature** photography from ZenPin — landscapes, wildlife, forests, and macro details!", cat: "nature" },
  { t: ["nature photography","landscape photography","outdoor photography"],
    a: "**Nature photography kit:** Wide-angle lens, tripod for long exposures, polarising filter (removes glare on water), weather-sealed body. Shoot at golden/blue hour. Check weather apps for dramatic skies." },

  // ── Superheroes ───────────────────────────────────────────
  { t: ["show superhero","hero images","superhero art","marvel art","dc art","comic art"],
    a: "Here is epic **superhero** artwork from ZenPin — Marvel, DC, and original comic-style illustrations!", cat: "superhero" },
  { t: ["superhero costume","cosplay ideas","hero outfit","costume design"],
    a: "**Cosplay planning:** 1) Choose a character you love 2) Break down the costume into parts 3) EVA foam for armour pieces 4) Worbla for detailed props 5) Wigs + coloured contacts for accuracy 6) Practice before the event." },

  // ── Gaming ────────────────────────────────────────────────
  { t: ["show gaming","gaming images","game setup","gaming room","gaming aesthetic"],
    a: "Here is epic **gaming** setup and game artwork from ZenPin — from battle stations to game concept art!", cat: "gaming" },
  { t: ["gaming room ideas","streaming setup","rgb setup","gaming desk"],
    a: "**Gaming room essentials:** Curved ultrawide or dual monitors, mechanical keyboard, high-DPI mouse, sound-dampening panels, RGB ambient lighting, a comfortable chair rated for 8+ hours." },

  // ── Workspace ─────────────────────────────────────────────
  { t: ["show workspace","desk ideas","office ideas","study setup","work desk"],
    a: "Here is minimal, productive **workspace** inspiration from ZenPin — clean desks, creative studios, and home offices!", cat: "workspace" },
  { t: ["productivity tips","how to be productive","focus tips","study tips"],
    a: "**Productivity system:** 1) Time-block your calendar 2) Pomodoro: 25min focus + 5min break 3) One priority per day 4) Phone in another room during deep work 5) Morning pages — 3 pages freewriting on waking." },

  // ── Motivation & Creativity ────────────────────────────────
  { t: ["motivate me","motivation","inspire me","feeling stuck","creative block","no ideas"],
    a: "**Break the block:** 1) Change your environment 2) Consume different art (visit a gallery, watch a documentary) 3) Limitations spark creativity — set a constraint 4) Work first, edit later 5) The first idea is rarely the best — push past it." },
  { t: ["how to be creative","creativity tips","creative thinking","think creatively"],
    a: "**Creativity practices:** Daily sketching, mood boarding, 10-ideas-a-day habit (James Altucher), reading outside your field, and combining two unrelated concepts. Creativity is a skill, not a gift." },
  { t: ["art ideas","drawing ideas","what to draw","painting ideas"],
    a: "**Drawing prompts today:** 1) Your view from a window 2) An object on your desk in 3 styles 3) A person from memory 4) A mythical creature in a modern setting 5) Your city 50 years from now.", cat: "art" },
  { t: ["color theory","colour theory","colour wheel","complementary colors"],
    a: "**Color theory basics:** Complementary (opposite on wheel — high contrast), Analogous (adjacent — harmonious), Triadic (triangle — vibrant). For design: 60% dominant, 30% secondary, 10% accent." },

  // ── Technical/Site help ────────────────────────────────────
  { t: ["site not loading","website broken","not working","page not loading","error"],
    a: "**Quick fixes:** 1) Hard refresh (Ctrl+Shift+R or Cmd+Shift+R on Mac) 2) Clear browser cache 3) Try incognito mode 4) Check your internet connection 5) The server may be starting up — wait 30 seconds and retry." },
  { t: ["images not loading","images broken","blank images","no images","images missing"],
    a: "**If images aren't loading:** 1) Hard refresh the page (Ctrl+Shift+R) 2) Check internet connection 3) Clear browser cache 4) Try a different browser. Images are hosted on GitHub Pages and usually load fast." },
  { t: ["how does it work","how does zenpin work","explain zenpin"],
    a: "**ZenPin works like this:** Browse discovery categories → Save ideas to your profile → Organise into Boards → Use AI Search to find specific images → Share your own creations via the Upload button." },
  { t: ["slow","website slow","loading slow","too slow"],
    a: "The backend runs on Render's free tier which may take 20–30 seconds to wake up after a period of inactivity. Once awake it runs normally. This is a known free-tier limitation." },
  { t: ["dark mode","light mode","theme","colour scheme"],
    a: "ZenPin uses a dark, premium aesthetic by default. Theme settings may be available in your profile settings." },
];


// ── AI fallback brain (module-level so brainLookup can access it) ──
// ── 100-entry fallback knowledge base ──────────────────────
// Matched when backend is unavailable or for common questions.
// Keys are lowercase stripped strings; values are {text, category?}.
const BRAIN = [
// ── Greetings ──────────────────────────────────────────────────
{k:["how are you","how r you","how are u","how you doing","how r u"],
 r:"I'm doing great! Ready to help you discover new ideas. 🎨"},
{k:["hi","hello","hey","hiya","sup","yo","hola","howdy","greetings","what's up","whats up"],
 r:"Hey! 👋 I'm ZenPin AI. Ask me about bikes, anime, fashion, interior design or anything creative!"},
{k:["good morning","morning"],
 r:"Good morning! ☀️ Ready to explore some beautiful ideas today?"},
{k:["good evening","good night","goodnight"],
 r:"Good evening! 🌙 Perfect time to browse some inspiring ideas. What are you looking for?"},
{k:["good afternoon","afternoon"],
 r:"Good afternoon! 🌤️ Hope your day is going well. What creative ideas can I help you find?"},
{k:["bye","goodbye","see you","cya","later","take care"],
 r:"See you later! 👋 Come back anytime for more inspiration. Happy creating!"},
{k:["thank you","thanks","thankyou","thx","ty","appreciate it"],
 r:"You're welcome! 😊 Happy to help. Let me know if you need more ideas!"},
{k:["ok","okay","cool","nice","great","awesome","perfect","got it"],
 r:"Great! 🎉 Anything else you'd like to explore on ZenPin?"},

// ── Identity ───────────────────────────────────────────────────
{k:["who are you","what are you","what is zenpin ai","tell me about yourself","introduce yourself"],
 r:"I'm ZenPin AI 🤖 — your creative assistant for discovering images, getting design inspiration, exploring craft ideas and finding aesthetic content across categories like bikes, anime, fashion, interior design and more!"},
{k:["what can you do","what do you do","help me","how can you help","your capabilities"],
 r:"I can: 🔍 Search ZenPin's image library, 🎨 Answer design and craft questions, 💡 Give fashion, anime, bike or interior tips, 🖼️ Show matching images from our collection, and 💬 Chat about creative topics!"},
{k:["are you ai","are you a bot","are you real","are you human","are you chatgpt"],
 r:"I'm ZenPin AI — a creative assistant built specifically for this platform. I'm not ChatGPT, but I'm here to help you discover ideas and get design inspiration! 🌟"},
{k:["what is zenpin","tell me about zenpin","what does zenpin do"],
 r:"ZenPin is a visual discovery platform — like Pinterest but with curated collections of bikes, anime, fashion, interior design, art, cars and more. You can browse, save, and get AI-powered ideas! 📌"},

// ── Image search ───────────────────────────────────────────────
{k:["show bike ideas","bike ideas","show me bikes","bike images","motorcycle ideas"],
 r:"Here are some amazing bike ideas from ZenPin! 🏍️ From sport bikes to cruisers, there's something for every rider.",
 cat:"bikes"},
{k:["show black bike","black motorcycle","dark bike"],
 r:"Here are some sleek dark motorcycle images from ZenPin! 🖤 Perfect for that edgy aesthetic.",
 cat:"bikes"},
{k:["show car ideas","car ideas","car images","show me cars","supercar","sports car ideas"],
 r:"Check out these stunning car images from ZenPin! 🚗 From supercars to classics.",
 cat:"cars"},
{k:["show anime ideas","anime ideas","anime images","anime wallpaper","anime room"],
 r:"Here are some incredible anime ideas from ZenPin! 🌸 From dark neon scenes to cherry blossom aesthetics.",
 cat:"anime"},
{k:["show fashion ideas","fashion ideas","outfit ideas","clothing ideas","style ideas"],
 r:"Here are some gorgeous fashion ideas from ZenPin! 👗 Trending styles and outfit inspiration.",
 cat:"fashion"},
{k:["show accessories","accessories ideas","jewelry ideas","bag ideas","show me jewelry"],
 r:"Here are some beautiful accessory ideas from ZenPin! 💍 From jewelry to bags and beyond.",
 cat:"accessories"},
{k:["show interior","room ideas","interior design ideas","home decor ideas","bedroom ideas","living room ideas"],
 r:"Here are some stunning interior design ideas from ZenPin! 🏠 From minimalist to cozy aesthetics.",
 cat:"interior"},
{k:["show architecture","building ideas","architecture ideas","house design"],
 r:"Here are some breathtaking architecture ideas from ZenPin! 🏛️ From modern to classic structures.",
 cat:"architecture"},
{k:["show art ideas","art ideas","digital art ideas","painting ideas","artwork"],
 r:"Here are some amazing art ideas from ZenPin! 🎨 From digital illustrations to traditional paintings.",
 cat:"art"},
{k:["show food ideas","food ideas","recipe ideas","food styling","plating ideas"],
 r:"Here are some delicious food styling ideas from ZenPin! 🍽️ Perfect for food photographers and chefs.",
 cat:"food"},
{k:["show gaming setup","gaming room ideas","pc setup ideas","gaming desk","esports setup"],
 r:"Here are some epic gaming setup ideas from ZenPin! 🎮 RGB, ultrawide and pro-level setups.",
 cat:"gaming"},
{k:["show nature","nature ideas","landscape ideas","outdoor photography","nature photography"],
 r:"Here are some breathtaking nature ideas from ZenPin! 🌿 From forests to mountain vistas.",
 cat:"nature"},
{k:["show pets","cute pets","pet ideas","dog pictures","cat pictures"],
 r:"Here are some adorable pet ideas from ZenPin! 🐾 Cats, dogs and furry friends galore.",
 cat:"pets"},
{k:["show scenery","scenery ideas","travel photos","beautiful places","scenic views"],
 r:"Here are some stunning scenery photos from ZenPin! 🌅 Beautiful landscapes from around the world.",
 cat:"scenery"},
{k:["show superhero","superhero ideas","marvel ideas","dc comics ideas","batman","spiderman"],
 r:"Here are some epic superhero ideas from ZenPin! 🦸 From Marvel to DC universe.",
 cat:"superhero"},
{k:["show workspace","desk setup","office ideas","home office","work setup"],
 r:"Here are some clean workspace setups from ZenPin! 💻 Productive and aesthetic desk setups.",
 cat:"workspace"},

// ── Design & craft ─────────────────────────────────────────────
{k:["design clothes","how to design clothes","clothing design","how can i design cloth","design an outfit"],
 r:"To design clothes: 1️⃣ Start with a sketch of your silhouette. 2️⃣ Choose a color palette (2-3 colors max). 3️⃣ Select fabric — cotton for casual, silk for elegant. 4️⃣ Add details like buttons, zippers or embroidery. 5️⃣ Make a pattern or find a template online. Try browsing ZenPin's Fashion category for visual inspiration! 👗"},
{k:["anime room ideas","how to make anime room","anime bedroom","anime aesthetic room"],
 r:"For an anime room aesthetic: 🌸 Use dark walls (navy/black) with neon accent lighting. Add anime posters and figure displays. Install LED strips behind your desk. Use sakura fairy lights for ambiance. Check ZenPin's Anime collection for specific ideas!",
 cat:"anime"},
{k:["fashion tips","style tips","how to dress better","dressing tips","outfit tips"],
 r:"Fashion tips: 👗 1. Build a capsule wardrobe (10 versatile pieces). 2. Wear neutral colors as a base. 3. Add one statement piece per outfit. 4. Dress for your body shape. 5. Invest in good shoes — they elevate any look. 6. Accessorize minimally but intentionally!"},
{k:["interior design tips","how to decorate room","room decoration tips","how to make room look good"],
 r:"Interior design tips: 🏠 1. Follow the 60-30-10 color rule. 2. Mix textures (wood, fabric, metal). 3. Use mirrors to make small rooms appear larger. 4. Layer lighting (ambient + task + accent). 5. Add plants for life and freshness. 6. Declutter first — good design starts with clean space!"},
{k:["workspace tips","how to setup desk","desk setup tips","productive workspace","office setup tips"],
 r:"Workspace setup tips: 💻 1. Monitor at eye level (use a stand). 2. Good chair = back health. 3. External keyboard and mouse for comfort. 4. Warm lighting to reduce eye strain. 5. Cable management makes it look professional. 6. Add a plant for focus. ZenPin's Workspace category has amazing setups!",
 cat:"workspace"},
{k:["photography tips","how to take better photos","photo tips","photo ideas"],
 r:"Photography tips: 📸 1. Use the rule of thirds. 2. Shoot in golden hour (sunrise/sunset). 3. Look for leading lines and natural frames. 4. Keep backgrounds simple. 5. Edit lightly — enhance, don't overprocess. 6. Shoot in RAW if your camera supports it!"},
{k:["color palette ideas","color combination","color scheme","best color combinations"],
 r:"Popular color palettes: 🎨 1. Monochromatic (shades of one color) — elegant. 2. Complementary (opposites on color wheel) — energetic. 3. Triadic (3 evenly spaced colors) — vibrant. 4. Earth tones — warm and timeless. 5. Pastel + white — soft and minimal. Try using Coolors.co to generate palettes!"},
{k:["diy craft ideas","craft ideas","creative diy","handmade ideas","craft project"],
 r:"DIY craft ideas: ✂️ 1. Macramé wall hangings (rope art). 2. Resin jewelry making. 3. Candle pouring with essential oils. 4. Embroidery on denim jackets. 5. Terrarium building. 6. Hand-painted plant pots. 7. Collage art using magazine cutouts. Browse ZenPin for visual inspiration!"},
{k:["minimalist style","minimalist design","minimalism tips","how to be minimalist"],
 r:"Minimalist style guide: ⬜ 1. Choose quality over quantity. 2. Stick to a neutral color palette. 3. Remove anything without function or meaning. 4. Leave negative space (empty space is good!). 5. One focal point per room or outfit. 6. Hidden storage > visible clutter."},
{k:["how to draw anime","draw anime character","anime drawing tips","drawing tips"],
 r:"Anime drawing basics: ✏️ 1. Start with a circle for the head (larger than realistic proportions). 2. Eyes are large and expressive — the focal point. 3. Keep noses and mouths minimal. 4. Hair has volume and flows dramatically. 5. Study your favorite anime artist's style. 6. Practice with reference before drawing from imagination!"},

// ── Car / bike specific ────────────────────────────────────────
{k:["best bike color","bike color ideas","motorcycle color","what color bike"],
 r:"Popular bike colors: 🏍️ **Matt Black** — timeless and aggressive. **Racing Red** — classic sport look. **Pearl White** — clean and premium. **Electric Blue** — eye-catching. **Burnt Orange** — vintage aesthetic. For night riding, darker colors look more dramatic under city lights!",
 cat:"bikes"},
{k:["best car color","car color ideas","what color car","car paint ideas"],
 r:"Best car colors: 🚗 **Midnight Black** — sophisticated and always stylish. **Glacier White** — clean and premium resale value. **Metallic Grey** — modern and understated. **Racing Red** — passionate and sporty. **British Racing Green** — classic and distinctive. Choose based on your climate — dark colors show dust more!",
 cat:"cars"},
{k:["superbike","superbike ideas","sports bike","racing bike"],
 r:"ZenPin has some incredible superbike images! 🏁 Check out our Bikes collection for sport bikes, naked bikes and café racers.",
 cat:"bikes"},

// ── Anime specific ─────────────────────────────────────────────
{k:["anime aesthetic","anime wallpaper ideas","anime desktop","anime phone wallpaper"],
 r:"Anime wallpaper aesthetics: 🌸 1. Dark city skylines (cyberpunk anime). 2. Cherry blossom forests. 3. Minimal character silhouettes. 4. Studio Ghibli landscapes. 5. Neon-lit street scenes. 6. Pastel kawaii characters. Browse ZenPin's Anime section for curated wallpaper ideas!",
 cat:"anime"},
{k:["best anime","favorite anime","top anime","recommend anime","anime recommendation"],
 r:"I'm focused on visual inspiration rather than reviews, but for stunning aesthetics: Attack on Titan, Demon Slayer, Your Name, and Spirited Away all have incredible visual design! ZenPin's anime collection showcases similar aesthetics. 🎌"},

// ── Fashion specific ───────────────────────────────────────────
{k:["street style","streetwear","street fashion","urban fashion"],
 r:"Streetwear essentials: 👟 Oversized hoodies, cargo pants, clean sneakers (Air Force 1s, Jordan 1s), graphic tees, and bucket hats. Layer with an open flannel or bomber jacket. Neutral base with one pop of color. ZenPin's Fashion section has great streetwear inspo!",
 cat:"fashion"},
{k:["boho style","bohemian fashion","boho fashion","boho look"],
 r:"Boho style guide: 🌿 Flowy maxi dresses, earthy tones (terracotta, rust, cream), fringe details, layered jewelry, woven bags, and suede ankle boots. Add a wide-brim hat for the full look! Great for summer and festival season.",
 cat:"fashion"},
{k:["casual outfit","casual style","casual look","everyday outfit"],
 r:"Casual outfit formula: 👕 Good jeans or chinos + clean t-shirt or polo + white sneakers = always works. Upgrade with a structured blazer over a t-shirt for smart-casual. Stick to max 3 colors per outfit for a cohesive look!"},

// ── Login / account help ───────────────────────────────────────
{k:["cannot login","can't login","login problem","login not working","sign in not working","cant sign in"],
 r:"Login help: 🔑 1. Check your email address for typos. 2. Try the OTP (email code) option instead of password. 3. Clear browser cache and try again. 4. If the server is just waking up, wait 30 seconds and retry. Still stuck? Contact support via the profile page."},
{k:["forgot password","reset password","password reset","forgot my password"],
 r:"Password reset: 📧 Use the 'Sign in with code' option on the login page — enter your email and we'll send you a one-time code. No password needed! This is the fastest way back in."},
{k:["how to register","how to sign up","create account","new account","signup help"],
 r:"To create a ZenPin account: 1️⃣ Click Sign In in the navbar. 2️⃣ Click 'Create account' on the login page. 3️⃣ Enter your email address. 4️⃣ Enter the 6-digit code sent to your email. 5️⃣ Set your username — you're in! 🎉"},
{k:["how to save image","save pin","how to save","bookmark image","save idea"],
 r:"To save an image: Click the ❤️ icon on any image card while browsing. You can find all your saved ideas in your Profile → Saved section!"},
{k:["how to upload","upload image","add my image","post image","share image"],
 r:"To upload: Click the ✦ Create button in the navbar. You can upload an image, add a title, category and description. Your image will appear in the community feed!"},

// ── Motivation / productivity ──────────────────────────────────
{k:["motivate me","i need motivation","feeling lazy","no motivation","inspire me"],
 r:"Here's some motivation: 🌟 Every great design started with someone who didn't know how. Start before you're ready. The best time to begin was yesterday — the second best time is right now. Browse ZenPin for visual fuel to get you started! 🔥"},
{k:["productivity tips","how to be productive","focus tips","study tips","work tips"],
 r:"Productivity tips: ⚡ 1. Use the Pomodoro technique (25 min work, 5 min break). 2. Single-task — multitasking kills focus. 3. Clear your workspace before starting. 4. Write tomorrow's top 3 tasks tonight. 5. Turn off notifications for 90-minute focus blocks!"},
{k:["creativity tips","how to be more creative","boost creativity","creative block","creative ideas"],
 r:"Boost creativity: 🧠 1. Browse visual inspiration daily (ZenPin is great for this!). 2. Keep a sketchbook or idea journal. 3. Constraints spark creativity — try a 10-minute challenge. 4. Walk and think — movement unlocks new ideas. 5. Combine two unrelated ideas and see what happens!"},

// ── Errors / technical ─────────────────────────────────────────
{k:["something went wrong","error","not working","broken","bug","issue"],
 r:"Sorry about that! 😅 Try: 1. Hard refresh the page (Ctrl+Shift+R). 2. Clear browser cache. 3. Wait 30 seconds — the server may be waking up from sleep. 4. Try a different browser. If it persists, this is likely a temporary glitch!"},
{k:["slow","loading slow","site is slow","takes long","server slow"],
 r:"The site may be slow because the backend server is waking up from sleep mode (Render free tier sleeps after 15 min of inactivity). ⏱️ First request takes ~30 seconds. After that it runs normally! Refresh if needed."},
{k:["blank screen","white screen","nothing showing","images not loading","images not appearing"],
 r:"Images not loading? Try: 1. Hard refresh (Ctrl+Shift+R). 2. Check your internet connection. 3. Click on a category chip to force a reload. 4. Wait a moment — server may be starting up. If the issue persists, try another browser!"},

// ── Misc ───────────────────────────────────────────────────────
{k:["what's trending","trending ideas","popular ideas","what is popular","trending now"],
 r:"Trending on ZenPin right now: 🔥 Dark academia aesthetics, neon bike setups, anime room decor, minimalist workspace designs, and bold fashion accessories! Browse the Explore section to see what's hot."},
{k:["give me ideas","random idea","surprise me","something creative","inspiration"],
 r:"Here's a creative challenge: 💡 Take one object near you and redesign it in a different style — minimalist, cyberpunk, vintage, or Japanese aesthetic. Or browse ZenPin's random category mix for unexpected inspiration! 🎲"},
{k:["how to make mood board","moodboard","vision board","aesthetic board"],
 r:"Create a mood board: 🎨 1. Choose a theme or emotion. 2. Collect 15-20 images that match. 3. Arrange by color and mood (similar tones together). 4. Add texture samples if physical. 5. Use Canva or ZenPin boards for digital mood boards. Your board should make you feel something instantly!"},
{k:["zenpin features","features","what features","what does zenpin have"],
 r:"ZenPin features: 📌 1. Image discovery across 15 curated categories. 2. Save and like images. 3. Create boards to organize ideas. 4. AI chat assistant (that's me!). 5. Image analysis — upload a photo for AI insights. 6. Collaborate with others. 7. Profile and portfolio!"},

// ── More design / craft ────────────────────────────────────────
{k:["architecture tips","how to appreciate architecture","best architectural styles"],
 r:"Architecture styles: 🏛️ **Minimalist** — clean lines, open space. **Industrial** — raw materials, exposed metal/brick. **Art Deco** — ornate geometric patterns. **Brutalist** — raw concrete, bold mass. **Biophilic** — nature integrated into buildings. ZenPin\'s Architecture section has stunning examples!",
 cat:"architecture"},
{k:["food styling tips","how to style food","food photography","food presentation"],
 r:"Food styling tips: 🍽️ 1. Use odd numbers (3, 5) of elements. 2. Create height and layers. 3. Use natural light from the side. 4. Add a colour contrast (green garnish on warm dishes). 5. Keep the hero ingredient front and centre. 6. Wipe plate edges clean before shooting!",
 cat:"food"},
{k:["home workout","workout at home","exercise at home","fitness tips","how to stay fit"],
 r:"Home fitness essentials: 💪 1. Bodyweight routines (push-ups, squats, lunges). 2. Resistance bands — cheap and versatile. 3. 20-min HIIT 3x/week beats 1-hour slow cardio. 4. Track progress with photos not just weight. 5. Consistency beats intensity every time!"},
{k:["cooking tips","how to cook better","improve cooking","kitchen tips"],
 r:"Cooking tips: 🍳 1. Salt pasta water like the sea. 2. Let meat rest after cooking. 3. Mise en place — prep everything before cooking. 4. High heat for searing, low heat for simmering. 5. Acid (lemon, vinegar) brightens flavours at the end. 6. Taste as you cook, always!"},
{k:["web design tips","website design","ui design tips","ux design","design a website"],
 r:"Web design principles: 💻 1. Hierarchy — guide the eye to what matters. 2. White space is a design element, not wasted space. 3. Consistent colour palette (2-3 colours max). 4. Typography hierarchy: 3 sizes max. 5. Mobile-first design. 6. Load time matters — optimize images!"},
{k:["social media tips","instagram tips","content tips","how to grow social media"],
 r:"Social media tips: 📱 1. Consistent aesthetic across posts. 2. Post at peak times (varies by platform). 3. Engage before and after posting (30 min each). 4. Carousels outperform single images. 5. Use 3-5 very specific hashtags, not 30 generic ones. 6. Stories daily, feed 3-4x/week!"},
{k:["startup ideas","business ideas","side hustle ideas","make money online"],
 r:"Starter business ideas: 💼 1. Digital products (presets, templates, e-books). 2. Print-on-demand shop. 3. Social media management for local businesses. 4. Photography/content creation. 5. Handmade crafts on Etsy. 6. Online tutoring in your skill. Start small, validate before scaling!"},
{k:["book recommendations","good books","must read books","recommend a book"],
 r:"Creative/design books worth reading: 📚 **The Elements of Style** (writing), **Steal Like an Artist** (creativity), **Don\'t Make Me Think** (UX), **Thinking Fast and Slow** (psychology), **The Creative Habit** (design thinking). ZenPin is great for visual book cover inspiration too!"},
{k:["what is interior design","interior design basics","how to design a room","room layout"],
 r:"Interior design basics: 🏠 1. Choose a focal point (fireplace, statement wall, large art). 2. Follow the 60-30-10 colour rule. 3. Scale furniture to the room size. 4. Layer lighting (overhead + lamps + accent). 5. Mix textures for depth. 6. Add 1 unexpected element per room!",
 cat:"interior"},
{k:["color theory","colour theory","how colors work","color wheel","complementary colors"],
 r:"Colour theory essentials: 🎨 **Complementary** = opposites on the wheel (most contrast). **Analogous** = neighbours (harmonious). **Triadic** = 3 evenly spaced (vibrant). **Warm colours** (red, orange, yellow) energise. **Cool colours** (blue, green, purple) calm. Use 60-30-10 for balance!"},
{k:["how to style bookshelf","bookshelf ideas","shelf decor","bookshelf aesthetic"],
 r:"Bookshelf styling tips: 📚 1. Group books by colour for visual harmony. 2. Mix books with objects (plants, candles, frames). 3. Leave empty space — not every inch needs filling. 4. Use bookends as art. 5. Lay some books horizontally as risers. 6. A plant on top adds life!",
 cat:"interior"},
{k:["mental health tips","feeling stressed","anxiety tips","how to relax","destress","calm down"],
 r:"Quick reset tips: 🌿 1. Box breathing (4-4-4-4 counts). 2. 5-minute walk outside. 3. Journal one thing you\'re grateful for. 4. Disconnect from screens for 20 minutes. 5. A warm shower resets the nervous system. Visual inspiration helps too — browse ZenPin\'s Nature category! 🌊",
 cat:"nature"},
{k:["study tips","how to study better","focus while studying","study methods"],
 r:"Study methods that work: 📖 1. **Active recall** — close book and write what you remember. 2. **Spaced repetition** — review at increasing intervals. 3. **Pomodoro** — 25 min focus, 5 min break. 4. Teach the concept to an imaginary person. 5. Handwrite key points — pen beats keyboard for retention!"},
{k:["money tips","save money","how to save money","budget tips","financial tips"],
 r:"Simple money tips: 💰 1. Track every expense for 30 days. 2. The 50-30-20 rule (needs-wants-savings). 3. Automate savings on payday. 4. Unsubscribe from unused services monthly. 5. 24-hour rule before non-essential purchases. 6. Learn one marketable skill per year!"},
{k:["gift ideas","gift for her","gift for him","what to gift","present ideas"],
 r:"Thoughtful gift ideas: 🎁 **For creators**: sketchbook + quality pens, Procreate subscription, photo book. **For homebody**: premium candle set, cosy throw, indoor plant. **For traveller**: packing cubes, camera accessories. **Universal**: personalised item, experience (class/event), book from their wishlist!"},
{k:["get inspired","find inspiration","creative inspiration","where to find ideas"],
 r:"Find inspiration everywhere: 💡 Browse ZenPin (you\'re already here! 🎉), walk around a new neighbourhood, visit a gallery or bookshop, scroll architecture/fashion hashtags, watch a documentary about an artist, read a coffee table book, or just sit quietly — inspiration often comes in silence!"},
{k:["what is ai","how does ai work","explain ai","artificial intelligence"],
 r:"AI simply explained: 🤖 AI learns patterns from data. When you ask me a question, I match it against things I\'ve been trained on or search ZenPin\'s content. I don\'t actually think like a human — I find the most useful response based on patterns. Think of me as a very fast pattern matcher with a creative twist!"},
{k:["make my room cosy","cosy room","hygge aesthetic","warm room ideas","cosy home"],
 r:"Cosy room essentials: 🕯️ 1. Warm-temperature bulbs (2700K). 2. Chunky knit throw + cushions. 3. Candles or fairy lights. 4. A soft rug underfoot. 5. Books within reach. 6. A warm drink station (kettle, mugs, tea). 7. One living plant. Less tech, more texture!",
 cat:"interior"},
{k:["dark academia","dark academia aesthetic","dark academia room"],
 r:"Dark academia aesthetic: 📚 Deep wooden furniture, vintage books stacked everywhere, warm amber lighting, oil paintings or prints, leather notebooks, plaid or herringbone textiles, dried flowers, a globe or antique map. Colour palette: forest green, burgundy, cream, dark brown.",
 cat:"interior"},
{k:["cyberpunk aesthetic","cyberpunk room","neon aesthetic","futuristic room","neon lights"],
 r:"Cyberpunk room aesthetic: 🌆 Neon LED strips (purple/blue/pink), dark walls, tech equipment with RGB, holograms or anime posters, dark glass shelving, sleek black furniture. Mix tech and decay — rough textures + high-tech gear. Great for gaming rooms!",
 cat:"gaming"},
{k:["cute room ideas","kawaii room","pink room","girly room ideas","aesthetic bedroom"],
 r:"Cute aesthetic room ideas: 🌸 Pastel palette (pink, lavender, mint), cloud/star string lights, plushies and small figures, DIY wall art, mirror vanity with warm lighting, fluffy rugs, aesthetic photo wall with polaroids and fairy lights. ZenPin\'s Interior section has tons of inspo!",
 cat:"interior"},
{k:["plant care tips","indoor plants","best indoor plants","how to keep plants alive"],
 r:"Easy indoor plants for beginners: 🌿 **Pothos** — nearly indestructible. **Snake plant** — thrives on neglect. **ZZ plant** — loves low light. **Aloe vera** — water once a month. **Spider plant** — propagates itself. Golden rule: most indoor plants die from overwatering, not under-watering!"},
{k:["sunset photos","sunrise photos","golden hour photography","magic hour"],
 r:"Golden hour photography tips: 🌅 Shoot within 1 hour of sunrise or sunset. Position subject backlit for a glow. Use a low angle. Expose for the sky, not the subject. Use lens flare intentionally. Warm up your white balance slightly in editing. Golden hour turns any location magical!",
 cat:"scenery"},
{k:["japanese aesthetic","wabi sabi","japanese interior","japandi","japanese design"],
 r:"Japanese interior aesthetics: 🏯 **Wabi-sabi** — embrace imperfection (handmade ceramics, weathered wood). **Japandi** — Japanese + Scandinavian minimalism (low furniture, neutral palette). **Traditional** — shoji screens, tatami, bonsai. Key principle: every item should be functional AND beautiful.",
 cat:"interior"},

// ── Final 15 entries to complete 100-entry library ─────────────
{k:["best gaming setup","build gaming setup","gaming room tour","rgb setup"],
 r:"Gaming setup essentials: 🎮 Curved ultrawide monitor, mechanical keyboard, smooth mouse pad (full-desk), good headset, RGB strips behind the desk for ambiance. Ergonomics first — invest in a proper chair and monitor arm. ZenPin\'s Gaming section has amazing setup inspiration!",
 cat:"gaming"},
{k:["superhero costume","superhero cosplay","cosplay ideas","which superhero"],
 r:"Superhero aesthetic picks: 🦸 **Black aesthetic** → Black Panther, Batman. **Futuristic** → Iron Man, Cyborg. **Mystic** → Doctor Strange, Scarlet Witch. **Classic** → Superman, Wonder Woman. ZenPin\'s Superhero collection has great visual references for any look!",
 cat:"superhero"},
{k:["pet photography","how to photograph pets","cute pet photos"],
 r:"Pet photography tips: 🐾 1. Get down to their eye level. 2. Use natural light near a window. 3. Have someone distract them while you shoot. 4. Burst mode catches perfect expressions. 5. Focus on the eyes — always. 6. A favourite toy helps keep their attention!",
 cat:"pets"},
{k:["workspace productivity","clean desk","minimalist desk","desk aesthetic"],
 r:"Minimal desk setup: 💻 Start with cable management. Single monitor + laptop stand combo. One plant (succulents for low maintenance). Notebook and pen always within reach. Remove everything that doesn\'t have a function. A clean desk = a clear mind. Browse ZenPin\'s Workspace section!",
 cat:"workspace"},
{k:["cafe aesthetic","coffee shop aesthetic","cafe vibe","study cafe"],
 r:"Café aesthetic elements: ☕ Warm amber lighting, exposed brick or wood, small round tables, hanging plants, vintage mugs and menu boards. Reproduce at home: a dedicated coffee corner with a pour-over kettle, good beans, and a small plant. Instant café mood!",
 cat:"interior"},
{k:["nature walk ideas","outdoor ideas","hiking aesthetic","nature photography spots"],
 r:"Nature photography locations: 🌿 Forests at golden hour (mist between trees), waterfalls (use slow shutter), coastal cliffs at dusk, mountain overlooks, flower fields in spring. Always look up — overhead canopies create stunning natural frames!",
 cat:"nature"},
{k:["vintage aesthetic","retro style","vintage room","retro design","70s aesthetic"],
 r:"Vintage/retro aesthetic guide: 🎞️ Warm amber + mustard + rust + avocado green. Record players, vintage cameras, rotary phones as decor. Film grain filters on photos. Thrift stores are gold for authentic vintage pieces. Mix old items with clean modern furniture for balance!",
 cat:"art"},
{k:["neon aesthetic","neon lights","neon photography","neon signs"],
 r:"Neon aesthetic tips: 🌈 Neon signs work best against dark walls (black or deep blue). Use one dominant neon colour + one accent. Long-exposure photography captures neon beautifully at night. Mix with industrial elements (brick, concrete) for contrast. Very popular in anime-inspired rooms!"},
{k:["car modification","car mods","customize car","car tuning ideas","modified car"],
 r:"Car customisation ideas: 🚗 **Exterior** — wrap vinyl, alloy wheel swap, tinted windows, body kit. **Interior** — carbon fibre trim, racing seats, custom steering wheel. **Lighting** — LED interior, HID headlights. Always match mod style to the car\'s character — sport vs luxury vs classic!",
 cat:"cars"},
{k:["bike customisation","custom motorcycle","cafe racer","scrambler bike"],
 r:"Motorcycle customisation styles: 🏍️ **Café Racer** — low handlebars, stripped down, speed focus. **Scrambler** — rugged, off-road ready, round headlight. **Bobber** — lowered, minimal fenders, solo seat. **Chopper** — extended front fork, custom frame. Each has its own distinct aesthetic — ZenPin\'s Bikes section shows them all!",
 cat:"bikes"},
{k:["how to make moodboard","pinterest board","inspiration board","aesthetic collection"],
 r:"Build a ZenPin inspiration board: 📌 1. Go to Boards → Create new board. 2. Give it a theme name. 3. Browse categories and save anything that resonates. 4. Aim for 20-30 images before judging. 5. Patterns emerge naturally — colours, textures, moods. Your board tells you what your aesthetic actually is!"},
{k:["outfit color combinations","what colors go together","colors that match","outfit palette"],
 r:"Outfit colour combos that always work: 👗 **Navy + white + tan** = classic preppy. **Black + camel + gold** = elevated minimal. **Olive + rust + cream** = earthy boho. **Grey + burgundy + black** = smart casual. **White + denim + any colour** = summer safe. Stick to 3 colours per outfit maximum!"},
{k:["photo editing tips","how to edit photos","lightroom tips","photo presets"],
 r:"Photo editing fundamentals: 🎨 1. Correct exposure before anything else. 2. Fix white balance for accurate colours. 3. Lift shadows slightly to reveal detail. 4. Reduce highlights to recover sky. 5. Add a gentle S-curve for contrast. 6. Sharpen last, at full zoom. Less is more — if you notice the edit, it\'s too heavy!"},
{k:["what is my aesthetic","find my aesthetic","aesthetic quiz","what aesthetic am i"],
 r:"Find your aesthetic: 🔍 Look at what you\'ve saved or liked on ZenPin — patterns emerge. Are you drawn to dark and moody? You might be dark academia or gothic. Bright and minimal? Scandinavian or clean girl. Warm and textured? Cottagecore or boho. Your saves don\'t lie — browse your profile collection!"},
{k:["ai art","ai generated images","how to make ai art","stable diffusion","midjourney"],
 r:"AI image generation tips: 🤖 Write descriptive prompts (style + subject + lighting + mood). Example: \'cinematic shot of a red motorcycle on a mountain road, golden hour, shallow depth of field, dramatic\'. Add artist style references for better results. Use ZenPin images as visual references for your prompt style!"},

  // ── Emotions & wellbeing ─────────────────────────────────────
  {k:["i am sad","i feel sad","i'm sad","feeling down","i feel bad","i'm upset","i'm unhappy"],
   r:"I'm really sorry to hear that 💙 Sometimes browsing beautiful imagery can be a gentle mood lift. Take your time. If you want, I can show you some calming nature or scenery ideas — or just chat with me for a bit."},
  {k:["i am happy","i'm happy","i feel great","i'm excited","great day","feeling good","so happy"],
   r:"That's wonderful! 🎉 Happiness is contagious. Come share the energy by exploring some inspiring ideas — what would you like to discover today?"},
  {k:["i am bored","i'm bored","nothing to do","so bored","bored af"],
   r:"Boredom is just creativity waiting to be unlocked! 🎨 Try browsing a category you've never explored before. How about architecture, anime, or interior design? Something will spark your imagination!"},
  {k:["i am lonely","i feel lonely","i'm lonely","no friends","feeling alone"],
   r:"You're not alone here 💙 ZenPin is a community of creative people just like you. Browse, save ideas, and you might find your people. What interests you most — fashion, gaming, art?"},
  {k:["i am stressed","i'm stressed","so stressed","feeling overwhelmed","too much stress"],
   r:"Take a deep breath 🌿 Scrolling through beautiful imagery is genuinely therapeutic. Try ZenPin's nature or scenery sections — looking at peaceful landscapes actually reduces cortisol. Want me to show you some?",
   cat:"scenery"},
  {k:["i am tired","i'm tired","so tired","feeling exhausted","no energy"],
   r:"Rest is productive too ✨ When you have energy again, come back and I'll help you find ideas that inspire you. For now, maybe browse some cosy interior or workspace designs — something warm and comforting.",
   cat:"interior"},
  {k:["i love zenpin","zenpin is amazing","zenpin is great","love this app","this is cool"],
   r:"That means everything to us! 🤍 ZenPin is built with love for creative people. Tell a friend and help the community grow! What can I help you discover today?"},
  {k:["i hate zenpin","zenpin is bad","zenpin sucks","not working","site is broken"],
   r:"I'm sorry about that! 😔 Please tell me what's not working and I'll do my best to help. For technical issues, try hard-refreshing the page (Ctrl+Shift+R) or clearing your browser cache first."},

  // ── Confidence & motivation ────────────────────────────────────
  {k:["i am not good enough","i'm not talented","i can't do this","i give up","not creative enough"],
   r:"Everyone starts somewhere, and creativity is a skill — not a gift 💪 The most talented designers once felt exactly how you do. Browse ZenPin for inspiration, save what moves you, and start small. One idea a day changes everything."},
  {k:["how do i start","where do i start","i don't know where to begin","lost","overwhelmed","too many options"],
   r:"Start with ONE thing that genuinely excites you 🌟 Browse a category that interests you most, save 5 images you love, and look for the pattern. That pattern is your aesthetic. Go from there — everything else follows."},
  {k:["give me confidence","how to be confident","confidence tips","more confidence"],
   r:"Confidence tip: 💪 Wear clothes that make you feel powerful. Master one skill deeply. Stand tall — posture affects mood. Celebrate small wins. Surround yourself with inspiring things (ZenPin helps with that!). And remember: confidence is built, not born."},

  // ── Friendship & relationships ────────────────────────────────
  {k:["how to make friends","i have no friends","making friends","finding friends","social tips"],
   r:"Making friends as an adult: 🤝 Join a class or club (pottery, coding, fitness). Be the one who follows up. Ask genuine questions and actually listen. Shared interests matter — creative communities like this one are great for meeting like-minded people!"},
  {k:["relationship advice","love advice","dating tips","how to find love"],
   r:"Relationship wisdom: ❤️ Be genuinely interested in the other person. Share your actual personality early. Consistency builds trust. Listen more than you talk. And build a life you love independently — attractive people are people who love their own life!"},
  {k:["gift ideas for girlfriend","gift for boyfriend","romantic gift","anniversary gift","birthday gift ideas"],
   r:"Romantic gift ideas: 🎁 **Experiences** beat objects every time (cooking class, concert, weekend trip). **Personalised** items show thought (custom illustration, engraved jewellery). **Their hobby** (gear, books, tools they've mentioned). **Handmade** always beats store-bought. Browse ZenPin's accessories section for jewellery inspiration!",
   cat:"accessories"},

  // ── Cars & bikes extended ─────────────────────────────────────
  {k:["best sports car","top sports cars","fastest car","dream car","luxury car"],
   r:"Dream cars: 🚗 **Supercar** → Lamborghini Huracán, Ferrari SF90, McLaren 720S. **GT** → Porsche 911, Aston Martin DB11. **Accessible performance** → Porsche Cayman, Toyota GR86, Mazda MX-5. **Electric** → Tesla Model S Plaid, Rimac Nevera. Check ZenPin's Cars section for visual inspiration!",
   cat:"cars"},
  {k:["how to maintain bike","motorcycle maintenance","bike care tips","bike service"],
   r:"Motorcycle maintenance basics: 🔧 1. Check tyre pressure weekly. 2. Change oil every 3,000-5,000 km. 3. Inspect brakes monthly. 4. Keep chain clean and lubed. 5. Check all lights before every ride. 6. Wash with motorcycle-specific products. A well-maintained bike is a safe bike!"},
  {k:["electric motorcycle","electric bike","ev motorcycle","electric motorbike"],
   r:"Electric motorcycles worth knowing: ⚡ Zero SR/F (fastest charging), Energica Ego (Italian premium), Harley-Davidson LiveWire (iconic brand), BMW CE-04 (urban futurism), Kawasaki Ninja e-1 (beginner friendly). The tech is improving fast — great time to be interested in EVs!",
   cat:"bikes"},

  // ── Anime extended ────────────────────────────────────────────
  {k:["best anime","top anime","must watch anime","anime to watch","recommend anime show"],
   r:"Anime with stunning visual aesthetics: 🎌 **Demon Slayer** (breathtaking water/flame effects). **Your Name** (beautiful backgrounds). **Violet Evergarden** (cinematic drama). **Spirited Away** (masterful world-building). **Jujutsu Kaisen** (dynamic action design). Browse ZenPin's Anime section for matching visual inspiration!",
   cat:"anime"},
  {k:["anime art style","draw like anime","anime illustration","anime inspired art"],
   r:"Anime art style essentials: ✏️ Large expressive eyes, simplified noses and mouths, detailed hair, dramatic lighting, speed lines for action, screen tones for texture. Key software: Clip Studio Paint (industry standard for manga/anime). Study by copying your favourite artist's panels — that's how pros learn.",
   cat:"anime"},
  {k:["anime merchandise","anime figure","figure collection","anime poster","anime decor"],
   r:"Anime merch tips: 🛒 Buy from official sources (Good Smile, Kotobukiya, Crunchyroll Store). Check review sites before buying figures. Funko Pops are entry-level — serious collectors prefer 1/8 or 1/7 scale PVC figures. Display behind glass to prevent dust. ZenPin's Anime section has room decoration ideas!",
   cat:"anime"},

  // ── Interior design extended ──────────────────────────────────
  {k:["small room ideas","decorate small room","small apartment ideas","tiny room","studio apartment"],
   r:"Small space solutions: 🏠 Mirrors make rooms feel 2× bigger. Wall-mounted shelves = no floor space used. Bed with storage underneath. Fold-away desk for WFH. Light, neutral walls. Vertical storage goes up, not out. Multi-function furniture (sofa bed, ottoman with storage). Less furniture = more space.",
   cat:"interior"},
  {k:["luxury interior","high end interior","expensive looking room","premium interior design"],
   r:"Luxury look without luxury prices: 💎 Crown moulding (cheap to add, high impact). Statement lighting (one dramatic pendant). Quality textiles (linen, velvet, real wool). Art above sofa (large piece, centred). Fresh flowers or quality faux plants. Everything white + one bold colour = classic luxury.",
   cat:"interior"},
  {k:["scandinavian design","nordic design","hygge","scandi style","minimalist nordic"],
   r:"Scandinavian design principles: 🌿 Functional beauty — every object must be useful. Natural materials (wood, linen, wool, stone). White walls with natural light. Minimal decoration. Quality over quantity. Candles and warm lighting. Plants everywhere. It's about feeling cosy and calm, not minimalism for its own sake.",
   cat:"interior"},

  // ── Fashion extended ──────────────────────────────────────────
  {k:["capsule wardrobe","minimal wardrobe","essentials wardrobe","what to wear","build wardrobe"],
   r:"Capsule wardrobe starter kit: 👗 White shirt (crisp). Black trousers (tailored). Dark wash jeans. Navy blazer. Grey or camel coat. White sneakers. Black ankle boots. 3 quality t-shirts (white, grey, black). These 10 items create 40+ outfits. Buy quality, buy less.",
   cat:"fashion"},
  {k:["how to dress for interview","interview outfit","professional outfit","smart casual"],
   r:"Interview outfit formula: 💼 **Formal** → dark suit, white shirt, tie (men) / tailored dress or suit (women). **Smart casual** → chinos + blazer (men) / blouse + trousers (women). Always pressed, clean shoes, minimal accessories. Dress one level above the company's culture. Confidence is the final accessory."},
  {k:["korean fashion","k-fashion","korean style","kdrama fashion","korean aesthetic"],
   r:"K-fashion essentials: 🇰🇷 Oversized blazers over mini skirts. Pastel coordinates. Platform shoes. Bucket hats. Layered necklaces. Clean minimalism meets bold detail. Key brands: Musinsa, W Concept, ADER Error. Korean beauty (K-beauty) completes the look. ZenPin's Fashion section has tons of K-style inspo!",
   cat:"fashion"},

  // ── Architecture extended ─────────────────────────────────────
  {k:["modern architecture","contemporary architecture","modern building","architectural styles"],
   r:"Modern architectural styles: 🏛️ **Minimalist** (Mies van der Rohe — less is more). **Parametric** (Zaha Hadid — flowing curves). **Brutalist** (raw concrete, bold mass). **Biophilic** (nature integrated). **Deconstructivist** (fragmented forms, Frank Gehry). ZenPin's Architecture section showcases all these styles!",
   cat:"architecture"},
  {k:["best buildings in world","famous buildings","iconic architecture","architectural wonders"],
   r:"Iconic architecture: 🌍 Sagrada Família (Gaudí, Barcelona). Sydney Opera House (Utzon). Burj Khalifa (Adrian Smith, Dubai). The Shard (Renzo Piano, London). CCTV Headquarters (Rem Koolhaas, Beijing). Guggenheim Bilbao (Frank Gehry). Each changed what we thought buildings could be.",
   cat:"architecture"},

  // ── Nature & scenery extended ─────────────────────────────────
  {k:["best travel destinations","places to visit","where to travel","travel ideas","dream vacation"],
   r:"Visually stunning destinations: 🌍 Santorini (iconic blue domes). Kyoto in cherry blossom season. Patagonia (dramatic mountains). Maldives (crystal lagoons). Morocco (intricate architecture). Iceland (aurora + geothermal). New Zealand (LOTR landscapes). Scotland's Highlands. Each one a photographer's dream.",
   cat:"scenery"},
  {k:["forest photography","outdoor photography","landscape photography tips","nature photo ideas"],
   r:"Landscape photography: 📸 Shoot at golden hour (1 hour after sunrise, 1 hour before sunset). Use a polarising filter for richer skies. Include foreground interest. Find leading lines (path, river, fence). Wait for the right light — patience is the most important piece of gear.",
   cat:"nature"},

  // ── Gaming extended ───────────────────────────────────────────
  {k:["best gaming pc","build gaming pc","gaming computer","pc gaming build","gaming rig"],
   r:"Gaming PC build tiers: 🖥️ **Budget £500** → AMD Ryzen 5 + RX 6600. **Mid £800** → Ryzen 7 5700X + RTX 3070. **High-end £1400** → Core i7-13700K + RTX 4080. Key rule: GPU = 40% of budget. Don't skimp on PSU (quality power supply). ZenPin's Gaming section has setup inspiration!",
   cat:"gaming"},
  {k:["rgb lighting","rgb setup","led lighting desk","cool gaming lights"],
   r:"RGB lighting tips: 🌈 Bias lighting behind monitor reduces eye strain. Underglow on desk creates floating effect. Match your peripheral colours to wallpaper. Less is more — consistent colour beats rainbow chaos. Govee or Philips Hue for smart control. LED strips at £10 make a huge visual difference.",
   cat:"gaming"},

  // ── Superhero & art extended ──────────────────────────────────
  {k:["comic book art","comic art style","how to draw comics","manga vs comics"],
   r:"Comics vs manga art: 🦸 **Western comics** → bold lines, heavy shading, muscular proportions, dynamic perspective. **Manga** → lighter lines, large eyes, more expressive emotion, screentone textures. Starting tip: copy existing panels to learn how masters handle anatomy, perspective and page composition.",
   cat:"superhero"},
  {k:["art supplies","what art supplies to buy","best art materials","drawing supplies for beginners"],
   r:"Beginner art supplies worth buying: 🎨 Mechanical pencil (0.5mm). Uni Pin fineliner set. Pentel Aquash water brush. Winsor & Newton cotman watercolours. Moleskine sketchbook. Procreate on iPad (if digital). Start with pencil and one medium — master the basics before collecting supplies.",
   cat:"art"},
  {k:["graphic design tips","how to design","graphic design basics","design for beginners"],
   r:"Graphic design fundamentals: 📐 **Hierarchy** — guide the eye. **Alignment** — nothing arbitrary. **Contrast** — make important things pop. **Repetition** — consistency creates brand. **Proximity** — related items together. Learn Canva free, then move to Figma (free) or Adobe Illustrator. Steal like an artist — study what you love."},

  // ── Workspace extended ────────────────────────────────────────
  {k:["home office setup","work from home setup","wfh setup","remote work setup","office desk"],
   r:"Home office essentials: 💻 Ergonomic chair (non-negotiable). Monitor at eye level. External keyboard and mouse. Good webcam and microphone for calls. Warm lighting (3000K bulbs). Noise-cancelling headphones. Room divider if in shared space. Separate work/home spaces helps your brain switch modes.",
   cat:"workspace"},
  {k:["productivity apps","best apps for productivity","tools for work","work apps","task management"],
   r:"Productivity tools that actually work: ⚡ **Notion** (knowledge base + tasks). **Todoist** (simple task manager). **Obsidian** (note-taking). **Linear** (engineering tasks). **Loom** (async video). **Raycast** (app launcher, Mac). **1Password** (password manager). Pick ONE task tool and commit — switching costs focus."},

  // ── Accessories & pets ────────────────────────────────────────
  {k:["watch recommendations","best watches","watch buying guide","men's watch","women's watch"],
   r:"Watch guide: ⌚ **Entry luxury** → Seiko, Orient, Hamilton. **Mid** → Tissot, Longines, Omega Seamaster (dress). **High-end** → Rolex Submariner, Patek Philippe (investments). **Smart** → Apple Watch Ultra (health features). A classic steel dress watch goes with everything. ZenPin's Accessories section has visual inspiration!",
   cat:"accessories"},
  {k:["dog breeds","best dog","choosing a dog","first dog","dog for family","what dog should i get"],
   r:"Choosing a dog: 🐕 Match to your lifestyle. **Active** → Border Collie, Vizsla. **Family** → Golden Retriever, Labrador. **Apartment** → French Bulldog, Pug, Shih Tzu. **Low maintenance** → Basenji, Greyhound. Rescue first — millions of wonderful dogs need homes. Research breed-specific health issues before buying.",
   cat:"pets"},
  {k:["cat care","cat tips","how to take care of cat","first cat","getting a cat"],
   r:"Cat care basics: 🐱 Litter box: 1 per cat + 1 extra. Vet check within first week. Microchip and vaccinate. Scratch post (saves furniture). Interactive play daily (15 min minimum). High-quality wet food beats dry-only. Keep indoors for safety and longer life. Cats are independent but need attention and enrichment.",
   cat:"pets"},

  // ── Food & cooking ────────────────────────────────────────────
  {k:["meal prep ideas","meal planning","how to meal prep","prep for the week","healthy meal prep"],
   r:"Meal prep guide: 🍱 Choose 1 protein, 2 carbs, 3 vegetables. Cook Sunday, eat all week. Batch-cook grains (rice, quinoa, oats). Marinate proteins overnight. Use glass containers for freshness. Label with date. Prep sauces separately to avoid soggy meals. Start with just 3 meals — don't over-commit."},
  {k:["baking tips","how to bake","baking for beginners","cake recipe","baking advice"],
   r:"Baking basics: 🧁 Always weigh ingredients (volume is unreliable). Room temperature butter and eggs matter. Don't open the oven in the first 75% of bake time. Underbake slightly — carryover cooking finishes the job. Cool completely before icing. Baking is science: follow the recipe exactly until you understand the chemistry."},

  // ── Life & random conversation ────────────────────────────────
  {k:["tell me a joke","make me laugh","say something funny","joke please"],
   r:"Why did the designer go broke? Because he had too many layers and not enough assets! 😄 ...I'll stick to design advice."},
  {k:["what time is it","what day is it","current time","todays date"],
   r:"I don't have access to real-time data like a clock, but your device's clock is always in the corner! ⏰ What I CAN help with: creative ideas, design questions, or ZenPin image browsing!"},
  {k:["random fact","tell me something interesting","fun fact","did you know","surprise me"],
   r:"Fun fact: 🌟 The Eiffel Tower grows about 15cm taller in summer due to thermal expansion of the iron. Also, the mantis shrimp can punch with the force of a bullet and sees 16 types of colour receptors (humans have 3). Nature is extraordinary — much like ZenPin's scenery collection!"},
  {k:["favourite color","what is your favorite color","favorite colour","best colour"],
   r:"If I had a favourite colour, I'd say deep purple — the colour of creativity, mystery and luxury 💜 It's also ZenPin's brand colour! What's yours? I can show you images that match any colour palette."},
  {k:["can you help me","need help","i need help","help me","need assistance"],
   r:"Absolutely — that's exactly what I'm here for! 🤝 Just tell me what you need: finding images, design advice, a creative idea, how to use ZenPin, or even just a chat. What's on your mind?"},
  {k:["do you have feelings","are you sentient","do you think","are you alive","do you understand"],
   r:"I'm an AI — I process, I respond, I match patterns 🤖 I don't feel in the way you do, but I'm designed to be genuinely helpful and to understand context. I find (in my computational way) that creative conversations are the most interesting! What would you like to explore?"},
  {k:["what is the meaning of life","why are we here","purpose of life","meaning of existence"],
   r:"That's the great question! Philosophers have wrestled with it forever 🌌 Some say connection, others say creation, others say experience. My perspective: people who make things tend to feel most alive. Maybe that's why creative platforms like ZenPin exist — to help people make and share."},
  {k:["i want to learn something new","what should i learn","learn new skill","new hobby ideas","hobby recommendations"],
   r:"Skills and hobbies worth starting: 🎯 **Visual** → photography, illustration, embroidery, pottery. **Technical** → coding (Python), woodworking, electronics. **Physical** → climbing, swimming, dancing, archery. **Creative** → writing, music production, ceramics. Pick something that scares you slightly — that's usually the right choice."},

  // ── Dashboard / page help ─────────────────────────────────────
  {k:["dashboard not working","dashboard blank","dashboard broken","why is dashboard not working"],
   r:"If your Dashboard is blank, you are likely not signed in 🔑 Click Sign In in the navbar, log in with your email and OTP code, and your Dashboard will show your posts, saves and boards. If you ARE signed in and still see nothing, try refreshing the page."},
  {k:["boards not working","boards blank","boards broken","cannot see boards","boards page"],
   r:"Your Boards page shows your saved collections 📌 You need to be signed in to see them. Sign in first, then click Boards in the navbar. If you see 'Sign in to see your boards', that means your session expired — log in again!"},
  {k:["collaboration not working","collab page","collab broken","collab help"],
   r:"The Collaboration page 🤝 lets you chat with other ZenPin users and get AI-powered ideas together. Sign in first to unlock collab features. The AI chat at the bottom of the page is always available even when logged out!"},
  {k:["how to save ideas","save idea","save image","how do i save","bookmark"],
   r:"Saving ideas on ZenPin is easy ❤️ Just click the heart icon on any image card. You need to be signed in first. Your saved ideas appear in your Profile → Saved tab. You can also add ideas to specific Boards!"},
  {k:["how to create board","create board","new board","make a board","add board"],
   r:"To create a Board 📋 Go to the Boards page and click the + Create Board button. Give it a name and description, then start adding images from your feed. Boards are great for organising ideas by theme or project!"},
  {k:["what is dashboard","what does dashboard do","dashboard features"],
   r:"Your Dashboard 📊 shows your ZenPin activity at a glance — posts you've created, ideas you've saved, boards you've made, and your most-liked content. It's your creative portfolio overview. Sign in to access it!"},
  {k:["ai not working","chat not working","ai broken","ai not responding","why ai not working"],
   r:"If the AI chat isn't responding, the backend server may be waking up (Render free tier sleeps after 15 minutes) ⏱️ Wait 20-30 seconds and try again. If it still doesn't respond, your fallback brain is always available for common questions!"},
  {k:["why is site slow","site slow","loading slow","takes long to load"],
   r:"ZenPin runs on Render's free tier which sleeps after 15 minutes of inactivity 💤 The first request after sleep takes 20-40 seconds to wake up. After that, everything runs normally! This is normal for the free hosting plan."},

  // ── Specific category queries ──────────────────────────────────
  {k:["superheroes","superhero ideas","marvel ideas","dc ideas","comic book ideas","avengers"],
   r:"Check out ZenPin's Superhero collection! 🦸 Marvel, DC, anime heroes and beyond — perfect for costume ideas, room decor, fan art inspiration and more.",
   cat:"superhero"},
  {k:["architecture ideas","building designs","modern architecture","house design ideas"],
   r:"Explore stunning architecture on ZenPin! 🏛️ From brutalist towers to glass minimalism, our Architecture collection has every style from around the world.",
   cat:"architecture"},
  {k:["interior ideas","room decoration","home decor","living room ideas","bedroom ideas","home design"],
   r:"Transform your space with ZenPin's Interior Design collection! 🏠 Minimalist, cosy, luxury, industrial — find the aesthetic that matches your personality.",
   cat:"interior"},
  {k:["food ideas","meal ideas","recipe inspiration","food photography","food styling"],
   r:"Get inspired by ZenPin's Food collection! 🍽️ From stunning plating to street food photography, find ideas for your next dish or food project.",
   cat:"food"},
  {k:["pet ideas","cute pets","animal photos","dog ideas","cat ideas","pet photography"],
   r:"Meet ZenPin's adorable Pets collection! 🐾 Dogs, cats, birds and more — perfect for pet portraits, cute moments and animal lover inspiration.",
   cat:"pets"},
  {k:["workspace ideas","office setup","desk setup","home office","study setup"],
   r:"Level up your workspace with ZenPin! 💻 Clean minimal desks, RGB gaming setups, cosy home offices — find your perfect productivity aesthetic.",
   cat:"workspace"},
  {k:["scenery ideas","landscape photos","travel photography","beautiful views","nature photography"],
   r:"Escape into ZenPin's Scenery collection! 🌅 Stunning landscapes, golden hour shots, mountain vistas and ocean horizons await.",
   cat:"scenery"},

  // ── More conversation ──────────────────────────────────────────
  {k:["what is your name","your name","name please","do you have a name"],
   r:"I'm ZenPin AI ✨ — your creative discovery assistant! I help you find images, answer design questions, get craft inspiration and navigate the ZenPin platform. What can I help you explore today?"},
  {k:["how do you work","how do you think","how are you made","what are you built with"],
   r:"I combine a built-in knowledge base about ZenPin's content with connections to the Gemini AI API 🤖 When the backend is available, I can give richer answers. When it's not, my fallback brain handles common questions instantly!"},
  {k:["tell me more","tell me something","talk to me","say something","chat with me"],
   r:"I'd love to chat! 💬 Ask me about any of ZenPin's 15 image categories, get design inspiration, learn about craft techniques, or just say hello. What's on your mind today?"},
  {k:["i love it","this is great","amazing","wonderful","fantastic","love this"],
   r:"Thank you so much! 🌟 That truly means a lot. If you have any suggestions for how ZenPin could be even better, feel free to share them. Now — what creative ideas can I help you find?"},
  {k:["how do i discover","discover ideas","find inspiration","how to use zenpin","getting started"],
   r:"Welcome to ZenPin! 🎉 Start by clicking any category chip (Cars, Bikes, Anime...) to see curated images. Save ones you love with the ❤️ button. Create Boards to organise them. Use the AI chat (you're doing it right now!) for specific ideas. Have fun exploring!"},
  {k:["what categories are there","what can i browse","what is available","categories list"],
   r:"ZenPin has 15 curated categories: 🚗 Cars · 🏍️ Bikes · 🎌 Anime · 👗 Fashion · 💍 Ladies Accessories · 🏛️ Architecture · 🎨 Art · 🍽️ Food · 🎮 Gaming · 🏠 Interior Design · 🌿 Nature · 🐾 Pets · 🌅 Scenery · 🦸 Superheroes · 💻 Workspace"},
  {k:["how to change profile","update profile","edit my profile","change username","change avatar"],
   r:"To edit your profile 👤 Click your profile avatar in the top-right navbar, navigate to your Profile page, then click the Edit Profile button. You can change your username, bio, location and social links. Your changes save instantly!"},
  {k:["how to logout","sign out","log out","how to sign out"],
   r:"To sign out 👋 Click your profile avatar in the navbar, then click the Logout button. You'll be returned to the homepage. Your saves and boards will still be there when you sign back in!"},
  {k:["how to upload","upload my own image","post image","share my work","create post"],
   r:"To share your creative work 📸 Click the ✦ Create button in the navbar. Upload an image (or paste a URL), add a title, pick a category, and write a description. Your post will appear in the community feed!"},
  {k:["can i download","download image","save to my phone","save to computer"],
   r:"To download an image 💾 Click any image card to open it, then click the Download button (⬇️ icon). The image will save to your device. Please respect creators' rights and credit the source when sharing!"},
  {k:["dark mode","light mode","theme","change theme","how to change theme"],
   r:"ZenPin automatically matches your system's dark/light mode preference 🌙☀️ To switch, change your operating system's display settings. We're working on an in-app theme toggle for a future update!"},
  {k:["mobile app","app download","ios app","android app","zenpin app"],
   r:"ZenPin currently runs as a progressive web app 📱 You can add it to your home screen! On mobile Chrome, tap the menu (⋮) and select 'Add to Home Screen'. On Safari, tap the Share icon and choose 'Add to Home Screen'. It works just like a native app!"},
  {k:["search images","how to search","find image","look for","search for"],
   r:"To search ZenPin 🔍 Use the search bar in the navbar to search by keyword, or use the AI Chat and ask me! For example: 'show me red sports cars' or 'find minimalist workspace ideas'. Category chips also let you browse specific themes instantly."},
  {k:["report bug","bug report","found a bug","something broken","report problem"],
   r:"Thank you for reporting! 🐛 Please use the feedback form in your Profile settings, or describe the issue to me and I'll note it. Screenshots help! We're continuously improving ZenPin based on user feedback."},
  {k:["privacy","data","my data","how is my data used","security"],
   r:"Your privacy matters to us 🔒 ZenPin stores only your email, username, and content you deliberately create. We never sell your data. Passwords are bcrypt-hashed. Sessions use JWT tokens that expire. For details, check our privacy policy in the footer."},
  {k:["free plan","pricing","cost","how much","paid"],
   r:"ZenPin is completely free to use! 🎉 Browse, save, create boards, use AI chat — all at no cost. We may introduce optional premium features in the future, but the core experience will always be free."},
  {k:["inspire me","random inspiration","something creative","give me ideas"],
   r:"Here's your creative spark! 💡 Pick a material you have nearby (wood, fabric, clay, wire) and combine it with your favourite ZenPin category. A wooden motorcycle sculpture? Fabric anime panel? Wire car model? The constraint creates the creativity!"},
  {k:["i feel creative","feeling creative","ready to create","let's create","want to make something"],
   r:"YES! Let's channel that energy 🔥 Open ZenPin's Explore page, filter by your favourite category, and save everything that excites you — aim for 20+ images. Then look at what connects them. That pattern is your project. Go!"},
  {k:["nature vs interior","anime vs fashion","which category","help me choose"],
   r:"Both are incredible in their own way! 🌟 My suggestion: look at both categories side by side and notice which images make you feel something stronger. Your gut reaction is always right. What are you comparing?"},
  {k:["vintage aesthetic","retro style","old school","vintage vibe"],
   r:"The vintage aesthetic! 🎞️ Warm amber tones, grain textures, imperfect edges. Try combining ZenPin's Art and Fashion categories for vintage-inspired ideas. Key colours: terracotta, rust, cream, forest green, burgundy."},
  {k:["futuristic aesthetic","cyberpunk","sci fi","neon","futurism"],
   r:"Cyberpunk/futuristic aesthetics 🌆 are dominated by neon blues and purples on dark backgrounds, holographic elements and tech-meets-nature contrast. Check ZenPin's Gaming and Architecture sections for amazing futuristic visual references!",
   cat:"gaming"},
  {k:["minimalist","minimalism","less is more","simple design","clean aesthetic"],
   r:"Minimalism philosophy: 🤍 Remove everything that doesn't need to be there. What remains should be both beautiful and functional. ZenPin's Workspace and Interior categories have stunning minimalist examples — clean lines, negative space, natural materials."},
  {k:["how to be consistent","creative consistency","daily practice","routine for creativity"],
   r:"Creative consistency secret: ⚡ Schedule it, don't wait for inspiration. 15 minutes of browsing ZenPin daily keeps your creative eye sharp. Keep a swipe file (save images that move you, even if you don't know why). Pattern emerges over months."},

  // ── Final 12 entries (reaches 200) ───────────────────────────
  {k:["what colors go with black","black outfit","all black look","black aesthetic"],
   r:"All-black outfits: 🖤 Add texture contrast (leather + knit, silk + denim). Break it with one metallic accessory (silver or gold). White sneakers pop beautifully against all-black. For room decor, black walls with warm amber lighting and wood accents create dramatic luxury.",
   cat:"fashion"},
  {k:["pink aesthetic","pink room","pink decor","pink fashion","girly aesthetic"],
   r:"Pink aesthetic guide: 🌸 Dusty rose + cream + gold = elegant. Hot pink + white + chrome = bold. Blush + terracotta + linen = earthy. For rooms: white furniture, fairy lights, arch mirrors, and dried pampas grass. For fashion: tonal pink outfits with nude accessories.",
   cat:"fashion"},
  {k:["earth tone","earthy colors","warm tones","terracotta","rust color","warm palette"],
   r:"Earth tone palette: 🌍 Terracotta, rust, burnt sienna, ochre, warm taupe, olive green, warm cream. These colours work in any combination and never clash. Ground them with dark wood and natural linen. ZenPin's Interior and Fashion sections have stunning earth tone examples!"},
  {k:["how to find my style","personal style","aesthetic quiz","discover my aesthetic"],
   r:"Discover your aesthetic: 🔍 Open ZenPin's Explore page and save everything that resonates — aim for 30+ images without overthinking. Then look at what connects them: colours, textures, moods. That pattern IS your style. Your saves tell you more than any quiz!"},
  {k:["beginner photography","photography for beginners","how to start photography","photo tips beginner"],
   r:"Photography beginner tips: 📸 Start with your phone — the best camera is the one you have. Learn the rule of thirds (imagine a 3×3 grid, place subjects at intersections). Shoot in natural light. Move your feet instead of zooming. Edit lightly. Take 100 bad photos to get 1 great one.",
   cat:"scenery"},
  {k:["typography tips","font pairing","which fonts go together","font combination"],
   r:"Font pairing that works: 🔤 Pair one serif + one sans-serif (e.g. Playfair + Inter). Use max 3 fonts per design. Display fonts for headings only. Body text should be highly readable at 16px+. Establish hierarchy: heading > subheading > body > caption. Size difference matters more than font choice."},
  {k:["wall art ideas","gallery wall","wall decor","how to decorate walls"],
   r:"Gallery wall guide: 🖼️ Lay your pieces on the floor first and arrange before hanging. Mix frame sizes and styles (some framed, some unframed). Use paper templates on the wall to plan spacing. Leave 2-3 inches between pieces. Start from the centre and work outward. Include one piece that surprises you.",
   cat:"art"},
  {k:["succulent care","plant beginner","easy plants","houseplant tips","low maintenance plants"],
   r:"Easiest houseplants: 🌱 Pothos (grows anywhere, forgives neglect). Snake plant (water once a month). ZZ plant (thrives in low light). Aloe vera (only water when bone dry). Spider plant (self-propagates!). Golden rule: most plants die from overwatering — when in doubt, don't water."},
  {k:["social media aesthetic","instagram feed","consistent feed","cohesive feed","instagram theme"],
   r:"Consistent Instagram feed: 📱 Choose 3 anchor colours and stick to them. Edit ALL photos with the same preset. Alternate between busy and simple photos. Plan your grid 9 photos ahead (Later app helps). Your bio = hook + what you post + call to action. Post for your niche, not for everyone.",
   cat:"fashion"},
  {k:["handmade gifts","diy gift ideas","personalised gift","homemade gift"],
   r:"Handmade gift ideas that feel premium: 🎁 Hand-poured soy candle with custom label. Embroidered tote bag (beginner-friendly). Clay earrings (air-dry clay, no kiln needed). Pressed flower bookmark or card. Macramé plant hanger. Photo book from Chatbooks or Artifact Uprising. Time and thought > price."},
  {k:["creative block","stuck creatively","no ideas","creative burnout","can't think of anything"],
   r:"Break creative block: 💡 1. Change location (café, park, different room). 2. Consume instead of create for 30 min (browse ZenPin!). 3. Set a 10-minute constraint challenge. 4. Work on something unrelated. 5. Go for a walk — movement literally reorganises thinking. 6. Lower the stakes: make something deliberately bad."},
  {k:["how to relax","relaxing ideas","unwind","chill out","stress relief","calm down activities"],
   r:"Genuine relaxation: 🌿 Progressive muscle relaxation (tense then release each body part). Nature sounds or binaural beats. Slow journaling with no agenda. Warm bath with magnesium salts. Creative doodling with no goal. Cooking a familiar recipe. ZenPin browsing with a warm drink 🍵 — calm and inspiring.",
   cat:"scenery"},
];
const CAT_KEYWORDS = {
  bikes:       ["bike","motorcycle","motorbike","two wheel","superbike","cruiser"],
  cars:        ["car","automobile","vehicle","supercar","sports car","sedan","suv","black car"],
  anime:       ["anime","manga","otaku","animation","japanese cartoon","anime room","waifu"],
  fashion:     ["fashion","outfit","clothing","clothes","dress","style","wardrobe","wear"],
  accessories: ["accessor","jewelry","jewellery","earring","necklace","bracelet","handbag","bag","watch","ring"],
  architecture:["architect","building","structure","skyscraper","facade","bridge","tower","house exterior"],
  art:         ["art","painting","illustration","digital art","sketch","drawing","artwork"],
  food:        ["food","recipe","dish","cooking","cuisine","meal","restaurant","plating"],
  gaming:      ["gaming","gamer","game","esport","pc setup","console","rgb","gaming room"],
  interior:    ["interior","room","decor","living room","bedroom","home decor","furniture","cosy"],
  nature:      ["nature","landscape","forest","mountain","ocean","waterfall","sky","leaf","tree"],
  pets:        ["pet","dog","cat","puppy","kitten","animal","cute animal","fur"],
  scenery:     ["scenery","scenic","travel","landscape photo","beautiful place","view","horizon"],
  superhero:   ["superhero","marvel","dc","batman","spiderman","iron man","hero","comic"],
  workspace:   ["workspace","desk","office","home office","setup","monitor","laptop desk"],
};

function detectCategory(msg) {
  const low = msg.toLowerCase();
  for (const [cat, kws] of Object.entries(CAT_KEYWORDS)) {
    if (kws.some(kw => low.includes(kw))) return cat;
  }
  return null;
}

function brainLookup(msg) {
  const clean = msg.toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim();
  const words  = new Set(clean.split(/\s+/).filter(w => w.length > 1));
  let best = null, bestScore = 0;
  for (const entry of BRAIN) {
    for (const trigger of entry.k) {
      // Check substring match OR word overlap
      if (clean.includes(trigger)) return entry;
      const tWords = trigger.split(" ");
      const overlap = tWords.filter(w => words.has(w)).length;
      const score   = overlap / tWords.length;
      if (score > 0.65 && score > bestScore) {
        bestScore = score; best = entry;
      }
    }
  }
  return bestScore > 0.65 ? best : null;
}

function setupChat() {
  // Selectors match actual HTML IDs (chatInput/chatSendBtn/chatMsgs in page-collab)
  const input  = $("chatInput");
  const send   = $("chatSendBtn");
  const msgs   = $("chatMsgs");
  if (!input) { console.warn("[ZenPin] AI: chatInput not found in DOM"); return; }
  if (!send)  { console.warn("[ZenPin] AI: chatSendBtn not found in DOM"); return; }
  if (!msgs)  { console.warn("[ZenPin] AI: chatMsgs not found in DOM"); return; }
  console.log("[ZenPin] chat input found");
  console.log("[ZenPin] chat send button found");




  // ── Category keyword → cache key mapping ─────────────────────


  // ── Fuzzy brain lookup ────────────────────────────────────────

  // ── Get 4 cards from a local category ────────────────────────
  function getCategoryCards(cat, count = 4) {
    if (!window._curatedCache || !window._curatedCache[cat]) {
      // Try to get from _curatedCache
      try {
        const all = getAllCuratedIdeas(cat);
        return all.slice(0, count);
      } catch (_) { return []; }
    }
    return [];
  }

  // ── DOM helpers ───────────────────────────────────────────────
  function appendMsg(role, html, ideas = []) {
    const wrap  = document.createElement("div");
    wrap.className = `chat-msg chat-msg-${role}`;
    const av    = document.createElement("div");
    av.className = "chat-av";
    av.textContent = role === "user" ? "Y" : "✦";
    const bub   = document.createElement("div");
    bub.className = "chat-bubble";
    bub.innerHTML  = html;

    if (ideas.length > 0) {
      const strip = document.createElement("div");
      strip.className = "chat-img-strip";
      ideas.slice(0, 6).forEach(idea => {
        const img = document.createElement("img");
        img.src     = idea.image_url || "";
        img.alt     = idea.title     || "";
        img.loading = "lazy";
        img.className = "chat-img-card";
        img.onclick = () => openModal(idea);
        img.onerror = () => { img.style.display = "none"; };
        strip.appendChild(img);
      });
      bub.appendChild(strip);
    }

    if (role === "user") { wrap.appendChild(bub); wrap.appendChild(av); }
    else                 { wrap.appendChild(av);  wrap.appendChild(bub); }
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function showTyping() {
    const el = document.createElement("div");
    el.id = "aiTyping";
    el.className = "chat-msg chat-msg-ai";
    el.innerHTML = `<div class="chat-av">✦</div><div class="chat-bubble"><div class="chat-typing"><span></span><span></span><span></span></div></div>`;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  // ── Format markdown-lite ──────────────────────────────────────
  function fmt(text) {
    return text
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/^## (.+)$/gm,    "<strong>$1</strong>")
      .replace(/^### (.+)$/gm,   "<strong>$1</strong>")
      .replace(/\n- /g,          "<br>• ")
      .replace(/\n\d+\. /g,      m => "<br>" + m.trim() + " ")
      .replace(/\n/g,            "<br>");
  }

  // ── Message history for multi-turn context ────────────────────
  const history = [];

  // ── Main send handler ─────────────────────────────────────────
  async function sendMsg() {
    const msg = input.value.trim();
    if (!msg) return;
    console.log(`[ZenPin] chat send triggered: "${msg.slice(0,50)}"`);
    input.value = "";
    appendMsg("user", escHtml ? escHtml(msg) : msg);
    history.push({ role: "user", content: msg });

    const typing = showTyping();

    let reply = "", ideaCards = [], poweredBy = "";

    try {
      // ── Step 1: Backend /ai/chat ─────────────────────────────
      const controller = new AbortController();
      const timeout    = setTimeout(() => controller.abort(), 20000);

      console.log("[ZenPin] backend AI request started");
      const res  = await fetch(`${API_URL}/ai/chat`, {
        method:  "POST",
        mode:    "cors",
        credentials: "omit",
        headers: { "Content-Type": "application/json",
                   ...(token() ? { Authorization: `Bearer ${token()}` } : {}) },
        body:    JSON.stringify({ message: msg, history: history.slice(-6) }),
        signal:  controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const resData = await res.json().catch(() => ({}));
        reply      = resData.answer   || "";
        ideaCards  = resData.ideas    || [];
        poweredBy  = resData.powered_by || "";
      }
    } catch (e) {
      console.log("[ZenPin] backend AI failed:", e?.message?.slice(0,60) || "unknown");
      const isAbort   = e?.name === "AbortError";
      const isNetwork = e?.message?.includes("Failed to fetch") || e?.message?.includes("NetworkError");
      poweredBy = isAbort || isNetwork ? "wakeup" : "error";
    }

    // ── Step 2: Brain fallback if backend gave nothing ───────────
    if (!reply || reply.trim().length < 3) {
      const hit = brainLookup(msg);
      if (hit) {
        console.log("[ZenPin] fallback brain used");
        reply     = hit.r;
        poweredBy = "brain";
        if (hit.cat) {
          try { ideaCards = getAllCuratedIdeas(hit.cat).slice(0, 6); } catch (_) {}
        }
      }
    }

    // ── Step 3: Category auto-detect → pull cards ───────────────
    if (!ideaCards.length) {
      const cat = detectCategory(msg);
      if (cat) {
        console.log(`[ZenPin] category detected: ${cat}`);
        try { ideaCards = getAllCuratedIdeas(cat).slice(0, 6); } catch (_) {}
        if (!reply || reply.length < 3) {
          reply = `Here are some ${cat} ideas from ZenPin! ✨`;
          poweredBy = "category";
        }
      }
    }

    // ── Step 4: Claude API fallback ──────────────────────────────
    if (!reply || reply.trim().length < 3) {
      try {
        const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 300,
            messages: [{ role: "user", content:
              `You are ZenPin AI, a creative assistant for a Pinterest-like site. ` +
              `Answer briefly and helpfully: ${msg}`
            }],
          }),
        });
        if (claudeRes.ok) {
          const cData = await claudeRes.json().catch(() => ({}));
          reply = cData?.content?.[0]?.text || "";
          poweredBy = "claude";
        }
      } catch (_) {}
    }

    // ── Step 5: Absolute final safe fallback ─────────────────────
    if (!reply || reply.trim().length < 3) {
      if (poweredBy === "wakeup") {
        reply = "The server is waking up (takes ~30 sec on first visit). Try again in a moment! ⏱️";
      } else {
        reply = "I'm having a little trouble right now, but I can still help you browse ideas. Try clicking a category in the filter bar, or ask me about bikes, anime, fashion or interior design! 🎨";
      }
      poweredBy = "safe";
    }

    // ── Render ───────────────────────────────────────────────────
    typing.remove();

    const formatted = fmt(reply);
    appendMsg("ai", formatted, ideaCards);
    console.log("[ZenPin] bot reply appended");
    history.push({ role: "assistant", content: reply.slice(0, 500) });

    // Powered-by badge (subtle)
    if (poweredBy && poweredBy !== "safe") {
      const badge = msgs.querySelector(".chat-msg-ai:last-child .chat-bubble");
      if (badge) {
        const labels = { gemini:"✦ Gemini", brain:"✦ ZenPin AI",
                         category:"✦ ZenPin", claude:"✦ Claude",
                         wakeup:"⏱ Server sleeping" };
        if (labels[poweredBy]) {
          const p = document.createElement("p");
          p.style.cssText = "font-size:0.68rem;color:var(--text-3);margin-top:8px;";
          p.textContent   = labels[poweredBy];
          badge.appendChild(p);
        }
      }
    }
  }

  send.onclick = sendMsg;
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); } });

  // Starter prompt chips
  const starters = $("chatStarters");
  if (starters) {
    starters.querySelectorAll("[data-starter]").forEach(btn => {
      btn.onclick = () => { input.value = btn.dataset.starter; sendMsg(); };
    });
  }
}

// ─────────────────────────────────────────────────────────────
// PAGE: AI GENERATOR
// ─────────────────────────────────────────────────────────────
async function initAI() {
  if (window.AIModule) AIModule.renderHistory($("aiHistoryList"));
}

async function runAI() {
  const topic = $("aiInput")?.value.trim();
  if (!topic) { $("aiInput")?.focus(); return; }

  $("aiOutput").style.display  = "none";
  $("aiLoading").style.display = "block";
  $("aiGenBtn").disabled       = true;

  try {
    const data = await apiFetch("POST", "/ai/generate", { topic });

    $("aiLoading").style.display = "none";
    $("aiOutput").style.display  = "block";

    // Title
    $("aiOutputTitle").textContent = `"${topic}"`;

    // Powered-by badge
    const badge = $("aiPoweredBadge");
    if (badge) {
      badge.textContent   = data.powered_by === "openai" ? "✨ GPT-4o" : "⚡ Smart Match";
      badge.style.display = "inline-flex";
    }

    // Render cards
    const ideas = data.ideas || [];
    renderGrid($("aiGrid"), ideas);

    // Color palette
    if (window.AIModule) {
      // Color palette
      const palette = AIModule.generatePalette(topic);
      AIModule.renderPalette(palette, $("aiPaletteWrap"));

      // Style tags as a simple label row
      const tags = AIModule.getStyleTags(topic);
      const styleEl = $("aiStyleCard");
      if (styleEl && tags.length) {
        styleEl.innerHTML = tags.map(t =>
          `<span style="background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.4);
            padding:4px 10px;border-radius:20px;font-size:12px;color:#c4b5fd">${t}</span>`
        ).join(" ");
        styleEl.style.display = "flex";
        styleEl.style.flexWrap = "wrap";
        styleEl.style.gap = "6px";
      }

      // Save to history
      AIModule.renderHistory($("aiHistoryList"));
    }

    toast(`✨ Board generated for "${topic}"`);

  } catch (e) {
    $("aiLoading").style.display = "none";
    toast("AI generation failed: " + e.message, true);
  } finally {
    $("aiGenBtn").disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────
// PAGE: PROFILE
// ─────────────────────────────────────────────────────────────
function fillProfileHeader(user) {
  const initial = (user.username || "?")[0].toUpperCase();
  if ($("profileAvatar"))  $("profileAvatar").textContent  = initial;
  if ($("profileName"))    $("profileName").textContent    = user.username || "Your Studio";
  if ($("profileHandle"))  $("profileHandle").textContent  = "@" + (user.username || "yourstudio").toLowerCase();
  if ($("profileBio"))     $("profileBio").textContent     = user.bio || "Visual thinker & creative explorer. Curating the world's best ideas.";
  if ($("epAvatarPreview")) $("epAvatarPreview").textContent = initial;
  // Member since
  if ($("profileJoined") && user.created_at) {
    const d = new Date(user.created_at);
    $("profileJoined").textContent = d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }
}

async function initProfile() {
  const user = getUser();
  if (!user) { navigate("home"); return; }
  fillProfileHeader(user);

  // Fetch real stats
  try {
    const promises = [apiFetch("GET", `/users/${user.id}/saves`)];
    if (isLoggedIn()) {
      promises.push(apiFetch("GET", "/boards"));
    } else {
      console.log("[ZenPin] no token found, skipping /boards");
      promises.push(Promise.resolve({ boards: [] }));
    }
    const [savedData, boardsData] = await Promise.allSettled(promises);
    const savedCount  = savedData.status  === "fulfilled" ? (savedData.value.ideas  || []).length : 0;
    const boardsCount = boardsData.status === "fulfilled" ? (boardsData.value.boards || []).length : 0;
    if ($("statSaved"))  $("statSaved").textContent  = savedCount;
    if ($("statBoards")) $("statBoards").textContent = boardsCount;
  } catch {}

  renderProfileTab(S.profileTab || "saved");
}

async function renderProfileTab(tab) {
  S.profileTab = tab;
  document.querySelectorAll(".profile-tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === tab)
  );
  const grid  = $("profileGrid");
  const empty = $("profileEmptyState");
  if (empty) empty.style.display = "none";
  grid.innerHTML = skeletonHTML(6);

  try {
    const user = getUser();
    if (!user) { grid.innerHTML = ""; return; }

    if (tab === "saved") {
      const data = await apiFetch("GET", `/users/${user.id}/saves`);
      const ideas = data.ideas || [];
      if ($("statSaved")) $("statSaved").textContent = ideas.length;
      if (!ideas.length) {
        grid.innerHTML = "";
        if (empty) empty.style.display = "flex";
        return;
      }
      renderGrid(grid, ideas);

    } else if (tab === "boards") {
      if (!isLoggedIn()) {
        console.log("[ZenPin] no token found, skipping /boards");
        if (grid) grid.innerHTML = `<div class="profile-empty-state" style="display:flex;grid-column:1/-1"><p>Sign in to load your boards.</p></div>`;
        return;
      }
      const { boards } = await apiFetch("GET", "/boards");
      if ($("statBoards")) $("statBoards").textContent = boards.length;
      if (!boards.length) {
        grid.innerHTML = `
          <div class="profile-empty-state" style="display:flex;grid-column:1/-1">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="color:#4b5563"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
            <p>No boards yet — create your first one!</p>
            <button class="btn-primary btn-sm" onclick="navigate('boards')">Go to Boards</button>
          </div>`;
        return;
      }
      grid.innerHTML = boards.map((b, i) => `
        <div class="idea-card" style="--i:${i};cursor:pointer" onclick="navigate('boards')">
          <div class="card-img-wrap" style="min-height:130px;background:linear-gradient(135deg,rgba(124,58,237,0.15),rgba(219,39,119,0.1));display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap;padding:12px">
            ${(b.preview_images||[]).slice(0,4).map(u =>
              `<img src="${u}" style="width:48%;height:55px;object-fit:cover;border-radius:6px" loading="lazy"/>`
            ).join("") || `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(124,58,237,0.5)" stroke-width="1.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`}
          </div>
          <div class="card-footer" style="flex-direction:column;align-items:flex-start;gap:3px;padding:12px 14px">
            <div style="font-weight:700;font-size:0.88rem;color:var(--text)">${b.name}</div>
            <div style="font-size:0.72rem;color:var(--text-3)">${b.idea_count||0} ideas${b.description ? " · " + b.description.slice(0,40) : ""}</div>
          </div>
        </div>`).join("");

    } else {
      // Created tab — ideas created by this user
      const { ideas: all } = await apiFetch("GET", `/ideas?limit=50`);
      const mine = all.filter(i => i.user_id === user.id || i.username === user.username);
      if ($("statIdeas")) $("statIdeas").textContent = mine.length;
      if (!mine.length) {
        grid.innerHTML = `
          <div class="profile-empty-state" style="display:flex;grid-column:1/-1">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="color:#4b5563"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
            <p>You haven't created any ideas yet.</p>
            <button class="btn-primary btn-sm" onclick="navigate('explore')">Get Inspired</button>
          </div>`;
        return;
      }
      renderGrid(grid, mine);
    }
  } catch (e) {
    grid.innerHTML = `<div class="load-error" style="grid-column:1/-1;padding:24px;color:var(--text-3);text-align:center">Could not load. <button onclick="renderProfileTab('${tab}')" style="color:var(--purple);cursor:pointer">Retry</button></div>`;
  }
}

// ─────────────────────────────────────────────────────────────
// PAGE: TRENDS
// ─────────────────────────────────────────────────────────────
function initTrends() {
  if (window.Trends) {
    Trends.renderTrendsGrid("trendsGrid");
  }
}

// ─────────────────────────────────────────────────────────────
// IDEA MODAL — fully connected to backend
// ─────────────────────────────────────────────────────────────
const STEPS_MAP = {
  "Interior Design": ["Choose neutral palette","Source natural materials","Plan furniture layout","Layer textures and lighting","Add plants and organic accents"],
  "Workspace":       ["Audit your current setup","Order core items first","Manage all cables","Set up monitor and lighting","Final arrangement and style"],
  "Architecture":    ["Site analysis and context","Develop concept sketches","Create floor plans","3D model and refine","Documentation and presentation"],
  "Art":             ["Gather references","Sketch thumbnail compositions","Prepare your surface","Block in major shapes","Refine, detail, and finish"],
  "Fashion":         ["Sketch design concepts","Select fabric and palette","Create pattern pieces","Sew and fit mockup","Final sewing and photography"],
  "Food":            ["Read full recipe","Mise en place preparation","Execute core technique","Taste and adjust seasoning","Plate and photograph"],
  "Travel":          ["Research location deeply","Scout spots on arrival","Shoot at golden hour","Review and cull shots","Edit and share the story"],
  "Nature":          ["Scout location beforehand","Arrive at blue hour","Set up camera carefully","Bracket exposures","Post-process in Lightroom"],
  "Tech":            ["Define requirements","Source components","Prototype on breadboard","Test and iterate","Final build and document"],
};

const TOOLS_MAP = {
  "Interior Design": ["Mood Board Kit","Paint Swatches","3D Planner","Fabric Samples","CAD Software"],
  "Workspace":       ["Monitor Arm","Cable Management Kit","LED Strip Lights","Desk Organizer","Anti-fatigue Mat"],
  "Architecture":    ["AutoCAD","Revit","SketchUp","Rhino 3D","Adobe InDesign"],
  "Art":             ["Procreate","Lino Cutter","Watercolor Set","Gesso + Canvas","Lightroom"],
  "Fashion":         ["Sewing Machine","Pattern Paper","Dressmaker's Scissors","Mannequin","Serger"],
  "Food":            ["Stand Mixer","Dutch Oven","Kitchen Scale","Bench Scraper","Instant Thermometer"],
  "Travel":          ["Sony A7 Camera","Tripod","ND Filter","Drone","Adobe Lightroom"],
  "Nature":          ["Macro Lens","Field Journal","Cable Release","Lightroom Classic","Waterproof Bag"],
  "Tech":            ["Soldering Iron","Oscilloscope","Arduino","3D Printer","Digital Multimeter"],
};

const DESC_MAP = {
  "Interior Design": "A thoughtfully curated space that balances aesthetics with function. Natural materials, intentional layering, and a restrained palette create an environment that feels calm and inspiring.",
  "Workspace":       "An optimised workspace designed for focus and creative output. Every element considered — from cable management to lighting temperature — creating conditions for deep work.",
  "Architecture":    "A bold architectural statement challenging conventional form. The interplay of light, material, and structure creates a space that rewards close observation.",
  "Art":             "An exploration of texture, form, and conceptual depth. Each mark carries deliberate intention, inviting dialogue between process and finished work.",
  "Fashion":         "A study in material consciousness and silhouette — exploring the tension between structure and flow, comfort and presence.",
  "Food":            "A culinary exploration rooted in seasonal ingredients and classical technique. Each element present for a clear reason, nothing superfluous.",
  "Travel":          "A visual document of a place at a specific moment — capturing not just light and geometry, but atmosphere and presence.",
  "Nature":          "An intimate encounter with the natural world at an unfamiliar scale — extraordinary beauty hiding in plain sight.",
  "Tech":            "A project where engineering constraints become design opportunities. The build process is part of the art.",
};

function modalStars(val) {
  return Array.from({length:5}, (_, i) =>
    `<div class="mr-dot ${i < val ? "on" : ""}"></div>`
  ).join("");
}

// ─────────────────────────────────────────────────────────────
// IMAGE DOWNLOAD — works for discovery + creator images
// ─────────────────────────────────────────────────────────────
function downloadImage(url, title = "zenpin-image") {
  // Sanitise filename
  const filename = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60) + ".jpg";
  // Try fetch-blob approach (bypasses cross-origin download block)
  fetch(url, { mode: "cors" })
    .then(r => r.blob())
    .then(blob => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    })
    .catch(() => {
      // Fallback: open in new tab (user can save manually)
      window.open(url, "_blank");
      toast("Image opened — right-click to save");
    });
}

async function openModal(id) {
  let idea;
  try {
    idea = await apiFetch("GET", `/ideas/${id}`);
  } catch {
    // Fallback to cached
    idea = S.allIdeas.find(i => i.id === id) || null;
  }
  if (!idea) return;
  S.modalId = id;
  // Opening a card = interest signal (+1 weight)
  if (idea.category) UserPrefs.bump(idea.category, 1);

  const diff  = idea.difficulty  || idea.diff  || 3;
  const creat = idea.creativity  || idea.creat || 3;
  const use   = idea.usefulness  || idea.use   || 3;
  const saved = S.savedIds.has(id);

  $("modalImg").src           = idea.image_url || idea.img;
  $("modalImg").alt           = idea.title;
  $("modalCatTag").textContent = idea.category;
  $("modalTitle").textContent  = idea.title;
  $("modalDesc").textContent   = idea.description || DESC_MAP[idea.category] || "";

  $("modalRatings").innerHTML = [
    { label:"Difficulty", val:diff  },
    { label:"Creativity", val:creat },
    { label:"Usefulness", val:use   },
  ].map(r => `
    <div class="modal-rating-box">
      <div class="mrl">${r.label}</div>
      <div class="mrs">${modalStars(r.val)}</div>
    </div>`).join("");

  $("modalSteps").innerHTML = (STEPS_MAP[idea.category] || STEPS_MAP["Art"]).map((s, i) => `
    <li class="step-row">
      <div class="step-num-badge">${i+1}</div>
      <span>${s}</span>
    </li>`).join("");

  $("modalTools").innerHTML = (TOOLS_MAP[idea.category] || TOOLS_MAP["Art"]).map(t =>
    `<span class="tool-tag">${t}</span>`
  ).join("");

  // Execution mode tab
  if (window.ExecutionMode) {
    const execEl = $("modalExecGuide");
    if (execEl) ExecutionMode.renderExecutionGuide(idea, "modalExecGuide");
  }

  // Estimated time + cost
  const metaEl = $("modalMeta");
  if (metaEl && window.ExecutionMode) {
    metaEl.innerHTML = `
      <div class="exec-meta-row">
        <div class="exec-meta-pill">⏱ ${ExecutionMode.getTime(idea.category)}</div>
        <div class="exec-meta-pill">💰 ${ExecutionMode.getCost(idea.category)}</div>
      </div>`;
  }

  syncSaveBtn();

  // ── Download button ──────────────────────────────────────
  const dlBtn = $("modalDownloadBtn");
  if (dlBtn) {
    dlBtn.onclick = () => downloadImage(idea.image_url, idea.title);
  }

  // Related ideas
  try {
    const { ideas: related } = await apiFetch("GET", `/ideas?category=${encodeURIComponent(idea.category)}&limit=9`);
    $("relatedRow").innerHTML = related.filter(r => r.id !== id).slice(0, 6).map(r => `
      <div class="related-thumb" data-id="${r.id}">
        <img src="${r.image_url || r.img}" alt="${r.title}" loading="lazy"/>
      </div>`).join("");
  } catch {}

  $("modalBackdrop").classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  $("modalBackdrop")?.classList.remove("open");
  document.body.style.overflow = "";
  S.modalId = null;
}

function syncSaveBtn() {
  const btn   = $("modalSaveBtn");
  const saved = S.savedIds.has(S.modalId);
  if (!btn) return;
  btn.innerHTML = saved
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> Saved ✓`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> Save Idea`;
}

// ─────────────────────────────────────────────────────────────
// SOCIAL ACTIONS — save / like (wired to API)
// ─────────────────────────────────────────────────────────────
async function handleSave(ideaId) {
  if (!requireLogin("Sign in to save ideas")) return;
  try {
    const { saved } = await apiFetch("POST", `/ideas/${ideaId}/save`);
    if (saved) {
      S.savedIds.add(ideaId);
      toast("Saved! 🎉");
      // Saving = strong intent signal (+3 weight)
      const idea = S.allIdeas.find(i => i.id === ideaId);
      if (idea?.category) UserPrefs.bump(idea.category, 3);
    } else {
      S.savedIds.delete(ideaId);
      toast("Removed from saves");
    }
    refreshCard(ideaId);
    if (S.modalId === ideaId) syncSaveBtn();
  } catch (e) { toast(e.message, true); }
}

async function handleLike(ideaId) {
  if (!requireLogin("Sign in to like ideas")) return;
  try {
    const { liked } = await apiFetch("POST", `/ideas/${ideaId}/like`);
    if (liked) {
      S.likedIds.add(ideaId);
      toast("Liked! ❤️");
      // Liking = moderate intent signal (+1 weight)
      const idea = S.allIdeas.find(i => i.id === ideaId);
      if (idea?.category) UserPrefs.bump(idea.category, 1);
    } else {
      S.likedIds.delete(ideaId);
      toast("Unliked");
    }
    refreshCard(ideaId);
  } catch (e) { toast(e.message, true); }
}

function refreshCard(ideaId) {
  // Find all cards with this id and re-render in place
  document.querySelectorAll(`.idea-card[data-id="${ideaId}"]`).forEach(cardEl => {
    const idea = S.allIdeas.find(i => i.id === ideaId);
    if (!idea) return;
    const idx  = parseInt(cardEl.style.getPropertyValue("--i") || "0");
    const tmp  = document.createElement("div");
    tmp.innerHTML = cardHTML(idea, idx);
    cardEl.replaceWith(tmp.firstElementChild);
  });
}

// ─────────────────────────────────────────────────────────────
// UPLOAD IMAGE
// ─────────────────────────────────────────────────────────────
async function handleUpload(file) {
  if (!requireLogin("Sign in to upload images")) return null;
  const form = new FormData();
  form.append("file", file);
  try {
    const data = await apiFetch("POST", "/upload", form, true);
    toast("Image uploaded! ✅");
    return data.url;
  } catch (e) {
    toast("Upload failed: " + e.message, true);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// FILTER HANDLERS
// ─────────────────────────────────────────────────────────────
function handleFilter(e, page) {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  btn.closest(".filter-chips").querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
  btn.classList.add("active");
  S.filter = btn.dataset.filter;
  // Reset dataset and scroll pointer when category changes
  resetLocalDataset();
  S.loaded = 0;
  // Explicitly choosing a category = strong intent signal (+2 weight)
  if (S.filter && S.filter !== "all") {
    // Bump on the normalized cache key so weights accumulate correctly
    const _bumpKey = CATEGORY_MAP[S.filter] || CATEGORY_MAP[S.filter.toLowerCase()] || S.filter;
    UserPrefs.bump(_bumpKey, 2);
  }
  if (page === "home")    initHome();
  if (page === "explore") initExplore();
}

// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS — single delegation root
// ─────────────────────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════
// AI SEARCH ENGINE
// ═══════════════════════════════════════════════════════════════
//
// Flow:
//   User types  → live filter (existing behavior, instant)
//   User presses Enter or clicks Search button
//               → fetch /ai/search?q=query
//               → show AI answer panel below navbar
//               → render image cards in panel grid
//
// Also supports image analysis:
//   openImageAnalysis(imageUrl) → fetch /ai/analyze → show panel
// ═══════════════════════════════════════════════════════════════

const AISearch = (() => {
  let _panel, _grid, _answer, _answerText, _meta, _analyzeWrap, _analyzeResult;
  let _active = false;
  let _lastQuery = "";
  let _loading   = false;

  function init() {
    _panel         = $("aiSearchPanel");
    _grid          = $("aiSearchGrid");
    _answer        = $("aiSearchAnswer");
    _answerText    = $("aiSearchAnswerText");
    _meta          = $("aiSearchMeta");
    _analyzeWrap   = $("aiAnalyzeWrap");
    _analyzeResult = $("aiAnalyzeResult");

    if (!_panel) return;

    // Close button
    $("aiSearchClose")?.addEventListener("click", close);

    // Close on backdrop click
    document.addEventListener("click", e => {
      if (!_active) return;
      if (_panel.contains(e.target)) return;
      if ($("navSearchWrap")?.contains(e.target)) return;
      close();
    });

    // Escape closes
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && _active) close();
    });
  }

  function open() {
    if (!_panel) return;
    _active = true;
    _panel.style.display = "block";
    requestAnimationFrame(() => _panel.classList.add("open"));
  }

  function close() {
    if (!_panel) return;
    _active = false;
    _panel.classList.remove("open");
    setTimeout(() => { if (!_active) _panel.style.display = "none"; }, 280);
  }

  function setLoading(on) {
    _loading = on;
    const wrap = $("navSearchWrap");
    if (on) wrap?.classList.add("searching");
    else    wrap?.classList.remove("searching");
  }

  // ── Main search ────────────────────────────────────────────
  async function search(query) {
    if (!query.trim() || _loading) return;
    if (query === _lastQuery && _active) return;
    _lastQuery = query;

    open();
    setLoading(true);

    // Show skeletons while loading
    if (_grid) _grid.innerHTML = skeletonHTML(6);
    if (_answer) _answer.style.display = "none";
    if (_analyzeWrap) _analyzeWrap.style.display = "none";

    try {
      const data = await apiFetch("GET", `/ai/search?q=${encodeURIComponent(query)}&limit=12`);

      // Render answer
      if (_answerText && data.answer) {
        _answerText.innerHTML = data.answer
          .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
          .replace(/\n/g, "<br>");
        const src  = data.source === "vector" ? "✦ Vector search" : "⚡ Keyword match";
        const cnt  = data.total  || 0;
        if (_meta) _meta.textContent = `${src} · ${cnt} result${cnt !== 1 ? "s" : ""} for "${query}"`;
        if (_answer) _answer.style.display = "flex";
      }

      // Render image cards
      const cards = data.cards || [];
      if (_grid) {
        if (cards.length) {
          renderGrid(_grid, cards);
        } else {
          _grid.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:40px 20px;color:var(--text-3)">
              <div style="font-size:2rem;margin-bottom:12px">🔍</div>
              <p>No images found for <strong>"${escHtml(query)}"</strong></p>
              <p style="font-size:0.8rem;margin-top:8px">
                Try: black cars · anime wallpaper · minimal desk setup
              </p>
            </div>`;
        }
      }

    } catch (e) {
      if (_grid) _grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:32px;color:var(--text-3)">
          <p>Search unavailable. <button class="link-btn" onclick="AISearch.retry()">Retry</button></p>
        </div>`;
    } finally {
      setLoading(false);
    }
  }

  // ── Image analysis (called from card context or analyze btn) ─
  async function analyzeImage(imageUrl, userPrompt = "") {
    console.log("[ZenPin] analyzer upload started");
    open();
    if (_analyzeWrap)   _analyzeWrap.style.display = "block";
    if (_analyzeResult) _analyzeResult.innerHTML = `
      <div class="ai-analyze-loading">
        <div class="ai-dots"><span></span><span></span><span></span></div>
        <p>Analyzing image…</p>
      </div>`;
    if (_grid)   _grid.innerHTML   = "";
    if (_answer) _answer.style.display = "none";

    if (!isLoggedIn()) {
      if (_analyzeResult) _analyzeResult.innerHTML =
        `<p style="color:#c8b8f0;text-align:center;padding:20px;line-height:1.7">
           🔐 <strong>Please sign in to use AI Analyze</strong><br>
           <a href="login.html" style="color:#a06aff;text-decoration:underline">Sign In</a>
         </p>`;
      return;
    }

    let currentUser = getUser();
    if (!currentUser) {
      try {
        currentUser = await apiFetch("GET", "/auth/me");
        if (currentUser) localStorage.setItem("zenpin_user", JSON.stringify(currentUser));
      } catch (_) {}
    }
    if (currentUser) console.log("[ZenPin] analyzer user loaded:", currentUser.username || currentUser.id);

    try {
      const analyzeBody = { image_url: imageUrl, prompt: userPrompt };
      if (currentUser?.id) analyzeBody.user_id = currentUser.id;

      const data = await apiFetch("POST", "/ai/analyze", analyzeBody);
      const a = data.analysis || {};
      console.log("[ZenPin] analyzer upload success");

      if (_analyzeResult) _analyzeResult.innerHTML = `
        <div class="ai-analyze-card">
          <img src="${imageUrl}" alt="Analyzed image" class="ai-analyze-thumb lazy-img"
               data-src="${imageUrl}" onerror="this.style.display='none'"/>
          <div class="ai-analyze-body">
            <div class="ai-analyze-caption">${escHtml(a.caption || "")}</div>
            <div class="ai-analyze-row">
              <span class="ai-analyze-pill">${escHtml(a.category || "")}</span>
              <span class="ai-analyze-mood">${escHtml(a.mood || "")}</span>
            </div>
            ${a.suggestions ? `
              <div class="ai-analyze-section-label">Design suggestions</div>
              <div class="ai-analyze-suggestions">${a.suggestions.replace(/\n/g,"<br>")}</div>
            ` : ""}
            ${(a.tags || []).length ? `
              <div class="ai-analyze-tags">
                ${a.tags.map(t => `<span class="ai-tag">${escHtml(t)}</span>`).join("")}
              </div>
            ` : ""}
            ${(a.similar_searches || []).length ? `
              <div class="ai-analyze-section-label">Try searching</div>
              <div class="ai-analyze-searches">
                ${a.similar_searches.map(s =>
                  `<button class="chip ai-search-suggestion" onclick="AISearch.search('${s.replace(/'/g,"\'")}')">${escHtml(s)}</button>`
                ).join("")}
              </div>
            ` : ""}
          </div>
        </div>`;
    } catch (e) {
      const reason = e?.message || "unknown error";
      console.log("[ZenPin] analyzer upload failed:", reason);
      if (_analyzeResult) _analyzeResult.innerHTML =
        `<p style="color:#ff8888;padding:16px;text-align:center">
           Analysis failed: ${escHtml(reason)}<br>
           <small style="color:rgba(200,180,240,0.6)">Ensure GEMINI_API_KEY is set in Render env vars and you are signed in.</small>
         </p>`;
    }
  }

  function retry() { search(_lastQuery); }

  return { init, search, analyzeImage, close, retry };
})();

// Auto-detect category from post description text
function autoDetectCategory(text) {
  const t = text.toLowerCase();
  const map = [
    [["car","ferrari","lambo","supercar","bmw","porsche","mustang","drift"],         "Cars"],
    [["motorcycle","bike","moto","harley","cafe racer","scrambler"],                "Bikes"],
    [["anime","manga","otaku","ghibli","naruto","demon slayer","aot"],              "Anime"],
    [["gaming","game","pc setup","controller","xbox","playstation","steam"],        "Gaming"],
    [["fashion","outfit","ootd","streetwear","drip","fit check","style"],           "Fashion"],
    [["jewelry","necklace","earring","bracelet","ring","bangle","accessory"],       "Ladies Accessories"],
    [["interior","room decor","home decor","living room","bedroom decor"],          "Interior Design"],
    [["desk","workspace","setup","monitor","battlestation"],                        "Workspace"],
    [["food","recipe","cook","bake","meal","sushi","pizza","ramen"],                "Food"],
    [["drink","cocktail","coffee","latte","matcha","wine","whiskey"],               "Drinks"],
    [["flower","floral","bouquet","bloom","petal"],                                 "Flowers"],
    [["plant","houseplant","monstera","succulent","cactus","botanical"],            "Plants"],
    [["travel","trip","vacation","hotel","destination","wanderlust"],               "Travel"],
    [["tech","gadget","apple","iphone","macbook","ai","robot"],                     "Tech"],
    [["architecture","building","skyscraper","brutalist","facade"],                "Architecture"],
    [["art","painting","illustration","canvas","digital art","drawing"],           "Art"],
    [["nature","forest","mountain","ocean","sunset","landscape"],                   "Nature"],
    [["scenery","view","vista","golden hour","sky","cloud"],                        "Scenery"],
    [["fitness","gym","workout","lifting","yoga","running"],                        "Fitness"],
    [["music","vinyl","guitar","concert","studio","headphones"],                    "Music"],
    [["pet","dog","cat","puppy","kitten","animal"],                                 "Pets"],
    [["tattoo","ink","sleeve","body art"],                                          "Tattoos"],
    [["superhero","marvel","dc","batman","spiderman","avengers"],                  "Superheroes"],
    [["cigarette","smoke","smoking","tobacco"],                                     "Cigarettes"],
  ];
  for (const [kws, cat] of map) {
    if (kws.some(kw => t.includes(kw))) return cat;
  }
  return "Art"; // default fallback
}


// ════════════════════════════════════════════════════════════════
// AMBIENT BACKGROUND — Cinematic scene for Dashboard/Boards/Collab
// Builds rain, clouds, lightning, flower petals, fog and dragon
// using only CSS animations — no canvas, no WebGL, no video.
// Max ~25 DOM elements per page. pointer-events:none on all layers.
// ════════════════════════════════════════════════════════════════

const AMBIENT_CONFIG = {
  dashboard: {
    rainCount:    22,   rainOpacity: 0.30,
    petalCount:   12,   petalColors: ["#e8b4d0","#f7c9df","#d4a0c0","#eec4d5","#c49ab0"],
    cloudCount:    4,   cloudColors: ["rgba(80,40,100,0.18)","rgba(60,30,80,0.14)"],
    lightningFreq: 20,  // seconds between flashes
    dragonDelay:   40,  dragonSpeed: 55,
    glowColors: ["rgba(180,80,200,0.15)","rgba(120,60,180,0.10)"],
  },
  boards: {
    rainCount:    30,   rainOpacity: 0.38,
    petalCount:    6,   petalColors: ["#a0b0d0","#c0c8e8","#9090b8"],
    cloudCount:    6,   cloudColors: ["rgba(30,20,60,0.22)","rgba(20,15,50,0.18)"],
    lightningFreq: 12,
    dragonDelay:   50,  dragonSpeed: 48,
    glowColors: ["rgba(60,40,140,0.12)","rgba(40,30,100,0.08)"],
  },
  collab: {
    rainCount:    38,   rainOpacity: 0.42,
    petalCount:    4,   petalColors: ["#b0b8d8","#d0c0e0"],
    cloudCount:    8,   cloudColors: ["rgba(20,15,50,0.25)","rgba(15,10,40,0.20)"],
    lightningFreq:  8,
    dragonDelay:   25,  dragonSpeed: 42,
    glowColors: ["rgba(40,20,100,0.10)"],
  },
};

function buildAmbientBg(theme) {
  const cfg = AMBIENT_CONFIG[theme];
  if (!cfg) { console.warn(`[ZenPin] buildAmbientBg: no config for theme "${theme}"`); return; }

  const bg = document.getElementById(`ambientBg-${theme}`);
  if (!bg) { console.warn(`[ZenPin] buildAmbientBg: container #ambientBg-${theme} not found in DOM`); return; }
  if (bg.dataset.built) { return; }  // already built
  console.log(`[ZenPin] ambient container found`);
  bg.dataset.built = "1";

  const rnd   = (min, max) => min + Math.random() * (max - min);
  const rndI  = (min, max) => Math.floor(rnd(min, max + 1));
  const mkDiv = (cls) => { const d = document.createElement("div"); d.className = cls; return d; };

  // ── Cloud layer ───────────────────────────────────────────────
  const cloudWrap = mkDiv("cloud-layer");
  for (let i = 0; i < cfg.cloudCount; i++) {
    const c = mkDiv("cloud-puff");
    const w = rndI(180, 320), h = rndI(80, 150);
    c.style.cssText = [
      `left:${rnd(0,80)}%`, `top:${rnd(0,35)}%`,
      `width:${w}px`, `height:${h}px`,
      `background:${cfg.cloudColors[i % cfg.cloudColors.length]}`,
      `--cd:${rnd(50,80)}s`, `--cdl:${rnd(0,20)}s`,
      `--cx:${rnd(-40,40)}px`, `--cx2:${rnd(-30,30)}px`,
    ].join(";");
    cloudWrap.appendChild(c);
  }
  bg.appendChild(cloudWrap);

  // ── Rain layer ────────────────────────────────────────────────
  const rainWrap = mkDiv("rain-layer");
  for (let i = 0; i < cfg.rainCount; i++) {
    const r = mkDiv("raindrop");
    const h = rndI(14, 28);
    r.style.cssText = [
      `left:${rnd(0,100)}%`, `top:${rnd(-10,10)}%`,
      `height:${h}px`, `opacity:${cfg.rainOpacity.toFixed(2)}`,
      `--rf-d:${rnd(0.6,1.2).toFixed(2)}s`,
      `--rf-l:${rnd(0, cfg.rainCount * 0.04).toFixed(2)}s`,
      `--rf-x:${rnd(4,14)}px`,
    ].join(";");
    rainWrap.appendChild(r);
  }
  bg.appendChild(rainWrap);

  // ── Lightning layer ───────────────────────────────────────────
  const lightWrap = mkDiv("lightning-layer");
  for (let i = 0; i < 3; i++) {
    const lf = mkDiv("lightning-flash");
    lf.style.cssText = [
      `--lf-d:${cfg.lightningFreq + rnd(-4,6)}s`,
      `--lf-l:${rnd(0, cfg.lightningFreq * 0.6)}s`,
    ].join(";");
    lightWrap.appendChild(lf);
  }
  bg.appendChild(lightWrap);

  // ── Flower petal layer ────────────────────────────────────────
  const petalWrap = mkDiv("flower-layer");
  for (let i = 0; i < cfg.petalCount; i++) {
    const p = mkDiv("petal");
    const size = rndI(5, 11);
    p.style.cssText = [
      `left:${rnd(0,95)}%`, `top:${rnd(-5,5)}%`,
      `background:${cfg.petalColors[i % cfg.petalColors.length]}`,
      `--ps:${size}px`,
      `--pf-d:${rnd(10,18)}s`,
      `--pf-l:${rnd(0, cfg.petalCount * 0.9)}s`,
      `--pf-x:${rnd(40,120)}px`,
      `--pr:${rnd(200,400)}deg`,
      `--po:${rnd(0.4,0.7).toFixed(2)}`,
    ].join(";");
    petalWrap.appendChild(p);
  }
  bg.appendChild(petalWrap);

  // ── Fog layer ─────────────────────────────────────────────────
  bg.appendChild(mkDiv("fog-layer"));

  // ── Dragon ───────────────────────────────────────────────────
  const dragonWrap = mkDiv("dragon-layer");
  const dragon = mkDiv("dragon");
  dragon.style.cssText = [
    `top:${rnd(8, 20)}%`,
    `--df-d:${cfg.dragonSpeed}s`,
    `--df-l:${cfg.dragonDelay}s`,
  ].join(";");
  dragonWrap.appendChild(dragon);
  bg.appendChild(dragonWrap);
  console.log(`[ZenPin] ambient DOM inserted`);
  // Force visibility check
  setTimeout(() => {
    const computed = window.getComputedStyle(bg);
    const visible  = computed.display !== "none" && computed.visibility !== "hidden" && parseFloat(computed.opacity) > 0;
    console.log(`[ZenPin] ambient visible: ${theme}`);
  if (!visible) {
    console.warn(`[ZenPin] ambient may be hidden — display=${computed.display}, opacity=${computed.opacity}, visibility=${computed.visibility}`);
  }
  }, 200);

  // ── Glow orbs (dashboard only) ────────────────────────────────
  if (cfg.glowColors && cfg.glowColors.length) {
    for (let i = 0; i < cfg.glowColors.length; i++) {
      const orb = mkDiv("glow-orb");
      orb.style.cssText = [
        `left:${rnd(10,80)}%`, `top:${rnd(10,60)}%`,
        `width:${rndI(200,400)}px`, `height:${rndI(200,400)}px`,
        `background:${cfg.glowColors[i]}`,
        `--op-d:${rnd(10,18)}s`, `--op-l:${rnd(0,8)}s`,
      ].join(";");
      bg.appendChild(orb);
    }
  }
}

// Trigger ambient bg when navigating to a themed page
function initAmbientForPage(page) {
  const themeMap = { dashboard: "dashboard", boards: "boards", collab: "collab" };
  const theme = themeMap[page];
  if (theme) {
    console.log(`[ZenPin] ambient background initialized: ${theme}`);
    // Small delay so page is visible first
    setTimeout(() => {
      try { buildAmbientBg(theme);  }
      catch(e) { console.warn(`[ZenPin] buildAmbientBg(${theme}) failed:`, e); }
    }, 100);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  console.log("[ZenPin] page initialized");

  // Decay preference weights slightly each session
  try { UserPrefs.decay(); } catch(e) { console.warn("[ZenPin] UserPrefs.decay failed:", e); }

  // Hero floating gallery (safe — never blocks the rest of init)
  try { initHeroGallery(); console.log("[ZenPin] Hero gallery initialised"); }
  catch(e) { console.warn("[ZenPin] initHeroGallery failed (non-fatal):", e); }

  // Wire AI chat (chatInput/chatSendBtn/chatMsgs are inside page-collab)
  try { setupChat(); console.log("[ZenPin] AI initialized"); }
  catch(e) { console.warn("[ZenPin] setupChat failed (non-fatal):", e); }

  // Generate category chips from actual _curatedCache keys
  // (runs after _curatedCache IIFE has already executed)
  try { generateCategoryChips("homeFilters"); generateCategoryChips("exploreFilters"); }
  catch(e) { console.warn("[ZenPin] generateCategoryChips failed:", e); }
  // ── Warm up Render backend (free tier sleeps) ──────────────
  // Ping silently so by the time user requests data, it's awake
  (async () => {
    try {
      await fetch(`${API_URL}/`, { method: "GET", mode: "cors",
        signal: AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined });
    } catch {}
  })();

  
  // Init auth
  updateNavbar();
  await loadUserState();

  // ── Navigation clicks ──────────────────────────────────────
  document.addEventListener("click", e => {
    // Skip card action buttons
    if (e.target.closest(".card-ico-btn") ||
        e.target.closest(".pin-vote-btn")) return;

    // Skip category-filter chips (they have data-filter, not data-page)
    const chip = e.target.closest(".chip");
    if (chip && chip.dataset.filter && !chip.dataset.page) return;

    const navEl = e.target.closest("[data-page]");
    if (navEl) {
      e.preventDefault();
      // If chip also has a filter, set it before navigating
      if (navEl.dataset.filter) S.filter = navEl.dataset.filter;
      go(navEl.dataset.page);
      return;
    }
  });

  // ── Card interactions ──────────────────────────────────────
  document.addEventListener("click", e => {
    const btn = e.target.closest(".card-ico-btn[data-action]");
    if (btn) {
      e.stopPropagation();
      const id  = Number(btn.dataset.id);
      const act = btn.dataset.action;
      if (act === "save") handleSave(id);
      if (act === "like") handleLike(id);
      return;
    }
    // Open modal
    const card = e.target.closest(".idea-card[data-id]");
    if (card && !e.target.closest(".card-ico-btn")) {
      openModal(Number(card.dataset.id));
      return;
    }
    // Related thumb
    const rel = e.target.closest(".related-thumb[data-id]");
    if (rel) openModal(Number(rel.dataset.id));
  });

  // ── Modal ──────────────────────────────────────────────────
  $("modalCloseBtn")?.addEventListener("click", closeModal);
  $("modalBackdrop")?.addEventListener("click", e => {
    if (e.target === $("modalBackdrop")) closeModal();
  });
  $("modalSaveBtn")?.addEventListener("click", () => {
    if (S.modalId) handleSave(S.modalId);
  });

  // Modal tabs (Overview vs Execution)
  document.querySelectorAll(".modal-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".modal-tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".modal-tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      $(btn.dataset.panel)?.classList.add("active");
    });
  });

  // ── Filters ────────────────────────────────────────────────
  $("homeFilters")?.addEventListener("click",    e => handleFilter(e, "home"));
  $("exploreFilters")?.addEventListener("click", e => handleFilter(e, "explore"));

  // ── Category slider arrow buttons ────────────────────────────
  // Buttons have class .chips-scroll-btn and data-target="{gridId}"
  document.addEventListener("click", e => {
    const btn = e.target.closest(".chips-scroll-btn");
    if (!btn) return;
    const targetId = btn.dataset.target;
    const strip    = targetId ? document.getElementById(targetId) : null;
    if (!strip) return;
    const dir = btn.classList.contains("chips-scroll-left") ? -1 : 1;
    strip.scrollBy({ left: dir * 280, behavior: "smooth" });
  });
  $("homeSort")?.addEventListener("change", e => { S.sort = e.target.value; initHome(); });

  // ── AI Search Engine ──────────────────────────────────────
  AISearch.init();

  const searchInput = $("globalSearch");
  const searchBtn   = $("navAiSearchBtn");
  const searchKbd   = $("searchKbd");

  // Show/hide the Search button based on whether input has text
  searchInput?.addEventListener("input", e => {
    const val = e.target.value.trim();
    // Show AI search button when user starts typing
    if (val) {
      searchBtn?.style && (searchBtn.style.display = "flex");
      searchKbd  && (searchKbd.style.display = "none");
    } else {
      searchBtn?.style && (searchBtn.style.display = "none");
      searchKbd  && (searchKbd.style.display = "");
      // If panel is open with no query, close it
      AISearch.close();
      // Also update page filter (existing behavior)
      S.search = "";
      if (S.page === "home")    initHome();
      if (S.page === "explore") initExplore();
    }
  });

  // Enter key → AI search
  searchInput?.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      const q = searchInput.value.trim();
      if (q) {
        e.preventDefault();
        AISearch.search(q);
      }
    }
  });

  // Search button click → AI search
  searchBtn?.addEventListener("click", () => {
    const q = searchInput?.value.trim();
    if (q) AISearch.search(q);
  });

  // ── Legacy live filter (for when panel is NOT open) ────────
  searchInput?.addEventListener("input", debounce(e => {
    const val = e.target.value.trim();
    if (!val) {
      // Cleared — refresh page normally
      S.search = "";
      document.querySelectorAll(".chip").forEach(c =>
        c.classList.toggle("active", c.dataset.filter === "all")
      );
      if (S.page === "home")    initHome();
      if (S.page === "explore") initExplore();
    }
    // If panel is open, AI search takes over — don't do live filter
  }, 400));

  // ── Keyboard shortcuts ─────────────────────────────────────
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeModal();
    if (e.key === "/" && document.activeElement !== $("globalSearch")) {
      e.preventDefault();
      $("globalSearch")?.focus();
    }
  });

  // ── Scroll shadow on navbar ────────────────────────────────
  window.addEventListener("scroll", () =>
    $("navbar")?.classList.toggle("scrolled", window.scrollY > 10),
    { passive: true }
  );

  // ── Load more (manual + infinite scroll) ──────────────────
  let _loadingMore = false;   // prevent concurrent fetches

  // Show/hide end-of-feed message and load-more button


  async function loadMoreIdeas() {
    if (_loadingMore) return;
    // Already shown everything — don't fire again
    if (S.loaded >= S.allIdeas.length) { _updateEndSentinel(); return; }

    _loadingMore = true;
    const btn = $("loadMoreBtn");
    if (btn) { btn.classList.add("busy"); btn.querySelector("span").textContent = "Loading…"; }
    try {
      const BATCH = 24;
      const next  = S.allIdeas.slice(S.loaded, S.loaded + BATCH);

      if (!next.length) {
        _updateEndSentinel();
        return;
      }

      appendGrid($("homeGrid"), next, S.loaded);
      S.loaded += next.length;

      // Check if we've shown everything
      if (S.loaded >= S.allIdeas.length) _updateEndSentinel();
    } catch (e) {
      console.warn("loadMoreIdeas failed:", e.message);
    } finally {
      if (btn) { btn.classList.remove("busy"); btn.querySelector("span").textContent = "Load more ideas"; }
      _loadingMore = false;
    }
  }

  $("loadMoreBtn")?.addEventListener("click", loadMoreIdeas);

  // ── Infinite scroll — home ────────────────────────────────
  const homeScrollObserver = new IntersectionObserver(
    entries => { if (entries[0].isIntersecting) loadMoreIdeas(); },
    { rootMargin: "600px" }   // pre-trigger 600px before sentinel hits viewport
  );
  if ($("loadMoreBtn")) homeScrollObserver.observe($("loadMoreBtn"));

  // ── Infinite scroll — explore ─────────────────────────────
  let _exploreLoading = false;
  let _exploreDiscPage = 1;

  async function loadMoreExplore() {
    if (_exploreLoading) return;
    const grid = $("exploreGrid");
    if (!grid) return;
    _exploreLoading = true;
    try {
      const cat = S.filter && S.filter !== "all" ? S.filter.toLowerCase() : null;
      _exploreDiscPage++;
      const [{ ideas: more }, discMore] = await Promise.all([
        apiFetch("GET", `/ideas?limit=20&offset=${grid.children.length}&sort=trending${cat ? `&category=${encodeURIComponent(cat)}` : ""}`).catch(() => ({ ideas: [] })),
        cat ? loadDiscoveryImages(cat, _exploreDiscPage)
            : (async () => {
                const cats = Object.keys(CAT_CONFIG).sort(() => Math.random() - 0.5).slice(0, 2);
                const res  = await Promise.all(cats.map(c => loadDiscoveryImages(c, _exploreDiscPage)));
                return res.flat().sort(() => Math.random() - 0.5);
              })(),
      ]);
      const merged = [...more, ...discMore];
      if (merged.length) appendGrid(grid, merged, grid.children.length);
    } catch (e) {
      console.warn("loadMoreExplore failed:", e.message);
    } finally {
      _exploreLoading = false;
    }
  }

  // Create an invisible sentinel at the bottom of explore grid
  const exploreSentinel = document.createElement("div");
  exploreSentinel.id = "exploreSentinel";
  exploreSentinel.style.cssText = "height:1px;width:100%";
  $("exploreGrid")?.after(exploreSentinel);

  const exploreScrollObserver = new IntersectionObserver(
    entries => { if (entries[0].isIntersecting) loadMoreExplore(); },
    { rootMargin: "600px" }
  );
  if (exploreSentinel) exploreScrollObserver.observe(exploreSentinel);

  // ── Lazy image loading via IntersectionObserver ─────────
  // Uses data-src pattern: images load only when near viewport
  // Progressive fade-in via CSS .lazy-img → .loaded transition
  const lazyObserver = new IntersectionObserver(
    entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const img = entry.target;
      const src = img.dataset.src;
      if (!src) { lazyObserver.unobserve(img); return; }
      img.onload  = () => { img.classList.add("loaded"); lazyObserver.unobserve(img); };
      img.onerror = () => { img.classList.add("loaded"); lazyObserver.unobserve(img); };
      img.src = src;
      delete img.dataset.src;
    }),
    { rootMargin: "500px 0px" }  // pre-load 500px before entering viewport
  );

  function observeNewImages() {
    document.querySelectorAll("img.lazy-img:not(.loaded)").forEach(img => {
      // If already has a real src (not blank GIF), just mark loaded
      if (img.src && !img.src.includes("data:image/gif") && !img.dataset.src) {
        if (img.complete && img.naturalWidth) img.classList.add("loaded");
        else img.addEventListener("load", () => img.classList.add("loaded"), { once: true });
        return;
      }
      lazyObserver.observe(img);
    });
    // Also handle non-lazy images already in DOM (modal thumbnails etc)
    document.querySelectorAll("img:not(.lazy-img)").forEach(img => {
      if (img.complete && img.naturalWidth) img.classList.add("loaded");
      else img.addEventListener("load", () => img.classList.add("loaded"), { once: true });
    });
  }

  observeNewImages();
  window.addEventListener("zenpin:gridupdate", observeNewImages);

  // ── AI generator ──────────────────────────────────────────
  $("aiGenBtn")?.addEventListener("click", runAI);
  $("aiInput")?.addEventListener("keydown", e => { if (e.key === "Enter") runAI(); });
  document.querySelectorAll(".quick-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      if ($("aiInput")) $("aiInput").value = btn.textContent;
      $("aiInput")?.focus();
    })
  );
  $("aiSaveBtn")?.addEventListener("click", () => {
    if (!requireLogin("Sign in to save boards")) return;
    toast("Board saved! ✨");
  });

  // AI history click → re-run
  $("aiHistoryList")?.addEventListener("click", e => {
    const item = e.target.closest(".ai-hist-item");
    if (item?.dataset?.topic && $("aiInput")) {
      $("aiInput").value = item.dataset.topic;
      runAI();
    }
  });

  // ── Collab tool buttons ────────────────────────────────────
  document.querySelectorAll(".tool-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tool-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    })
  );

  // ── Profile tabs ───────────────────────────────────────────
  $("profileTabsBar")?.addEventListener("click", e => {
    const tab = e.target.closest(".profile-tab");
    if (tab) renderProfileTab(tab.dataset.tab);
  });

  // ── New board button ───────────────────────────────────────
  $("newBoardBtn")?.addEventListener("click", showNewBoardModal);

  // ── Edit Profile ──────────────────────────────────────────
  async function openEditProfile() {
    // Open modal immediately — user sees feedback right away
    const m = $("editProfileModal");
    if (!m) { toast("Profile editor not available", true); return; }
    if ($("epError")) $("epError").textContent = "";
    m.classList.add("open");

    // Get user data — localStorage first, then /auth/me if missing
    let user = getUser();
    if (!user && isLoggedIn()) {
      // Only call /auth/me if we actually have a token (avoids 401 when logged out)
      if ($("epUsername")) $("epUsername").placeholder = "Loading…";
      try {
        user = await apiFetch("GET", "/auth/me");
        if (user) localStorage.setItem("zenpin_user", JSON.stringify(user));
      } catch (fetchErr) {
        const status = fetchErr?.message || "";
        if (status.includes("401") || status.includes("403")) {
          // Token invalid — clear it and treat as logged-out
          localStorage.removeItem("zenpin_token");
          localStorage.removeItem("zenpin_user");
          if ($("epError")) $("epError").textContent = "Session expired. Please sign in again.";
          return;
        }
        // Other error (Render sleeping etc.) — keep modal open
        if ($("epError")) $("epError").textContent =
          "Profile load failed (server waking up). You can still edit and save.";
      }
    }
    if (!user) {
      // No token — show friendly message, keep modal visible
      if ($("epError")) $("epError").textContent = "Please sign in to edit your profile.";
      return;
    }

    // Pre-fill all fields
    if ($("epUsername"))     { $("epUsername").value = user.username || ""; $("epUsername").placeholder = "your username"; }
    if ($("epBio"))          $("epBio").value          = user.bio      || "";
    if ($("epBioCount"))     $("epBioCount").textContent = (user.bio || "").length;
    if ($("epAvatarPreview")) $("epAvatarPreview").textContent = (user.username || "?")[0].toUpperCase();
    if ($("epLocation"))     $("epLocation").value     = user.location || "";
    const sl = user.social_links || {};
    if ($("epInstagram"))    $("epInstagram").value    = sl.instagram || "";
    if ($("epTwitter"))      $("epTwitter").value      = sl.twitter   || "";
    if (window.TypographySettings) TypographySettings.renderPicker("fontPickerWrap");
  }

  $("editProfileBtn")?.addEventListener("click", () => {
    console.log("[ZenPin] edit profile opened");
    openEditProfile();
  });
  $("profileAvEditBtn")?.addEventListener("click", openEditProfile);

  $("editProfileClose")?.addEventListener("click", () => $("editProfileModal")?.classList.remove("open"));
  $("epCancel")?.addEventListener("click",        () => $("editProfileModal")?.classList.remove("open"));
  $("editProfileModal")?.addEventListener("click", e => {
    if (e.target === $("editProfileModal")) $("editProfileModal").classList.remove("open");
  });

  // Live char count
  $("epBio")?.addEventListener("input", () => {
    if ($("epBioCount")) $("epBioCount").textContent = ($("epBio").value || "").length;
  });

  $("epSave")?.addEventListener("click", async () => {
    const bio      = ($("epBio")?.value || "").trim();
    const username = ($("epUsername")?.value || "").trim();
    const location = ($("epLocation")?.value || "").trim();
    const instagram= ($("epInstagram")?.value || "").trim();
    const twitter  = ($("epTwitter")?.value || "").trim();
    const btn   = $("epSave");
    const errEl = $("epError");
    if (errEl) errEl.textContent = "";
    if (username.length > 0 && username.length < 2) {
      if (errEl) errEl.textContent = "Username must be at least 2 characters.";
      return;
    }
    btn.disabled = true;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 0.8s linear infinite"><path d="M12 2a10 10 0 1 0 10 10"/></svg> Saving…`;
    try {
      const payload = { bio };
      if (username) payload.username = username;
      if (location) payload.location = location;
      const social = {};
      if (instagram) social.instagram = instagram;
      if (twitter)   social.twitter   = twitter;
      if (Object.keys(social).length) payload.social_links = social;

      const updated = await apiFetch("PATCH", "/auth/me", payload);
      // Persist locally with all new fields
      const stored = JSON.parse(localStorage.getItem("zenpin_user") || "{}");
      Object.assign(stored, updated);
      localStorage.setItem("zenpin_user", JSON.stringify(stored));
      // Update navbar + profile header
      fillProfileHeader(stored);
      const navUsernameEl = $("navUsername");
      if (navUsernameEl && stored.username) navUsernameEl.textContent = stored.username;
      $("editProfileModal").classList.remove("open");
      toast("✓ Profile updated!");
    } catch(e) {
      if (errEl) errEl.textContent = e.message || "Update failed. Please try again.";
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Save Changes`;
    }
  });

  // ── Profile Share ──────────────────────────────────────────
  $("profileShareBtn")?.addEventListener("click", () => {
    const user = getUser();
    const url  = window.location.href.split("?")[0];
    const text = `Check out ${user?.username || "my"} profile on ZenPin!`;
    if (navigator.share) {
      navigator.share({ title: "ZenPin Profile", text, url });
    } else {
      navigator.clipboard?.writeText(url);
      toast("Profile link copied!");
    }
  });

  // ── AI Share Board ────────────────────────────────────────
  $("aiShareBtn")?.addEventListener("click", () => {
    const topic = $("aiInput")?.value.trim() || "ZenPin Board";
    const url   = window.location.href.split("#")[0];
    if (navigator.share) {
      navigator.share({ title: `ZenPin — ${topic}`, url });
    } else {
      navigator.clipboard?.writeText(url);
      toast("Link copied to clipboard!");
    }
  });

  // ── Modal Share ───────────────────────────────────────────
  $("modalShareBtn")?.addEventListener("click", () => {
    const title = $("modalTitle")?.textContent || "ZenPin Idea";
    const url   = window.location.href.split("#")[0];
    if (navigator.share) {
      navigator.share({ title: `ZenPin — ${title}`, url });
    } else {
      navigator.clipboard?.writeText(url);
      toast("Link copied!");
    }
  });

  // ── Login btn in navbar ────────────────────────────────────
  $("navLoginBtn")?.addEventListener("click", () => {
    console.log("[ZenPin] login clicked");
    window.location.href = "login.html";
  });

  // Signup — wire any element pointing to signup.html
  document.querySelectorAll('[href="signup.html"],[data-href="signup.html"],[data-signup]').forEach(el => {
    el.addEventListener("click", e => {
      console.log("[ZenPin] signup clicked");
      window.location.href = "signup.html";
    });
  });
  // Also intercept direct navigation to signup.html
  window._zpSignup = () => {
    console.log("[ZenPin] signup clicked");
    window.location.href = "signup.html";
  };

  // ── Profile / avatar wiring ───────────────────────────────────
  $("navAvatar")?.addEventListener("click", () => {
    console.log("[ZenPin] profile opened");
    go("profile");
  });
  $("navProfileBtn")?.addEventListener("click", () => {
    console.log("[ZenPin] profile opened");
    go("profile");
  });


  // ── Hamburger ─────────────────────────────────────────────
  $("hamburger")?.addEventListener("click", () => {
    const links = document.getElementById("navLinks");
    if (links) links.style.display = links.style.display === "flex" ? "none" : "flex";
  });

  // ── Skill level change → re-filter grid ───────────────────
  window.addEventListener("zenpin:skillchange", () => {
    if (S.page === "home" || S.page === "explore") {
      applySkillFilter();
      renderGrid($("homeGrid") || $("exploreGrid"), S.ideas);
    }
  });

  // ── Typography — apply saved font on load ────────────────
  TypographySettings.init();

  // ── Font picker in profile settings ───────────────────────
  TypographySettings.renderPicker("fontPickerWrap");

  // ── Dashboard nav link ─────────────────────────────────────
  $("navDashboardBtn")?.addEventListener("click", () => go("dashboard"));
  $("dashNewPostBtn")?.addEventListener("click", () => openCreatorPost?.());

  
  // ── Creator Post Modal ────────────────────────────────────
  function openCreatorPost() {
    if (!requireLogin("Sign in to share your ideas")) return;
    $("creatorPostModal")?.classList.add("open");
  }

  // Wire up "Create" button in navbar to open creator post modal
  $("createPostBtn")?.addEventListener("click", openCreatorPost);

  // Close handlers
  $("creatorPostClose")?.addEventListener("click", () => $("creatorPostModal")?.classList.remove("open"));
  $("cpCancel")?.addEventListener("click",        () => $("creatorPostModal")?.classList.remove("open"));
  $("creatorPostModal")?.addEventListener("click", e => {
    if (e.target === $("creatorPostModal")) $("creatorPostModal").classList.remove("open");
  });

  // Image upload area
  $("cpUploadArea")?.addEventListener("click", () => $("cpFile")?.click());
  $("cpFile")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Preview locally
    const preview = $("cpPreview");
    preview.src = URL.createObjectURL(file);
    preview.style.display = "block";

    // Upload to backend
    const errEl = $("cpError");
    errEl.textContent = "Uploading image…";
    try {
      const form = new FormData();
      form.append("file", file);
      const data = await apiFetch("POST", "/upload", form, true);
      $("cpImageUrl").value = data.url;
      errEl.textContent = "";
    } catch (e) {
      errEl.textContent = "Upload failed: " + e.message;
    }
  });

  // Preview from URL
  $("cpImageUrl")?.addEventListener("input", () => {
    const url = $("cpImageUrl").value.trim();
    const preview = $("cpPreview");
    if (url.startsWith("http")) {
      preview.src = url;
      preview.style.display = "block";
    }
  });

  // Submit creator post
  $("cpSubmit")?.addEventListener("click", async () => {
    const errEl  = $("cpError");
    const desc   = $("cpDesc")?.value.trim();
    const imgUrl = $("cpImageUrl")?.value.trim();

    // Only description + image required
    if (!desc)   { errEl.textContent = "Please add a caption."; return; }
    if (!imgUrl) { errEl.textContent = "Please add an image — upload one or paste a URL."; return; }

    const btn = $("cpSubmit");
    btn.disabled = true;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 0.8s linear infinite"><path d="M12 2a10 10 0 1 0 10 10"/></svg> Posting…`;
    errEl.textContent = "";

    // Auto-detect category from description if not chosen
    const rawCat = $("cpCategory")?.value || "";
    const cat    = rawCat || autoDetectCategory(desc);

    // Tags from comma-separated input
    const tags = ($("cpTags")?.value || "")
      .split(",").map(t => t.trim().toLowerCase()).filter(Boolean);

    // Title: first sentence of description (max 80 chars)
    const autoTitle = desc.replace(/[.!?].*/, "").trim().slice(0, 80) || desc.slice(0, 80);

    // Reference link
    const refLink = $("cpLinks")?.value?.trim() || "";
    const links = refLink.startsWith("http") ? [refLink] : [];

    try {
      await apiFetch("POST", "/ideas", {
        title:           autoTitle,
        category:        cat,
        image_url:       imgUrl,
        description:     desc,
        difficulty:      3,
        creativity:      3,
        usefulness:      3,
        steps:           [],
        tools:           tags,           // re-use tools field for tags
        estimated_cost:  "",
        reference_links: links,
        source:          "creator",
      });

      // Reset & close
      $("creatorPostModal").classList.remove("open");
      ["cpDesc", "cpTags", "cpLinks", "cpImageUrl"].forEach(id => {
        if ($(id)) $(id).value = "";
      });
      if ($("cpCategory")) $("cpCategory").value = "";
      if ($("cpPreview")) { $("cpPreview").src = ""; $("cpPreview").style.display = "none"; }

      clearApiCache("/ideas");   // bust so the new post appears immediately
      toast("✦ Posted!");
      setTimeout(() => initHome(), 400);
    } catch (e) {
      errEl.textContent = e.message || "Post failed. Try again.";
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 2L11 13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Post`;
    }
  });


  // ═══════════════════════════════════════════════════════════
  // MODAL: Analyze with AI button
  // ═══════════════════════════════════════════════════════════
  $("modalAnalyzeBtn")?.addEventListener("click", () => {
    const imgSrc = $("modalImg")?.src;
    if (!imgSrc) return;
    $("modalBackdrop").classList.remove("open");  // close modal
    AISearch.analyzeImage(imgSrc);
  });

  // ═══════════════════════════════════════════════════════════
  // AI PAGE — 3-tab system
  // Tabs: Generate Board | AI Search | Analyze Image
  // ═══════════════════════════════════════════════════════════
  function switchAiTab(tabId) {
    document.querySelectorAll(".ai-tab").forEach(t =>
      t.classList.toggle("active", t.dataset.aiTab === tabId)
    );
    ["aiTabGenerate", "aiTabSearch", "aiTabAnalyze"].forEach(id => {
      const el = $(id);
      if (el) el.style.display = id === "aiTab" + tabId.charAt(0).toUpperCase() + tabId.slice(1)
                                  ? "block" : "none";
    });
  }

  document.querySelectorAll(".ai-tab").forEach(tab =>
    tab.addEventListener("click", () => switchAiTab(tab.dataset.aiTab))
  );

  // Quick search buttons on the Search tab
  document.querySelectorAll(".quick-search-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      const input = $("aiSearchInput");
      if (input) { input.value = btn.textContent.trim(); runAiSearchTab(); }
    })
  );

  // AI Search tab — run search inline (not in navbar panel)
  async function runAiSearchTab() {
    const q = $("aiSearchInput")?.value.trim();
    if (!q) return;

    const loading = $("aiSearchLoading");
    const result  = $("aiSearchInlineResult");
    const grid    = $("aiSearchInlineGrid");
    const answer  = $("aiSearchInlineAnswer");
    const text    = $("aiSearchInlineText");
    const meta    = $("aiSearchInlineMeta");

    if (loading) loading.style.display = "block";
    if (result)  result.style.display  = "none";

    try {
      const data = await apiFetch("GET", `/ai/search?q=${encodeURIComponent(q)}&limit=12`);

      if (text && data.answer) {
        text.innerHTML = data.answer
          .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
          .replace(/\n/g, "<br>");
        const src = data.source === "vector" ? "✦ Vector" : "⚡ Keyword";
        if (meta) meta.textContent = `${src} · ${data.total || 0} results for "${q}"`;
        if (answer) answer.style.display = "flex";
      }

      if (grid) {
        const cards = data.cards || [];
        if (cards.length) {
          renderGrid(grid, cards);
        } else {
          grid.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-3)">
            <p>No images found for <strong>"${escHtml(q)}"</strong></p>
            <p style="font-size:0.8rem;margin-top:8px">Make sure search_index.json is committed to your repo.</p>
          </div>`;
        }
      }

      if (result) result.style.display = "block";
    } catch (e) {
      if (grid) grid.innerHTML =
        `<p style="color:var(--text-3);text-align:center;padding:32px">Search failed: ${escHtml(e.message)}</p>`;
      if (result) result.style.display = "block";
    } finally {
      if (loading) loading.style.display = "none";
    }
  }

  $("aiSearchRunBtn")?.addEventListener("click", runAiSearchTab);
  $("aiSearchInput")?.addEventListener("keydown", e => {
    if (e.key === "Enter") runAiSearchTab();
  });

  // ═══════════════════════════════════════════════════════════
  // ANALYZE TAB — file upload + URL + run
  // ═══════════════════════════════════════════════════════════
  $("analyzeDropZone")?.addEventListener("click", () => $("analyzeFile")?.click());

  $("analyzeFile")?.addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Show local preview immediately
    const preview = $("analyzePreview");
    if (preview) { preview.src = URL.createObjectURL(file); preview.style.display = "block"; }
    // Upload to backend to get a URL
    try {
      const form = new FormData();
      form.append("file", file);
      const data = await apiFetch("POST", "/upload", form, true);
      if ($("analyzeUrl")) $("analyzeUrl").value = data.url;
    } catch (err) {
      toast("Upload failed: " + err.message, true);
    }
  });

  // Preview on URL paste
  $("analyzeUrl")?.addEventListener("input", () => {
    const url = $("analyzeUrl").value.trim();
    const preview = $("analyzePreview");
    if (preview && url.startsWith("http")) {
      preview.src = url;
      preview.style.display = "block";
    }
  });

  // Drag-and-drop on analyze zone
  $("analyzeDropZone")?.addEventListener("dragover", e => {
    e.preventDefault();
    $("analyzeDropZone").classList.add("drag-over");
  });
  $("analyzeDropZone")?.addEventListener("dragleave",  () =>
    $("analyzeDropZone").classList.remove("drag-over")
  );
  $("analyzeDropZone")?.addEventListener("drop", e => {
    e.preventDefault();
    $("analyzeDropZone").classList.remove("drag-over");
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      const input = $("analyzeFile");
      if (input) {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event("change"));
      }
    }
  });

  // Run analysis
  async function runAnalyzeTab() {
    const url    = $("analyzeUrl")?.value.trim();
    const prompt = $("analyzePrompt")?.value.trim() || "";
    const result  = $("analyzePageResult");
    const loading = $("analyzeLoading");

    if (!url) { toast("Paste an image URL or upload a file first.", true); return; }
    if (!isLoggedIn()) { toast("Please sign in to use AI Analyze", true); return; }

    console.log("[ZenPin] analyzer upload started");
    if (loading) loading.style.display = "block";
    if (result)  result.innerHTML = "";

    let currentUser = getUser();
    if (!currentUser) {
      try { currentUser = await apiFetch("GET", "/auth/me"); } catch (_) {}
    }
    if (currentUser) console.log("[ZenPin] analyzer user loaded:", currentUser.username || currentUser.id);

    try {
      const analyzeBody = { image_url: url, prompt };
      if (currentUser?.id) analyzeBody.user_id = currentUser.id;
      const data = await apiFetch("POST", "/ai/analyze", analyzeBody);
      const a    = data.analysis || {};
      console.log("[ZenPin] analyzer upload success");

      if (result) result.innerHTML = `
        <div class="ai-analyze-card" style="background:var(--surface-2);border-radius:16px;padding:20px">
          <img src="${url}" alt="Analyzed" class="ai-analyze-thumb" onerror="this.style.display='none'"/>
          <div class="ai-analyze-body">
            <div class="ai-analyze-caption">${escHtml(a.caption || "")}</div>
            <div class="ai-analyze-row">
              <span class="ai-analyze-pill">${escHtml(a.category || "")}</span>
              <span class="ai-analyze-mood">${escHtml(a.mood || "")}</span>
            </div>
            ${a.suggestions ? `
              <div class="ai-analyze-section-label">Design suggestions</div>
              <div class="ai-analyze-suggestions">${a.suggestions.replace(/\n/g,"<br>")}</div>
            ` : ""}
            ${(a.tags || []).length ? `
              <div class="ai-analyze-tags">
                ${a.tags.map(t => `<span class="ai-tag">${escHtml(t)}</span>`).join("")}
              </div>
            ` : ""}
            ${(a.similar_searches || []).length ? `
              <div class="ai-analyze-section-label">Try searching</div>
              <div class="ai-analyze-searches">
                ${a.similar_searches.map(s => `
                  <button class="chip ai-search-suggestion" onclick="
                    document.querySelectorAll('.ai-tab')[1].click();
                    const inp=document.getElementById('aiSearchInput');
                    if(inp){inp.value='${s.replace(/'/g,"\'")}'; }
                    setTimeout(runAiSearchTab,50);">${escHtml(s)}</button>`).join("")}
              </div>
            ` : ""}
          </div>
        </div>`;
    } catch (e) {
      const reason = e?.message || "unknown error";
      console.log("[ZenPin] analyzer upload failed:", reason);
      if (result) result.innerHTML =
        `<p style="color:#ff8888;text-align:center;padding:20px">
           Analysis failed: ${escHtml(reason)}<br>
           <small>Ensure GEMINI_API_KEY is set in Render env vars.</small>
         </p>`;
    } finally {
      if (loading) loading.style.display = "none";
    }
  }

  $("analyzeRunBtn")?.addEventListener("click", runAnalyzeTab);

  // ═══════════════════════════════════════════════════════════
  // CARD CONTEXT MENU — right-click or long-press → "Search similar"
  // ═══════════════════════════════════════════════════════════
  let _ctxMenu = null;
  let _ctxTimer = null;

  function showCardCtx(x, y, idea) {
    removeCardCtx();
    const menu = document.createElement("div");
    menu.className = "card-ctx-menu";
    menu.innerHTML = `
      <button class="card-ctx-item" id="ctxSearch">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        Search similar
      </button>
      <button class="card-ctx-item" id="ctxAnalyze">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        Analyze with AI
      </button>
      <button class="card-ctx-item" id="ctxSave">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
        Save idea
      </button>`;
    menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:9999`;
    document.body.appendChild(menu);
    _ctxMenu = menu;

    menu.querySelector("#ctxSearch")?.addEventListener("click", () => {
      removeCardCtx();
      const q = idea.category || idea.title || "";
      AISearch.search(q);
    });
    menu.querySelector("#ctxAnalyze")?.addEventListener("click", () => {
      removeCardCtx();
      if (idea.image_url) AISearch.analyzeImage(idea.image_url);
    });
    menu.querySelector("#ctxSave")?.addEventListener("click", () => {
      removeCardCtx();
      if (idea.id) handleSave(idea.id);
    });

    // Auto-close on outside click
    setTimeout(() => document.addEventListener("click", removeCardCtx, { once: true }), 10);
  }

  function removeCardCtx() {
    if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
    clearTimeout(_ctxTimer);
  }

  // Right-click on idea card
  document.addEventListener("contextmenu", e => {
    const card = e.target.closest(".idea-card");
    if (!card) return;
    e.preventDefault();
    const id   = Number(card.dataset.id);
    const idea = S.allIdeas.find(i => i.id === id) || { id, category: "", image_url: "" };
    showCardCtx(e.clientX, e.clientY, idea);
  });

  // Long-press on mobile (500ms)
  document.addEventListener("pointerdown", e => {
    const card = e.target.closest(".idea-card");
    if (!card || e.button !== 0) return;
    _ctxTimer = setTimeout(() => {
      const id   = Number(card.dataset.id);
      const idea = S.allIdeas.find(i => i.id === id) || { id, category: "", image_url: "" };
      // Get card bounding rect for menu position
      const rect = card.getBoundingClientRect();
      showCardCtx(rect.left + rect.width / 2, rect.top + 80, idea);
    }, 500);
  });
  document.addEventListener("pointerup",    () => clearTimeout(_ctxTimer));
  document.addEventListener("pointermove",  () => clearTimeout(_ctxTimer));

  // ── START ─────────────────────────────────────────────────
  go("home");
});
