/* ===============================
   ZenPin Frontend API Connection
================================ */

const API_URL = "http://localhost:8000";

/* Fetch ideas from backend */
async function fetchIdeasFromAPI() {
  try {

    const response = await fetch(`${API_URL}/ideas`);
    const data = await response.json();

    if (data.ideas && data.ideas.length > 0) {

      // clear demo ideas
      IDEAS.length = 0;

      data.ideas.forEach(idea => {

        IDEAS.push({
          id: idea.id,
          img: idea.image_url,
          category: idea.category,
          title: idea.title,
          diff: idea.difficulty || 3,
          creat: idea.creativity || 3,
          use: idea.usefulness || 3,
          saves: idea.saves_count || 0,
          likes: idea.likes_count || 0,
          h: 320
        });

      });

    }

    initHome();

  } catch (error) {

    console.error("Failed to connect to ZenPin API:", error);

  }
}
const IDEAS = [
  { id:1,  img:"https://images.unsplash.com/photo-1705321963943-de94bb3f0dd3?w=500&q=80", category:"Interior Design",  title:"Japandi Living Room Refresh",         diff:3, creat:5, use:4, saves:8420, likes:3200, h:320 },
  { id:2,  img:"https://images.unsplash.com/photo-1644337540803-2b2fb3cebf12?w=500&q=80", category:"Workspace",         title:"Minimal Oak Desk Setup",              diff:2, creat:4, use:5, saves:6100, likes:2800, h:260 },
  { id:3,  img:"https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=500&q=80", category:"Architecture",      title:"Brutalist Concrete Staircase",        diff:4, creat:5, use:2, saves:9300, likes:4400, h:380 },
  { id:4,  img:"https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?w=500&q=80", category:"Interior Design",  title:"Curved Plaster Arch Alcove",          diff:5, creat:5, use:3, saves:7700, likes:3900, h:290 },
  { id:5,  img:"https://images.unsplash.com/photo-1476357471311-43c0db9fb2b4?w=500&q=80", category:"Art",              title:"Generative Geometry Study #12",       diff:3, creat:5, use:2, saves:5500, likes:2100, h:340 },
  { id:6,  img:"https://images.unsplash.com/photo-1543966888-7c1dc482a810?w=500&q=80", category:"Fashion",           title:"Textural Linen Layering",             diff:2, creat:4, use:3, saves:4200, likes:1900, h:410 },
  { id:7,  img:"https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=500&q=80", category:"Food",             title:"Sourdough Scoring Patterns",          diff:3, creat:4, use:5, saves:3800, likes:1700, h:260 },
  { id:8,  img:"https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=500&q=80", category:"Travel",           title:"Fjord Ferry Crossing at Dusk",        diff:1, creat:5, use:3, saves:11200,likes:5600, h:300 },
  { id:9,  img:"https://images.unsplash.com/photo-1585771724684-38269d6639fd?w=500&q=80", category:"Nature",           title:"Ice Crystal Macro Study",             diff:3, creat:5, use:2, saves:7800, likes:3300, h:350 },
  { id:10, img:"https://images.unsplash.com/photo-1518770660439-4636190af475?w=500&q=80", category:"Tech",             title:"Circuit Board Abstraction",           diff:4, creat:4, use:4, saves:4600, likes:2200, h:280 },
  { id:11, img:"https://images.unsplash.com/photo-1449824913935-59a10b8d2000?w=500&q=80", category:"Architecture",     title:"Glass Tower Blue Hour",               diff:2, creat:5, use:2, saves:8900, likes:4100, h:420 },
  { id:12, img:"https://images.unsplash.com/photo-1553361371-9b22f78e8b1d?w=500&q=80", category:"Interior Design",  title:"Wabi-Sabi Earthy Bedroom",            diff:3, creat:5, use:4, saves:6700, likes:2900, h:260 },
  { id:13, img:"https://images.unsplash.com/photo-1502005229762-cf1b2da7c5d6?w=500&q=80", category:"Nature",           title:"Desert Dunes Golden Hour",            diff:1, creat:4, use:2, saves:9100, likes:4800, h:310 },
  { id:14, img:"https://images.unsplash.com/photo-1487014679447-9f8336841d58?w=500&q=80", category:"Art",              title:"Ink Wash on Rice Paper",              diff:4, creat:5, use:2, saves:5300, likes:2400, h:370 },
  { id:15, img:"https://images.unsplash.com/photo-1558618047-3c8c76ca7d13?w=500&q=80", category:"Workspace",         title:"Terracotta Ceramic Desk Accents",     diff:2, creat:4, use:4, saves:3900, likes:1800, h:240 },
  { id:16, img:"https://images.unsplash.com/photo-1513542789411-b6a5d4f31634?w=500&q=80", category:"Fashion",          title:"Monochrome Editorial in Fog",         diff:3, creat:5, use:2, saves:7200, likes:3500, h:380 },
  { id:17, img:"https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=500&q=80", category:"Food",             title:"Japanese Breakfast Bird's Eye",       diff:2, creat:4, use:5, saves:4800, likes:2200, h:260 },
  { id:18, img:"https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=500&q=80", category:"Travel",            title:"Narrow Streets of Old Lisbon",        diff:1, creat:4, use:3, saves:8300, likes:3700, h:320 },
  { id:19, img:"https://images.unsplash.com/photo-1461695008884-244cb4543d74?w=500&q=80", category:"Tech",             title:"LED Neon Sign Workshop",              diff:4, creat:5, use:3, saves:5100, likes:2300, h:290 },
  { id:20, img:"https://images.unsplash.com/photo-1532274402911-5a369e4c4bb5?w=500&q=80", category:"Travel",           title:"Salt Flats Mirror at Sunset",         diff:1, creat:5, use:2, saves:10500,likes:5200, h:340 },
  { id:21, img:"https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=500&q=80", category:"Interior Design",  title:"Curved Sectional in Cream Boucle",    diff:3, creat:4, use:4, saves:5600, likes:2500, h:300 },
  { id:22, img:"https://images.unsplash.com/photo-1600121848594-d8644e57abab?w=500&q=80", category:"Architecture",     title:"Japanese Minimal Courtyard",          diff:2, creat:5, use:3, saves:8800, likes:4200, h:350 },
  { id:23, img:"https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=500&q=80", category:"Art",              title:"Abstract Risograph Print",            diff:3, creat:5, use:2, saves:4300, likes:1900, h:280 },
  { id:24, img:"https://images.unsplash.com/photo-1551218808-94e220e084d2?w=500&q=80", category:"Food",              title:"Handmade Pasta on Marble",            diff:2, creat:4, use:5, saves:3700, likes:1600, h:260 },
  { id:25, img:"https://images.unsplash.com/photo-1532274402911-5a369e4c4bb5?w=500&q=80", category:"Nature",           title:"Alpine Lake at Dawn",                 diff:1, creat:5, use:2, saves:12400,likes:6100, h:350 },
];

const BOARDS = [
  { id:"b1", name:"Japandi Interiors",   count:42, imgs:[1,3,12,4] },
  { id:"b2", name:"Workspace Inspo",     count:28, imgs:[2,15,10,19] },
  { id:"b3", name:"Architecture Dreams", count:67, imgs:[3,11,22,8] },
  { id:"b4", name:"Food & Mood",         count:19, imgs:[7,17,24,14] },
];

const COLLAB_BOARDS = [
  { id:"cb1", name:"Studio Redesign 2025",  desc:"Collaborative moodboard for our studio refresh project.", members:["Y","A","S","M"] },
  { id:"cb2", name:"Brand Campaign Q3",     desc:"Visual direction for upcoming campaign assets.",           members:["Y","J","K"]     },
  { id:"cb3", name:"Product Launch Vibes",  desc:"Gathering references for the new product visual identity.",members:["Y","A","L","P"] },
];

const AV_COLORS = [
  "linear-gradient(135deg,#7c3aed,#ec4899)",
  "linear-gradient(135deg,#f97316,#ec4899)",
  "linear-gradient(135deg,#06b6d4,#7c3aed)",
  "linear-gradient(135deg,#10b981,#3b82f6)",
  "linear-gradient(135deg,#f59e0b,#ef4444)",
];

const STEPS = {
  "Interior Design": ["Measure and plan the space","Create a mood board with references","Source materials and key furniture","Clear and prep the room","Install, layer, and style"],
  "Workspace":       ["Audit your current setup","List needed upgrades and new items","Order components and furniture","Handle cable management first","Final styling and lighting"],
  "Architecture":    ["Research precedents and context","Sketch concept ideas and massing","Develop floor plan and sections","3D model exploration and iteration","Refine, document, and present"],
  "Art":             ["Gather reference images","Sketch thumbnail compositions","Prepare your surface and medium","Block in major shapes and values","Refine, detail, and finish"],
  "Fashion":         ["Sketch the initial design","Choose fabric, color, and texture","Create and adjust pattern pieces","Cut, baste, and fit first mockup","Sew, finish, and photograph"],
  "Food":            ["Gather and prep all ingredients","Mise en place — everything in order","Follow the core technique carefully","Taste, adjust seasoning and texture","Plate thoughtfully and photograph"],
  "Travel":          ["Research the destination thoroughly","Plan golden-hour and blue-hour shots","Pack minimal, high-quality gear","Shoot in RAW format with intention","Edit, export, and share the story"],
  "Nature":          ["Scout the location the day before","Arrive before sunrise or at dusk","Use manual focus for precision","Bracket exposures for safety","Process carefully in Lightroom"],
  "Tech":            ["Define clear requirements upfront","Source all components and tools","Prototype on breadboard first","Test thoroughly and iterate","Solder final build and document"],
};

const TOOLS = {
  "Interior Design": ["Mood Board Kit","Paint Swatches","3D Space Planner","Fabric Samples","CAD Software"],
  "Workspace":       ["Monitor Arm","Cable Management Kit","LED Strip Lights","Desk Organizer","Anti-fatigue Mat"],
  "Architecture":    ["AutoCAD","Revit","SketchUp","Rhino 3D","Adobe InDesign"],
  "Art":             ["Procreate","Lino Cutter","Printing Press","Watercolor Set","Gesso + Canvas"],
  "Fashion":         ["Sewing Machine","Pattern Paper","Dressmaker's Scissors","Mannequin","Serger"],
  "Food":            ["Stand Mixer","Proofing Basket","Dutch Oven","Bench Scraper","Kitchen Scale"],
  "Travel":          ["Sony A7 Camera","Tripod","ND Filter Set","Drone","Adobe Lightroom"],
  "Nature":          ["Macro Lens","Field Journal","Plant Press","Cable Release","Lightroom Classic"],
  "Tech":            ["Soldering Iron","Oscilloscope","Arduino Uno","3D Printer","Digital Multimeter"],
};

const DESCS = {
  "Interior Design": "A thoughtfully curated space that balances aesthetics with functionality. This approach emphasises natural materials, intentional layering, and a restrained palette to create an environment that feels both calm and inspiring.",
  "Workspace":       "An optimised workspace designed to maximise focus and creative output. Every element is considered — from cable management to lighting temperature — creating ideal conditions for deep work and flow states.",
  "Architecture":    "A bold architectural statement that challenges conventional form. The interplay of light, material, and structure creates a space that rewards close observation with unexpected details at every scale.",
  "Art":             "An exploration of texture, form, and conceptual depth. This piece invites a dialogue between process and finished work, with each mark carrying the weight of deliberate intention.",
  "Fashion":         "A study in material consciousness and silhouette experimentation — exploring the tension between structure and flow, comfort and presence, tradition and contemporary sensibility.",
  "Food":            "A culinary exploration rooted in seasonal ingredients and classical technique. The result surprises with its simplicity — each element present for a clear reason, nothing superfluous.",
  "Travel":          "A visual document of a place at a specific moment. The photograph captures not just light and geometry, but atmosphere — the ineffable quality of being somewhere fully present.",
  "Nature":          "An intimate encounter with the natural world at an unfamiliar scale. Patient observation and technical precision combine to reveal structures of extraordinary beauty hiding in plain sight.",
  "Tech":            "A project at the intersection of form and function, where engineering constraints become design opportunities. The build process itself is part of the art.",
};

const AI_SEED_MAP = {
  "wabi":    [1,12,9,4,13,14],
  "cyber":   [10,19,5,11,16,3],
  "cottage": [13,9,7,17,6,14],
  "brutal":  [3,11,4,22,8,5],
  "pastel":  [15,6,16,17,23,7],
  "minimal": [2,15,1,12,4,22],
  "modern":  [1,11,3,10,2,19],
  "nature":  [9,13,20,25,8,14],
  "food":    [7,17,24,6,14,5],
  "travel":  [8,18,20,25,13,19],
};

const S = { page:"home", filter:"all", search:"", savedIds:new Set(), likedIds:new Set(), loaded:20, modalId:null, profileTab:"saved", aiHistory:[] };

const D = id => document.getElementById(id);
const DOM = {
  navbar:D("navbar"), globalSearch:D("globalSearch"), hamburger:D("hamburger"), navLinks:D("navLinks"),
  homeGrid:D("homeGrid"), exploreGrid:D("exploreGrid"), homeFilters:D("homeFilters"),
  exploreFilters:D("exploreFilters"), homeSort:D("homeSort"), loadMoreBtn:D("loadMoreBtn"),
  boardsGrid:D("boardsGrid"), collabBoardsList:D("collabBoardsList"), collabCanvas:D("collabCanvas"),
  canvasHint:D("canvasHint"), pinIdeaList:D("pinIdeaList"), chatMsgs:D("chatMsgs"),
  chatInput:D("chatInput"), chatSendBtn:D("chatSendBtn"), aiInput:D("aiInput"),
  aiGenBtn:D("aiGenBtn"), aiLoading:D("aiLoading"), aiOutput:D("aiOutput"),
  aiOutputTitle:D("aiOutputTitle"), aiGrid:D("aiGrid"), aiHistoryList:D("aiHistoryList"),
  aiSaveBtn:D("aiSaveBtn"), profileGrid:D("profileGrid"), profileTabsBar:D("profileTabsBar"),
  modalBackdrop:D("modalBackdrop"), modalCloseBtn:D("modalCloseBtn"), modalImg:D("modalImg"),
  modalCatTag:D("modalCatTag"), modalTitle:D("modalTitle"), modalRatings:D("modalRatings"),
  modalDesc:D("modalDesc"), modalSteps:D("modalSteps"), modalTools:D("modalTools"),
  modalSaveBtn:D("modalSaveBtn"), relatedRow:D("relatedRow"), toastBar:D("toastBar"), toastText:D("toastText"),
};

const fmt = n => n >= 1000 ? (n/1000).toFixed(1).replace(".0","")+"k" : String(n);
const byId = id => IDEAS.find(i => i.id === id);

function stars(val, cls) {
  return Array.from({length:5},(_,i) => `<div class="rb-star ${i<val?"on-"+cls:""}"></div>`).join("");
}
function modalStars(val) {
  return Array.from({length:5},(_,i) => `<div class="mr-dot ${i<val?"on":""}"></div>`).join("");
}
function filtered(pool) {
  return (pool||IDEAS.slice(0,S.loaded)).filter(idea => {
    const cat  = S.filter==="all" || idea.category===S.filter;
    const srch = !S.search || idea.title.toLowerCase().includes(S.search.toLowerCase()) || idea.category.toLowerCase().includes(S.search.toLowerCase());
    return cat && srch;
  });
}

function cardHTML(idea, idx) {
  const saved = S.savedIds.has(idea.id);
  const liked = S.likedIds.has(idea.id);
  return `
<div class="idea-card" data-id="${idea.id}" style="--i:${idx}">
  <div class="card-img-wrap">
    <img class="card-img" src="${idea.img}" alt="${idea.title}" loading="lazy" height="${idea.h}"/>
    <div class="card-static-cat">${idea.category}</div>
    <div class="card-overlay">
      <div class="card-top-row">
        <button class="card-ico-btn ${liked?"heart-on":""}" data-action="like" data-id="${idea.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="${liked?"currentColor":"none"}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        </button>
        <button class="card-ico-btn ${saved?"save-on":""}" data-action="save" data-id="${idea.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="${saved?"currentColor":"none"}" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
        </button>
      </div>
      <div class="card-bot-row">
        <div class="card-cat-pill">${idea.category}</div>
        <div class="card-title">${idea.title}</div>
        <div class="card-ratings">
          <div class="rating-badge"><span class="rb-label">Diff</span><div class="rb-stars">${stars(idea.diff,"blue")}</div></div>
          <div class="rating-badge"><span class="rb-label">Create</span><div class="rb-stars">${stars(idea.creat,"purple")}</div></div>
          <div class="rating-badge"><span class="rb-label">Use</span><div class="rb-stars">${stars(idea.use,"green")}</div></div>
        </div>
      </div>
    </div>
  </div>
  <div class="card-footer">
    <div class="card-saves">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
      ${fmt(idea.saves+(saved?1:0))}
    </div>
  </div>
</div>`;
}

function renderGrid(container, ideas) {
  if (!container) return;
  container.innerHTML = ideas.map((idea,i) => cardHTML(idea,i)).join("");
}
function appendGrid(container, ideas, startIdx) {
  if (!container) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = ideas.map((idea,i) => cardHTML(idea,startIdx+i)).join("");
  while (tmp.firstChild) container.appendChild(tmp.firstChild);
}

function go(page) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const el = document.getElementById("page-"+page);
  if (el) el.classList.add("active");
  document.querySelectorAll(".nav-link").forEach(l => l.classList.toggle("active", l.dataset.page===page));
  document.getElementById("navProfileBtn").classList.toggle("active", page==="profile");
  S.page = page;
  window.scrollTo({top:0,behavior:"smooth"});
  ({home:initHome,explore:initExplore,boards:initBoards,collab:initCollab,ai:initAI,profile:initProfile}[page]||(() => {}))();
}

function initHome()    { renderGrid(DOM.homeGrid, filtered(IDEAS.slice(0,S.loaded))); }
function initExplore() { renderGrid(DOM.exploreGrid, filtered(IDEAS)); }

function initBoards() {
  DOM.boardsGrid.innerHTML = BOARDS.map((b,i) => {
    const imgs = b.imgs.slice(0,3).map(id => { const idea=byId(id); return `<div class="bm-img">${idea?`<img src="${idea.img}" alt="" loading="lazy"/>`:"" }</div>`; }).join("") + `<div class="bm-img" style="background:var(--surface-2)"></div>`;
    return `<div class="board-card" data-board="${b.id}" style="--i:${i}"><div class="board-mosaic">${imgs}</div><div class="board-info"><div class="board-name">${b.name}</div><div class="board-cnt">${b.count} ideas</div></div></div>`;
  }).join("");
  DOM.collabBoardsList.innerHTML = COLLAB_BOARDS.map((cb,i) => {
    const avs = cb.members.map((m,j) => `<div class="cboard-av" style="background:${AV_COLORS[j%AV_COLORS.length]}">${m}</div>`).join("");
    return `<div class="cboard-card" style="--i:${i}"><div class="cboard-header"><div class="cboard-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div><div class="cboard-name">${cb.name}</div></div><p class="cboard-desc">${cb.desc}</p><div class="cboard-members">${avs}<span class="cboard-member-cnt">${cb.members.length} collaborators</span></div></div>`;
  }).join("");
}

function initCollab() {
  DOM.pinIdeaList.innerHTML = IDEAS.slice(0,10).map(idea => `<div class="pin-idea-item" data-pin-id="${idea.id}"><img class="pin-idea-thumb" src="${idea.img}" alt="${idea.title}" loading="lazy"/><span class="pin-idea-name">${idea.title}</span></div>`).join("");
  IDEAS.slice(0,4).forEach((idea,i) => {
    const pos = [{top:"12%",left:"8%"},{top:"38%",left:"32%"},{top:"16%",left:"57%"},{top:"52%",left:"12%"}];
    addPin(idea, pos[i].top, pos[i].left);
  });
  DOM.canvasHint.style.display = "none";
}

function addPin(idea, top, left) {
  const pin = document.createElement("div");
  pin.className = "pinned-card";
  pin.style.top = top; pin.style.left = left;
  pin.innerHTML = `<img src="${idea.img}" alt="${idea.title}" loading="lazy"/><div class="pinned-card-label">${idea.title.substring(0,24)}…</div>`;
  DOM.collabCanvas.appendChild(pin);
  makeDraggable(pin);
}

function makeDraggable(el) {
  let ox,oy,drag=false;
  el.addEventListener("mousedown", e => { drag=true; const r=el.getBoundingClientRect(); ox=e.clientX-r.left; oy=e.clientY-r.top; el.style.transition="none"; el.style.zIndex=99; e.preventDefault(); });
  document.addEventListener("mousemove", e => { if(!drag)return; const pr=el.parentElement.getBoundingClientRect(); el.style.left=Math.max(0,Math.min(pr.width-el.offsetWidth,e.clientX-pr.left-ox))+"px"; el.style.top=Math.max(0,Math.min(pr.height-el.offsetHeight,e.clientY-pr.top-oy))+"px"; });
  document.addEventListener("mouseup", () => { if(!drag)return; drag=false; el.style.transition=""; el.style.zIndex=""; });
}

function initAI() { renderAIHistory(); }

function runAI() {
  const topic = DOM.aiInput.value.trim();
  if (!topic) { DOM.aiInput.focus(); shake(DOM.aiInput); return; }
  DOM.aiOutput.style.display = "none";
  DOM.aiLoading.style.display = "block";
  setTimeout(() => {
    DOM.aiLoading.style.display = "none";
    const lower = topic.toLowerCase();
    const key = Object.keys(AI_SEED_MAP).find(k => lower.includes(k));
    const pool = key ? AI_SEED_MAP[key].map(id => byId(id)).filter(Boolean) : [...IDEAS].sort(()=>Math.random()-.5).slice(0,6);
    DOM.aiOutputTitle.textContent = `"${topic}"`;
    renderGrid(DOM.aiGrid, pool);
    DOM.aiOutput.style.display = "block";
    S.aiHistory.unshift({topic, date:new Date().toLocaleDateString()});
    renderAIHistory();
    toast(`✨ Board generated for "${topic}"`);
  }, 1700);
}

function renderAIHistory() {
  if (!S.aiHistory.length) { DOM.aiHistoryList.innerHTML = `<p class="empty-note">Your generated boards will appear here.</p>`; return; }
  DOM.aiHistoryList.innerHTML = S.aiHistory.slice(0,6).map(h => `<div class="ai-hist-item"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--purple)" stroke-width="2" style="flex-shrink:0"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg><span class="ai-hist-prompt">${h.topic}</span><span class="ai-hist-date">${h.date}</span></div>`).join("");
}

function initProfile() { renderProfileTab(S.profileTab); }
function renderProfileTab(tab) {
  S.profileTab = tab;
  document.querySelectorAll(".profile-tab").forEach(t => t.classList.toggle("active", t.dataset.tab===tab));
  const ideas = tab==="saved" ? (S.savedIds.size ? IDEAS.filter(i=>S.savedIds.has(i.id)) : IDEAS.slice(0,8)) : tab==="boards" ? IDEAS.slice(8,16) : IDEAS.slice(0,12);
  renderGrid(DOM.profileGrid, ideas);
}

function openModal(id) {
  const idea = byId(id);
  if (!idea) return;
  S.modalId = id;
  DOM.modalImg.src = idea.img;
  DOM.modalImg.alt = idea.title;
  DOM.modalCatTag.textContent = idea.category;
  DOM.modalTitle.textContent  = idea.title;
  DOM.modalDesc.textContent   = DESCS[idea.category] || DESCS["Art"];
  DOM.modalRatings.innerHTML  = [
    {label:"Difficulty",val:idea.diff},{label:"Creativity",val:idea.creat},{label:"Usefulness",val:idea.use}
  ].map(r => `<div class="modal-rating-box"><div class="mrl">${r.label}</div><div class="mrs">${modalStars(r.val)}</div></div>`).join("");
  DOM.modalSteps.innerHTML = (STEPS[idea.category]||STEPS["Art"]).map((s,i) => `<li class="step-row"><div class="step-num-badge">${i+1}</div><span>${s}</span></li>`).join("");
  DOM.modalTools.innerHTML = (TOOLS[idea.category]||TOOLS["Art"]).map(t => `<span class="tool-tag">${t}</span>`).join("");
  syncSaveBtn();
  DOM.relatedRow.innerHTML = IDEAS.filter(i=>i.category===idea.category&&i.id!==id).slice(0,6).map(r => `<div class="related-thumb" data-id="${r.id}"><img src="${r.img}" alt="${r.title}" loading="lazy"/></div>`).join("");
  DOM.modalBackdrop.classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeModal() { DOM.modalBackdrop.classList.remove("open"); document.body.style.overflow=""; S.modalId=null; }

function syncSaveBtn() {
  const saved = S.savedIds.has(S.modalId);
  DOM.modalSaveBtn.innerHTML = saved
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> Saved ✓`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> Save Idea`;
}

let _tt;
function toast(msg="Saved!") { DOM.toastText.textContent=msg; DOM.toastBar.classList.add("show"); clearTimeout(_tt); _tt=setTimeout(()=>DOM.toastBar.classList.remove("show"),2600); }

function shake(el) { el.style.animation="none"; el.offsetHeight; el.style.animation="shake 0.4s ease"; setTimeout(()=>el.style.animation="",450); }

const _s = document.createElement("style");
_s.textContent = `@keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-7px)}40%{transform:translateX(7px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}`;
document.head.appendChild(_s);

function handleFilter(e, page) {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  btn.closest(".filter-chips").querySelectorAll(".chip").forEach(c=>c.classList.remove("active"));
  btn.classList.add("active");
  S.filter = btn.dataset.filter;
  if (page==="home") initHome();
  if (page==="explore") initExplore();
}

document.addEventListener("DOMContentLoaded", () => {
  /* Navigation */
  document.addEventListener("click", e => {
    if (e.target.closest(".chip")||e.target.closest(".card-ico-btn")) return;
    const el = e.target.closest("[data-page]");
    if (el) { e.preventDefault(); go(el.dataset.page); }
  });

  /* Cards */
  document.addEventListener("click", e => {
    const btn = e.target.closest(".card-ico-btn[data-action]");
    if (btn) {
      e.stopPropagation();
      const id=Number(btn.dataset.id), act=btn.dataset.action;
      if (act === "like") {

  fetch(`${API_URL}/ideas/${id}/like`, {
    method: "POST"
  });

  if (S.likedIds.has(id)) {
    S.likedIds.delete(id);
  } else {
    S.likedIds.add(id);
    toast("Liked! ❤️");
  }
}
      if (act === "save") {

  fetch(`${API_URL}/ideas/${id}/save`, {
    method: "POST"
  });

  if (S.savedIds.has(id)) {
    S.savedIds.delete(id);
    toast("Removed from saves");
  } else {
    S.savedIds.add(id);
    toast("Saved! 🎉");
  }
}
      const cardEl = btn.closest(".idea-card");
      if (cardEl) { const tmp=document.createElement("div"); tmp.innerHTML=cardHTML(byId(id),parseInt(cardEl.style.getPropertyValue("--i")||"0")); cardEl.replaceWith(tmp.firstElementChild); }
      return;
    }
    const card = e.target.closest(".idea-card");
    if (card&&!e.target.closest(".card-ico-btn")) openModal(Number(card.dataset.id));
    const rel = e.target.closest(".related-thumb");
    if (rel) openModal(Number(rel.dataset.id));
  });

  /* Modal */
  DOM.modalCloseBtn.addEventListener("click", closeModal);
  DOM.modalBackdrop.addEventListener("click", e=>{ if(e.target===DOM.modalBackdrop) closeModal(); });
  DOM.modalSaveBtn.addEventListener("click", () => {
    if (!S.modalId) return;
    if (S.savedIds.has(S.modalId)){S.savedIds.delete(S.modalId);toast("Removed from saves");}
    else{S.savedIds.add(S.modalId);toast("Saved! 🎉");}
    syncSaveBtn();
  });

  /* Filters */
  DOM.homeFilters.addEventListener("click",    e=>handleFilter(e,"home"));
  DOM.exploreFilters.addEventListener("click", e=>handleFilter(e,"explore"));
  DOM.homeSort.addEventListener("change", initHome);

  /* Search */
  let _st;
  DOM.globalSearch.addEventListener("input", e => {
    clearTimeout(_st);
    _st=setTimeout(()=>{ S.search=e.target.value.trim(); S.filter="all"; document.querySelectorAll(".chip").forEach(c=>c.classList.toggle("active",c.dataset.filter==="all")); if(S.page==="home")initHome(); if(S.page==="explore")initExplore(); },200);
  });

  /* Keyboard */
  document.addEventListener("keydown", e => {
    if (e.key==="Escape") closeModal();
    if (e.key==="/"&&document.activeElement!==DOM.globalSearch){e.preventDefault();DOM.globalSearch.focus();}
  });

  /* Scroll */
  window.addEventListener("scroll",()=>DOM.navbar.classList.toggle("scrolled",window.scrollY>10),{passive:true});

  /* Load more */
  DOM.loadMoreBtn.addEventListener("click", () => {
    DOM.loadMoreBtn.classList.add("busy");
    DOM.loadMoreBtn.querySelector("span").textContent="Loading…";
    setTimeout(()=>{
      const extra=IDEAS.slice(S.loaded);
      appendGrid(DOM.homeGrid,filtered(extra),S.loaded);
      S.loaded+=extra.length;
      DOM.loadMoreBtn.classList.remove("busy");
      DOM.loadMoreBtn.querySelector("span").textContent="Load more ideas";
      if(S.loaded>=IDEAS.length) DOM.loadMoreBtn.style.display="none";
    },700);
  });

  /* AI */
  DOM.aiGenBtn.addEventListener("click", runAI);
  DOM.aiInput.addEventListener("keydown", e=>{ if(e.key==="Enter") runAI(); });
  document.querySelectorAll(".quick-btn").forEach(btn=>btn.addEventListener("click",()=>{DOM.aiInput.value=btn.textContent;DOM.aiInput.focus();}));
  DOM.aiSaveBtn&&DOM.aiSaveBtn.addEventListener("click",()=>toast("Board saved! ✨"));

  /* Collab pin */
  DOM.pinIdeaList.addEventListener("click", e=>{
    const item=e.target.closest(".pin-idea-item");
    if(!item)return;
    const idea=byId(Number(item.dataset.pinId));
    if(!idea)return;
    DOM.canvasHint.style.display="none";
    addPin(idea,(10+Math.random()*55)+"%",(5+Math.random()*65)+"%");
    toast("Pinned to board!");
  });

  /* Toolbar */
  document.querySelectorAll(".tool-btn").forEach(btn=>btn.addEventListener("click",()=>{ document.querySelectorAll(".tool-btn").forEach(b=>b.classList.remove("active")); btn.classList.add("active"); }));

  /* Chat */
  function sendChat(){const msg=DOM.chatInput.value.trim();if(!msg)return;DOM.chatMsgs.innerHTML+=`<div class="chat-msg"><div class="chat-av" style="background:var(--grad-brand)">Y</div><div class="chat-bubble"><span class="chat-name">You</span>${msg}</div></div>`;DOM.chatInput.value="";DOM.chatMsgs.scrollTop=DOM.chatMsgs.scrollHeight;}
  DOM.chatSendBtn.addEventListener("click",sendChat);
  DOM.chatInput.addEventListener("keydown",e=>{if(e.key==="Enter")sendChat();});

  /* Profile tabs */
  DOM.profileTabsBar.addEventListener("click",e=>{const tab=e.target.closest(".profile-tab");if(tab)renderProfileTab(tab.dataset.tab);});

  /* New board */
  D("newBoardBtn")&&D("newBoardBtn").addEventListener("click",()=>toast("Board creation coming soon! 🚀"));

  /* Hamburger */
  DOM.hamburger.addEventListener("click",()=>{ DOM.navLinks.style.display=DOM.navLinks.style.display==="flex"?"none":"flex"; });

  fetchIdeasFromAPI();
go("home");
});