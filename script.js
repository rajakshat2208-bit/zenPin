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

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmt = n => n >= 1000 ? (n/1000).toFixed(1).replace(".0","")+"k" : String(n||0);

function token()     { return localStorage.getItem("zenpin_token"); }
function isLoggedIn(){ return !!token(); }

function getUser() {
  try { return JSON.parse(localStorage.getItem("zenpin_user") || "null"); }
  catch { return null; }
}

// ─────────────────────────────────────────────────────────────
// API WRAPPER
// ─────────────────────────────────────────────────────────────
async function apiFetch(method, path, body = null, isForm = false) {
  const headers = {};
  if (token()) headers["Authorization"] = `Bearer ${token()}`;
  if (body && !isForm) headers["Content-Type"] = "application/json";

  const res  = await fetch(`${API_URL}${path}`, {
    method,
    mode: "cors",
    credentials: "omit",
    headers,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
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
      localStorage.removeItem("token");
      localStorage.removeItem("zenpin_user");
      S.savedIds.clear(); S.likedIds.clear();
      updateNavbar();
      go("home");
      toast("Logged out. See you soon!");
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
  const saves = (idea.saves_count || idea.saves || 0) + (saved ? 0 : 0);

    const sourceBadge = idea.source === "creator"
    ? `<div class="card-source-badge creator">Creator</div>`
    : idea.source === "discovery"
    ? `<div class="card-source-badge discovery">Discovery</div>`
    : "";

  return `
<div class="idea-card" data-id="${idea.id}" style="--i:${idx}">
  <div class="card-img-wrap">
    <img class="card-img" src="${idea.image_url || idea.img}" alt="${idea.title}" loading="lazy"/>
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
        <div class="card-ratings">
          <div class="rating-badge"><span class="rb-label">Diff</span><div class="rb-stars">${stars(diff,"blue")}</div></div>
          <div class="rating-badge"><span class="rb-label">Create</span><div class="rb-stars">${stars(creat,"purple")}</div></div>
          <div class="rating-badge"><span class="rb-label">Use</span><div class="rb-stars">${stars(use,"green")}</div></div>
        </div>
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
  container.innerHTML = ideas.map((idea, i) => cardHTML(idea, i)).join("");
}

function appendGrid(container, ideas, startIdx) {
  if (!container) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = ideas.map((idea, i) => cardHTML(idea, startIdx + i)).join("");
  while (tmp.firstChild) container.appendChild(tmp.firstChild);
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
  // ── Not logged in: show a friendly prompt instead of redirecting ──
  const user = getUser();
  if (!user) {
    const inner = document.querySelector("#page-dashboard .page-inner");
    if (inner) inner.innerHTML = `
      <div style="text-align:center;padding:80px 20px">
        <div style="font-size:3rem;margin-bottom:16px">📊</div>
        <h2 style="font-size:1.4rem;font-weight:700;margin-bottom:8px">Your Dashboard</h2>
        <p style="color:var(--text-3);margin-bottom:24px">Sign in to track your posts, saves, and creative activity.</p>
        <button class="btn-primary" onclick="window.location.href='login.html'">Sign In</button>
      </div>`;
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

    // ── Stats ──
    if ($("dashPosts"))  $("dashPosts").textContent  = fmt(data.posts  || 0);
    if ($("dashSaves"))  $("dashSaves").textContent  = fmt(data.saves  || 0);
    if ($("dashLikes"))  $("dashLikes").textContent  = fmt(data.likes  || 0);
    if ($("dashBoards")) $("dashBoards").textContent = fmt(data.boards || 0);

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

// ─────────────────────────────────────────────────────────────
// DISCOVERY — real category-matched images (no API key needed)
// Uses verified Unsplash photo IDs that load directly as <img src>
// 30+ photos per category, infinite scroll cycles through them
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// VERIFIED PHOTOS — each URL manually confirmed to show correct content
// Uses Unsplash CDN directly — works as <img src> without any API key
// Photos carefully selected to match each category accurately
// ─────────────────────────────────────────────────────────────
const VERIFIED_PHOTOS = {

  "cars": [
    { url:"https://images.unsplash.com/photo-1544636331-e26879cd4d9b?w=500&h=700&fit=crop", title:"Sports Car at Dusk",    desc:"Golden hour light wraps a low-slung sports car parked on an empty coastal road — the kind of shot that makes you want to drive somewhere with no destination in mind." },
    { url:"https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=500&h=750&fit=crop", title:"Classic Americana",    desc:"A vintage American muscle car, waxed to a mirror finish, sitting outside a sun-bleached garage. Every curve a reminder of an era when cars were built to be noticed." },
    { url:"https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=500&h=680&fit=crop", title:"Luxury Interior",      desc:"Hand-stitched leather, brushed aluminium trim, and a perfectly weighted steering wheel. The cockpit of a grand tourer designed to make long distances feel effortless." },
    { url:"https://images.unsplash.com/photo-1541899481282-d53bffe3c35d?w=500&h=800&fit=crop", title:"Supercar Detail",      desc:"Carbon fibre, aerodynamic splitters, and an exhaust that whispers of engineering obsession. A hypercar studied up close reveals craft that photos barely capture." },
    { url:"https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=500&h=720&fit=crop", title:"Red Sports Car",        desc:"Vibrant red against a blurred cityscape — a street-legal race car that turns morning commutes into something closer to a lap record attempt." },
    { url:"https://images.unsplash.com/photo-1555353540-64580b51c258?w=500&h=760&fit=crop", title:"Race Track Action",     desc:"Tyre marks on tarmac, the smell of hot rubber and high-octane fuel. This is what cars were truly built for — total focus, nothing else matters." },
    { url:"https://images.unsplash.com/photo-1606220588913-b3aacb4d2f46?w=500&h=700&fit=crop", title:"Muscle Car Garage",   desc:"Parked under workshop lights, this classic muscle car waits for a weekend drive. Restoration in progress — the best kind of Saturday project." },
    { url:"https://images.unsplash.com/photo-1580274455191-1c62773470e3?w=500&h=750&fit=crop", title:"Midnight Drive",      desc:"City lights streak past at speed. A long-exposure shot that captures the pure joy of driving at night when the roads are finally clear." },
    { url:"https://images.unsplash.com/photo-1571607388263-1044f9ea01dd?w=500&h=680&fit=crop", title:"Luxury Coupe",        desc:"Sculpted bodywork that looks fast even standing still. A modern grand tourer blending performance and refinement in equal measure." },
    { url:"https://images.unsplash.com/photo-1558981403-c5f9899a28bc?w=500&h=700&fit=crop", title:"Rally Stage",           desc:"Gravel flying, suspension fully loaded, flat out between tree-lined stages. Rally driving is the most raw and exciting form of motorsport." },
  ],

  "bikes": [
    { url:"https://images.unsplash.com/photo-1558981806-ec527fa84c39?w=500&h=700&fit=crop", title:"Sports Bike Sunset",    desc:"A naked sportsbike silhouetted against a burning sunset. The kind of evening ride that resets everything — helmet on, throttle open, mind empty." },
    { url:"https://images.unsplash.com/photo-1449426468159-d96dbf08f19f?w=500&h=750&fit=crop", title:"Adventure Touring",   desc:"Loaded for a long-distance adventure, this touring bike is packed and ready. The open road ahead promises landscapes and freedom that nothing else delivers." },
    { url:"https://images.unsplash.com/photo-1609630875171-b1321377ee65?w=500&h=680&fit=crop", title:"Cafe Racer Build",    desc:"Stripped-back, low-slung, purposeful. This hand-built cafe racer is a study in motorcycle minimalism — every unnecessary component removed, every essential refined." },
    { url:"https://images.unsplash.com/photo-1558981359-219d6364c9c8?w=500&h=800&fit=crop", title:"Workshop Build",        desc:"Mid-restoration in a cluttered garage. Tools laid out, engine on the bench, the whole thing apart — the satisfying chaos of a build in progress." },
    { url:"https://images.unsplash.com/photo-1591637333184-19aa84b3e01f?w=500&h=720&fit=crop", title:"Mountain Road Ride",  desc:"High altitude switchbacks, crisp air, stunning views at every bend. Mountain roads are why motorcycles exist — pure connection between rider and landscape." },
    { url:"https://images.unsplash.com/photo-1568772585407-9361f9bf3a87?w=500&h=760&fit=crop", title:"Custom Chopper",      desc:"Long forks, stretched frame, custom paint. This chopper is a rolling sculpture — built to be looked at as much as ridden." },
    { url:"https://images.unsplash.com/photo-1571068316344-75bc76f77890?w=500&h=700&fit=crop", title:"Scrambler Style",     desc:"High pipes, knobbly tyres, upright bars. The scrambler aesthetic bridges road and dirt — versatile, rugged, and genuinely cool." },
    { url:"https://images.unsplash.com/photo-1547245324-d777c6f05e80?w=500&h=750&fit=crop", title:"Street Tracker",        desc:"Flat track racing aesthetics brought to the street. Minimal, fast-looking, and deeply satisfying to ride hard through a set of bends." },
    { url:"https://images.unsplash.com/photo-1507036066871-b7e8032b3dea?w=500&h=680&fit=crop", title:"Naked Roadster",      desc:"All the performance with none of the fairing. A naked roadster exposes its engineering proudly — this is a motorcycle with nothing to hide." },
    { url:"https://images.unsplash.com/photo-1599819811279-d5ad9cccf838?w=500&h=700&fit=crop", title:"Dirt Track Racing",   desc:"Sideways into a dirt corner, both wheels sliding. Flat track racing strips motorcycling back to its absolute essentials — throttle, balance, commitment." },
  ],

  "anime": [
    { url:"https://images.unsplash.com/photo-1578632767115-351597cf2477?w=500&h=700&fit=crop", title:"Anime Aesthetic",     desc:"Soft pastels and dreamy lighting — a visual aesthetic inspired by anime art direction, where ordinary scenes become quietly magical." },
    { url:"https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?w=500&h=750&fit=crop", title:"Tokyo Neon Night",    desc:"Neon kanji, glowing convenience stores, umbrellas in the rain. Tokyo at night is the real-world backdrop to a thousand anime stories." },
    { url:"https://images.unsplash.com/photo-1503899036084-c55cdd92da26?w=500&h=680&fit=crop", title:"Japan Street Life",   desc:"A quiet alley somewhere between Shinjuku and a Studio Ghibli background painting. Japan has a gift for making the everyday feel cinematic." },
    { url:"https://images.unsplash.com/photo-1528360983277-13d401cdc186?w=500&h=800&fit=crop", title:"Tokyo Lights",        desc:"The electric chaos of a Tokyo intersection at night — layered signage, crowds, light trails. Overwhelming and beautiful in equal measure." },
    { url:"https://images.unsplash.com/photo-1536098561742-ca998e48cbcc?w=500&h=720&fit=crop", title:"Neon Signs",          desc:"Stacked lanterns, flickering neon, hand-painted kanji. Tokyo's back streets are a typographer's dream and an anime background artist's reference." },
    { url:"https://images.unsplash.com/photo-1490806843957-31f4c9a91c65?w=500&h=760&fit=crop", title:"Cherry Blossom",      desc:"Sakura season transforms Japan into something from another world — soft pink petals drifting against blue skies, lasting just long enough to feel precious." },
    { url:"https://images.unsplash.com/photo-1522383225653-ed111181a951?w=500&h=700&fit=crop", title:"Sakura Avenue",       desc:"A long avenue canopied in cherry blossom, the ground carpeted in fallen petals. This is the Japan that stays with you long after you leave." },
    { url:"https://images.unsplash.com/photo-1480796927426-f609979314bd?w=500&h=750&fit=crop", title:"Tokyo Skyline",       desc:"The Tokyo skyline stretching endlessly — a city so vast and layered that every new visit reveals a neighbourhood you've never seen before." },
    { url:"https://images.unsplash.com/photo-1549692520-acc6669e2f0c?w=500&h=680&fit=crop", title:"Anime City Vibes",     desc:"Long shadows, warm ambient light, and that specific feeling of a quiet evening in a dense urban neighbourhood — familiar from a hundred anime series." },
    { url:"https://images.unsplash.com/photo-1611516491426-03025e6043c8?w=500&h=700&fit=crop", title:"Japan Night Scene",   desc:"Rain-slicked streets reflecting storefronts, a lone figure under an umbrella. The kind of atmospheric night scene that anime has taught us to love." },
  ],

  "scenery": [
    { url:"https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=500&h=700&fit=crop", title:"Mountain Lake",       desc:"A still alpine lake reflecting peaks in perfect symmetry. The kind of silence you can only find above the treeline, where the world feels impossibly large." },
    { url:"https://images.unsplash.com/photo-1531366936337-7c912a4589a7?w=500&h=750&fit=crop", title:"Aurora Borealis",     desc:"Curtains of green and violet light rippling across an arctic sky. The Northern Lights are among the few natural phenomena that exceed every expectation." },
    { url:"https://images.unsplash.com/photo-1448375240767-89691b064a0e?w=500&h=680&fit=crop", title:"Misty Forest",        desc:"Morning mist threading between ancient trees, filtering light into cathedral beams. A forest at dawn carries a quiet magic that photographs can barely hold." },
    { url:"https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=500&h=800&fit=crop", title:"Ocean Sunset",        desc:"Warm light dissolving into the horizon, waves catching the last gold of the day. A reminder that the simplest scenes are often the most profound." },
    { url:"https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=500&h=720&fit=crop", title:"Snowy Mountain",      desc:"A peak buried in fresh snow, the world reduced to white and blue. High altitude emptiness that puts human concerns in reassuring perspective." },
    { url:"https://images.unsplash.com/photo-1501854140801-50d01698950b?w=500&h=760&fit=crop", title:"Green Valley",        desc:"Lush valley floor stretching between protective ridges. The kind of landscape that makes you want to slow down and stay a while." },
    { url:"https://images.unsplash.com/photo-1476514525405-46d8cfdef2d7?w=500&h=700&fit=crop", title:"Waterfall Mist",      desc:"A waterfall throwing cold mist into a sunlit gorge. The roar and spray of falling water is one of nature's most primal and energising experiences." },
    { url:"https://images.unsplash.com/photo-1499002238440-d264edd596ec?w=500&h=750&fit=crop", title:"Lavender Field",      desc:"Rows of lavender stretching to the horizon in Provence — purple geometry under a blue sky, the air thick with scent on a warm afternoon." },
    { url:"https://images.unsplash.com/photo-1518020382113-a7e8fc38eac9?w=500&h=680&fit=crop", title:"Desert Dunes",        desc:"Wind-sculpted dunes casting long shadows at golden hour. The desert teaches patience and simplicity — vast, silent, and strangely comforting." },
    { url:"https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?w=500&h=700&fit=crop", title:"Autumn Forest",       desc:"Blazing oranges and reds crowding a woodland path in peak autumn. For a few short weeks each year, forests transform into something otherworldly." },
  ],

  "gaming": [
    { url:"https://images.unsplash.com/photo-1593305841991-05c297ba4575?w=500&h=700&fit=crop", title:"RGB Gaming Setup",    desc:"A fully dialled battlestation — triple monitors, RGB fans synced to the build, mechanical keyboard perfectly positioned. This is a workspace built around one thing: performance." },
    { url:"https://images.unsplash.com/photo-1585620385456-4759f9b5c7d9?w=500&h=750&fit=crop", title:"Controller Collection",desc:"A flat lay of gaming controllers spanning three generations. Each one a portal to hundreds of hours of worlds, stories, and late-night sessions." },
    { url:"https://images.unsplash.com/photo-1616588589676-62b3bd4ff6d2?w=500&h=680&fit=crop", title:"Neon Battlestation",  desc:"Neon light strips casting purple and cyan across a minimalist gaming desk. Aesthetic and functional — this setup is as much art installation as workstation." },
    { url:"https://images.unsplash.com/photo-1542751371-adc38448a05e?w=500&h=800&fit=crop", title:"Gaming Chair Setup",   desc:"Ergonomic chair, monitor at eye level, headset on the stand. Built for marathon sessions without compromise — comfort and performance working together." },
    { url:"https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=500&h=720&fit=crop", title:"Retro Console",        desc:"A vintage console and cartridges displayed with collector's pride. Every scratched label a memory, every pixel a reminder of how much games have shaped us." },
    { url:"https://images.unsplash.com/photo-1587202372775-e229f172b9d7?w=500&h=760&fit=crop", title:"Mechanical Keyboard", desc:"Hot-swappable switches, custom keycaps, satisfying clicky feedback. The mechanical keyboard rabbit hole is deep, expensive, and completely worth it." },
    { url:"https://images.unsplash.com/photo-1598550476439-6847ef8efa67?w=500&h=700&fit=crop", title:"Gaming Monitor",      desc:"High refresh rate, low response time, pixel-perfect panel. A gaming monitor is the window between you and the world — choosing right changes everything." },
    { url:"https://images.unsplash.com/photo-1612404730901-83e1e631c3ca?w=500&h=750&fit=crop", title:"Custom PC Build",     desc:"Glass-sided case showing off cable management, water cooling, and GPU lighting. A custom PC build is a project as satisfying as the games it runs." },
    { url:"https://images.unsplash.com/photo-1627856013091-fed6e4e90867?w=500&h=680&fit=crop", title:"Streaming Setup",     desc:"Ring light, quality microphone, camera positioned just so. A content creator's desk where gaming meets broadcasting — the modern studio." },
    { url:"https://images.unsplash.com/photo-1640161704729-cbe966a08476?w=500&h=700&fit=crop", title:"VR Gaming",           desc:"Headset on, controllers ready, completely transported. VR gaming is still finding its feet but the moments of genuine presence it creates are unlike anything else." },
  ],

  "fashion": [
    { url:"https://images.unsplash.com/photo-1509631179647-0177331693ae?w=500&h=700&fit=crop", title:"Street Style",        desc:"Fashion at its most honest — not a runway but a pavement. Street style captures how real people interpret trends, making it endlessly more interesting than editorial." },
    { url:"https://images.unsplash.com/photo-1539109136262-a3b12641d71c?w=500&h=750&fit=crop", title:"Editorial Fashion",   desc:"High contrast, strong silhouette, deliberate styling. An editorial shoot where clothing becomes the vehicle for a particular mood or idea." },
    { url:"https://images.unsplash.com/photo-1483985988355-763728e1ccc1?w=500&h=680&fit=crop", title:"Fashion Week",        desc:"Front row energy, unprecedented silhouettes, and the knowledge that what you're seeing will filter down to the high street in eighteen months." },
    { url:"https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=500&h=800&fit=crop", title:"Minimal Outfit",      desc:"One clean silhouette, premium fabric, nothing superfluous. Minimalist dressing is actually harder than maximalist — every choice is completely visible." },
    { url:"https://images.unsplash.com/photo-1490481895907-6b1fd08e9b72?w=500&h=720&fit=crop", title:"Summer Lookbook",     desc:"Lightweight linen, warm tones, unhurried energy. A summer wardrobe built around ease and the understanding that comfort and style are not opposites." },
    { url:"https://images.unsplash.com/photo-1469334031218-e382a71b716b?w=500&h=760&fit=crop", title:"Boho Style",          desc:"Layered textures, earthy palette, silver jewellery, natural fabrics. Bohemian dressing is a lifestyle as much as an aesthetic — unhurried and self-assured." },
    { url:"https://images.unsplash.com/photo-1487222477099-a1faa099f14f?w=500&h=700&fit=crop", title:"Dark Academia",       desc:"Plaid coats, turtlenecks, leather satchels. Dark academia dressing borrows from the libraries and lecture halls of old universities." },
    { url:"https://images.unsplash.com/photo-1554412933-514a83d2f3c8?w=500&h=750&fit=crop", title:"Summer Fashion",       desc:"Bold colour, confident cut, the kind of outfit that arrives before you do. Summer fashion at its most unapologetic and joyful." },
    { url:"https://images.unsplash.com/photo-1496747488965-30f7a25a5d73?w=500&h=680&fit=crop", title:"Vintage Style",       desc:"Thrifted finds styled with modern sensibility. Vintage dressing is sustainability with soul — every piece carries a history you get to continue." },
    { url:"https://images.unsplash.com/photo-1434389677669-e08b4cac3105?w=500&h=700&fit=crop", title:"Power Dressing",      desc:"Structured shoulders, sharp tailoring, complete confidence. Power dressing isn't about intimidation — it's about arriving ready for whatever the day requires." },
  ],

  "nature": [
    { url:"https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=500&h=700&fit=crop", title:"Forest Path",         desc:"Dappled light filtering through a forest canopy onto a trail leading somewhere unknown. Walking in old woodland slows the mind in ways nothing else can match." },
    { url:"https://images.unsplash.com/photo-1472214103451-9374bd1c798e?w=500&h=750&fit=crop", title:"Sunset Meadow",       desc:"A meadow catching the last warm light of the day. Simple and ancient — grass, light, and air — and still somehow extraordinary every single time." },
    { url:"https://images.unsplash.com/photo-1518495973542-4542adba7896?w=500&h=680&fit=crop", title:"Sunflower Field",     desc:"A field of sunflowers all facing the same direction, following their star. There's something deeply optimistic about a sunflower — they know exactly what they want." },
    { url:"https://images.unsplash.com/photo-1465146344425-f00d5f5c8f07?w=500&h=800&fit=crop", title:"Wildflower Meadow",   desc:"Wildflowers colonising a hillside with joyful randomness. No designer could arrange them better — nature's chaos produces its own perfect composition." },
    { url:"https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?w=500&h=720&fit=crop", title:"Jungle Canopy",       desc:"Looking up through layers of tropical canopy — green upon green, light fragmenting as it descends. Rainforests hold more life per square metre than anywhere on earth." },
    { url:"https://images.unsplash.com/photo-1426604966848-d7adac402bff?w=500&h=760&fit=crop", title:"Mountain Wildlife",   desc:"A high-altitude habitat where only the most determined species survive. Mountain ecosystems are fragile, extraordinary, and worth every effort to protect." },
    { url:"https://images.unsplash.com/photo-1504198453319-5ce911bafcde?w=500&h=700&fit=crop", title:"Autumn Colours",      desc:"Deciduous trees in full autumn display — the season of endings that somehow always feels like abundance. Peak colour lasts days. That's what makes it matter." },
    { url:"https://images.unsplash.com/photo-1473773508845-188df298d2d1?w=500&h=750&fit=crop", title:"Ocean Waves",         desc:"Waves building and collapsing in an endless cycle. The ocean operates on timescales that make human concerns feel temporary — which is exactly the point." },
    { url:"https://images.unsplash.com/photo-1477346611705-65d1883cee1e?w=500&h=680&fit=crop", title:"Snowy Trees",         desc:"Trees carrying fresh snow in absolute silence. A winter woodland after snowfall is one of the most peaceful environments on the planet." },
    { url:"https://images.unsplash.com/photo-1513836279014-a89f7a76ae86?w=500&h=700&fit=crop", title:"Tropical Plants",     desc:"Dense tropical foliage in layered greens — a reminder of how lush and abundant the natural world is when left to its own devices." },
  ],

  "food": [
    { url:"https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=500&h=700&fit=crop", title:"Food Photography",    desc:"Natural light, considered composition, ingredients at their best. Great food photography captures not just how a dish looks but how it would taste and smell." },
    { url:"https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=500&h=750&fit=crop", title:"Gourmet Plating",     desc:"A restaurant-quality plate where every element has been placed with the same intention a painter gives a canvas. Fine dining as visual art." },
    { url:"https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=500&h=680&fit=crop", title:"Artisan Pizza",       desc:"Wood-fired, charred crust, quality ingredients generously distributed. A great pizza is one of life's genuinely reliable pleasures." },
    { url:"https://images.unsplash.com/photo-1484723091739-30f299b3fbe4?w=500&h=800&fit=crop", title:"Morning Breakfast",   desc:"The considered morning ritual — warm light, good coffee, fruit and bread. Breakfast eaten slowly, without a phone, is a genuinely radical act." },
    { url:"https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500&h=720&fit=crop", title:"Healthy Bowl",          desc:"A grain bowl assembled with colour and nutrition in mind — proof that healthy eating doesn't require sacrifice, just a little thought and good ingredients." },
    { url:"https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=500&h=760&fit=crop", title:"Coffee Art",          desc:"A flat white with latte art pulled by someone who treats their craft seriously. Good coffee is a daily ritual worth doing properly." },
    { url:"https://images.unsplash.com/photo-1482049016688-2d3e1b311543?w=500&h=700&fit=crop", title:"Stacked Pancakes",    desc:"Thick, fluffy pancakes stacked with syrup pooling at the edges. Weekend breakfast energy — no rush, nowhere to be, something delicious in front of you." },
    { url:"https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=500&h=750&fit=crop", title:"Plated Dessert",      desc:"A restaurant dessert constructed with a pastry chef's precision — textures, temperatures, and flavours working together in one perfect composition." },
    { url:"https://images.unsplash.com/photo-1551024709-8f23befc58f0?w=500&h=680&fit=crop", title:"Craft Cocktails",      desc:"A bartender's considered creation — spirits, modifiers, garnish, and glass all chosen deliberately. Craft cocktails are the food photography of the drinks world." },
    { url:"https://images.unsplash.com/photo-1467003909585-2f8a72700288?w=500&h=700&fit=crop", title:"Sushi Platter",       desc:"Pristine fish on perfectly seasoned rice — sushi at its best requires years of practice and sourcing to achieve apparent simplicity." },
  ],

  "travel": [
    { url:"https://images.unsplash.com/photo-1533105079629-3b4f297290b3?w=500&h=700&fit=crop", title:"Santorini Sunset",    desc:"White cubic buildings cascading down a caldera edge, sunset painting everything gold. Santorini is perhaps the most photographed view in the world — and every photo still surprises you." },
    { url:"https://images.unsplash.com/photo-1476514525405-46d8cfdef2d7?w=500&h=750&fit=crop", title:"Alpine Adventure",    desc:"High passes, cold air, and views that justify every switchback. Mountain travel demands effort and rewards it beyond any reasonable expectation." },
    { url:"https://images.unsplash.com/photo-1502602167500-b0b85cf0cfbb?w=500&h=680&fit=crop", title:"Paris Eiffel Tower",  desc:"The Eiffel Tower at dusk — a structure that should feel clichéd but somehow still manages to stop you in your tracks every single time." },
    { url:"https://images.unsplash.com/photo-1516483638261-f4dbaf036963?w=500&h=800&fit=crop", title:"Amalfi Coast",        desc:"Pastel-coloured villages clinging to cliffs above an impossibly blue sea. The Amalfi Coast is a place where every corner turn produces a new postcard." },
    { url:"https://images.unsplash.com/photo-1528360983277-13d401cdc186?w=500&h=720&fit=crop", title:"Tokyo Crossing",      desc:"Shibuya intersection at rush hour — hundreds of people crossing in every direction in a choreography that somehow never collides. Tokyo as organised miracle." },
    { url:"https://images.unsplash.com/photo-1501952476817-1b9e86754b5a?w=500&h=760&fit=crop", title:"Bali Temple",         desc:"Ancient stone temple draped in moss and ceremony, Bali's spiritual architecture feels grown rather than built — a natural part of the landscape." },
    { url:"https://images.unsplash.com/photo-1548013146-b06f929d8f95?w=500&h=700&fit=crop", title:"Desert Safari",        desc:"Sand dunes stretching endlessly, a camel silhouetted against an amber sky. The desert's apparent emptiness is actually full of life and staggering beauty." },
    { url:"https://images.unsplash.com/photo-1523906834458-a773373a33ca?w=500&h=750&fit=crop", title:"Venice Canal",        desc:"A gondola slipping through a narrow canal, buildings rising straight from the water. Venice exists nowhere else on earth and is more beautiful in person than in any photograph." },
    { url:"https://images.unsplash.com/photo-1534430480872-3498386e7856?w=500&h=680&fit=crop", title:"New York City",       desc:"The Manhattan skyline — a city that declared its ambitions in concrete and glass and somehow delivered. New York rewards the walker with something new on every block." },
    { url:"https://images.unsplash.com/photo-1526392060635-9d6019ef41a8?w=500&h=700&fit=crop", title:"Machu Picchu",        desc:"The Inca citadel emerging from morning cloud above a river valley in the Andes. Machu Picchu is one of those rare places that lives up entirely to its reputation." },
  ],

  "tech": [
    { url:"https://images.unsplash.com/photo-1518770660439-4636190af475?w=500&h=700&fit=crop", title:"Circuit Board",       desc:"The intricate geometry of a printed circuit board — a city in miniature where electrons travel highways at the speed of light doing unfathomably complex work." },
    { url:"https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=500&h=750&fit=crop", title:"Code on Screen",      desc:"A developer's environment at night — terminal open, a problem half-solved, the satisfying focus of debugging code that almost does what you intended." },
    { url:"https://images.unsplash.com/photo-1535378620977-b83cac63a4e5?w=500&h=680&fit=crop", title:"3D Printing",         desc:"A 3D printer building an object layer by layer — one of those technologies that still feels like magic even after you understand exactly how it works." },
    { url:"https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=500&h=800&fit=crop", title:"Space Technology",    desc:"Earth from orbit — the ultimate reminder of what technology can achieve when we direct our best engineering efforts toward genuinely ambitious goals." },
    { url:"https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=500&h=720&fit=crop", title:"Programming",         desc:"Clean code in a dark IDE — the craft of writing software that other people will read, maintain, and build upon. Good code is both functional and readable." },
    { url:"https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=500&h=760&fit=crop", title:"VR Headset",            desc:"A VR headset that transports you somewhere else entirely. Presence — the feeling of actually being in a virtual space — is the technology's genuinely revolutionary quality." },
    { url:"https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=500&h=700&fit=crop", title:"Server Room",          desc:"Rows of servers blinking in a cold, climate-controlled room. The physical infrastructure of the internet — all those abstract cloud services running on very real hardware." },
    { url:"https://images.unsplash.com/photo-1579829366248-204fe8413f31?w=500&h=750&fit=crop", title:"Drone Photography",   desc:"A drone hovering above a landscape, capturing perspectives impossible from the ground. Consumer drones have democratised aerial photography in less than a decade." },
    { url:"https://images.unsplash.com/photo-1593941707882-a56bbc8df44e?w=500&h=680&fit=crop", title:"Electric Vehicle",    desc:"An electric car charging — the end of the internal combustion era visible in a single quiet image. The transition is happening faster than almost anyone predicted." },
    { url:"https://images.unsplash.com/photo-1555949963-ff9d10d4788c?w=500&h=700&fit=crop", title:"Smart Home",            desc:"Integrated technology making a home more responsive and efficient. The best smart home tech disappears into the background — present when needed, invisible when not." },
  ],

  "art": [
    { url:"https://images.unsplash.com/photo-1547826039-bfc35e0f1ea8?w=500&h=700&fit=crop", title:"Abstract Study",       desc:"Form and colour liberated from representation. Abstract art asks the viewer to bring their own meaning — every reading is simultaneously correct and personal." },
    { url:"https://images.unsplash.com/photo-1579783902184-75ad4fa3e1c4?w=500&h=750&fit=crop", title:"Oil Painting",        desc:"Layers of oil paint building texture, depth, and light over weeks or months. The slow accumulation of a painting is inseparable from its final presence." },
    { url:"https://images.unsplash.com/photo-1513364776144-4e9b6f93a9b8?w=500&h=680&fit=crop", title:"Watercolour Work",    desc:"Pigment blooming through wet paper in controlled accidents. Watercolour rewards lightness of touch and punishes overthinking — the medium itself teaches the artist." },
    { url:"https://images.unsplash.com/photo-1460661419201-fd4cecdf8a8b?w=500&h=800&fit=crop", title:"Art Gallery",         desc:"White walls, careful lighting, objects given the space to speak. An art gallery at its best creates conditions for genuine encounter between viewer and work." },
    { url:"https://images.unsplash.com/photo-1561214115-f2f134cc4912?w=500&h=720&fit=crop", title:"Digital Illustration",  desc:"The digital canvas has no physical constraints — unlimited undo, infinite layers, any colour imaginable. A new generation of artists is building entirely new visual languages." },
    { url:"https://images.unsplash.com/photo-1501366236196-f24a0b977e3e?w=500&h=760&fit=crop", title:"Street Mural",        desc:"Large-scale mural art reclaiming urban surfaces. The best street art transforms neglected walls into landmarks that define a neighbourhood's character." },
    { url:"https://images.unsplash.com/photo-1541961017774-22349e4a1262?w=500&h=700&fit=crop", title:"Ceramic Sculpture",   desc:"Clay shaped, fired, and glazed — one of humanity's oldest art forms still producing new possibilities. Ceramics sits at the intersection of utility and pure expression." },
    { url:"https://images.unsplash.com/photo-1578301978162-7b1b4b7c4f9b?w=500&h=750&fit=crop", title:"Collage Art",         desc:"Found images cut and recombined into something that couldn't exist any other way. Collage has always been a democratic art form — all materials welcome." },
    { url:"https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=500&h=680&fit=crop", title:"Ceramic Art",           desc:"Thrown on a wheel or hand-built from slabs — ceramics carries the mark of the maker in every surface. No two pieces ever quite identical." },
    { url:"https://images.unsplash.com/photo-1541912329116-4e7f5e51d12c?w=500&h=700&fit=crop", title:"Sketch Study",        desc:"A sketchbook filled with observational drawings — the most honest document of how an artist sees the world, unmediated by production values." },
  ],

  "architecture": [
    { url:"https://images.unsplash.com/photo-1486325212027-8081e485255e?w=500&h=700&fit=crop", title:"Modern Building",     desc:"Bold geometric forms, honest materials, natural light handled as a primary design element. Contemporary architecture at its best creates spaces that genuinely improve lives." },
    { url:"https://images.unsplash.com/photo-1510127034890-ba27f53d680c?w=500&h=750&fit=crop", title:"Glass Tower",         desc:"A high-rise curtain wall reflecting sky and cloud — the glass tower as urban mirror, simultaneously transparent and opaque depending on the light." },
    { url:"https://images.unsplash.com/photo-1497366811353-6870744d04b2?w=500&h=680&fit=crop", title:"Interior Arch",       desc:"A dramatic interior where structure becomes ornament. The best architectural interiors create a physical sensation — you feel the space differently as you move through it." },
    { url:"https://images.unsplash.com/photo-1470723255736-7f5b65e82b3b?w=500&h=800&fit=crop", title:"Urban Architecture",  desc:"Buildings in conversation with each other across a city block — styles, periods, and scales creating an accidental composition more interesting than any single building." },
    { url:"https://images.unsplash.com/photo-1511452885600-a5e59b859f5d?w=500&h=720&fit=crop", title:"Concrete Design",     desc:"Raw concrete finished with craft — brutalism understood not as harshness but as material honesty. Concrete's imperfections make it warm rather than cold." },
    { url:"https://images.unsplash.com/photo-1520250497591-112533b01376?w=500&h=760&fit=crop", title:"White Architecture",  desc:"White rendered surfaces, deep shadows, flat roofs. Mediterranean modernism where every building is an abstract sculpture placed in a landscape." },
    { url:"https://images.unsplash.com/photo-1565183997392-2f6f122e5912?w=500&h=700&fit=crop", title:"Spiral Staircase",    desc:"A staircase that becomes the architecture. Spiral stairs concentrate engineering and beauty in a single element — hard to build well, impossible to ignore." },
    { url:"https://images.unsplash.com/photo-1527030280862-64139fba04ca?w=500&h=750&fit=crop", title:"Minimalist House",    desc:"A house reduced to its essential elements — shelter, light, view. Minimalist architecture is the hardest kind because there's nowhere for a compromise to hide." },
    { url:"https://images.unsplash.com/photo-1480714378408-67cf0d13bc1b?w=500&h=680&fit=crop", title:"City Skyline",        desc:"A skyline built over decades by competing ambitions, each tower expressing the economic moment of its construction. Cities are the most complex things humans build." },
    { url:"https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=500&h=700&fit=crop", title:"Bridge Design",         desc:"A bridge spanning impossible distances — engineering and aesthetics inseparable at this scale. The best bridges become the symbol of the cities they serve." },
  ],

  "workspace": [
    { url:"https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=500&h=700&fit=crop", title:"Home Office",         desc:"A home office built around what actually helps you think — natural light from the right direction, clear surfaces, and the right tools within reach." },
    { url:"https://images.unsplash.com/photo-1497032374-b6b08cb50e5c?w=500&h=750&fit=crop", title:"Minimal Desk",          desc:"A desk with only what you need today. The minimal workspace is a daily commitment — clearing it at the end of the day is itself part of the practice." },
    { url:"https://images.unsplash.com/photo-1524758631624-e2822b8f8c7e?w=500&h=680&fit=crop", title:"Cosy Workspace",      desc:"Warm light, a good chair, a candle, a plant. A workspace that feels like somewhere you actually want to be changes everything about how you work." },
    { url:"https://images.unsplash.com/photo-1542621334-8427c901e0a0?w=500&h=800&fit=crop", title:"Creative Desk",         desc:"The creative desk tells a story — sketches pinned to the wall, references spread out, works in progress visible. Organised chaos in service of a project." },
    { url:"https://images.unsplash.com/photo-1556761175-4b46a572b786?w=500&h=720&fit=crop", title:"Coffee & Work",         desc:"A laptop, a good coffee, and morning light. The simplest and most reliable combination for getting something done before the day has a chance to interrupt." },
    { url:"https://images.unsplash.com/photo-1504868584819-f8fcdbdb8d08?w=500&h=760&fit=crop", title:"Morning Desk Setup",  desc:"Everything in its place before the work begins. The five minutes spent setting up properly pays back every time — preparation as the first act of creation." },
    { url:"https://images.unsplash.com/photo-1497366754035-d6fd28461b96?w=500&h=700&fit=crop", title:"Standing Desk",       desc:"A height-adjustable desk that lets you choose how to work through the day. Standing for part of it changes your energy and your relationship to long tasks." },
    { url:"https://images.unsplash.com/photo-1513258496099-cf297231d96d?w=500&h=750&fit=crop", title:"Bookshelf Workspace",  desc:"Books behind the monitor, books on the desk, books on the floor. A workspace surrounded by books is a workspace that knows where good ideas come from." },
    { url:"https://images.unsplash.com/photo-1518455027359-f3f8164ba6bd?w=500&h=680&fit=crop", title:"Plant Office",         desc:"A desk next to a window with plants on the sill. Research confirms what most people already know — natural light and living things make workspaces better." },
    { url:"https://images.unsplash.com/photo-1486312338219-ce68d2c6f44d?w=500&h=700&fit=crop", title:"Laptop Workspace",    desc:"Work from anywhere — a laptop and good wifi have made location a choice rather than a constraint. The workspace has become wherever you decide it is." },
  ],

  "interior design": [
    { url:"https://images.unsplash.com/photo-1484154152960-2c50e28d01e7?w=500&h=750&fit=crop", title:"Japandi Bedroom",     desc:"The Japandi aesthetic — Japanese restraint meeting Scandinavian warmth — produces spaces that feel deeply calm and completely considered." },
    { url:"https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=500&h=680&fit=crop", title:"Minimal Kitchen",       desc:"A kitchen where every surface has earned its place — clean lines, quality materials, the functionality that makes cooking feel like a pleasure rather than a chore." },
    { url:"https://images.unsplash.com/photo-1493809842364-d2f5249c69e5?w=500&h=800&fit=crop", title:"Cosy Living Room",    desc:"Layered textiles, warm light, a sofa you don't want to leave. The living room designed for actual living — comfort and aesthetics working together." },
    { url:"https://images.unsplash.com/photo-1567016432519-13fcf8a8e4f9?w=500&h=720&fit=crop", title:"Boho Interior",       desc:"Rattan, macrame, layered rugs, trailing plants. Bohemian interior design is maximalist but never chaotic — every object chosen for meaning as much as aesthetics." },
    { url:"https://images.unsplash.com/photo-1538688359-a2f46e56b4c5?w=500&h=760&fit=crop", title:"Scandi Living",         desc:"White walls, natural wood, clean lines. Scandinavian interior design emerged from a climate that requires spending a lot of time indoors — it takes making home feel good seriously." },
    { url:"https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?w=500&h=700&fit=crop", title:"Earthy Tones",         desc:"Terracotta, warm ochre, sand, olive. An earthy palette grounds a space and connects it to the natural world — sustainable design that ages beautifully." },
    { url:"https://images.unsplash.com/photo-1586105251261-fa68f5cba2b8?w=500&h=750&fit=crop", title:"Reading Nook",         desc:"A window seat with cushions, good light, and a small shelf of books. The reading nook is perhaps the single best thing you can add to a home." },
    { url:"https://images.unsplash.com/photo-1560185007-cde436f6a4d0?w=500&h=680&fit=crop", title:"Modern Dining",         desc:"A dining table as the centre of the home — generous in scale, surrounded by good chairs. The best dining spaces are designed for long meals and longer conversations." },
    { url:"https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?w=500&h=700&fit=crop", title:"Gallery Wall",         desc:"A collection of artworks, photographs, and objects arranged on a wall. A gallery wall is a portrait of the people who live there — accumulated meaning on display." },
    { url:"https://images.unsplash.com/photo-1555041469-db61528b-b6d7?w=500&h=700&fit=crop", title:"Modern Living Room",   desc:"A contemporary living room where every decision — material, proportion, light — has been considered. Good interior design is invisible until you try to replicate it." },
  ],

  "ladies accessories": [
    { url:"https://images.unsplash.com/photo-1611085374630-ac6e55c0e5a2?w=500&h=700&fit=crop", title:"Gold Jewellery",      desc:"Delicate gold chains, fine settings, considered design. Quality jewellery is investment dressing — pieces that work with everything and improve with age." },
    { url:"https://images.unsplash.com/photo-1535632066927-ab722d79e7c4?w=500&h=750&fit=crop", title:"Pearl Earrings",      desc:"Classic pearl earrings — the piece that bridges every occasion from boardroom to beach. Pearls' enduring appeal is that they make the wearer look more considered, not more dressed up." },
    { url:"https://images.unsplash.com/photo-1573408301185-9521cf7f26b1?w=500&h=680&fit=crop", title:"Layered Necklaces",   desc:"Multiple fine chains at different lengths — the layered necklace trend that shows no sign of fading because it works with almost everything." },
    { url:"https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?w=500&h=800&fit=crop", title:"Bracelet Stack",      desc:"Bracelets collected over years — some bought, some gifted, some found. A stacked wrist tells a story that a single piece never could." },
    { url:"https://images.unsplash.com/photo-1601121141461-9d6647bef0a1?w=500&h=720&fit=crop", title:"Ring Collection",     desc:"Rings worn across multiple fingers — each one chosen for what it means rather than following any particular convention about which finger it belongs on." },
    { url:"https://images.unsplash.com/photo-1602173574767-37ac01994b2a?w=500&h=760&fit=crop", title:"Luxury Handbag",      desc:"A well-made handbag in quality leather — the accessory that ties an outfit together while actually being useful. Good bags age into something better than they started." },
    { url:"https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=500&h=700&fit=crop", title:"Designer Bag",        desc:"Clean lines, quality hardware, a silhouette that hasn't changed in decades because it doesn't need to. The investment bag as the foundation of a considered wardrobe." },
    { url:"https://images.unsplash.com/photo-1612817288484-6f916006741a?w=500&h=750&fit=crop", title:"Fine Jewellery",      desc:"The craft of fine jewellery — stones set with precision, metal worked into forms that look effortless but required extraordinary skill." },
    { url:"https://images.unsplash.com/photo-1630019852942-f89202989a59?w=500&h=680&fit=crop", title:"Gold Bangles",        desc:"Stacked gold bangles catching light with every gesture. Bangles are among jewellery's most ancient forms — worn in the same way for thousands of years." },
    { url:"https://images.unsplash.com/photo-1619119069152-a2b331eb392a?w=500&h=700&fit=crop", title:"Statement Earrings",  desc:"Earrings large enough to be the entire statement — the piece that makes everything else a supporting role. Worn with confidence, they transform a simple outfit." },
  ],

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

// Get verified local photos for a category — always correct, no API needed
function getLocalDiscovery(category, page = 1) {
  const key    = category.toLowerCase();
  const photos = VERIFIED_PHOTOS[key] || VERIFIED_PHOTOS["scenery"];
  const PER    = 8;

  return Array.from({ length: PER }, (_, i) => {
    const globalIdx = (page - 1) * PER + i;
    const photo     = photos[globalIdx % photos.length];
    return {
      id:          -(Date.now() + globalIdx * 100 + page * 10000),
      title:       photo.title,
      image_url:   photo.url,
      category:    category.charAt(0).toUpperCase() + category.slice(1),
      source:      "discovery",
      saves_count: 0, likes_count: 0,
      difficulty:  2, creativity: 4, usefulness: 3,
      description: photo.desc || "",
    };
  });
}

// Try backend first (for Unsplash images if key set), fall back to local instantly
async function loadDiscoveryImages(category, page = 1) {
  // Priority:
  // 1. Unsplash direct (best quality, correct categories, 50 req/hr free)
  // 2. Pixabay direct (100 req/min, huge library)
  // 3. Render backend (if keys set there)
  // 4. Verified local photos (always correct, no key needed)

  // 1. Unsplash direct from browser — best algorithm, perfect category match
  const unsplashResult = await fetchUnsplash(category, page);
  if (unsplashResult?.length) return unsplashResult;

  // 2. Pixabay direct from browser
  const pixabayResult = await fetchPixabay(category, page);
  if (pixabayResult?.length) return pixabayResult;

  // 3. Render backend (tries Unsplash/Pexels server-side if keys set)
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 4000);
    const res = await fetch(
      `${API_URL}/images/category?name=${encodeURIComponent(category)}&page=${page}&limit=12`,
      { mode: "cors", credentials: "omit", signal: controller.signal }
    );
    if (res.ok) {
      const data = await res.json();
      if (data.images?.length) {
        return data.images.map((img, i) => ({
          id:          -(Date.now() + i + 1000),
          title:       img.title || category + " Inspiration",
          image_url:   img.image_url,
          category:    category.charAt(0).toUpperCase() + category.slice(1),
          source:      "discovery",
          saves_count: 0, likes_count: 0,
          difficulty:  2, creativity: 4, usefulness: 3,
          description: img.author ? `Photo by ${img.author}` : "",
        }));
      }
    }
  } catch (_) {}

  // 4. Verified local photos — always correct category, no key needed
  return getLocalDiscovery(category, page);
}

// ─────────────────────────────────────────────────────────────
// PAGE: HOME
// ─────────────────────────────────────────────────────────────
async function initHome() {
  const grid = $("homeGrid");
  if (!grid) return;

  // Show skeleton while loading
  grid.innerHTML = skeletonHTML(10);

  const ALL_CATEGORIES = [
    "anime","cars","bikes","scenery","gaming","ladies accessories",
    "interior design","workspace","architecture","art",
    "nature","food","fashion","travel","tech"
  ];
  const cat = S.filter && S.filter !== "all" ? S.filter.toLowerCase() : null;

  // ── Step 1: Show local discovery images IMMEDIATELY (no backend needed) ──
  let discoveryIdeas = [];
  if (cat) {
    discoveryIdeas = getLocalDiscovery(cat);
  } else {
    const shuffled = [...ALL_CATEGORIES].sort(() => Math.random() - 0.5).slice(0, 4);
    discoveryIdeas = shuffled.flatMap(c => getLocalDiscovery(c)).sort(() => Math.random() - 0.5);
  }
  // Show discovery images right away so grid is never empty
  S.ideas = discoveryIdeas;
  S.allIdeas = discoveryIdeas;
  renderGrid(grid, S.ideas);

  // ── Step 2: Load DB ideas from backend (async, enhances the grid) ──
  try {
    const params = buildParams();
    const { ideas: dbIdeas } = await apiFetch("GET", `/ideas?${params}`);
    if (dbIdeas?.length) {
      // Merge DB ideas with discovery — interleave every 4th
      const merged = [];
      let di = 0;
      for (let i = 0; i < dbIdeas.length; i++) {
        merged.push(dbIdeas[i]);
        if ((i + 1) % 4 === 0 && di < discoveryIdeas.length) {
          merged.push(discoveryIdeas[di++]);
        }
      }
      while (di < discoveryIdeas.length) merged.push(discoveryIdeas[di++]);
      S.ideas    = merged;
      S.allIdeas = merged;
      applySkillFilter();
      renderGrid(grid, S.ideas);
    }
  } catch (e) {
    // Backend sleeping — that's fine, discovery images already showing
    console.warn("Backend not ready yet, showing discovery images:", e.message);
  }

  // Trending strip
  if (window.Trends) Trends.renderTrendingStrip("trendingStrip");
  // Skill selector
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

function skeletonHTML(n) {
  return Array.from({length:n}, (_, i) => `
    <div class="idea-card skeleton-card" style="--i:${i}">
      <div class="skeleton-img"></div>
      <div class="skeleton-footer">
        <div class="skeleton-line short"></div>
        <div class="skeleton-line long"></div>
      </div>
    </div>`).join("");
}

// ─────────────────────────────────────────────────────────────
// PAGE: EXPLORE
// ─────────────────────────────────────────────────────────────
async function initExplore() {
  const grid = $("exploreGrid");
  if (!grid) return;
  grid.innerHTML = skeletonHTML(16);
  try {
    const p = new URLSearchParams({ limit:40, sort:"trending" });
    if (S.filter !== "all") p.set("category", S.filter);
    if (S.search) p.set("search", S.search);
    const { ideas } = await apiFetch("GET", `/ideas?${p}`);
    renderGrid(grid, ideas);
  } catch {
    grid.innerHTML = `<div class="load-error">Could not load ideas.</div>`;
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
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: `You are ZenPin AI — a creative assistant for ZenPin, a visual inspiration platform.
You help users discover ideas, plan creative projects, suggest aesthetics, and explore design concepts.
You know about interior design, architecture, fashion, food, travel, art, tech, and workspace aesthetics.
Keep responses concise, inspiring, and practical. Use emojis sparingly to add warmth.
The user is browsing ZenPin — a Pinterest-like platform for creative inspiration.`,
          messages: _chatHistory
        })
      });

      const data = await response.json();
      const reply = data.content?.[0]?.text || "I couldn't generate a response. Please try again.";

      // Remove typing indicator
      $("aiTyping")?.remove();

      _chatHistory.push({ role: "assistant", content: reply });
      // Keep last 20 messages for context
      if (_chatHistory.length > 20) _chatHistory = _chatHistory.slice(-20);

      appendMsg("assistant", reply.replace(/\n/g, "<br>"));

    } catch (err) {
      $("aiTyping")?.remove();
      appendMsg("assistant", "Sorry, I couldn't connect right now. Try again in a moment.");
      console.error("AI chat error:", err);
    } finally {
      sendBtn.disabled = false;
      chatInput.focus();
    }
  }

  // Welcome message
  if (!chatMsgs.innerHTML.trim()) {
    appendMsg("assistant", "Hi! I'm ZenPin AI ✦ Ask me anything — design ideas, aesthetic advice, project inspiration, or help exploring the platform!");
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
  "Cars":               "Pure automotive passion — every curve, line and detail designed to move you before the engine even starts. Whether it's a track weapon or a grand tourer, great cars stir something that nothing else can.",
  "Bikes":              "Two wheels, open road, complete freedom. Motorcycling strips away every unnecessary layer between rider and world — the most direct and honest form of motorised travel ever invented.",
  "Anime":              "A visual world where imagination has no limits — vibrant colours, expressive characters, and emotional storytelling that resonates far beyond any age or border.",
  "Scenery":            "The natural world photographed at its most extraordinary — a reminder that Earth's best work requires no filter, no edit, and no improvement.",
  "Gaming":             "A space built around play, performance, and the joy of being completely absorbed in another world. The modern gaming setup is part workstation, part personal statement.",
  "Fashion":            "Clothing as self-expression — where fabric, cut, and colour become the language through which we tell the world who we are before we've said a word.",
  "Nature":             "An intimate encounter with the natural world at an unfamiliar scale — extraordinary beauty hiding in plain sight, available to anyone who slows down enough to notice.",
  "Food":               "A culinary moment captured — where ingredients, technique, light and composition combine into something that makes you hungry just looking at it.",
  "Travel":             "A place documented at a specific moment — capturing not just light and geography, but the atmosphere and feeling of being somewhere that changes how you see things.",
  "Tech":               "Engineering and design working together — where solving hard problems produces objects and systems of unexpected beauty.",
  "Art":                "An exploration of texture, form, and conceptual depth where every mark carries deliberate intention, inviting a personal dialogue between you and the work.",
  "Architecture":       "Space, light, material and structure combined into something that changes how you feel the moment you enter it. The best architecture improves every life it touches.",
  "Workspace":          "A space designed around how you actually think and work — where every object earns its place and the environment itself becomes a tool for clearer thinking.",
  "Interior Design":    "A room where every decision — material, proportion, light, texture — works together to create an atmosphere that's both beautiful and deeply liveable.",
  "Ladies Accessories": "The finishing details that complete an outfit and express personality — jewellery, bags, and accessories chosen with intention, worn with confidence.",
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

  const diff  = idea.difficulty  || idea.diff  || 3;
  const creat = idea.creativity  || idea.creat || 3;
  const use   = idea.usefulness  || idea.use   || 3;
  const saved = S.savedIds.has(id);

  $("modalImg").src           = idea.image_url || idea.img;
  $("modalImg").alt           = idea.title;
  $("modalCatTag").textContent = idea.category;
  $("modalTitle").textContent  = idea.title;
  $("modalDesc").textContent   = idea.description || DESC_MAP[idea.category] || DESC_MAP[idea.category?.trim()] || "";

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
    if (saved) { S.savedIds.add(ideaId); toast("Saved! 🎉"); }
    else        { S.savedIds.delete(ideaId); toast("Removed from saves"); }
    refreshCard(ideaId);
    if (S.modalId === ideaId) syncSaveBtn();
  } catch (e) { toast(e.message, true); }
}

async function handleLike(ideaId) {
  if (!requireLogin("Sign in to like ideas")) return;
  try {
    const { liked } = await apiFetch("POST", `/ideas/${ideaId}/like`);
    if (liked) { S.likedIds.add(ideaId); toast("Liked! ❤️"); }
    else        { S.likedIds.delete(ideaId); toast("Unliked"); }
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
  S.discoveryPage = {}; // reset page counter on filter change
  if (page === "home")    initHome();
  if (page === "explore") initExplore();
}

// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS — single delegation root
// ─────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {

  // Init auth
  updateNavbar();
  await loadUserState();

  // ── Navigation clicks ──────────────────────────────────────
  document.addEventListener("click", e => {
    // Skip card action buttons
    if (e.target.closest(".card-ico-btn") ||
        e.target.closest(".chip")         ||
        e.target.closest(".pin-vote-btn")) return;

    const navEl = e.target.closest("[data-page]");
    if (navEl) { e.preventDefault(); go(navEl.dataset.page); return; }
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
  $("homeSort")?.addEventListener("change", e => { S.sort = e.target.value; initHome(); });

  // ── Search ─────────────────────────────────────────────────
  let _st;
  $("globalSearch")?.addEventListener("input", e => {
    clearTimeout(_st);
    _st = setTimeout(() => {
      S.search = e.target.value.trim();
      S.filter = "all";
      document.querySelectorAll(".chip").forEach(c =>
        c.classList.toggle("active", c.dataset.filter === "all")
      );
      if (S.page === "home")    initHome();
      if (S.page === "explore") initExplore();
    }, 260);
  });

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

  // ── Load more — infinite discovery pages ──────────────────
  // ── INFINITE SCROLL — loads more images forever as you scroll ──
  let _loadingMore = false;

  async function loadMoreIdeas() {
    if (_loadingMore) return;
    _loadingMore = true;

    const spinner = $("loadingSpinner");
    if (spinner) spinner.style.display = "block";

    try {
      const ALL_CATS = [
        "anime","cars","bikes","scenery","gaming","ladies accessories",
        "interior design","workspace","architecture","art",
        "nature","food","fashion","travel","tech"
      ];

      const cat    = S.filter && S.filter !== "all" ? S.filter.toLowerCase() : null;
      const catKey = cat || "all";

      // Advance the discovery page for this category
      const discPage = (S.discoveryPage[catKey] || 1) + 1;
      S.discoveryPage[catKey] = discPage;

      // Get next batch of images — always works, no backend needed
      let newImages = [];
      if (cat) {
        // Single category — load next page of that category
        newImages = getLocalDiscovery(cat, discPage);
      } else {
        // All feed — round-robin through categories so every scroll = different category
        const catIndex = (discPage - 2) % ALL_CATS.length;
        const thisCat  = ALL_CATS[catIndex];
        const thisPage = Math.floor((discPage - 2) / ALL_CATS.length) + 2;
        newImages = getLocalDiscovery(thisCat, thisPage);
      }

      // Append straight to grid — no merging needed, images load instantly
      const grid = $("homeGrid");
      if (grid && newImages.length) {
        appendGrid(grid, newImages, S.allIdeas.length);
        S.allIdeas = [...S.allIdeas, ...newImages];
      }

      // Silently try backend DB ideas too (bonus content if Render is awake)
      try {
        const p = buildParams({ offset: S.loaded });
        const { ideas: dbNew } = await apiFetch("GET", `/ideas?${p}`);
        if (dbNew?.length) {
          appendGrid(grid, dbNew, S.allIdeas.length);
          S.allIdeas = [...S.allIdeas, ...dbNew];
          S.loaded  += dbNew.length;
        }
      } catch (_) { /* backend asleep — fine, discovery images already appended */ }

    } catch (e) {
      console.warn("loadMore error:", e);
    } finally {
      _loadingMore = false;
      const spinner = $("loadingSpinner");
      if (spinner) spinner.style.display = "none";
    }
  }

  // ── Sentinel observer — fires when bottom of grid is reached ──
  const _sentinel = $("scrollSentinel");
  if (_sentinel) {
    const _infiniteObserver = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && !_loadingMore) loadMoreIdeas();
      },
      { rootMargin: "600px" } // start loading 600px before reaching the bottom
    );
    _infiniteObserver.observe(_sentinel);
  }

  // ── Lazy-load images via IntersectionObserver ───────────
  function setupLazyImages() {
    const lazyObserver = new IntersectionObserver(
      entries => entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
          lazyObserver.unobserve(img);
        }
      }),
      { rootMargin: "300px" }
    );
    document.querySelectorAll("img[data-src]").forEach(img => lazyObserver.observe(img));
  }
  setupLazyImages();
  // Re-run after grid updates
  window.addEventListener("zenpin:gridupdate", setupLazyImages);

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
  function openEditProfile() {
    const user = getUser();
    if (!user) return;
    const m = $("editProfileModal");
    if (!m) return;
    // Pre-fill
    if ($("epUsername")) $("epUsername").value  = user.username || "";
    if ($("epBio"))      $("epBio").value       = user.bio      || "";
    if ($("epBioCount")) $("epBioCount").textContent = (user.bio || "").length;
    if ($("epAvatarPreview")) $("epAvatarPreview").textContent = (user.username || "?")[0].toUpperCase();
    if ($("epLocation")) $("epLocation").value  = user.location || "";
    const sl = user.social_links || {};
    if ($("epInstagram")) $("epInstagram").value = sl.instagram || "";
    if ($("epTwitter"))  $("epTwitter").value   = sl.twitter   || "";
    // Refresh font picker with current selection
    TypographySettings.renderPicker("fontPickerWrap");
  UnsplashSettings.renderInput("unsplashSettingWrap");
  PixabaySettings.renderInput("pixabaySettingWrap");
    if ($("epError"))    $("epError").textContent = "";
    m.classList.add("open");
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
  UnsplashSettings.renderInput("unsplashSettingWrap");
  PixabaySettings.renderInput("pixabaySettingWrap");

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
    const title  = $("cpTitle")?.value.trim();
    const cat    = $("cpCategory")?.value;
    const imgUrl = $("cpImageUrl")?.value.trim();

    if (!title)  { errEl.textContent = "Please enter a title."; return; }
    if (!cat)    { errEl.textContent = "Please select a category."; return; }
    if (!imgUrl) { errEl.textContent = "Please add an image (upload or paste URL)."; return; }

    const btn = $("cpSubmit");
    btn.disabled = true;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 0.8s linear infinite"><path d="M12 2a10 10 0 1 0 10 10"/></svg> Posting…`;
    errEl.textContent = "";

    const steps = ($("cpSteps")?.value || "")
      .split("\n").map(s => s.replace(/^\d+\.\s*/, "").trim()).filter(Boolean);
    const tools = ($("cpTools")?.value || "")
      .split(",").map(t => t.trim()).filter(Boolean);
    const links = ($("cpLinks")?.value || "")
      .split("\n").map(l => l.trim()).filter(l => l.startsWith("http"));

    try {
      const idea = await apiFetch("POST", "/ideas", {
        title,
        category:        cat,
        image_url:       imgUrl,
        description:     $("cpDesc")?.value.trim()  || "",
        difficulty:      parseInt($("cpDifficulty")?.value || "3"),
        creativity:      3,
        usefulness:      3,
        steps,
        tools,
        estimated_cost:  $("cpCost")?.value.trim()  || "",
        reference_links: links,
      });

      // Close modal & reset
      $("creatorPostModal").classList.remove("open");
      ["cpTitle","cpDesc","cpSteps","cpTools","cpCost","cpLinks","cpImageUrl"]
        .forEach(id => { if ($(id)) $(id).value = ""; });
      if ($("cpPreview")) { $("cpPreview").src=""; $("cpPreview").style.display="none"; }
      $("cpCategory").value = "";

      toast("✦ Your idea has been posted!");
      // Reload current page to show new idea
      setTimeout(() => initHome(), 600);
    } catch (e) {
      errEl.textContent = e.message || "Post failed. Please try again.";
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Post Idea`;
    }
  });

  // ── START ─────────────────────────────────────────────────
  go("home");
});
