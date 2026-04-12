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
  if (!isLoggedIn()) return;
  try {
    const me = await apiFetch("GET", "/auth/me");
    localStorage.setItem("zenpin_user", JSON.stringify(me));
    S.savedIds = new Set(me.saved_idea_ids  || []);
    S.likedIds = new Set(me.liked_idea_ids  || []);
    updateNavbar();
  } catch (e) {
    // Token expired — clear it
    if (e.message.includes("401") || e.message.includes("expired")) {
      localStorage.removeItem("token");
      localStorage.removeItem("zenpin_user");
      updateNavbar();
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
  "travel":            { q:"travel+destination+adventure+city",titles:["Santorini Sunset","Alpine Adventure","Paris Eiffel","Amalfi Coast","Tokyo Crossing","Bali Temple","Desert Safari","Venice Canal","New York City","Machu Picchu"],descs:["White buildings cascading down a caldera edge, sunset painting everything gold. Santorini still surprises every time.","High passes, cold air, views that justify every switchback. Mountain travel rewards effort beyond expectation.","The Eiffel Tower at dusk — should feel clichéd but somehow still stops you in your tracks.","Pastel villages on cliffs above an impossibly blue sea. Every Amalfi corner turn produces a new postcard.","Shibuya intersection at rush hour — hundreds crossing in every direction in a choreography that never collides.","Ancient stone temple draped in moss and ceremony. Bali's spiritual architecture feels grown rather than built.","Sand dunes stretching endlessly, a camel against amber sky. The desert's apparent emptiness is full of beauty.","A gondola through a narrow canal, buildings rising from water. Venice is more beautiful in person than any photo.","The Manhattan skyline — a city that declared its ambitions in glass and steel and somehow delivered completely.","The Inca citadel emerging from morning cloud above the Andes. One of those rare places that fully lives up to its reputation."] },
  "tech":              { q:"technology+computer+digital",     titles:["Circuit Board","Code on Screen","3D Printing","Space Technology","Programming","VR Headset","Server Room","Drone Photography","Electric Vehicle","Smart Home"],descs:["The intricate geometry of a circuit board — a city in miniature where electrons travel at light speed.","A developer's environment at night — terminal open, a problem half-solved, the focus of debugging code.","A 3D printer building layer by layer — technology that still feels like magic even after you understand it.","Earth from orbit — the ultimate reminder of what technology achieves when aimed at genuinely ambitious goals.","Clean code in a dark IDE — the craft of writing software others will read, maintain, and build upon.","A VR headset that transports you somewhere else entirely. Presence in a virtual space is truly revolutionary.","Rows of servers blinking in a cold room. The physical infrastructure of the internet — clouds on real hardware.","A drone capturing perspectives impossible from the ground. Consumer drones democratised aerial photography.","An electric car charging — the end of the combustion era visible in one quiet image. Faster than anyone predicted.","Integrated technology making a home more responsive. The best smart tech disappears — present when needed."] },
  "art":               { q:"art+painting+creative+gallery",   titles:["Abstract Study","Oil Painting","Watercolour Work","Art Gallery","Digital Illustration","Street Mural","Ceramic Sculpture","Collage Art","Ceramic Art","Sketch Study"],descs:["Form and colour liberated from representation. Abstract art asks viewers to bring their own meaning — every reading is personal.","Layers of oil paint building texture, depth, and light over weeks. The accumulation is inseparable from the presence.","Pigment blooming through wet paper in controlled accidents. Watercolour rewards lightness of touch.","White walls, careful lighting, objects given space to speak. A gallery creates conditions for genuine encounter.","The digital canvas has no constraints — unlimited undo, infinite layers. New artists building new visual languages.","Large-scale mural reclaiming urban surfaces. The best street art transforms neglected walls into landmarks.","Clay shaped, fired, glazed — one of humanity's oldest art forms still producing new possibilities.","Found images cut and recombined into something new. Collage has always been democratic — all materials welcome.","Thrown on a wheel or hand-built — ceramics carries the maker's mark in every surface. No two pieces identical.","A sketchbook of observational drawings — the most honest document of how an artist sees the world."] },
  "architecture":      { q:"architecture+building+modern+design",titles:["Modern Building","Glass Tower","Interior Arch","Urban Architecture","Concrete Design","White Architecture","Spiral Staircase","Minimalist House","City Skyline","Bridge Design"],descs:["Bold geometric forms, honest materials, natural light as a primary design element. Architecture that genuinely improves lives.","A high-rise curtain wall reflecting sky and cloud — simultaneously transparent and opaque depending on the light.","A dramatic interior where structure becomes ornament. The best spaces create a physical sensation as you move through them.","Buildings in conversation across a city block — styles, periods, scales creating an accidental composition.","Raw concrete finished with craft — material honesty making brutalism warm rather than cold.","White rendered surfaces, deep shadows, flat roofs. Mediterranean modernism where every building is a sculpture.","A staircase that becomes the architecture. Spiral stairs concentrate engineering and beauty into one element.","A house reduced to essentials — shelter, light, view. Minimalist architecture is hardest because nothing can hide.","A skyline built over decades by competing ambitions, each tower expressing its economic moment.","A bridge spanning impossible distances — engineering and aesthetics inseparable at this scale."] },
  "workspace":         { q:"workspace+desk+office+minimal",   titles:["Home Office","Minimal Desk","Cosy Workspace","Creative Desk","Coffee & Work","Morning Setup","Standing Desk","Bookshelf Workspace","Plant Office","Laptop Setup"],descs:["A home office built around what helps you think — natural light, clear surfaces, the right tools within reach.","A desk with only what you need today. The minimal workspace is a daily commitment worth maintaining.","Warm light, a good chair, a candle, a plant. A workspace you want to be in changes everything about how you work.","The creative desk tells a story — sketches pinned up, references spread out, works in progress visible.","A laptop, good coffee, morning light. The simplest and most reliable combination for getting something done.","Everything in its place before the work begins. Five minutes of preparation pays back every single time.","A height-adjustable desk letting you choose how to work. Standing for part of the day changes your energy.","Books behind the monitor, books on the desk. A workspace surrounded by books knows where ideas come from.","A desk next to a window with plants on the sill. Natural light and living things make workspaces genuinely better.","Work from anywhere — a laptop made location a choice rather than a constraint. The workspace is wherever you decide."] },
  "interior design":   { q:"interior+design+home+living+room",titles:["Japandi Bedroom","Minimal Kitchen","Cosy Living Room","Boho Interior","Scandi Living","Earthy Tones","Reading Nook","Modern Dining","Gallery Wall","Modern Living Room"],descs:["Japanese restraint meeting Scandinavian warmth — Japandi spaces feel deeply calm and completely considered.","A kitchen where every surface has earned its place — clean lines, quality materials, cooking as pleasure.","Layered textiles, warm light, a sofa you don't want to leave. The living room designed for actual living.","Rattan, macrame, layered rugs, trailing plants. Every object chosen for meaning as much as aesthetics.","White walls, natural wood, clean lines. Scandinavian design takes making home feel good very seriously.","Terracotta, warm ochre, sand, olive. An earthy palette grounds a space and connects it to the natural world.","A window seat with cushions, good light, a shelf of books. Perhaps the single best addition to any home.","A dining table at the centre of home — generous in scale, designed for long meals and longer conversations.","A collection of artworks and objects on a wall. A gallery wall is a portrait of the people who live there.","A contemporary living room where every decision has been considered. Good design is invisible until you try to replicate it."] },
  "ladies accessories":{ q:"jewelry+accessories+necklace+bracelet",titles:["Gold Jewellery","Pearl Earrings","Layered Necklaces","Bracelet Stack","Ring Collection","Luxury Handbag","Designer Bag","Fine Jewellery","Gold Bangles","Statement Earrings"],descs:["Delicate gold chains, fine settings, considered design. Quality jewellery is investment dressing that improves with age.","Classic pearl earrings bridging every occasion. Pearls make the wearer look more considered, not more dressed up.","Multiple fine chains at different lengths — layered necklaces work with almost everything and tell a personal story.","Bracelets collected over years — bought, gifted, found. A stacked wrist tells stories a single piece never could.","Rings chosen for meaning rather than convention — which finger they belong on is entirely up to you.","A well-made handbag in quality leather — the accessory that ties an outfit together while being genuinely useful.","Clean lines, quality hardware, a silhouette unchanged for decades. The investment bag as wardrobe foundation.","Stones set with precision, metal worked into forms that look effortless but required extraordinary skill.","Stacked gold bangles catching light with every gesture. Among jewellery's most ancient forms — worn the same way for millennia.","Earrings large enough to be the entire statement — worn with confidence, they transform a simple outfit completely."] },
  // ── 5 New Categories ────────────────────────────────────────
  "tattoos":           { q:"tattoo+ink+body+art",           titles:["Minimalist Line","Blackwork Sleeve","Floral Tattoo","Geometric Ink","Japanese Style","Fine Line Detail","Neo-Traditional","Watercolour Tattoo","Abstract Ink","Script Tattoo"],descs:["A single-needle fine line tattoo reduced to its absolute essentials — proof that restraint is its own kind of mastery.","Bold blackwork covering the sleeve with patterns that reference folk art and sacred geometry equally.","Botanical illustration transferred to skin — flowers and leaves rendered with the delicacy of a watercolour painting.","Sacred geometry and precise linework creating patterns that read differently at every viewing distance.","Traditional Japanese tattooing where every element carries symbolic weight — dragons, koi, cherry blossom, waves.","Fine line detail work that rewards close inspection — the kind of tattoo that reveals more the longer you look.","Neo-traditional tattooing updating classic flash imagery with contemporary illustration techniques and richer colour.","Watercolour effects on skin — pigment appearing to bleed and bloom as if on wet paper.","Abstract shapes and brush strokes that prioritise feeling over representation — each one completely unique.","Elegant script in a carefully chosen typeface, words made permanent because they deserve to be."] },
  "plants":            { q:"indoor+plants+houseplants+botanical",titles:["Monstera Delight","Trailing Pothos","Succulent Garden","Fiddle Leaf Fig","Snake Plant","Propagation Station","Terrarium World","Hanging Planters","Cactus Collection","Botanical Shelfie"],descs:["A monstera deliciosa with leaves splitting into their signature fenestrations — the plant that defined a decade of interior design.","Trailing pothos spilling from a high shelf, vines reaching toward the light with determined grace.","A curated succulent arrangement — rosettes of different sizes, textures, and subtle colour variations.","The fiddle leaf fig: dramatic, architectural, temperamental, and somehow still worth every dropped leaf.","The snake plant standing upright in a terracotta pot, requiring almost nothing and giving geometric beauty back.","A propagation station of glass vessels holding cuttings at various stages — life visible through clear glass.","A self-contained world under glass — moss, stones, tiny plants creating a miniature ecosystem.","Macrame hangers suspending plants at different heights, turning a corner into a living installation.","A cactus collection on a sunny windowsill — each one a different silhouette, some ancient-looking, some comic.","A shelf styled with plants, books, and ceramics — the shelfie as a form of domestic self-expression."] },
  "fitness":           { q:"gym+fitness+workout+training",    titles:["Morning Workout","Weight Training","Yoga Practice","HIIT Session","Running Route","Home Gym Setup","Calisthenics","Cycling Training","Boxing Gym","Recovery Day"],descs:["The 5am workout before the world wakes up — discipline made visible in the empty gym and the chalk on the bar.","Progressive overload applied consistently over years. Strength training is the slowest and most reliable form of self-improvement.","A yoga practice that started for flexibility and became a daily meditation. The mat as a consistent place to return to.","High-intensity intervals that compress maximum effort into minimum time. HIIT respects your schedule and rewards commitment.","A running route that has become a ritual — the same streets different every morning depending on light and mood.","A home gym built piece by piece: a rack, a bar, some plates, enough space. No excuses, no commute.","Bodyweight training that needs nothing but a bar and the ground. Calisthenics builds strength you can see and feel.","Early morning cycling before traffic — the city quiet, legs spinning, the day beginning on your own terms.","The boxing gym: bags hanging in rows, the smell of leather and effort, technique built through repetition.","Active recovery, stretching, stillness. The rest day is as important as the training day — the body needs both."] },
  "music":             { q:"music+studio+guitar+vinyl",       titles:["Vinyl Collection","Guitar Setup","Studio Session","Concert Energy","Headphone Escape","Synthesizer Lab","Record Store","Live Performance","Pedalboard Art","Producer Desk"],descs:["A vinyl record collection organised by mood rather than alphabet — pulling a sleeve out and committing to a side is a different relationship with music.","A guitar setup in the corner of a room — the instrument always within reach, always inviting a few minutes of play.","Red light on in the studio: headphones up, take thirty-seven, the song finally revealing its best self.","A concert crowd with hands raised, the moment when recorded music becomes a shared physical experience.","Headphones on, the world cancelled. Music heard properly for the first time — every detail audible in the mix.","A synthesizer and patch cables — analogue equipment creating sounds that exist nowhere else, shaped by hands and intuition.","A record store where discovery is physical: thumbing through sleeves, reading liner notes, buying something unknown.","A live performance where the gap between artist and audience collapses into something nobody can quite describe.","A pedalboard as an instrument in itself — signal chain mapped and optimised, each pedal chosen for a specific sound.","The producer's desk at 2am: headphones, a laptop, hardware, a project finally coming together after months."] },
  "pets":              { q:"pets+dogs+cats+animals",          titles:["Golden Morning","Cat Window Watch","Puppy Chaos","Senior Dog Portrait","Cat Nap","Dog at Beach","Kitten Play","Dog Training","Cat Curiosity","Dog Walk Ritual"],descs:["A golden retriever in morning light — no photograph better communicates uncomplicated joy than a happy dog.","A cat positioned in a window, monitoring the outside world with the focused attention of a naturalist.","Puppy energy: everything interesting, nothing dangerous, the world a continuous source of wonder and things to chew.","The senior dog's portrait — grey muzzle, wise eyes, the accumulated trust of a decade of companionship.","A cat in the deepest phase of a nap, completely surrendered to sleep in a patch of afternoon sun.","A dog at the beach with wet fur and salt-crusted ears, running back with a stick as if it's the most important thing.","Kittens playing — rapid movement, sudden stops, the exaggerated seriousness of creatures that haven't yet learned what's dangerous.","Dog training session: focus, reward, the building of communication between two species through patience and consistency.","A cat inspecting something invisible at floor level with complete scientific seriousness and slightly narrowed eyes.","The morning dog walk ritual — the same route every day, always somehow new to the dog, which makes it new to you too."] },
  "superheroes":       { q:"superhero+comic+book+hero",
    titles:["Iron Man Armour","Batman Cowl","Spider-Man City","Wonder Woman","Captain America","Thor Lightning","Black Panther","Superman Cape","The Flash","Wolverine Claws"],
    descs:["Tony Stark's armour as engineering fantasy — the suit as the ultimate expression of applied intelligence.","Batman on a Gotham rooftop: discipline and will as the superpower, no origin required.","Spider-Man swinging between towers — the most kinetic superhero, the city itself his gymnasium.","Wonder Woman in battle — representing justice and the price of peace with equal conviction.","Captain America: the super soldier whose actual power is stubborn moral clarity.","Thor summoning lightning — Norse myth colliding with cosmic Marvel universe.","Black Panther in Wakanda: a superhero inseparable from the civilization he protects.","Superman in flight — the original, the one every other superhero is measured against.","The Flash as pure speed — a hero whose power collapses the gap between decision and action.","Wolverine's claws extended — the berserker with regeneration as burden, not gift."] },
  "drinks":            { q:"cocktail+whisky+bar+drinks+alcohol",
    titles:["Whisky Neat","Craft Cocktail","Espresso Pull","Cold Brew","Red Wine Pour","Negroni Classic","Old Fashioned","Champagne Toast","Craft Beer","Gin & Tonic"],
    descs:["A whisky glass, neat, on a wooden bar — the reward economy at its most elemental and honest.","A craft cocktail built with precision — spirits, modifiers, garnish, ice all chosen deliberately.","An espresso pulled through a professional machine — 25 seconds of aligned pressure and temperature.","Cold brew steeped overnight — patience rewarded with smooth, concentrated, un-bitter coffee.","A red wine decanted and poured into good crystal — the ritual of opening as anticipation itself.","A Negroni in a rocks glass: gin, vermouth, Campari — equal parts, no argument needed.","An Old Fashioned: whisky, bitters, sugar, ice — the cocktail that needs absolutely nothing else.","Champagne bubbles rising in a flute — carbonation as celebration physics, universal and reliable.","A craft beer poured into the correct glass — foam settling as the revival of local brewing culture.","A gin and tonic with botanicals — the spirit's complexity made legible by the right tonic water."] },
  "flowers":           { q:"flowers+floral+botanical+bloom+garden",
    titles:["Peony Abundance","Single Red Rose","Wildflower Field","Orchid Elegance","Sunflower Field","Cherry Blossom","Tulip Season","Lavender Row","Dahlia Drama","Poppy Field"],
    descs:["Peonies in full bloom — a profusion of petals that lasts a week and is worth waiting for all year.","A single rose at peak: the most familiar flower still capable of stopping you completely.","A wildflower meadow in full summer — ecological complexity masquerading as aesthetic pleasure.","An orchid evolved into specific beauty through millions of years of pollinator communication.","Sunflowers tracking light across a field — heliotropism as agricultural and visual spectacle.","Cherry blossom in full flower — hanami celebrating beauty that lasts only days, perfectly.","A tulip field in spring colour — Dutch horticulture producing annual seasonal spectacle.","Lavender rows in Provence — the fragrance reaching you before the purple becomes visible.","A dahlia in full bloom: complex petal geometry in a flower rewarding close examination.","Poppies in a grain field — red flowers in green, the combination that defined a generation's mourning."] },
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
  "travel":             "travel destination adventure",
  "tech":               "technology futuristic digital",
  "art":                "art painting creative",
  "architecture":       "architecture building modern",
  "workspace":          "workspace desk minimal office",
  "interior design":    "interior design home decor",
  "ladies accessories": "jewelry accessories necklace",
  "tattoos":             "tattoo ink body art",
  "plants":              "houseplants indoor botanical",
  "fitness":             "gym fitness workout training",
  "music":               "music studio guitar vinyl",
  "pets":                "pets dogs cats animals",
  "superheroes":         "superhero comic book hero",
  "drinks":              "cocktail whisky bar drinks",
  "flowers":             "flowers floral botanical bloom",
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
  "landscape": "scenery", "travel": "scenery", "Travel": "scenery",

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
  "tech": "tech", "Tech": "tech",
  "tattoos": "tattoos", "Tattoos": "tattoos",
  "plants": "plants", "Plants": "plants",
  "flowers": "flowers", "Flowers": "flowers",
  "fitness": "fitness", "Fitness": "fitness",
  "music": "music", "Music": "music",
  "drinks": "drinks", "Drinks": "drinks",
  "cigarettes": "cigarettes",
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
    "anime":        seq("anime",        "anime",        30),
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
    "travel":    seq("travel",    "travel",    25),
    "tech":      seq("tech",      "tech",      25),
    "flowers":   seq("flowers",   "flower",    25),
    "plants":    seq("plants",    "plant",     25),
    "fitness":   seq("fitness",   "fitness",   25),
    "music":     seq("music",     "music",     25),
    "tattoos":   seq("tattoos",   "tattoo",    25),
    "drinks":    seq("drinks",    "drink",     25),
  };

  // ── Also try to load images.json if present ──────────────────
  // images.json is generated by: node generate-manifest.js
  // This is async and supplements the cache — it does NOT replace it.
  fetch("images.json")
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data) return;
      let added = 0;
      // FOLDER_KEY: disk folder name → _curatedCache key (NOT display label)
      const FOLDER_KEY = {
        "accessories":      "accessories",   // folder=accessories → key=accessories ✓
        "ladies_accessories":"accessories",
        "interior":         "interior",
        "interior_design":  "interior",
        "superhero":        "superhero",     // folder=superhero → key=superhero ✓
        "superheroes":      "superhero",
        "aesthetic":        "art",
      };
      for (const [folder, urls] of Object.entries(data)) {
        if (folder.startsWith("_") || !Array.isArray(urls) || !urls.length) continue;
        const key = FOLDER_KEY[folder.toLowerCase()] || folder.toLowerCase();
        if (!cache[key]) cache[key] = [];
        for (const url of urls) {
          if (!cache[key].includes(url)) { cache[key].push(url); added++; }
        }
      }
      if (added > 0) console.log(`📸 +${added} images loaded from images.json`);
    })
    .catch(() => {});

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
      "assets/discovery/accessories/accessories3.jpg",
      "assets/discovery/accessories/accessories12.jpg",
      "assets/discovery/interior/interior4.jpg",
    ],
    action: [
      "assets/discovery/cars/car1.jpg",
      "assets/discovery/cars/car7.jpg",
      "assets/discovery/cars/car14.jpg",
      "assets/discovery/cars/car22.jpg",
      "assets/discovery/bikes/bike2.jpg",
      "assets/discovery/bikes/bike10.jpg",
      "assets/discovery/bikes/bike20.jpg",
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
      "assets/discovery/bikes/bike5.jpg", "assets/discovery/bikes/bike14.jpg",
      "assets/discovery/bikes/bike23.jpg",
      "assets/discovery/gaming/gaming2.jpg","assets/discovery/gaming/gaming10.jpg",
      "assets/discovery/anime/anime4.jpg", "assets/discovery/anime/anime12.jpg",
      "assets/discovery/anime/anime22.jpg",
      "assets/discovery/superhero/superhero2.jpg",
      "assets/discovery/scenery/scenery8.jpg",
    ],
    signup: [
      "assets/discovery/fashion/fashion2.jpg",  "assets/discovery/fashion/fashion10.jpg",
      "assets/discovery/fashion/fashion20.jpg",
      "assets/discovery/accessories/accessories5.jpg",
      "assets/discovery/accessories/accessories16.jpg",
      "assets/discovery/accessories/accessories24.jpg",
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
  "travel":"✈️","tech":"⚡","tattoos":"🖊️","plants":"🪴","fitness":"💪",
  "music":"🎵","drinks":"🥃","flowers":"🌸","cigarettes":"🚬",
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
  "travel":       "Travel",
  "tech":         "Tech",
  "flowers":      "Flowers",
  "plants":       "Plants",
  "fitness":      "Fitness",
  "music":        "Music",
  "tattoos":      "Tattoos",
  "drinks":       "Drinks",
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
function setupChat() {
  const sendBtn   = $("chatSendBtn");
  const chatInput = $("chatInput");
  const chatMsgs  = $("chatMsgs");
  if (!sendBtn) return;

  // Conversation history for context
  let _chatHistory = [];

  function appendMsg(role, text, isLoading = false) {
    const user    = getUser();
    const initial = (user?.username || "Y")[0].toUpperCase();
    const isUser  = role === "user";
    const id      = isLoading ? "aiTyping" : "";
    chatMsgs.innerHTML += `
      <div class="chat-msg${isUser ? "" : " chat-msg-ai"}" ${id ? `id="${id}"` : ""}>
        <div class="chat-av" style="background:${isUser ? "var(--grad-brand)" : "linear-gradient(135deg,#7c3aed,#db2777)"}">
          ${isUser ? initial : "✦"}
        </div>
        <div class="chat-bubble">
          <span class="chat-name">${isUser ? (user?.username || "You") : "ZenPin AI"}</span>
          ${isLoading ? `<span class="chat-typing"><span></span><span></span><span></span></span>` : text}
        </div>
      </div>`;
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }

  async function sendMsg() {
    const msg = chatInput.value.trim();
    if (!msg) return;
    chatInput.value = "";
    sendBtn.disabled = true;

    appendMsg("user", msg);
    _chatHistory.push({ role: "user", content: msg });

    appendMsg("assistant", "", true); // typing indicator

    try {
      // Use ZenPin research endpoint first (RAG: DB search + AI)
      let reply = "";
      let ideaCards = [];
      let poweredBy = "";

      try {
        // /ai/chat is Gemini-first, falls back to OpenAI then template
        const resData = await apiFetch("POST", "/ai/chat", {
          message: msg,
          history: _chatHistory.slice(-8),
        });
        reply     = resData.answer || "";
        ideaCards = resData.ideas  || [];
        poweredBy = resData.powered_by || "";
      } catch (_) {
        // Backend sleeping — use Anthropic API if available, else graceful message
        try {
          const response = await fetch("https://api.anthropic.com/v1/messages", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model:      "claude-sonnet-4-20250514",
              max_tokens: 600,
              system: `You are ZenPin AI — a creative expert for a Pinterest-style platform.
Help with inspiration, design, fashion, cars, anime, food, travel, interior design, and creative culture.
Be conversational but expert. Use **bold** and bullets. Stay under 200 words.`,
              messages: _chatHistory
            })
          });
          const data = await response.json();
          if (data.error) throw new Error(data.error.message);
          reply     = data.content?.[0]?.text || "";
          poweredBy = "claude";
        } catch {
          // Both backend and Anthropic unavailable — show a retry suggestion
          reply     = "The ZenPin server is starting up (Render free tier takes ~30s). **Please try again in a moment** — your message is saved above.";
          poweredBy = "offline";
        }
      }

      $("aiTyping")?.remove();
      _chatHistory.push({ role: "assistant", content: reply });
      if (_chatHistory.length > 20) _chatHistory = _chatHistory.slice(-20);

      // Format markdown-lite: **bold**, bullet points
      // Guard: never show empty reply
      if (!reply || reply.trim().length < 2) {
        reply = "I searched ZenPin but couldn't find a specific answer for that. " +
                "Try browsing the Explore page or refining your question.";
      }

      const formatted = reply
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/^## (.+)$/gm, "<strong>$1</strong>")
        .replace(/^### (.+)$/gm, "<strong>$1</strong>")
        .replace(/\n- /g, "<br>• ")
        .replace(/\n\d+\. /g, m => "<br>" + m.trim() + " ")
        .replace(/\n/g, "<br>");

      // Render AI reply (text always comes before images)
      appendMsg("assistant", formatted);

      // If research returned relevant ZenPin cards, show them inline
      if (ideaCards.length) {
        const cardWrap = document.createElement("div");
        cardWrap.className = "chat-results-row";
        cardWrap.innerHTML = `
          <div class="chat-results-label">
            ${ poweredBy === "openai" ? "✨ GPT-4o" : poweredBy === "claude" ? "✦ Claude" : "⚡ ZenPin" }
            · Found ${ideaCards.length} ideas
          </div>
          <div class="chat-cards-strip">
            ${ideaCards.slice(0, 5).map(idea => `
              <div class="chat-card" data-id="${idea.id}" style="cursor:pointer" onclick="openModal(${idea.id})">
                <img src="${getLocalImage(idea)}"
                     alt="${escHtml(idea.title)}" loading="lazy"
                     onerror="this.src='${makePlaceholder((idea.category||'scenery').toLowerCase(),0,idea.title)}'"/>
                <div class="chat-card-title">${escHtml(idea.title)}</div>
              </div>`).join("")}
          </div>`;
        const chatMsgsEl = $("chatMsgs");
        if (chatMsgsEl) {
          chatMsgsEl.appendChild(cardWrap);
          chatMsgsEl.scrollTop = chatMsgsEl.scrollHeight;
        }
      }

    } catch (err) {
      $("aiTyping")?.remove();
      const errMsg = err?.message?.includes("Failed to fetch") || err?.message?.includes("NetworkError")
        ? "Server is waking up — please try again in 10 seconds. ☕"
        : "I had trouble processing that. Could you try rephrasing your question?";
      appendMsg("assistant", errMsg);
      console.error("AI chat error:", err);
    } finally {
      sendBtn.disabled = false;
      chatInput.focus();
    }
  }

  // Welcome message
  const existingMsgs = chatMsgs.querySelectorAll(".chat-msg");
  if (existingMsgs.length <= 2) {  // only demo messages exist
    appendMsg("assistant",
      "Hi! I'm ZenPin Research Assistant ✦ Ask me anything — <strong>motorcycle photography tips</strong>, " +
      "<strong>latest interior trends</strong>, <strong>anime art techniques</strong>, or explore any creative topic. " +
      "I'll search ZenPin's discovery feed and give you expert insights.");
  }

  sendBtn.addEventListener("click", sendMsg);
  chatInput.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) sendMsg(); });
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
    const [savedData, boardsData] = await Promise.allSettled([
      apiFetch("GET", `/users/${user.id}/saves`),
      apiFetch("GET", "/boards"),
    ]);
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
    open();
    if (_analyzeWrap)   _analyzeWrap.style.display = "block";
    if (_analyzeResult) _analyzeResult.innerHTML = `
      <div class="ai-analyze-loading">
        <div class="ai-dots"><span></span><span></span><span></span></div>
        <p>Analyzing image…</p>
      </div>`;
    if (_grid)   _grid.innerHTML   = "";
    if (_answer) _answer.style.display = "none";

    try {
      const data = await apiFetch("POST", "/ai/analyze", {
        image_url: imageUrl,
        prompt:    userPrompt,
      });
      const a = data.analysis || {};

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
                  `<button class="chip ai-search-suggestion" onclick="AISearch.search('${s.replace(/'/g,"\'")}')">
                    ${escHtml(s)}
                  </button>`
                ).join("")}
              </div>
            ` : ""}
          </div>
        </div>`;
    } catch (e) {
      if (_analyzeResult) _analyzeResult.innerHTML =
        `<p style="color:var(--text-3);padding:16px">Analysis failed. Make sure GEMINI_API_KEY is set on Render.</p>`;
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

document.addEventListener("DOMContentLoaded", async () => {
  // Decay preference weights slightly each session
  UserPrefs.decay();

  // Hero floating gallery (anti-gravity effect)
  initHeroGallery();

  // Generate category chips from actual _curatedCache keys
  // (runs after _curatedCache IIFE has already executed)
  generateCategoryChips("homeFilters");
  generateCategoryChips("exploreFilters");
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
  function _updateEndSentinel() {
    const btn      = $("loadMoreBtn");
    const sentinel = $("endOfFeedMsg");
    const atEnd    = S.loaded >= S.allIdeas.length;
    if (btn) btn.style.display = atEnd ? "none" : "";
    if (sentinel) sentinel.style.display = atEnd && S.allIdeas.length > 0 ? "block" : "none";
  }

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
      if ($("epUsername")) $("epUsername").placeholder = "Loading…";
      try {
        user = await apiFetch("GET", "/auth/me");
        if (user) localStorage.setItem("zenpin_user", JSON.stringify(user));
      } catch (fetchErr) {
        // Render cold start — show warning but keep modal open for retry
        if ($("epError")) $("epError").textContent =
          "Profile load failed (server waking up). You can still edit and save.";
        // Don't return — fall through so user can see the modal
      }
    }
    if (!user) {
      // No token at all — show message but keep modal visible
      if ($("epError")) $("epError").textContent = "Sign in first to edit your profile.";
      // Still don't close — user sees the modal with the error
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

  $("editProfileBtn")?.addEventListener("click", openEditProfile);
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
  $("navLoginBtn")?.addEventListener("click", () => { window.location.href = "login.html"; });

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

  // ── Collab chat ────────────────────────────────────────────
  setupChat();

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
    const result = $("analyzePageResult");
    const loading = $("analyzeLoading");

    if (!url) { toast("Paste an image URL or upload a file first.", true); return; }

    if (loading) loading.style.display = "block";
    if (result)  result.innerHTML = "";

    try {
      const data = await apiFetch("POST", "/ai/analyze", { image_url: url, prompt });
      const a    = data.analysis || {};

      if (result) result.innerHTML = `
        <div class="ai-analyze-card" style="background:var(--surface-2);border-radius:16px;padding:20px">
          <img src="${url}" alt="Analyzed" class="ai-analyze-thumb"
               onerror="this.style.display='none'"/>
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
                    const inp = document.getElementById('aiSearchInput');
                    if(inp){ inp.value='${s.replace(/'/g, "\\'")}'; }
                    setTimeout(runAiSearchTab, 50);
                  ">${escHtml(s)}</button>`).join("")}
              </div>
            ` : ""}
          </div>
        </div>`;
    } catch (e) {
      if (result) result.innerHTML =
        `<p style="color:var(--text-3);text-align:center;padding:20px">
          Analysis failed: ${escHtml(e.message)}<br>
          <small>Make sure GEMINI_API_KEY is set in Render env vars.</small>
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
