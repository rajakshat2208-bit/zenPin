// ============================================================
// script.js — ZenPin SPA Core
// Fully wired to https://zenpin-api.onrender.com
// ============================================================

const API_URL = "https://zenpin-api.onrender.com";

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────
const S = {
  page:       "home",
  filter:     "all",
  search:     "",
  sort:       "newest",
  loaded:     20,
  savedIds:   new Set(),
  likedIds:   new Set(),
  modalId:    null,
  profileTab: "saved",
  aiHistory:  [],
  ideas:      [],      // live from backend
  allIdeas:   [],      // full cache for offline fallback
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
// DISCOVERY — load images from external API into the feed
// ─────────────────────────────────────────────────────────────

// Map discovery images into idea-like objects for the card renderer
function discoveryToIdeas(images, category) {
  return images.map((img, i) => ({
    id:          -(i + 1),          // Negative IDs = discovery (not in DB)
    title:       img.title || category + " Inspiration",
    image_url:   img.image_url,
    category:    category,
    source:      "discovery",
    saves_count: 0,
    likes_count: 0,
    difficulty:  2,
    creativity:  4,
    usefulness:  3,
    description: img.author ? `Photo by ${img.author}` : "",
  }));
}

async function loadDiscoveryImages(category, page = 1) {
  try {
    const res = await fetch(
      `${API_URL}/images/category?name=${encodeURIComponent(category)}&page=${page}&limit=12`,
      { mode: "cors", credentials: "omit" }
    );
    const data = await res.json();
    return discoveryToIdeas(data.images || [], category);
  } catch (e) {
    console.warn("Discovery load failed:", e);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// PAGE: HOME
// ─────────────────────────────────────────────────────────────
async function initHome() {
  const grid = $("homeGrid");
  if (!grid) return;

  // Show skeleton while loading
  grid.innerHTML = skeletonHTML(10);

  try {
    const params = buildParams();

    // Load DB ideas (creator + seeded discovery posts)
    const { ideas: dbIdeas } = await apiFetch("GET", `/ideas?${params}`);

    // Always load discovery images — use selected category or rotate through all
    const ALL_CATEGORIES = [
      "anime","cars","bikes","scenery","gaming","ladies accessories",
      "interior design","workspace","architecture","art",
      "nature","food","fashion","travel","tech"
    ];
    const cat = S.filter && S.filter !== "all" ? S.filter.toLowerCase() : null;

    // For "all" feed: pick 3 random categories to get variety
    let discoveryIdeas = [];
    if (cat) {
      discoveryIdeas = await loadDiscoveryImages(cat);
    } else {
      // Shuffle and pick 3 categories, load in parallel
      const shuffled = [...ALL_CATEGORIES].sort(() => Math.random() - 0.5).slice(0, 3);
      const results  = await Promise.all(shuffled.map(c => loadDiscoveryImages(c)));
      discoveryIdeas = results.flat();
      // Shuffle the combined list so they mix well
      discoveryIdeas.sort(() => Math.random() - 0.5);
    }

    // Merge: interleave discovery every 4th card for a mixed feel
    const merged = [];
    let di = 0;
    for (let i = 0; i < dbIdeas.length; i++) {
      merged.push(dbIdeas[i]);
      if ((i + 1) % 4 === 0 && di < discoveryIdeas.length) {
        merged.push(discoveryIdeas[di++]);
      }
    }
    // Append remaining discovery images at the end
    while (di < discoveryIdeas.length) merged.push(discoveryIdeas[di++]);

    S.ideas = merged;
    S.allIdeas = merged;
    applySkillFilter();
    renderGrid(grid, S.ideas);
  } catch (e) {
    console.error("initHome error:", e);
    grid.innerHTML = `<div class="load-error">Could not load ideas. Check your connection.</div>`;
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

  // ── Load more (manual + infinite scroll) ──────────────────
  async function loadMoreIdeas() {
    const btn = $("loadMoreBtn");
    if (btn) { btn.classList.add("busy"); btn.querySelector("span").textContent = "Loading…"; }
    try {
      const p = buildParams({ offset: S.loaded });
      const { ideas: newIdeas } = await apiFetch("GET", `/ideas?${p}`);
      // Also fetch next page of discovery images for current category
      let discoveryNew = [];
      const cat = S.filter && S.filter !== "all" ? S.filter : null;
      if (cat) {
        const nextPage = Math.floor(S.loaded / 12) + 2;
        discoveryNew = await loadDiscoveryImages(cat, nextPage);
      }
      const merged = [];
      let di = 0;
      for (let i = 0; i < newIdeas.length; i++) {
        merged.push(newIdeas[i]);
        if ((i + 1) % 4 === 0 && di < discoveryNew.length) merged.push(discoveryNew[di++]);
      }
      while (di < discoveryNew.length) merged.push(discoveryNew[di++]);

      if (!merged.length) { if (btn) btn.style.display = "none"; return; }
      appendGrid($("homeGrid"), merged, S.loaded);
      S.allIdeas = [...S.allIdeas, ...merged];
      S.loaded  += merged.length;
      if (newIdeas.length < 20 && !discoveryNew.length) { if (btn) btn.style.display = "none"; }
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (btn) { btn.classList.remove("busy"); btn.querySelector("span").textContent = "Load more ideas"; }
    }
  }

  $("loadMoreBtn")?.addEventListener("click", loadMoreIdeas);

  // ── Infinite scroll ─────────────────────────────────────
  const _infiniteObserver = new IntersectionObserver(
    entries => { if (entries[0].isIntersecting) loadMoreIdeas(); },
    { rootMargin: "400px" }
  );
  const _sentinel = $("loadMoreBtn");
  if (_sentinel) _infiniteObserver.observe(_sentinel);

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
