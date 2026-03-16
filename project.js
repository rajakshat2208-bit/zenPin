// ============================================================
// project.js — ZenPin Extended Features
//
// Includes:
//  • ProjectMode  — convert ideas → full project with tasks
//  • ExecutionMode— step-by-step guide for each idea
//  • RatingSystem — creativity / difficulty / usefulness display
//  • SkillLevel   — user skill preference (Beginner/Inter/Expert)
//  • Trends       — trending topics discovery page
// ============================================================

// ─────────────────────────────────────────────────────────────
// 1. PROJECT MODE
// ─────────────────────────────────────────────────────────────
const ProjectMode = (() => {

  // Projects stored in localStorage (extend to backend later)
  function getProjects() {
    try { return JSON.parse(localStorage.getItem("zenpin_projects") || "[]"); }
    catch { return []; }
  }

  function saveProjects(projects) {
    localStorage.setItem("zenpin_projects", JSON.stringify(projects));
  }

  function createProject(name, description = "", ideaIds = []) {
    const projects = getProjects();
    const project  = {
      id:          Date.now(),
      name,
      description,
      ideaIds,
      tasks:       [],
      photos:      [],
      progress:    0,
      createdAt:   new Date().toISOString(),
    };
    projects.unshift(project);
    saveProjects(projects);
    return project;
  }

  function getProject(id) {
    return getProjects().find(p => p.id === id) || null;
  }

  function updateProject(id, updates) {
    const projects = getProjects();
    const idx      = projects.findIndex(p => p.id === id);
    if (idx === -1) return null;
    projects[idx]  = { ...projects[idx], ...updates };
    saveProjects(projects);
    return projects[idx];
  }

  function addTask(projectId, taskText) {
    const project = getProject(projectId);
    if (!project) return;
    project.tasks.push({ id: Date.now(), text: taskText, done: false });
    updateProject(projectId, { tasks: project.tasks });
    recalcProgress(projectId);
    return project;
  }

  function toggleTask(projectId, taskId) {
    const project = getProject(projectId);
    if (!project) return;
    project.tasks = project.tasks.map(t =>
      t.id === taskId ? { ...t, done: !t.done } : t
    );
    updateProject(projectId, { tasks: project.tasks });
    recalcProgress(projectId);
  }

  function recalcProgress(projectId) {
    const project = getProject(projectId);
    if (!project || !project.tasks.length) return;
    const done     = project.tasks.filter(t => t.done).length;
    const progress = Math.round((done / project.tasks.length) * 100);
    updateProject(projectId, { progress });
  }

  // ── Render the Project Modal ───────────────────────────────
  function openProjectModal(projectId) {
    const project = getProject(projectId);
    if (!project) return;

    let modal = document.getElementById("projectModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "projectModal";
      modal.innerHTML = `
        <div class="pm-backdrop" id="pmBackdrop"></div>
        <div class="pm-card">
          <button class="pm-close" id="pmClose">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
          <div class="pm-body" id="pmBody"></div>
        </div>`;
      document.body.appendChild(modal);
      document.getElementById("pmBackdrop").onclick = () => modal.classList.remove("open");
      document.getElementById("pmClose").onclick    = () => modal.classList.remove("open");
    }

    renderProjectInModal(project);
    requestAnimationFrame(() => modal.classList.add("open"));
  }

  function renderProjectInModal(project) {
    const el = document.getElementById("pmBody");
    if (!el) return;

    const doneCnt = project.tasks.filter(t => t.done).length;

    el.innerHTML = `
      <div class="pm-header">
        <div class="pm-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
        </div>
        <div>
          <h2 class="pm-title">${project.name}</h2>
          <p class="pm-sub">${project.description || "No description"}</p>
        </div>
      </div>

      <!-- Progress -->
      <div class="pm-section">
        <div class="pm-section-head">
          Progress
          <span class="pm-progress-pct" id="pmPct">${project.progress}%</span>
        </div>
        <div class="pm-progress-bar">
          <div class="pm-progress-fill" id="pmFill" style="width:${project.progress}%"></div>
        </div>
        <div class="pm-progress-sub">${doneCnt} of ${project.tasks.length} tasks done</div>
      </div>

      <!-- Tasks -->
      <div class="pm-section">
        <div class="pm-section-head">Task Checklist</div>
        <div class="pm-task-list" id="pmTaskList">
          ${project.tasks.map(t => `
            <div class="pm-task ${t.done ? "done" : ""}" data-task="${t.id}">
              <div class="pm-task-check ${t.done ? "checked" : ""}">
                ${t.done ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>` : ""}
              </div>
              <span class="pm-task-text">${t.text}</span>
            </div>`).join("") || '<p class="pm-empty">No tasks yet. Add your first one below.</p>'}
        </div>
        <div class="pm-add-task-row">
          <input class="pm-task-input" id="pmTaskInput" type="text" placeholder="Add a task…"/>
          <button class="pm-add-btn" id="pmAddTask">Add</button>
        </div>
      </div>

      <!-- Idea count -->
      <div class="pm-section">
        <div class="pm-section-head">Saved Ideas</div>
        <div class="pm-ideas-info">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--purple,#7c3aed)" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
          ${project.ideaIds.length} ideas linked to this project
        </div>
      </div>`;

    // Wire task interactions
    document.getElementById("pmAddTask").onclick = () => {
      const input = document.getElementById("pmTaskInput");
      if (!input.value.trim()) return;
      addTask(project.id, input.value.trim());
      input.value = "";
      renderProjectInModal(getProject(project.id));
    };
    document.getElementById("pmTaskInput").onkeydown = e => {
      if (e.key === "Enter") document.getElementById("pmAddTask").click();
    };
    document.getElementById("pmTaskList").querySelectorAll(".pm-task").forEach(el => {
      el.addEventListener("click", () => {
        toggleTask(project.id, Number(el.dataset.task));
        renderProjectInModal(getProject(project.id));
      });
    });
  }

  // ── Render project list panel ──────────────────────────────
  function renderProjectList(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const projects = getProjects();
    if (!projects.length) {
      el.innerHTML = `<p class="empty-note">No projects yet. Convert an idea into a project to start!</p>`;
      return;
    }
    el.innerHTML = projects.map(p => `
      <div class="project-card" data-pid="${p.id}">
        <div class="project-card-header">
          <div class="project-card-name">${p.name}</div>
          <div class="project-card-pct">${p.progress}%</div>
        </div>
        <div class="project-mini-bar"><div class="project-mini-fill" style="width:${p.progress}%"></div></div>
        <div class="project-card-meta">${p.tasks.length} tasks · ${p.ideaIds.length} ideas</div>
      </div>`).join("");

    el.querySelectorAll(".project-card").forEach(card => {
      card.addEventListener("click", () => openProjectModal(Number(card.dataset.pid)));
    });
  }

  // ── Convert idea to project (call from modal) ─────────────
  function ideaToProject(idea) {
    if (!Auth.requireAuth(null, "Sign in to create projects")) return;
    const name    = `Project: ${idea.title}`;
    const project = createProject(name, idea.description || "", [idea.id]);

    // Auto-add default tasks based on category
    const DEFAULT_TASKS = {
      "Interior Design": ["Research references","Create mood board","Source materials","Prep the space","Execute and style"],
      "Workspace":       ["Audit current setup","Order items","Cable management","Set up lighting","Final arrangement"],
      "Architecture":    ["Site analysis","Sketch concepts","Develop plans","3D modeling","Presentation"],
      "Art":             ["Gather references","Sketch compositions","Prepare surface","Create artwork","Document and share"],
    };
    const tasks = DEFAULT_TASKS[idea.category] || ["Research","Plan","Execute","Review","Share"];
    tasks.forEach(t => addTask(project.id, t));

    openProjectModal(project.id);
    return project;
  }

  return { getProjects, createProject, getProject, openProjectModal, renderProjectList, ideaToProject, addTask, toggleTask };
})();


// ─────────────────────────────────────────────────────────────
// 2. EXECUTION MODE — step-by-step guide per idea
// ─────────────────────────────────────────────────────────────
const ExecutionMode = (() => {

  const STEPS = {
    "Interior Design": [
      { step:"Define your aesthetic", time:"1–2 hours",  tip:"Browse ZenPin for references. Pin what resonates." },
      { step:"Measure and plan",      time:"2–3 hours",  tip:"Use a floor plan app — RoomSketcher is free." },
      { step:"Source key pieces",     time:"1–2 weeks",  tip:"Start with the largest furniture first." },
      { step:"Paint and prep",        time:"1 weekend",  tip:"Always test paint swatches — lighting changes everything." },
      { step:"Style and layer",       time:"2–4 hours",  tip:"Add rugs, cushions, plants last for personality." },
    ],
    "Workspace": [
      { step:"Audit current setup",   time:"30 min",    tip:"List everything you hate about the current setup." },
      { step:"Design your ideal",     time:"1 hour",    tip:"Sketch it out — even rough drawings help." },
      { step:"Order core items",      time:"30 min",    tip:"Start with monitor arm and desk — everything else fits around those." },
      { step:"Cable management",      time:"2–3 hours", tip:"Buy more cable clips than you think you need." },
      { step:"Final tuning",          time:"1 hour",    tip:"Lighting temperature matters most for focus." },
    ],
    "Architecture": [
      { step:"Site analysis",         time:"1–2 days",  tip:"Sun path, views, and access define the project." },
      { step:"Concept development",   time:"1 week",    tip:"Push your first idea — it's rarely the best." },
      { step:"Schematic design",      time:"2–3 weeks", tip:"Floor plans first, then sections, then elevations." },
      { step:"Design development",    time:"3–4 weeks", tip:"Resolve every detail before documentation." },
      { step:"Documentation",         time:"2–4 weeks", tip:"Use AutoCAD or Revit. Precision is everything." },
    ],
    "Art": [
      { step:"Gather references",     time:"1–2 hours", tip:"Create a dedicated reference folder — screenshot everything." },
      { step:"Thumbnail sketches",    time:"1–2 hours", tip:"Do at least 10 tiny thumbnails before committing." },
      { step:"Prepare your medium",   time:"30 min",    tip:"Prime canvas, prep paper — never skip surface prep." },
      { step:"Block in values",       time:"1–3 hours", tip:"Work from dark to light. Get big shapes right first." },
      { step:"Refine and finish",     time:"2–8 hours", tip:"Know when to stop. Overworking ruins most art." },
    ],
    "Food": [
      { step:"Read recipe through",   time:"15 min",    tip:"Surprises mid-cook are never good." },
      { step:"Mise en place",         time:"30–45 min", tip:"Prep and measure everything before heat touches anything." },
      { step:"Core technique",        time:"30–60 min", tip:"Follow the method exactly the first time." },
      { step:"Taste and adjust",      time:"10 min",    tip:"Season in layers, not all at once at the end." },
      { step:"Plate and photograph",  time:"10 min",    tip:"Natural side-light makes food look incredible." },
    ],
    "Travel": [
      { step:"Research deeply",       time:"2–4 hours", tip:"Read recent blog posts, not just travel guides." },
      { step:"Scout locations",       time:"On arrival", tip:"Visit spots the day before at the time you'll shoot." },
      { step:"Golden hour shoot",     time:"1–2 hours", tip:"Set alarm for 30 min before sunrise. No excuses." },
      { step:"RAW shooting",          time:"Ongoing",   tip:"Shoot in RAW. Always. Storage is cheap, moments aren't." },
      { step:"Edit and share",        time:"2–4 hours", tip:"Lightroom > VSCO. Develop a consistent look." },
    ],
  };

  const COST_MAP = {
    "Interior Design": "$500–$5,000+",
    "Workspace":       "$200–$2,000",
    "Architecture":    "$50,000–$500,000+",
    "Art":             "$20–$500",
    "Food":            "$10–$80",
    "Travel":          "$500–$5,000",
    "Fashion":         "$50–$1,000",
    "Nature":          "$0–$500 (gear)",
    "Tech":            "$50–$2,000",
  };

  const TIME_MAP = {
    "Interior Design": "1–4 weeks",
    "Workspace":       "1–3 days",
    "Architecture":    "3–18 months",
    "Art":             "4–20 hours",
    "Food":            "1–4 hours",
    "Travel":          "3–14 days",
    "Fashion":         "1–4 weeks",
    "Nature":          "1 day",
    "Tech":            "1–4 weeks",
  };

  function getSteps(category) {
    return STEPS[category] || STEPS["Art"];
  }

  function getCost(category) {
    return COST_MAP[category] || "Varies";
  }

  function getTime(category) {
    return TIME_MAP[category] || "Varies";
  }

  // ── Render execution guide into modal ─────────────────────
  function renderExecutionGuide(idea, containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const steps = getSteps(idea.category);
    const cost  = getCost(idea.category);
    const time  = getTime(idea.category);
    const diff  = idea.difficulty || 3;

    el.innerHTML = `
      <div class="exec-meta-row">
        <div class="exec-meta-pill">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          ${time}
        </div>
        <div class="exec-meta-pill">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          ${cost}
        </div>
        <div class="exec-meta-pill">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          Difficulty: ${["", "Very Easy", "Easy", "Moderate", "Hard", "Expert"][diff] || "Moderate"}
        </div>
      </div>

      <div class="exec-steps-list">
        ${steps.map((s, i) => `
          <div class="exec-step" style="animation-delay:${i * 60}ms">
            <div class="exec-step-num">${i + 1}</div>
            <div class="exec-step-body">
              <div class="exec-step-title">${s.step}</div>
              <div class="exec-step-time">⏱ ${s.time}</div>
              <div class="exec-step-tip">💡 ${s.tip}</div>
            </div>
          </div>`).join("")}
      </div>

      <button class="exec-project-btn" id="execToProject">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        Convert to Project
      </button>`;

    document.getElementById("execToProject")?.addEventListener("click", () => {
      ProjectMode.ideaToProject(idea);
    });
  }

  return { getSteps, getCost, getTime, renderExecutionGuide };
})();


// ─────────────────────────────────────────────────────────────
// 3. RATING SYSTEM — display + interact
// ─────────────────────────────────────────────────────────────
const RatingSystem = (() => {

  function starHTML(val, max = 5, color = "#7c3aed") {
    return Array.from({ length: max }, (_, i) => `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="${i < val ? color : "none"}"
           stroke="${color}" stroke-width="1.8" style="opacity:${i < val ? 1 : 0.3}">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
      </svg>`).join("");
  }

  function renderRatingRow(idea, containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `
      <div class="rating-item">
        <div class="rating-item-label">Creativity</div>
        <div class="rating-item-stars">${starHTML(idea.creativity || 3, 5, "#7c3aed")}</div>
        <div class="rating-item-val">${idea.creativity || 3}/5</div>
      </div>
      <div class="rating-item">
        <div class="rating-item-label">Difficulty</div>
        <div class="rating-item-stars">${starHTML(idea.difficulty || 3, 5, "#db2777")}</div>
        <div class="rating-item-val">${idea.difficulty || 3}/5</div>
      </div>
      <div class="rating-item">
        <div class="rating-item-label">Usefulness</div>
        <div class="rating-item-stars">${starHTML(idea.usefulness || 3, 5, "#f97316")}</div>
        <div class="rating-item-val">${idea.usefulness || 3}/5</div>
      </div>`;
  }

  return { starHTML, renderRatingRow };
})();


// ─────────────────────────────────────────────────────────────
// 4. SKILL LEVEL SYSTEM
// ─────────────────────────────────────────────────────────────
const SkillLevel = (() => {
  const LEVELS = { beginner: 1, intermediate: 3, expert: 5 };

  function get() {
    return localStorage.getItem("zenpin_skill") || "all";
  }

  function set(level) {
    localStorage.setItem("zenpin_skill", level);
    // Dispatch event so other modules can react
    window.dispatchEvent(new CustomEvent("zenpin:skillchange", { detail: { level } }));
  }

  function filterIdeas(ideas) {
    const skill = get();
    if (skill === "all") return ideas;
    const maxDiff = LEVELS[skill] || 5;
    return ideas.filter(i => (i.difficulty || 3) <= maxDiff);
  }

  // ── Render skill selector ─────────────────────────────────
  function renderSelector(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const current = get();
    el.innerHTML = `
      <div class="skill-selector">
        <div class="skill-selector-label">Skill Level</div>
        <div class="skill-selector-btns">
          ${[["all","All"],["beginner","Beginner"],["intermediate","Intermediate"],["expert","Expert"]].map(([v, l]) => `
            <button class="skill-btn ${current === v ? "active" : ""}" data-skill="${v}">${l}</button>
          `).join("")}
        </div>
      </div>`;

    el.querySelectorAll(".skill-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        el.querySelectorAll(".skill-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        set(btn.dataset.skill);
      });
    });
  }

  return { get, set, filterIdeas, renderSelector };
})();


// ─────────────────────────────────────────────────────────────
// 5. TREND DISCOVERY
// ─────────────────────────────────────────────────────────────
const Trends = (() => {

  const TREND_DATA = [
    { id:1,  tag:"#JapandiWorkspace",   category:"Workspace",       heat:98, img:"https://images.unsplash.com/photo-1644337540803-2b2fb3cebf12?w=500&q=80", desc:"Minimalist desks with warm wood, ceramic mugs, and zero clutter.", rise:"+340%" },
    { id:2,  tag:"#BrutalistInterior",  category:"Architecture",    heat:92, img:"https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=500&q=80", desc:"Raw concrete walls, exposed pipes, industrial hardware.", rise:"+210%" },
    { id:3,  tag:"#CyberpunkHome",      category:"Interior Design", heat:89, img:"https://images.unsplash.com/photo-1461695008884-244cb4543d74?w=500&q=80", desc:"Neon accents, dark walls, LED strips, futuristic furniture.", rise:"+280%" },
    { id:4,  tag:"#CottageGarden",      category:"Nature",          heat:85, img:"https://images.unsplash.com/photo-1502005229762-cf1b2da7c5d6?w=500&q=80", desc:"Wild English gardens, climbing roses, stone paths.", rise:"+190%" },
    { id:5,  tag:"#WabiSabiHome",       category:"Interior Design", heat:83, img:"https://images.unsplash.com/photo-1553361371-9b22f78e8b1d?w=500&q=80", desc:"Imperfect pottery, linen textiles, earthy tones, raw edges.", rise:"+155%" },
    { id:6,  tag:"#SourdoughArt",       category:"Food",            heat:79, img:"https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=500&q=80", desc:"Intricate scoring patterns on artisan sourdough loaves.", rise:"+420%" },
    { id:7,  tag:"#MacroNature",        category:"Nature",          heat:76, img:"https://images.unsplash.com/photo-1585771724684-38269d6639fd?w=500&q=80", desc:"Ice crystals, moss, dew drops — the world at extreme closeup.", rise:"+160%" },
    { id:8,  tag:"#EditorialFashion",   category:"Fashion",         heat:74, img:"https://images.unsplash.com/photo-1513542789411-b6a5d4f31634?w=500&q=80", desc:"Moody studio shots, architectural silhouettes, monochrome.", rise:"+130%" },
    { id:9,  tag:"#SaltFlatMirror",     category:"Travel",          heat:91, img:"https://images.unsplash.com/photo-1532274402911-5a369e4c4bb5?w=500&q=80", desc:"Uyuni-style reflections, infinity horizons, surreal landscapes.", rise:"+380%" },
    { id:10, tag:"#CircuitArt",         category:"Tech",            heat:67, img:"https://images.unsplash.com/photo-1518770660439-4636190af475?w=500&q=80", desc:"PCB boards as art prints, illuminated circuit photography.", rise:"+95%" },
  ];

  function getAll()  { return TREND_DATA; }
  function getTop(n) { return [...TREND_DATA].sort((a,b) => b.heat - a.heat).slice(0, n); }

  function heatColor(heat) {
    if (heat >= 90) return "#ef4444";
    if (heat >= 80) return "#f97316";
    if (heat >= 70) return "#eab308";
    return "#22c55e";
  }

  // ── Render trends grid ─────────────────────────────────────
  function renderTrendsGrid(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const trends = getAll();
    el.innerHTML = trends.map((t, i) => `
      <div class="trend-card" style="animation-delay:${i * 50}ms">
        <div class="trend-img-wrap">
          <img class="trend-img" src="${t.img}" alt="${t.tag}" loading="lazy"/>
          <div class="trend-overlay">
            <div class="trend-rise">${t.rise}</div>
            <div class="trend-heat-bar">
              <div class="trend-heat-fill" style="width:${t.heat}%;background:${heatColor(t.heat)}"></div>
            </div>
          </div>
          <div class="trend-rank">#${i + 1}</div>
        </div>
        <div class="trend-info">
          <div class="trend-tag">${t.tag}</div>
          <div class="trend-cat-pill">${t.category}</div>
          <p class="trend-desc">${t.desc}</p>
          <div class="trend-heat-row">
            <div class="trend-heat-dot" style="background:${heatColor(t.heat)}"></div>
            <span class="trend-heat-label">${t.heat}/100 heat score</span>
          </div>
        </div>
      </div>`).join("");
  }

  // ── Render compact trending strip ─────────────────────────
  function renderTrendingStrip(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const top = getTop(5);
    el.innerHTML = `
      <div class="trend-strip-label">🔥 Trending 2026</div>
      <div class="trend-strip-items">
        ${top.map(t => `
          <div class="trend-strip-item">
            <img src="${t.img}" alt="${t.tag}" class="trend-strip-img"/>
            <div class="trend-strip-tag">${t.tag}</div>
            <div class="trend-strip-rise" style="color:${heatColor(t.heat)}">${t.rise}</div>
          </div>`).join("")}
      </div>`;
  }

  return { getAll, getTop, renderTrendsGrid, renderTrendingStrip };
})();


// ─────────────────────────────────────────────────────────────
// INJECTED STYLES for all project.js components
// ─────────────────────────────────────────────────────────────
const _projectStyles = document.createElement("style");
_projectStyles.textContent = `

/* ── Project Modal ─────────────────────────── */
#projectModal { position:fixed;inset:0;z-index:9200;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity 0.25s ease; }
#projectModal.open { opacity:1;pointer-events:all; }
.pm-backdrop { position:absolute;inset:0;background:rgba(0,0,0,0.68);backdrop-filter:blur(14px); }
.pm-card { position:relative;background:white;border-radius:24px;padding:32px;max-width:540px;width:calc(100% - 40px);max-height:85vh;overflow-y:auto;box-shadow:0 32px 100px rgba(0,0,0,0.24);animation:pmSlide 0.38s cubic-bezier(0.34,1.1,0.64,1) both;scrollbar-width:thin; }
@keyframes pmSlide{from{transform:translateY(28px) scale(0.97);opacity:0}to{transform:translateY(0) scale(1);opacity:1}}
.pm-close { position:absolute;top:16px;right:16px;width:34px;height:34px;border-radius:50%;background:#f4f3f0;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#6b6560;transition:background 0.15s; }
.pm-close:hover { background:#e5e4e0; }
.pm-header { display:flex;align-items:flex-start;gap:14px;margin-bottom:24px; }
.pm-icon { width:50px;height:50px;flex-shrink:0;background:linear-gradient(135deg,#7c3aed,#db2777);border-radius:14px;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 18px rgba(124,58,237,0.35); }
.pm-title { font-family:'Playfair Display',Georgia,serif;font-size:1.3rem;font-weight:900;letter-spacing:-0.02em;margin-bottom:4px; }
.pm-sub { font-size:0.82rem;color:#6b6560; }
.pm-section { margin-bottom:22px; }
.pm-section-head { font-size:0.72rem;font-weight:800;color:#a39d97;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between; }
.pm-progress-bar { height:8px;background:#f0f0ef;border-radius:4px;overflow:hidden;margin-bottom:5px; }
.pm-progress-fill { height:100%;background:linear-gradient(90deg,#7c3aed,#db2777);border-radius:4px;transition:width 0.5s ease; }
.pm-progress-pct { font-size:0.82rem;font-weight:800;background:linear-gradient(135deg,#7c3aed,#db2777);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent; }
.pm-progress-sub { font-size:0.75rem;color:#a39d97; }
.pm-task-list { display:flex;flex-direction:column;gap:8px;margin-bottom:12px; }
.pm-task { display:flex;align-items:center;gap:10px;padding:10px 12px;border:1.5px solid #eee;border-radius:11px;cursor:pointer;transition:all 0.15s; }
.pm-task:hover { border-color:rgba(124,58,237,0.25);background:rgba(124,58,237,0.02); }
.pm-task.done { opacity:0.55; }
.pm-task.done .pm-task-text { text-decoration:line-through;color:#a39d97; }
.pm-task-check { width:20px;height:20px;border-radius:6px;border:2px solid #d1d5db;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s; }
.pm-task-check.checked { background:linear-gradient(135deg,#7c3aed,#db2777);border-color:transparent; }
.pm-task-text { font-size:0.875rem; }
.pm-add-task-row { display:flex;gap:8px; }
.pm-task-input { flex:1;height:38px;padding:0 14px;background:#f9fafb;border:1.5px solid #e5e7eb;border-radius:10px;font-size:0.85rem;outline:none;transition:border-color 0.15s; }
.pm-task-input:focus { border-color:#7c3aed; }
.pm-add-btn { height:38px;padding:0 16px;background:linear-gradient(135deg,#7c3aed,#db2777);color:white;border:none;border-radius:10px;font-size:0.82rem;font-weight:700;cursor:pointer;transition:transform 0.15s; }
.pm-add-btn:hover { transform:scale(1.04); }
.pm-ideas-info { display:flex;align-items:center;gap:8px;font-size:0.85rem;color:#374151;padding:10px 14px;background:#f9fafb;border-radius:10px; }
.pm-empty { font-size:0.82rem;color:#a39d97;padding:4px 0; }

/* Project list cards */
.project-card { background:white;border:1.5px solid #eee;border-radius:14px;padding:16px;cursor:pointer;transition:all 0.2s;margin-bottom:10px; }
.project-card:hover { border-color:rgba(124,58,237,0.25);transform:translateY(-2px);box-shadow:0 6px 20px rgba(0,0,0,0.07); }
.project-card-header { display:flex;align-items:center;justify-content:space-between;margin-bottom:8px; }
.project-card-name { font-weight:700;font-size:0.9rem; }
.project-card-pct { font-size:0.8rem;font-weight:800;background:linear-gradient(135deg,#7c3aed,#db2777);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent; }
.project-mini-bar { height:5px;background:#f0f0ef;border-radius:3px;overflow:hidden;margin-bottom:6px; }
.project-mini-fill { height:100%;background:linear-gradient(90deg,#7c3aed,#db2777);border-radius:3px; }
.project-card-meta { font-size:0.72rem;color:#a39d97; }

/* ── Execution Mode ────────────────────────── */
.exec-meta-row { display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px; }
.exec-meta-pill { display:flex;align-items:center;gap:6px;padding:5px 12px;background:#f4f3f0;border-radius:999px;font-size:0.75rem;font-weight:700;color:#374151; }
.exec-steps-list { display:flex;flex-direction:column;gap:12px;margin-bottom:20px; }
.exec-step { display:flex;gap:13px;align-items:flex-start;animation:cardin2 0.5s both; }
@keyframes cardin2{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
.exec-step-num { width:28px;height:28px;flex-shrink:0;background:linear-gradient(135deg,#7c3aed,#db2777);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.65rem;font-weight:800;color:white;margin-top:1px; }
.exec-step-body { flex:1; }
.exec-step-title { font-weight:700;font-size:0.875rem;margin-bottom:3px; }
.exec-step-time { font-size:0.72rem;color:#a39d97;margin-bottom:3px; }
.exec-step-tip { font-size:0.78rem;color:#6b6560;font-style:italic;line-height:1.5; }
.exec-project-btn { width:100%;height:44px;background:linear-gradient(135deg,#7c3aed,#db2777,#f97316);color:white;border:none;border-radius:12px;font-size:0.875rem;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 4px 16px rgba(124,58,237,0.3);transition:all 0.2s; }
.exec-project-btn:hover { transform:translateY(-2px);box-shadow:0 8px 24px rgba(124,58,237,0.45); }

/* ── Rating System ─────────────────────────── */
.rating-item { display:flex;align-items:center;gap:10px;padding:8px 12px;background:#f9fafb;border-radius:10px; }
.rating-item-label { font-size:0.72rem;font-weight:800;color:#6b6560;text-transform:uppercase;letter-spacing:0.04em;width:80px; }
.rating-item-stars { display:flex;gap:2px; }
.rating-item-val { font-size:0.72rem;font-weight:700;color:#a39d97;margin-left:auto; }

/* ── Skill Level ───────────────────────────── */
.skill-selector { display:flex;align-items:center;gap:10px;flex-wrap:wrap; }
.skill-selector-label { font-size:0.72rem;font-weight:800;color:#a39d97;letter-spacing:0.05em;text-transform:uppercase; }
.skill-selector-btns { display:flex;gap:6px; }
.skill-btn { padding:5px 14px;background:white;border:1.5px solid #e5e7eb;border-radius:999px;font-size:0.75rem;font-weight:700;color:#374151;cursor:pointer;transition:all 0.15s; }
.skill-btn:hover { border-color:rgba(124,58,237,0.3);background:rgba(124,58,237,0.04);color:#7c3aed; }
.skill-btn.active { background:linear-gradient(135deg,#7c3aed,#db2777);border-color:transparent;color:white;box-shadow:0 3px 12px rgba(124,58,237,0.32); }

/* ── Trends ────────────────────────────────── */
.trend-card { background:white;border-radius:18px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);cursor:pointer;transition:all 0.22s;animation:cardin2 0.5s both; }
.trend-card:hover { transform:translateY(-5px);box-shadow:0 10px 32px rgba(0,0,0,0.12); }
.trend-img-wrap { position:relative;overflow:hidden;aspect-ratio:16/9; }
.trend-img { width:100%;height:100%;object-fit:cover;transition:transform 0.5s; }
.trend-card:hover .trend-img { transform:scale(1.06); }
.trend-overlay { position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.7),transparent);display:flex;flex-direction:column;justify-content:flex-end;padding:14px; }
.trend-rise { font-size:1.1rem;font-weight:900;color:#4ade80;margin-bottom:6px; }
.trend-heat-bar { height:4px;background:rgba(255,255,255,0.2);border-radius:2px;overflow:hidden; }
.trend-heat-fill { height:100%;border-radius:2px; }
.trend-rank { position:absolute;top:12px;left:12px;width:32px;height:32px;background:rgba(255,255,255,0.9);backdrop-filter:blur(8px);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.72rem;font-weight:800;color:#1a1714; }
.trend-info { padding:14px 16px; }
.trend-tag { font-weight:800;font-size:0.95rem;margin-bottom:5px;letter-spacing:-0.01em; }
.trend-cat-pill { display:inline-flex;padding:3px 10px;background:rgba(124,58,237,0.07);border-radius:999px;font-size:0.62rem;font-weight:700;color:#7c3aed;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:8px; }
.trend-desc { font-size:0.8rem;color:#6b6560;line-height:1.55;margin-bottom:10px; }
.trend-heat-row { display:flex;align-items:center;gap:7px; }
.trend-heat-dot { width:8px;height:8px;border-radius:50%; }
.trend-heat-label { font-size:0.7rem;font-weight:700;color:#a39d97; }

/* Trend strip */
.trend-strip-label { font-size:0.72rem;font-weight:800;color:#a39d97;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:10px; }
.trend-strip-items { display:flex;gap:10px;overflow-x:auto;scrollbar-width:none;padding-bottom:4px; }
.trend-strip-items::-webkit-scrollbar { display:none; }
.trend-strip-item { flex-shrink:0;width:110px;cursor:pointer;transition:transform 0.2s; }
.trend-strip-item:hover { transform:translateY(-3px); }
.trend-strip-img { width:110px;height:70px;object-fit:cover;border-radius:10px;margin-bottom:5px; }
.trend-strip-tag { font-size:0.68rem;font-weight:700;line-height:1.3;margin-bottom:2px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical; }
.trend-strip-rise { font-size:0.65rem;font-weight:800; }
`;
document.head.appendChild(_projectStyles);
