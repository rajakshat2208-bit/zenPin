// ============================================================
// script.js — ZenPin SPA Core
// Fully wired to https://zenpin-api.onrender.com
// ============================================================

const API_URL = "https://zenpin-api.onrender.com"

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

function token()     { return localStorage.getItem("token"); }
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

  return `
<div class="idea-card" data-id="${idea.id}" style="--i:${idx}">
  <div class="card-img-wrap">
    <img class="card-img" src="${idea.image_url || idea.img}" alt="${idea.title}" loading="lazy"/>
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
// ROUTER
// ─────────────────────────────────────────────────────────────
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
                  collab:initCollab, ai:initAI, profile:initProfile, trends:initTrends };
  (inits[page] || (() => {}))();
}

// ─────────────────────────────────────────────────────────────
<<<<<<< HEAD
=======
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
    return {
      id,
      title:       cfg.titles[tIdx],
      image_url:   getPhotoUrl(key, gIdx),   // baked at creation — never re-derived from render idx
      thumb_url:   getPicsumUrl(key, gIdx),
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
// HOW TO USE:
//   1. Put your images in:  assets/discovery/cars/car1.jpg
//   2. Add the path below:  cars: ["assets/discovery/cars/car1.jpg", ...]
//   3. Save and push to GitHub — done.
//
// Keys must be lowercase category names.
// Supports any number of categories and images.
// Curated images always appear BEFORE API images in the feed.
// ═══════════════════════════════════════════════════════════════

const CURATED_IMAGES = {
  // ════════════════════════════════════════════════════════════
  // CURATED IMAGE LIBRARY
  // Keys = lowercase category names matching the feed filters.
  // Paths are relative to index.html (after repo restructure).
  // Adjust counts to match your actual files.
  // ════════════════════════════════════════════════════════════

  "cars": [
    "assets/discovery/cars/car1.jpg",
    "assets/discovery/cars/car2.jpg",
    "assets/discovery/cars/car3.jpg",
    "assets/discovery/cars/car4.jpg",
    "assets/discovery/cars/car5.jpg",
    "assets/discovery/cars/car6.jpg",
    "assets/discovery/cars/car7.jpg",
    "assets/discovery/cars/car8.jpg",
    "assets/discovery/cars/car9.jpg",
    "assets/discovery/cars/car10.jpg",
    "assets/discovery/cars/car11.jpg",
    "assets/discovery/cars/car12.jpg",
    "assets/discovery/cars/car13.jpg",
    "assets/discovery/cars/car14.jpg",
    "assets/discovery/cars/car15.jpg",
    "assets/discovery/cars/car16.jpg",
    "assets/discovery/cars/car17.jpg",
    "assets/discovery/cars/car18.jpg",
    "assets/discovery/cars/car19.jpg",
    "assets/discovery/cars/car20.jpg",
    "assets/discovery/cars/car21.jpg",
    "assets/discovery/cars/car22.jpg",
    "assets/discovery/cars/car23.jpg",
    "assets/discovery/cars/car24.jpg",
    "assets/discovery/cars/car25.jpg",
    "assets/discovery/cars/car26.jpg",
    "assets/discovery/cars/car27.jpg",
    "assets/discovery/cars/car28.jpg",
    "assets/discovery/cars/car29.jpg",
    "assets/discovery/cars/car30.jpg",
  ],
  "anime": [
    "assets/discovery/anime/anime1.jpg",
    "assets/discovery/anime/anime2.jpg",
    "assets/discovery/anime/anime3.jpg",
    "assets/discovery/anime/anime4.jpg",
    "assets/discovery/anime/anime5.jpg",
    "assets/discovery/anime/anime6.jpg",
    "assets/discovery/anime/anime7.jpg",
    "assets/discovery/anime/anime8.jpg",
    "assets/discovery/anime/anime9.jpg",
    "assets/discovery/anime/anime10.jpg",
    "assets/discovery/anime/anime11.jpg",
    "assets/discovery/anime/anime12.jpg",
    "assets/discovery/anime/anime13.jpg",
    "assets/discovery/anime/anime14.jpg",
    "assets/discovery/anime/anime15.jpg",
    "assets/discovery/anime/anime16.jpg",
    "assets/discovery/anime/anime17.jpg",
    "assets/discovery/anime/anime18.jpg",
    "assets/discovery/anime/anime19.jpg",
    "assets/discovery/anime/anime20.jpg",
    "assets/discovery/anime/anime21.jpg",
    "assets/discovery/anime/anime22.jpg",
    "assets/discovery/anime/anime23.jpg",
    "assets/discovery/anime/anime24.jpg",
    "assets/discovery/anime/anime25.jpg",
    "assets/discovery/anime/anime26.jpg",
    "assets/discovery/anime/anime27.jpg",
    "assets/discovery/anime/anime28.jpg",
    "assets/discovery/anime/anime29.jpg",
    "assets/discovery/anime/anime30.jpg",
  ],
  "scenery": [
    "assets/discovery/scenery/scenery1.jpg",
    "assets/discovery/scenery/scenery2.jpg",
    "assets/discovery/scenery/scenery3.jpg",
    "assets/discovery/scenery/scenery4.jpg",
    "assets/discovery/scenery/scenery5.jpg",
    "assets/discovery/scenery/scenery6.jpg",
    "assets/discovery/scenery/scenery7.jpg",
    "assets/discovery/scenery/scenery8.jpg",
    "assets/discovery/scenery/scenery9.jpg",
    "assets/discovery/scenery/scenery10.jpg",
    "assets/discovery/scenery/scenery11.jpg",
    "assets/discovery/scenery/scenery12.jpg",
    "assets/discovery/scenery/scenery13.jpg",
    "assets/discovery/scenery/scenery14.jpg",
    "assets/discovery/scenery/scenery15.jpg",
    "assets/discovery/scenery/scenery16.jpg",
    "assets/discovery/scenery/scenery17.jpg",
    "assets/discovery/scenery/scenery18.jpg",
    "assets/discovery/scenery/scenery19.jpg",
    "assets/discovery/scenery/scenery20.jpg",
    "assets/discovery/scenery/scenery21.jpg",
    "assets/discovery/scenery/scenery22.jpg",
    "assets/discovery/scenery/scenery23.jpg",
    "assets/discovery/scenery/scenery24.jpg",
    "assets/discovery/scenery/scenery25.jpg",
    "assets/discovery/scenery/scenery26.jpg",
    "assets/discovery/scenery/scenery27.jpg",
    "assets/discovery/scenery/scenery28.jpg",
    "assets/discovery/scenery/scenery29.jpg",
    "assets/discovery/scenery/scenery30.jpg",
  ],
  "gaming": [
    "assets/discovery/gaming/gaming1.jpg",
    "assets/discovery/gaming/gaming2.jpg",
    "assets/discovery/gaming/gaming3.jpg",
    "assets/discovery/gaming/gaming4.jpg",
    "assets/discovery/gaming/gaming5.jpg",
    "assets/discovery/gaming/gaming6.jpg",
    "assets/discovery/gaming/gaming7.jpg",
    "assets/discovery/gaming/gaming8.jpg",
    "assets/discovery/gaming/gaming9.jpg",
    "assets/discovery/gaming/gaming10.jpg",
    "assets/discovery/gaming/gaming11.jpg",
    "assets/discovery/gaming/gaming12.jpg",
    "assets/discovery/gaming/gaming13.jpg",
    "assets/discovery/gaming/gaming14.jpg",
    "assets/discovery/gaming/gaming15.jpg",
    "assets/discovery/gaming/gaming16.jpg",
    "assets/discovery/gaming/gaming17.jpg",
    "assets/discovery/gaming/gaming18.jpg",
    "assets/discovery/gaming/gaming19.jpg",
    "assets/discovery/gaming/gaming20.jpg",
    "assets/discovery/gaming/gaming21.jpg",
    "assets/discovery/gaming/gaming22.jpg",
    "assets/discovery/gaming/gaming23.jpg",
    "assets/discovery/gaming/gaming24.jpg",
    "assets/discovery/gaming/gaming25.jpg",
    "assets/discovery/gaming/gaming26.jpg",
    "assets/discovery/gaming/gaming27.jpg",
    "assets/discovery/gaming/gaming28.jpg",
  ],
  "bikes": [
    "assets/discovery/bikes/bike1.jpg",
    "assets/discovery/bikes/bike2.jpg",
    "assets/discovery/bikes/bike3.jpg",
    "assets/discovery/bikes/bike4.jpg",
    "assets/discovery/bikes/bike5.jpg",
    "assets/discovery/bikes/bike6.jpg",
    "assets/discovery/bikes/bike7.jpg",
    "assets/discovery/bikes/bike8.jpg",
    "assets/discovery/bikes/bike9.jpg",
    "assets/discovery/bikes/bike10.jpg",
    "assets/discovery/bikes/bike11.jpg",
    "assets/discovery/bikes/bike12.jpg",
    "assets/discovery/bikes/bike13.jpg",
    "assets/discovery/bikes/bike14.jpg",
    "assets/discovery/bikes/bike15.jpg",
    "assets/discovery/bikes/bike16.jpg",
    "assets/discovery/bikes/bike17.jpg",
    "assets/discovery/bikes/bike18.jpg",
    "assets/discovery/bikes/bike19.jpg",
    "assets/discovery/bikes/bike20.jpg",
    "assets/discovery/bikes/bike21.jpg",
    "assets/discovery/bikes/bike22.jpg",
    "assets/discovery/bikes/bike23.jpg",
    "assets/discovery/bikes/bike24.jpg",
    "assets/discovery/bikes/bike25.jpg",
  ],
  "superheroes": [
    "assets/discovery/superhero/superhero1.jpg",
    "assets/discovery/superhero/superhero2.jpg",
    "assets/discovery/superhero/superhero3.jpg",
    "assets/discovery/superhero/superhero4.jpg",
    "assets/discovery/superhero/superhero5.jpg",
    "assets/discovery/superhero/superhero6.jpg",
    "assets/discovery/superhero/superhero7.jpg",
    "assets/discovery/superhero/superhero8.jpg",
    "assets/discovery/superhero/superhero9.jpg",
    "assets/discovery/superhero/superhero10.jpg",
    "assets/discovery/superhero/superhero11.jpg",
    "assets/discovery/superhero/superhero12.jpg",
    "assets/discovery/superhero/superhero13.jpg",
    "assets/discovery/superhero/superhero14.jpg",
    "assets/discovery/superhero/superhero15.jpg",
    "assets/discovery/superhero/superhero16.jpg",
    "assets/discovery/superhero/superhero17.jpg",
    "assets/discovery/superhero/superhero18.jpg",
    "assets/discovery/superhero/superhero19.jpg",
    "assets/discovery/superhero/superhero20.jpg",
    "assets/discovery/superhero/superhero21.jpg",
    "assets/discovery/superhero/superhero22.jpg",
    "assets/discovery/superhero/superhero23.jpg",
    "assets/discovery/superhero/superhero24.jpg",
    "assets/discovery/superhero/superhero25.jpg",
  ],
  "workspace": [
    "assets/discovery/workspace/workspace1.jpg",
    "assets/discovery/workspace/workspace2.jpg",
    "assets/discovery/workspace/workspace3.jpg",
    "assets/discovery/workspace/workspace4.jpg",
    "assets/discovery/workspace/workspace5.jpg",
    "assets/discovery/workspace/workspace6.jpg",
    "assets/discovery/workspace/workspace7.jpg",
    "assets/discovery/workspace/workspace8.jpg",
    "assets/discovery/workspace/workspace9.jpg",
    "assets/discovery/workspace/workspace10.jpg",
    "assets/discovery/workspace/workspace11.jpg",
    "assets/discovery/workspace/workspace12.jpg",
    "assets/discovery/workspace/workspace13.jpg",
    "assets/discovery/workspace/workspace14.jpg",
    "assets/discovery/workspace/workspace15.jpg",
    "assets/discovery/workspace/workspace16.jpg",
    "assets/discovery/workspace/workspace17.jpg",
    "assets/discovery/workspace/workspace18.jpg",
    "assets/discovery/workspace/workspace19.jpg",
    "assets/discovery/workspace/workspace20.jpg",
    "assets/discovery/workspace/workspace21.jpg",
    "assets/discovery/workspace/workspace22.jpg",
    "assets/discovery/workspace/workspace23.jpg",
    "assets/discovery/workspace/workspace24.jpg",
    "assets/discovery/workspace/workspace25.jpg",
  ],
  "fashion": [
    "assets/discovery/fashion/fashion1.jpg",
    "assets/discovery/fashion/fashion2.jpg",
    "assets/discovery/fashion/fashion3.jpg",
    "assets/discovery/fashion/fashion4.jpg",
    "assets/discovery/fashion/fashion5.jpg",
    "assets/discovery/fashion/fashion6.jpg",
    "assets/discovery/fashion/fashion7.jpg",
    "assets/discovery/fashion/fashion8.jpg",
    "assets/discovery/fashion/fashion9.jpg",
    "assets/discovery/fashion/fashion10.jpg",
    "assets/discovery/fashion/fashion11.jpg",
    "assets/discovery/fashion/fashion12.jpg",
    "assets/discovery/fashion/fashion13.jpg",
    "assets/discovery/fashion/fashion14.jpg",
    "assets/discovery/fashion/fashion15.jpg",
    "assets/discovery/fashion/fashion16.jpg",
    "assets/discovery/fashion/fashion17.jpg",
    "assets/discovery/fashion/fashion18.jpg",
    "assets/discovery/fashion/fashion19.jpg",
    "assets/discovery/fashion/fashion20.jpg",
    "assets/discovery/fashion/fashion21.jpg",
    "assets/discovery/fashion/fashion22.jpg",
    "assets/discovery/fashion/fashion23.jpg",
    "assets/discovery/fashion/fashion24.jpg",
    "assets/discovery/fashion/fashion25.jpg",
  ],
  "food": [
    "assets/discovery/food/food1.jpg",
    "assets/discovery/food/food2.jpg",
    "assets/discovery/food/food3.jpg",
    "assets/discovery/food/food4.jpg",
    "assets/discovery/food/food5.jpg",
    "assets/discovery/food/food6.jpg",
    "assets/discovery/food/food7.jpg",
    "assets/discovery/food/food8.jpg",
    "assets/discovery/food/food9.jpg",
    "assets/discovery/food/food10.jpg",
    "assets/discovery/food/food11.jpg",
    "assets/discovery/food/food12.jpg",
    "assets/discovery/food/food13.jpg",
    "assets/discovery/food/food14.jpg",
    "assets/discovery/food/food15.jpg",
    "assets/discovery/food/food16.jpg",
    "assets/discovery/food/food17.jpg",
    "assets/discovery/food/food18.jpg",
    "assets/discovery/food/food19.jpg",
    "assets/discovery/food/food20.jpg",
    "assets/discovery/food/food21.jpg",
    "assets/discovery/food/food22.jpg",
    "assets/discovery/food/food23.jpg",
    "assets/discovery/food/food24.jpg",
    "assets/discovery/food/food25.jpg",
  ],
  "pets": [
    "assets/discovery/pets/pet1.jpg",
    "assets/discovery/pets/pet2.jpg",
    "assets/discovery/pets/pet3.jpg",
    "assets/discovery/pets/pet4.jpg",
    "assets/discovery/pets/pet5.jpg",
    "assets/discovery/pets/pet6.jpg",
    "assets/discovery/pets/pet7.jpg",
    "assets/discovery/pets/pet8.jpg",
    "assets/discovery/pets/pet9.jpg",
    "assets/discovery/pets/pet10.jpg",
    "assets/discovery/pets/pet11.jpg",
    "assets/discovery/pets/pet12.jpg",
    "assets/discovery/pets/pet13.jpg",
    "assets/discovery/pets/pet14.jpg",
    "assets/discovery/pets/pet15.jpg",
    "assets/discovery/pets/pet16.jpg",
    "assets/discovery/pets/pet17.jpg",
    "assets/discovery/pets/pet18.jpg",
    "assets/discovery/pets/pet19.jpg",
    "assets/discovery/pets/pet20.jpg",
    "assets/discovery/pets/pet21.jpg",
    "assets/discovery/pets/pet22.jpg",
    "assets/discovery/pets/pet23.jpg",
    "assets/discovery/pets/pet24.jpg",
    "assets/discovery/pets/pet25.jpg",
  ],
};



// ── Internal cache: CURATED_IMAGES + images.json merged ───────
// You don't need to touch anything below this line.
const _curatedCache = {};

// Merge hardcoded CURATED_IMAGES into cache immediately (synchronous, instant)
(function seedCuratedCache() {
  for (const [cat, urls] of Object.entries(CURATED_IMAGES)) {
    if (!Array.isArray(urls) || !urls.length) continue;
    const key = cat.toLowerCase();
    if (!_curatedCache[key]) _curatedCache[key] = [];
    // Deduplicate
    for (const url of urls) {
      if (!_curatedCache[key].includes(url)) _curatedCache[key].push(url);
    }
  }
  const total = Object.values(_curatedCache).reduce((s, a) => s + a.length, 0);
  if (total > 0) console.log(`📸 ${total} curated images ready`);
})();

// Also load images.json manifest if present (adds to cache on top of hardcoded)
// images.json is generated by: node generate-manifest.js
// If the file doesn't exist, this silently does nothing.
(function loadManifest() {
  fetch("images.json")
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data) return;
      let added = 0;
      for (const [folder, urls] of Object.entries(data)) {
        if (folder.startsWith("_") || !Array.isArray(urls) || !urls.length) continue;
        // Normalize folder name → category key
        const key = folder.toLowerCase().replace(/_/g, " ")
          .replace("accessories", "ladies accessories")
          .replace("interior", "interior design")
          .replace("aesthetic", "art");
        if (!_curatedCache[key]) _curatedCache[key] = [];
        for (const url of urls) {
          if (!_curatedCache[key].includes(url)) {
            _curatedCache[key].push(url);
            added++;
          }
        }
      }
      if (added > 0) console.log(`📸 +${added} images loaded from images.json`);
    })
    .catch(() => {}); // no manifest = no problem
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

// ── Get curated images for a category ─────────────────────────
// Returns up to `limit` cards, rotating through the library per page
// so infinite scroll never repeats the same images.
function getCuratedForCategory(category, limit = 12, page = 1) {
  const key  = category.toLowerCase();
  const urls = _curatedCache[key] || [];
  if (!urls.length) return [];

  // Rotate through the library based on page number
  // Page 1 → first 12, Page 2 → next 12, wraps around if needed
  const start  = ((page - 1) * limit) % urls.length;
  const slice  = [];
  for (let i = 0; i < limit; i++) {
    slice.push(urls[(start + i) % urls.length]);
  }
  return curatedUrlsToIdeas(slice, category, (page - 1) * limit);
}

// ── Check if any curated images exist for a category ──────────
function hasCurated(category) {
  return (_curatedCache[category.toLowerCase()] || []).length > 0;
}

// ─────────────────────────────────────────────────────────────
>>>>>>> 391858b66caf572b21cf06acad0d02a93e92bc24
// PAGE: HOME
// ─────────────────────────────────────────────────────────────
async function initHome() {
  const grid = $("homeGrid");
  if (!grid) return;

  // Show skeleton while loading
  grid.innerHTML = skeletonHTML(10);

  try {
    const params = buildParams();
    const { ideas } = await apiFetch("GET", `/ideas?${params}`);
    S.ideas = ideas;
    S.allIdeas = ideas;
    applySkillFilter();
    renderGrid(grid, S.ideas);
  } catch (e) {
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
  const sendBtn  = $("chatSendBtn");
  const chatInput = $("chatInput");
  const chatMsgs = $("chatMsgs");
  if (!sendBtn) return;

  function sendMsg() {
    const msg = chatInput.value.trim();
    if (!msg) return;
    const user = getUser();
    const initial = (user?.username || "Y")[0].toUpperCase();
    chatMsgs.innerHTML += `
      <div class="chat-msg">
        <div class="chat-av" style="background:var(--grad-brand)">${initial}</div>
        <div class="chat-bubble"><span class="chat-name">${user?.username || "You"}</span>${msg}</div>
      </div>`;
    chatInput.value = "";
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }
  sendBtn.addEventListener("click", sendMsg);
  chatInput.addEventListener("keydown", e => { if (e.key === "Enter") sendMsg(); });
}

// ─────────────────────────────────────────────────────────────
// PAGE: AI GENERATOR
// ─────────────────────────────────────────────────────────────
async function initAI() {
  if (window.AI) AI.renderHistory("aiHistoryList");
}

async function runAI() {
  if (!requireLogin("Sign in to use the AI generator")) return;

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
    if (window.AI) {
      const palette = AI.getPalette(topic);
      AI.renderPalette(palette, "aiPaletteWrap");

      // Style card
      const style = AI.getStyleInfo(topic);
      const styleEl = $("aiStyleCard");
      if (styleEl) {
        styleEl.innerHTML = `
          <div class="ai-style-name">${style.name}</div>
          <div class="ai-style-desc">${style.desc}</div>`;
        styleEl.style.display = "block";
      }

      AI.saveToHistory(topic, ideas);
      AI.renderHistory("aiHistoryList");
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
async function initProfile() {
  const user = getUser();
  if (!user) {
    $("profileGrid").innerHTML = `
      <div class="boards-login-prompt" style="grid-column:1/-1">
        <p>Sign in to view your profile</p>
        <a href="login.html" class="btn-primary" style="margin-top:12px;display:inline-flex">Sign In</a>
      </div>`;
    return;
  }

  // Fill in profile header
  const nameEl   = document.querySelector(".profile-name");
  const handleEl = document.querySelector(".profile-handle");
  const bioEl    = document.querySelector(".profile-bio");
  const avEl     = document.querySelector(".profile-av");
  if (nameEl)   nameEl.textContent   = user.username || "Your Studio";
  if (handleEl) handleEl.textContent = "@" + (user.username || "yourstudio");
  if (bioEl)    bioEl.textContent    = user.bio || "Visual thinker & creative explorer.";
  if (avEl) {
    avEl.textContent = (user.username || "Y")[0].toUpperCase();
    if (user.avatar_url) {
      avEl.style.backgroundImage = `url(${user.avatar_url})`;
      avEl.style.backgroundSize  = "cover";
      avEl.textContent           = "";
    }
  }

  renderProfileTab(S.profileTab);
}

async function renderProfileTab(tab) {
  S.profileTab = tab;
  document.querySelectorAll(".profile-tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === tab)
  );
  const grid = $("profileGrid");
  grid.innerHTML = skeletonHTML(8);

  try {
    let ideas = [];
    if (tab === "saved") {
      const user = getUser();
      if (user) {
        const data = await apiFetch("GET", `/users/${user.id}/saves`);
        ideas = data.ideas || [];
      }
    } else if (tab === "boards") {
      // Show board preview cards
      const { boards } = await apiFetch("GET", "/boards");
      grid.innerHTML = boards.map((b, i) => `
        <div class="idea-card" style="--i:${i}">
          <div class="card-img-wrap" style="min-height:120px;background:var(--surface-2);display:flex;align-items:center;justify-content:center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" stroke-width="1.5"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
          </div>
          <div class="card-footer" style="flex-direction:column;align-items:flex-start;gap:2px">
            <div style="font-weight:700;font-size:0.85rem">${b.name}</div>
            <div style="font-size:0.72rem;color:var(--text-3)">${b.idea_count||0} ideas</div>
          </div>
        </div>`).join("");
      return;
    } else {
      // Created — get ideas by this user (fallback: show all)
      const { ideas: all } = await apiFetch("GET", "/ideas?limit=12");
      ideas = all;
    }
    renderGrid(grid, ideas);
    if (!ideas.length) {
      grid.innerHTML = `<p class="empty-note" style="padding:24px;grid-column:1/-1">Nothing here yet.</p>`;
    }
  } catch {
    grid.innerHTML = `<div class="load-error">Could not load.</div>`;
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

  // ── Load more ──────────────────────────────────────────────
  $("loadMoreBtn")?.addEventListener("click", async () => {
    const btn = $("loadMoreBtn");
    btn.classList.add("busy");
    btn.querySelector("span").textContent = "Loading…";
    try {
      const p = buildParams({ offset: S.loaded });
      const { ideas } = await apiFetch("GET", `/ideas?${p}`);
      if (!ideas.length) { btn.style.display = "none"; return; }
      appendGrid($("homeGrid"), ideas, S.loaded);
      S.allIdeas = [...S.allIdeas, ...ideas];
      S.loaded  += ideas.length;
      if (ideas.length < 20) btn.style.display = "none";
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.classList.remove("busy");
      btn.querySelector("span").textContent = "Load more ideas";
    }
  });

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

  // ── Collab chat ────────────────────────────────────────────
  setupChat();

  // ── START ─────────────────────────────────────────────────
  go("home");
});
