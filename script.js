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
  const saves = (idea.saves_count || idea.saves || 0);
  const catKey = (idea.category||"scenery").toLowerCase();

  // Image: Unsplash Source (category-matched, instant CDN)
  // onerror → Picsum (random real photo) → SVG gradient (never fails)
  const imgSrc     = idea.image_url || getPhotoUrl(catKey, idx);
  const picsumFb   = idea.thumb_url || getPicsumUrl(catKey, idx);
  const svgFb      = makePlaceholder(catKey, idx, idea.title);

  const sourceBadge = idea.source === "creator"
    ? `<div class="card-source-badge creator">Creator</div>`
    : idea.source === "discovery"
    ? `<div class="card-source-badge discovery">Discovery</div>`
    : "";

  return `
<div class="idea-card" data-id="${idea.id}" style="--i:${idx}">
  <div class="card-img-wrap">
    <img class="card-img"
      src="${imgSrc}"
      alt="${escHtml(idea.title)}"
      loading="lazy"
      data-fb1="${picsumFb}"
      data-fb2="${svgFb}"
      onerror="(function(el){if(!el._e1){el._e1=1;el.src=el.dataset.fb1;}else if(!el._e2){el._e2=1;el.src=el.dataset.fb2;el.onerror=null;}})(this)"
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

// ─────────────────────────────────────────────────────────────
// IMAGE SYSTEM v3 — Verified Unsplash photo IDs per category
// Direct CDN access, no API key, no keyword randomness, instant load
// Each category has 15 real curated photos that ALWAYS match the category
// URL: https://images.unsplash.com/photo-{ID}?w=500&h=700&q=80&auto=format&fit=crop
// ─────────────────────────────────────────────────────────────

const PHOTO_IDS = {
  "cars":["1492144534655-ae79c964c9d7","1544636331-9849d33b2f86","1503376780353-7e6692767b70","1541443131876-3346f4e9d967","1555215695-3004980ad54e","1568605117036-5c2e97b7e3dc","1494976388531-d1058494cdd8","1502877338535-766e1452684a","1583121274602-3e2820c69888","1549317661-bd32c8ce0db2","1504007082539-c3aa2e7f5059","1606016159991-4ce5de1c6d7a","1571019613454-1cb2f99b2d8b","1462396240927-2f87e90f7b9a","1533473359331-0135ef1b58bf"],
  "bikes":["1558618666-fcd25c85cd64","1449426468-f3aa30e3a38e","1622185135505-2d795b710b35","1609630875171-b1321377ee65","1568772585407-9b217eda1c9d","1590762520757-b34b8b0e5eac","1571068316344-75bc9135e2a8","1547549082-7f5a9d606737","1601584674439-6f21ae00f3df","1591637333184-19aa84b3e01f","1506905925346-21bda4d32df4","1604154906893-e0dc76dba35a","1568138085834-b2e65df3b9b5","1519681393784-d120267933ba","1563455176830-f3cdef7a7948"],
  "anime":["1578632767115-351597cf2a0d","1607604276583-edbf35b9b238","1560807707-8cc077767359","1545569341-9eb8b30979d9","1566041510639-8d95a2490bfb","1614309257163-b59a1a5a6c7a","1542751371-adc38448a05e","1610296669489-d9a9d7e3ea4b","1587502536575-6dfba0a6e017","1569701813229-33284b643e3c","1509909756405-be0199881695","1528360983277-13d401cdc186","1534796636912-3b584c7b9f28","1490376197562-a8f07b0da5a1","1464790861760-db3e2f58889a"],
  "scenery":["1506905925346-21bda4d32df4","1464822759023-fed622ff2c3b","1501854140801-50d01698950b","1470770841072-f978cf4d7821","1472214103451-9374f2e987a6","1441974231531-c6227db76b6e","1500534314209-a25ddb2bd429","1505765050516-f72dc64571a3","1447752875215-b2761acb3c5d","1493246507139-91e8fad9978e","1434608519344-49d77a699e1d","1426604966848-d7adac402bff","1469474968028-56623f02e42e","1476514525663-7d9c7e3c5b1d","1519681393784-d120267933ba"],
  "gaming":["1542751371-adc38448a05e","1538481199705-c710c4e965fc","1600861195091-690c92f1d272","1593305841991-05c297ba4575","1607853202273-797f1c22a38e","1612198188060-c7c2a3b66eae","1593508512255-86ab42a8e620","1616588589240-4887ee025abd","1594652634010-275456c808d0","1605647540924-852d61db7c43","1586182987788-f3ccd6cba22a","1547394765-185b5e8cd9a6","1493711662062-fa541adb3fc8","1536098561742-b4e129f3f3fe","1614294149010-950b698f72c0"],
  "fashion":["1469334031218-e382a71b716b","1490481651871-ab68de25d43d","1515886657613-9f3515b0c78f","1539109136881-3be0616acf4b","1524504388868-fd219f6d2f4c","1509631179647-0177331693ae","1483985988355-763728e1e89a","1487222444575-c6e77f85c1f3","1534528741775-53994a69daeb","1571945153237-4929e783af4a","1566479179817-b58be8a52f82","1552902865-b72c031ac5ea","1558769132-cb1aea153895","1567401893414-76b7b1e5a7a5","1558618047-3e6d2f4c0c7a"],
  "nature":["1474511320723-9a56873867b5","1437622368342-7a3d73a34c8f","1518020382113-a7e8fc38eac9","1466611653911-0265b048d87c","1484406566174-5da10a91c9b3","1456926631375-92c8ce872def","1440101197538-f5ac0f5a2c05","1508739773434-c26b3d09e071","1474552226712-ac184aba1e72","1437072397-c80c1e20f9d2","1455849318743-b2233052fcff","1549366021-9f761d040a94","1564349683136-77e08dba1ef7","1553991982-1c18e37d44d0","1516912481851-ca44e7b18d4d"],
  "food":["1540189549336-e6e99eb4b951","1565299624946-b28f40a0ae38","1567620905732-2d1ec7ab7445","1546069901-ba9599a7e63c","1432139555190-58524dae6a55","1414235077428-338989a2e8c0","1568901346375-23c9450c58cd","1565958011703-44f9829ba187","1504674900247-0877df9cc836","1555939594-0c1cdabb406b","1482049016688-2d3e1b311543","1498837167922-ddd27525d352","1484980859896-0bf8b05e7e3d","1606787366850-de6330128bfc","1567188040759-fb8a883dc6d8"],
  "travel":["1503917988258-f87a78e3c995","1499856374338-c63a35f84c5b","1492731890-c3a5d03e7ce4","1520250297959-02c69ace3b35","1501516069584-4e8e959c0a5a","1483347756197-b6bc1765ce3b","1500259783255-2b3fc9a6e22b","1504609773096-104ff2c73ba4","1516483638261-f4dbaf036963","1528702748617-c405b1b84e47","1470004914212-424e97f4b88a","1519046904884-53103b34b206","1547826939-b6bf7b28a45f","1494548162494-384bba1d0d1d","1539651044729-f5c69e438e18"],
  "tech":["1518770660439-4636190af475","1550751827-4bd374c3f58b","1563986288458-f34e2f7d4a6a","1526374965328-7f61d4dc18c5","1516321318423-f06f85e504b3","1451187580459-43490279c0fa","1518096960592-4e0cba5a5bb9","1485827404703-89b55fcc595e","1544197150-b99a580bb7a8","1607706189992-eae32a9f8b44","1624953587687-ae615e49d88b","1615729947596-a598e5de0ab3","1581091226825-a6a2a5aee158","1620712943543-bcc4688e7485","1461749280684-dccba630e2f6"],
  "art":["1541961017774-22349e4a1262","1513364776144-60967b0f800f","1578301978693-85fa9c0320b9","1460661419201-fd4cecdf8a8b","1547826039-a400eb2da2d4","1579783902614-a3fb3927b6a5","1604076913837-52ab5629fde9","1560180474-e8563fd75bab","1573221840310-aba9ab3f2b5f","1518998053901-5348d3961a04","1508700115892-45ecd05ae2ad","1561214115-f2f134cc4912","1589804019355-c23c3d2c7a48","1638803040283-7a5ffd48dad5","1506157786151-b8491531f063"],
  "architecture":["1486325212027-8081e485255e","1512917774240-4993b13ef9b1","1513635269975-59663e0ac1ad","1494526585800-65bba985b41f","1508450859948-4e04fabaa4ea","1477959858617-67f85cf4f1df","1587325241014-60b3c89b0db1","1559136555-9303baea8eae","1545987796-200677720458","1470723255239-ab2b9df2d5a5","1611348586804-61bf6c080437","1568605114967-8130f3a36994","1567177662154-dfbc4f0a69fb","1600585154363-67eb9e2e2099","1587325241014-60b3c89b0db1"],
  "workspace":["1518455027359-f3f8164ba6bd","1497366216548-37526070297c","1497215728317-cf7f4e2e25ad","1593642632559-0c6d3fc62b89","1517694712202-14dd9538aa97","1524758631624-e2822132978f","1527192491265-7e15c55b1ed2","1585771724684-38269d6639fd","1593642634867-5eb5f5e3c95c","1611532736597-de2d4265fba3","1588196749597-9ff075ee6b5b","1486312338219-ce68d2c6f44d","1599687351724-dfa3d4ff5f45","1562516155-e0d5d44b26ad","1448932223592-d1fc686e76ea"],
  "interior design":["1555041469-db61528b393a","1586023492125-27b2c045efd3","1600210492493-0a1c1c8e3a2c","1618221195710-dd6b41faaea6","1505691938895-1758d7feb511","1556020685-b1fc3beae6a1","1583608205776-bfd35f0d9f83","1600566752355-35792bedcfea","1598928506311-c55ded91a20c","1567767292276-6e6bd1b18f9a","1519710164239-da123dc3f738","1561049933-c8fbef47b329","1600047509807-ba8f99d2cdde","1628744448840-55bdb2497bd4","1615529182904-14819c35db37"],
  "ladies accessories":["1515562141207-7a88fb7ce338","1573221840310-aba9ab3f2b5f","1492707731509-56e7a5d69c1b","1611591437281-460bfbe1220a","1590839609626-f3d66e6bb90e","1601821765780-754fa98af5e3","1584917865442-de89df76afd3","1605100804763-247f67b3557e","1625591340274-63ade9d23311","1608667351380-b3b45b39bbb9","1572635196237-14b3f281503f","1526170375885-4d8ecf77b99f","1594938298603-3a08d0d13f8d","1561828995-aa79a2db86dd","1584917865442-de89df76afd3"],
  "tattoos":["1543488702-b933c0e8af43","1568702846914-96b305d2aaeb","1562887245-610b8b8c0d03","1586803253568-8a46a3a9c72c","1526045431048-f857369baa09","1512218215043-40c26d304e4e","1570655653822-9152a5856d5f","1519823572734-fd28f5be9e87","1596386461350-326ccb383e9f","1536329583941-14287ec6fc4e","1522327646785-a07dc3b16fe1","1542736705-af7d77cbe78e","1579546929518-9e396f3cc809","1612532275214-e4ca76d9e5b1","1564349683136-77e08dba1ef7"],
  "plants":["1416879595882-3373a0480b5b","1463936579013-966f9a24c60b","1484318571209-661cf29a69d8","1501004318641-b39e6451bec6","1545241047-6083a3f17943","1518335959124-f4a6c8aa9d48","1555400038-63f5ba517a47","1594139668-de93e7e134c8","1564682895970-0d7e2e71f92c","1585484173835-a787a65a21b1","1600411833200-a7c8c22d5b3c","1610022789602-51fa6e32c53c","1446071236358-8a4a49a3d847","1580906853135-e784c283e54c","1558618047-3e6d2f4c0c7a"],
  "fitness":["1517836357463-d25dfeac3438","1534438327489-9c9f5b3e2ff4","1583454110551-21f2fa2afe61","1571019614242-c5c5dee9f50b","1549060279-7e168fcee0c2","1541534741688-6078c738a63b","1544724107-6d5c4caaac34","1558611439-36efebcd5b02","1556817411-31ae72c54d9f","1526506118085-60ce8714f8c5","1571388208497-36fb79346dcd","1599058917212-d750089bc07b","1567463537571-09a3f0e43ea4","1546519638-68e109498ffc","1539794830467-1f1755804d13"],
  "music":["1511671001456-8c5b7fcb2e50","1493225457124-a3eb161ffa5f","1514320291840-2e0a9bf2a9ae","1516450360452-9312f5e86fc7","1510915361815-ffe5ab25c44b","1571330735066-03aaa9429d89","1519892300165-cb5542fb47c7","1524230572899-a752b3835840","1470229722913-7c0e2dbbafd3","1507838153414-b486b2b0d2c3","1478737270239-2f02b77fc618","1504898770640-29c4fa9b5e94","1557804506-669a67965ba0","1569930030899-6e71b2197cd0","1598387993441-a364f854cfef"],
  "pets":["1543466835-00a7907e9de1","1587300003388-59208cc962cb","1574144611937-0df059b5ef3e","1517849845537-4d257902454a","1574158622682-e719686f9e05","1583511655826-05700d52f4d1","1548681528-6c2ceed91808","1601758123927-4d7cb4d4cb00","1553736435-c8ef7cd87e3b","1518715308788-3005a97f3f3f","1511382686132-4e2dc6e1a33a","1560743641-3914f2c45636","1587300003388-59208cc962cb","1517849845537-4d257902454a","1574158622682-e719686f9e05"],
  "superheroes":["1608889175157-f67ef58e5bc2","1531259683007-c13b0a4cdfa7","1563089145-8a6a00bd3c84","1595769816263-9b910be24d5e","1509347528160-9a9e33742cdb","1608889175157-f67ef58e5bc2","1531259683007-c13b0a4cdfa7","1563089145-8a6a00bd3c84","1595769816263-9b910be24d5e","1509347528160-9a9e33742cdb","1608889175157-f67ef58e5bc2","1531259683007-c13b0a4cdfa7","1563089145-8a6a00bd3c84","1595769816263-9b910be24d5e","1509347528160-9a9e33742cdb"],
  "drinks":["1551024709-8f23c42e6c7a","1546171753-97d7626c6011","1497534446932-3a06972602e3","1560180474-e8563fd75bab","1506377247-f9d6ebf30afe","1544145945-f90425340c7e","1578022761930-4e5e7e0a7a0f","1565299507177-b51e03e39d39","1572635196237-14b3f281503f","1504674900247-0877df9cc836","1555400038-63f5ba517a47","1567188040759-fb8a883dc6d8","1558618047-3e6d2f4c0c7a","1551024709-8f23c42e6c7a","1546171753-97d7626c6011"],
  "flowers":["1490750967868-88df5691b2ba","1508610048-b40a5a5e4a79","1457573430-c2fe1ab2ccd3","1465577512280-1c2d41a79df3","1500530855697-b586d89ba3ee","1508739126509-4c3b07a026ab","1530982011411-54bbdb040c1b","1490750967868-88df5691b2ba","1508610048-b40a5a5e4a79","1457573430-c2fe1ab2ccd3","1465577512280-1c2d41a79df3","1500530855697-b586d89ba3ee","1508739126509-4c3b07a026ab","1530982011411-54bbdb040c1b","1490750967868-88df5691b2ba"]
};

const CARD_HEIGHTS = [680, 750, 700, 820, 660, 780, 720, 800, 640, 760, 710, 770];

// Get the direct Unsplash CDN URL for a verified, category-correct photo
// Same idx always returns same photo (stable layout, no jumping on refresh)
function getPhotoUrl(category, idx) {
  const key  = (category || "scenery").toLowerCase();
  const ids  = PHOTO_IDS[key] || PHOTO_IDS["scenery"];
  const id   = ids[idx % ids.length];
  const h    = CARD_HEIGHTS[idx % CARD_HEIGHTS.length];
  return `https://images.unsplash.com/photo-${id}?w=500&h=${h}&q=80&auto=format&fit=crop`;
}

// Picsum fallback — stable seeded real photos, always loads
function getPicsumUrl(category, idx) {
  const catBase = {"cars":10,"bikes":25,"anime":40,"scenery":55,"gaming":70,"fashion":85,"nature":100,"food":115,"travel":130,"tech":145,"art":160,"architecture":175,"workspace":190,"interior design":205,"ladies accessories":220,"tattoos":235,"plants":250,"fitness":265,"music":280,"pets":295,"superheroes":310,"drinks":325,"flowers":340};
  const base = catBase[(category||"scenery").toLowerCase()] || 50;
  const h    = CARD_HEIGHTS[idx % CARD_HEIGHTS.length];
  return `https://picsum.photos/seed/${base + idx * 3}/500/${h}`;
}

// SVG gradient — absolute last resort, never fails
function makePlaceholder(category, idx, title) {
  const ICON = {"cars":"🚗","bikes":"🏍","anime":"🎌","scenery":"🌄","gaming":"🎮","fashion":"👗","nature":"🌿","food":"🍜","travel":"✈️","tech":"⚡","art":"🎨","architecture":"🏛","workspace":"💻","interior design":"🏠","ladies accessories":"💎","tattoos":"🖊️","plants":"🪴","fitness":"💪","music":"🎵","pets":"🐾","superheroes":"🦸","drinks":"🥃","flowers":"🌸"};
  const GRAD = {"cars":"#0f3460,#e94560","bikes":"#11998e,#38ef7d","anime":"#f093fb,#f5576c","scenery":"#4facfe,#43e97b","gaming":"#302b63,#7c3aed","fashion":"#f7971e,#ffd200","nature":"#134e5e,#71b280","food":"#f46b45,#eea849","travel":"#2980b9,#6dd5fa","tech":"#7c3aed,#06b6d4","art":"#ec008c,#fc6767","architecture":"#2c3e50,#4ca1af","workspace":"#3498db,#2c3e50","interior design":"#d4a574,#6b4c3b","ladies accessories":"#b8860b,#ffd700","tattoos":"#1a1a1a,#8b0000","plants":"#1a4731,#56ab2f","fitness":"#232526,#ff6b6b","music":"#6f0000,#df73ff","pets":"#614385,#516395","superheroes":"#b22222,#1a1a2e","drinks":"#c94b4b,#4b134f","flowers":"#f953c6,#b91d73"};
  const key = (category||"scenery").toLowerCase();
  const icon = ICON[key] || "✦";
  const [c1,c2] = (GRAD[key]||"#7c3aed,#db2777").split(",");
  const h = CARD_HEIGHTS[idx % CARD_HEIGHTS.length];
  const label = (title||"").slice(0,22).replace(/[<>&]/g,"");
  const gid = "g"+((idx*31+(key.charCodeAt(0)||0))%9999);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="${h}"><defs><linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs><rect width="500" height="${h}" fill="url(#${gid})"/><text x="250" y="${Math.floor(h*.43)}" font-size="88" text-anchor="middle" dominant-baseline="middle">${icon}</text><text x="250" y="${Math.floor(h*.61)}" font-size="18" fill="rgba(255,255,255,0.85)" text-anchor="middle" dominant-baseline="middle" font-family="system-ui,sans-serif">${label}</text></svg>`;
  return "data:image/svg+xml;base64,"+btoa(unescape(encodeURIComponent(svg)));
}

// Build discovery cards with category-correct photos in correct order
function getLocalDiscovery(category, page = 1) {
  const key      = (category || "scenery").toLowerCase();
  const cfg      = CAT_CONFIG[key] || CAT_CONFIG["scenery"];
  const PER      = 12;
  const catLabel = key.split(" ").map(w => w[0].toUpperCase()+w.slice(1)).join(" ");

  return Array.from({ length: PER }, (_, i) => {
    const gIdx = (page - 1) * PER + i;
    const tIdx = gIdx % cfg.titles.length; // SAME index for title AND desc — always matched
    return {
      id:          -(800000 + (key.charCodeAt(0)||65)*10000 + gIdx*7 + page*300),
      title:       cfg.titles[tIdx],
      image_url:   getPhotoUrl(key, gIdx),
      thumb_url:   getPicsumUrl(key, gIdx),
      category:    catLabel,
      source:      "discovery",
      saves_count: 0, likes_count: 0,
      difficulty:  (gIdx%3)+1, creativity: (gIdx%3)+3, usefulness: (gIdx%3)+2,
      description: cfg.descs[tIdx], // guaranteed same index as title
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

  // 2. Pixabay — skipped (fetchPixabay requires a user key; handled in backend tier 3)

  // 3. Render backend (tries Unsplash/Pexels server-side if keys set)
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1500); // fast timeout — backend sleeping is common
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

  const ALL_CATEGORIES = Object.keys(CAT_CONFIG);
  const cat = S.filter && S.filter !== "all" ? S.filter.toLowerCase() : null;

  // ── Step 1: Show local discovery images IMMEDIATELY (no backend needed) ──
  let discoveryIdeas = [];
  if (cat) {
    discoveryIdeas = getLocalDiscovery(cat);
  } else {
    // Show 3 categories × 12 cards = 36 cards initially (fast load)
    const shuffled = [...ALL_CATEGORIES].sort(() => Math.random() - 0.5).slice(0, 3);
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

  // Show local images immediately — no wait
  const cat = S.filter && S.filter !== "all" ? S.filter.toLowerCase() : null;
  const ALL_CATS = Object.keys(CAT_CONFIG);
  let localIdeas = [];
  if (cat) {
    // Single category selected: show 24 cards for that category in order
    localIdeas = getLocalDiscovery(cat, 1).concat(getLocalDiscovery(cat, 2));
  } else {
    // All categories: show 4 cards from each for variety (ordered per category)
    localIdeas = ALL_CATS.flatMap(c => getLocalDiscovery(c).slice(0, 4));
  }
  renderGrid(grid, localIdeas);

  // Then enhance with backend content silently
  try {
    const p = new URLSearchParams({ limit:40, sort:"trending" });
    if (S.filter !== "all") p.set("category", S.filter);
    if (S.search) p.set("search", S.search);
    const { ideas } = await apiFetch("GET", `/ideas?${p}`);
    if (ideas?.length) renderGrid(grid, ideas);
  } catch {
    // Backend asleep — local images already showing, nothing to do
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
  "Tattoos":  "Permanent marks made with intention — each one a decision that carries the weight of knowing it will outlast every passing trend.",
  "Plants":   "Living things that ask very little and give a lot back — greenery that makes every space feel more alive and more human.",
  "Fitness":  "The daily practice of showing up for yourself — not for an aesthetic but for the way it makes everything else in life feel more manageable.",
  "Music":    "Sound arranged deliberately to produce feeling — the art form that bypasses every rational defence and gets directly to something essential.",
  "Pets":     "Companionship without agenda — the daily reminder that unconditional presence is among the most valuable things one living thing can offer another.",
  "Superheroes": "Icons of power, justice, and human potential — the myths of our age rendered in colour, action, and conviction.",
  "Drinks":      "The craft of the glass — spirits, technique, and presentation elevated into ritual and genuine sensory pleasure.",
  "Flowers":     "Nature's most concentrated beauty — petals and colour arranged by evolution and human intention in equal measure.",
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

async function navigateModal(dir) {
  const allCards = [...S.allIdeas, ...S.ideas].filter((v,i,a) => a.findIndex(x=>x.id===v.id)===i);
  const idx = allCards.findIndex(x => x.id === S.modalId);
  if (idx < 0) return;
  const next = allCards[idx + dir];
  if (next) openModal(next.id);
}

async function openModal(id) {
  // First try local cache (instant)
  let idea = S.allIdeas.find(x => x.id === id) || S.ideas.find(x => x.id === id) || null;
  // If not in cache and positive id, try backend
  if (!idea && id > 0) {
    try { idea = await apiFetch("GET", `/ideas/${id}`); } catch {}
  }
  if (!idea) return;
  S.modalId = id;

  const diff  = idea.difficulty  || idea.diff  || 3;
  const creat = idea.creativity  || idea.creat || 3;
  const use   = idea.usefulness  || idea.use   || 3;
  const saved = S.savedIds.has(id);

  const mImg = $("modalImg");
  const mCat2 = (idea.category || "scenery").toLowerCase();
  const mSrc2 = idea.image_url || getPhotoUrl(mCat2, 0);
  const mFb12 = idea.thumb_url || getPicsumUrl(mCat2, 0);
  const mFb22 = makePlaceholder(mCat2, 0, idea.title);
  mImg.alt    = idea.title;
  mImg._e1 = 0; mImg._e2 = 0;
  mImg.onerror = function() {
    if (!mImg._e1) { mImg._e1=1; mImg.src=mFb12; return; }
    if (!mImg._e2) { mImg._e2=1; mImg.src=mFb22; mImg.onerror=null; }
  };
  mImg.src = mSrc2;
  $("modalCatTag").textContent = idea.category;
  $("modalTitle").textContent  = idea.title;
  // Always use the card's own description — never override with generic category text
  const catKey2 = (idea.category||"").trim();
  const ideaDesc = (idea.description || "").trim();
  $("modalDesc").textContent = ideaDesc || DESC_MAP[catKey2] || DESC_MAP[catKey2.toLowerCase()] || "";

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

  // ── Filter chip scroll arrow buttons ──────────────────────
  document.addEventListener("click", e => {
    const btn = e.target.closest(".chips-scroll-btn");
    if (!btn) return;
    const chips = document.getElementById(btn.dataset.target);
    if (!chips) return;
    chips.scrollBy({ left: btn.classList.contains("chips-scroll-left") ? -240 : 240, behavior:"smooth" });
  });

  // Drag-to-scroll on filter chips (mouse + touch)
  document.querySelectorAll(".filter-chips").forEach(el => {
    let sx = 0, ss = 0, drag = false;
    el.addEventListener("mousedown",  e => { drag=true; sx=e.pageX; ss=el.scrollLeft; el.style.cursor="grabbing"; e.preventDefault(); });
    el.addEventListener("mouseleave", ()  => { drag=false; el.style.cursor=""; });
    el.addEventListener("mouseup",    ()  => { drag=false; el.style.cursor=""; });
    el.addEventListener("mousemove",  e  => { if (!drag) return; el.scrollLeft = ss - (e.pageX - sx); });
    el.addEventListener("touchstart", e  => { sx=e.touches[0].pageX; ss=el.scrollLeft; }, { passive:true });
    el.addEventListener("touchmove",  e  => { el.scrollLeft = ss - (e.touches[0].pageX - sx); }, { passive:true });
  });

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

  // ── Modal prev/next navigation ─────────────────────────────
  $("modalPrevBtn")?.addEventListener("click", () => navigateModal(-1));
  $("modalNextBtn")?.addEventListener("click", () => navigateModal(+1));
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
    if (e.key === "Escape")      closeModal();
    if (e.key === "ArrowLeft"  && S.modalId) navigateModal(-1);
    if (e.key === "ArrowRight" && S.modalId) navigateModal(+1);
    if (e.key === "/" && document.activeElement !== $("globalSearch")) {
      e.preventDefault();
      $("globalSearch")?.focus();
    }
  });

  // ── Scroll shadow on navbar + back-to-top visibility ────────
  window.addEventListener("scroll", () => {
    $("navbar")?.classList.toggle("scrolled", window.scrollY > 10);
    $("backToTop")?.classList.toggle("visible", window.scrollY > 500);
  }, { passive: true });

  // ── Load more — infinite discovery pages ──────────────────
  // ── INFINITE SCROLL — loads more images forever as you scroll ──
  let _loadingMore = false;

  async function loadMoreIdeas() {
    if (_loadingMore) return;
    _loadingMore = true;

    const spinner = $("loadingSpinner");
    if (spinner) spinner.style.display = "block";

    try {
      const ALL_CATS = Object.keys(CAT_CONFIG);

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

      // Note: we don't call backend on scroll — it causes lag when sleeping
      // Local images load instantly and provide infinite variety

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
  $("newBoardBtn")?.addEventListener("click", showNewBoardModal);
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
