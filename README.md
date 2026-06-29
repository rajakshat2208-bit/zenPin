ZenPin
A Pinterest-inspired creative discovery platform — built as a personal portfolio project by a first-year Computer Science Engineering student.
Visual discovery · AI-powered search · 832 curated images · 15 categories
🔗 Live Demo  |  🖥️ Backend API
⚠️ The backend runs on Render's free tier. First load after a period of inactivity may take 20–30 seconds to wake up. The image feed and search work immediately without the backend.

What it is
ZenPin is a full-stack visual discovery platform I built independently. It lets users browse curated images across 15 categories, save ideas to boards, generate AI-powered inspiration boards, and analyse images using AI. I built it to demonstrate what a first-year CS student can ship end-to-end — frontend, backend, AI integration, and deployment — without a team.

Features
Discovery
Masonry image grid — 832 hand-curated images across 15 categories
Category filter chips (Anime, Cars, Fashion, Gaming, Nature, Architecture, Art, and 8 more)
Scroll-triggered load-more — new images load automatically as you reach the bottom
Personalised feed — tracks engagement per category in localStorage and surfaces preferred content more often
Search
Keyword search across image titles and categories; richer results when backend is online (full metadata)
Desktop search dropdown with trending suggestions and persistent recent search history
Full-screen mobile search experience with visual category previews and animated transitions
Voice search via the Web Speech API
Recent searches persisted in localStorage across sessions
AI Features
Generate Board — type any theme, get a curated inspiration board drawn from local images and the Gemini API
Image Analyzer — paste an image URL to get style, colour palette, mood analysis, and recreation steps (file upload also supported when backend is online)
ZENCHAT — conversational assistant with a 500+ entry local knowledge base; falls back to this instantly when the backend is offline, escalates to Gemini when available
Accounts and Boards
OTP-based email authentication (password login also supported)
Save images to personal boards
Create and manage multiple boards
Collaborative canvas — pin images and drag to reposition (desktop); local upvote counter per pin (not persisted or shared between users)
Profile with full save history
UI
Dark/light mode with system preference detection
Dedicated mobile navigation bar and full-screen search experience
Glassmorphism design with ambient animated backgrounds
Image modal viewer with keyboard arrow navigation

Tech Stack
Layer
Technology
Frontend
Vanilla HTML, CSS, JavaScript (no framework)
Backend
Python · FastAPI
Database
SQLite
AI
Google Gemini API
Auth
OTP via email · JWT tokens
Hosting
GitHub Pages (frontend) · Render free tier (backend)
Images
832 locally-hosted files in assets/discovery/
Why Vanilla JS? Deliberate decision. I wanted to build real understanding of the DOM, event delegation, CSS layout, and state management before using a framework. Core feed state lives in a single S object; additional state (modal context, user session, personalisation weights) is managed in separate purpose-built modules. At 7,100 lines, script.js makes the architectural cost of that choice obvious — React is first on the "do differently" list below.

Project Structure
zenPin/
├── index.html          # Single-page app shell — all pages live here
├── login.html          # Login (password + OTP)
├── signup.html         # Registration
├── style.css           # ~4,600 lines — all styling
├── script.js           # ~7,100 lines — all frontend logic
├── ai.js               # AI module (Generate Board, Image Analyzer)
├── project.js          # Extended features
└── assets/
    └── discovery/      # 832 curated images across 15 folders
        ├── anime/      (59 images)
        ├── fashion/    (90 images)
        ├── cars/       (69 images)
        ├── art/        (90 images)
        ├── accessories/(90 images)
        ├── bikes/      (72 images)
        ├── superhero/  (69 images)
        ├── nature/     (60 images)
        ├── scenery/    (54 images)
        ├── architecture/(32 images)
        ├── food/       (30 images)
        ├── interior/   (30 images)
        ├── workspace/  (30 images)
        ├── pets/       (29 images)
        └── gaming/     (28 images)


Run Locally
# Clone the repo
git clone https://github.com/rajakshat2208-bit/zenPin.git
cd zenPin

# No build step needed — open index.html in a browser, or serve with:
npx serve .
# or
python3 -m http.server 8080

The image feed, search, and ZENCHAT work without the backend. Auth, boards, dashboard, and image upload require either the live Render API or a local FastAPI instance.
Backend endpoints used: /auth/me  /auth/otp/send  /auth/otp/verify
                        /ideas    /boards          /dashboard
                        /users/:id/saves           /upload


Challenges
State management without a framework — The app is a single HTML file with multiple "pages" toggled by CSS classes. Managing modal context, filter state, pagination, and search state across page transitions without a framework required explicit reset logic on every navigation. I rebuilt the page-switch system twice to eliminate stale-state bugs.
Image click opening the wrong image — The most persistent bug. getLocalImage() used a hash-modulo formula to select a URL from the local image cache. The hash index didn't map back to the original URL position, so the card displayed car5.jpg while the modal opened car2.jpg. Root fix: cardHTML() now uses idea.image_url directly. getLocalImage() is only called as a fallback when image_url is absent.
Mobile search as a genuine experience — Version 1 was a 52px floating pill overlay. It looked like a debug control. I rebuilt it as a dedicated full-screen search destination with a category preview grid (populated from the local image cache), trending chips, localStorage-backed recent history, and animated transitions between the suggestion and results states.
Render free-tier cold starts — The backend sleeps after inactivity and takes 20–30 seconds to wake. Rather than block the UI, I made every backend call non-blocking. The feed, search, and AI features serve local data immediately; backend data enriches the UI when the response arrives.
JavaScript Temporal Dead Zone crash — runSearch() logged pool.length before the const pool declaration in the same block scope. A compiled language would reject this at build time; in JS it silently throws a ReferenceError at runtime and killed the search system entirely. Fixed by moving the declaration above its first use.

What I'd do differently
React — a 7,100-line single script.js is hard to navigate; components would have made the page architecture much cleaner
TypeScript — several bugs I caught manually (wrong property names, undefined checks) would have been type errors at write-time
WebSocket real-time collaboration — the canvas is currently local-only; pins are not shared between users
Image CDN — GitHub Pages handles the 832 images fine at current scale, but it's not designed for that
Automated tests — all QA was manual; a Playwright suite would have caught regressions much faster
Bundler (Vite or Webpack) — no minification, no tree-shaking, no code splitting currently

Planned improvements
[ ] WebSocket-based real-time canvas sync
[ ] User-to-user following and activity feed
[ ] Board sharing via public URLs
[ ] Progressive Web App (PWA) with offline support
[ ] Switch to React + TypeScript
[ ] Automated end-to-end tests with Playwright

Author
Akshat Raj — First-year B.Tech Computer Science Engineering, Swami Vivekananda University, Kolkata
Interests: Full-stack development · Cybersecurity · AI integration · UI/UX
GitHub: @rajakshat2208-bit
LinkedIn: www.linkedin.com/in/akshat-raj-371544392 

License
This project is for portfolio and educational purposes.

Built independently as a learning project. No starter templates or tutorial codebases were used.
