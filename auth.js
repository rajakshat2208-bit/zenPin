// auth.js — ZenPin Authentication State Manager
// Handles: token storage, user state, navbar updates, route guards, login modal
// ─────────────────────────────────────────────────────────────────────────────

const API_URL = "https://zenpin-api.onrender.com";

const Auth = (() => {

  // ── Internal state ────────────────────────────────────────────
  let _token = localStorage.getItem("zenpin_token") || null;
  let _user  = (() => {
    try { return JSON.parse(localStorage.getItem("zenpin_user") || "null"); }
    catch { return null; }
  })();

  // ── Session helpers ───────────────────────────────────────────
  function setSession(token, user) {
    _token = token; _user = user;
    localStorage.setItem("zenpin_token", token);
    localStorage.setItem("zenpin_user", JSON.stringify(user));
  }
  function clearSession() {
    _token = null; _user = null;
    localStorage.removeItem("zenpin_token");
    localStorage.removeItem("zenpin_user");
  }

  const getToken   = () => _token;
  const getUser    = () => _user;
  const isLoggedIn = () => !!_token && !!_user;

  // ── Raw API helpers (used only internally) ────────────────────
  async function _post(path, body) {
    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    return data;
  }
  async function _get(path) {
    const res = await fetch(`${API_URL}${path}`, {
      headers: { Authorization: `Bearer ${_token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    return data;
  }

  // ── Auth actions ──────────────────────────────────────────────
  async function signup(username, email, password) {
    const data = await _post("/auth/signup", { username, email, password });
    setSession(data.token, data.user);
    return data;
  }
  async function login(email, password) {
    const data = await _post("/auth/login", { email, password });
    setSession(data.token, data.user);
    return data;
  }
  function logout() {
    clearSession();
    window.location.href = "login.html";
  }
  async function refreshMe() {
    if (!_token) return null;
    try {
      const user = await _get("/auth/me");
      _user = user;
      localStorage.setItem("zenpin_user", JSON.stringify(user));
      return user;
    } catch {
      clearSession();
      return null;
    }
  }

  // ── Route guards ──────────────────────────────────────────────
  function requireAuth() {
    if (!isLoggedIn()) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `login.html?next=${next}`;
      return false;
    }
    return true;
  }
  function redirectIfAuthed(dest = "index.html") {
    if (isLoggedIn()) { window.location.href = dest; return true; }
    return false;
  }

  // ── Navbar update ─────────────────────────────────────────────
  function updateNavbar() {
    const actions = document.querySelector(".nav-actions");
    if (!actions) return;

    if (isLoggedIn()) {
      actions.querySelector(".nav-login-btn")?.remove();
      if (!actions.querySelector(".nav-user-wrap")) {
        const u = _user;
        const initials = (u?.username || "U").charAt(0).toUpperCase();
        const wrap = document.createElement("div");
        wrap.className = "nav-user-wrap";
        wrap.innerHTML = `
          <div class="nav-av">${u?.avatar_url ? `<img src="${u.avatar_url}" alt=""/>` : initials}</div>
          <span class="nav-username">${u?.username || "You"}</span>
          <button class="nav-logout-btn" id="navLogout" title="Log out">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
          </button>`;
        const create = actions.querySelector(".nav-btn-create");
        create ? actions.insertBefore(wrap, create) : actions.prepend(wrap);
        wrap.querySelector("#navLogout").onclick = logout;
      }
    } else {
      if (!actions.querySelector(".nav-login-btn")) {
        const btn = document.createElement("a");
        btn.href = "login.html";
        btn.className = "nav-login-btn";
        btn.textContent = "Log in";
        actions.prepend(btn);
      }
    }
  }

  // ── Login required modal ──────────────────────────────────────
  function showLoginModal() {
    document.getElementById("authModal")?.remove();
    const el = document.createElement("div");
    el.id = "authModal";
    el.className = "auth-modal";
    el.innerHTML = `
      <div class="auth-modal-card">
        <button class="auth-modal-x" id="authModalX">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
        <div class="auth-modal-gem">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5">
            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/>
          </svg>
        </div>
        <h3>Join ZenPin</h3>
        <p>Create an account to save ideas, build boards, and unlock AI generation.</p>
        <a href="signup.html" class="btn-primary" style="width:100%;justify-content:center;margin-bottom:10px;text-decoration:none">Create free account</a>
        <a href="login.html" class="btn-ghost" style="width:100%;justify-content:center;text-decoration:none">Log in</a>
      </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("open"));
    const close = () => { el.classList.remove("open"); setTimeout(() => el.remove(), 280); };
    el.querySelector("#authModalX").onclick = close;
    el.onclick = e => { if (e.target === el) close(); };
  }

  // ── Inject auth CSS ───────────────────────────────────────────
  function _injectCSS() {
    if (document.getElementById("auth-styles")) return;
    const s = document.createElement("style");
    s.id = "auth-styles";
    s.textContent = `
.nav-user-wrap{display:flex;align-items:center;gap:8px}
.nav-av{width:34px;height:34px;border-radius:50%;background:var(--grad-brand);display:flex;align-items:center;justify-content:center;font-size:.78rem;font-weight:800;color:white;overflow:hidden;cursor:pointer;box-shadow:0 2px 10px rgba(124,58,237,.3);transition:transform .2s;flex-shrink:0}
.nav-av:hover{transform:scale(1.1)}
.nav-av img{width:100%;height:100%;object-fit:cover}
.nav-username{font-size:.8rem;font-weight:700;color:var(--text);max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-logout-btn{width:32px;height:32px;border-radius:50%;background:var(--surface-2);border:1.5px solid var(--border-2);display:flex;align-items:center;justify-content:center;color:var(--text-3);cursor:pointer;transition:all .15s}
.nav-logout-btn:hover{background:#fee2e2;color:#ef4444;border-color:#fca5a5}
.nav-login-btn{height:36px;padding:0 18px;background:var(--surface);border:1.5px solid var(--border-2);border-radius:var(--r-pill);font-size:.82rem;font-weight:700;color:var(--text);display:flex;align-items:center;text-decoration:none;transition:all .2s}
.nav-login-btn:hover{background:var(--grad-brand);color:white;border-color:transparent;box-shadow:0 4px 14px rgba(124,58,237,.35)}
.auth-modal{position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(14px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;transition:opacity .25s}
.auth-modal.open{opacity:1}
.auth-modal-card{background:var(--surface);border-radius:28px;padding:44px 38px;max-width:390px;width:100%;text-align:center;box-shadow:0 32px 80px rgba(0,0,0,.2);position:relative;transform:translateY(20px);transition:transform .35s cubic-bezier(.34,1.2,.64,1);display:flex;flex-direction:column;align-items:center}
.auth-modal.open .auth-modal-card{transform:translateY(0)}
.auth-modal-x{position:absolute;top:16px;right:16px;width:32px;height:32px;border-radius:50%;background:var(--surface-2);border:none;display:flex;align-items:center;justify-content:center;color:var(--text-3);cursor:pointer;transition:all .15s}
.auth-modal-x:hover{background:var(--surface-3)}
.auth-modal-gem{width:60px;height:60px;background:var(--grad-brand);border-radius:18px;display:flex;align-items:center;justify-content:center;margin-bottom:18px;box-shadow:0 8px 28px rgba(124,58,237,.35)}
.auth-modal-card h3{font-family:var(--f-display);font-size:1.6rem;font-weight:900;letter-spacing:-.03em;margin-bottom:10px}
.auth-modal-card p{font-size:.88rem;color:var(--text-2);line-height:1.65;margin-bottom:26px;max-width:280px}
    `;
    document.head.appendChild(s);
  }

  // ── Init ──────────────────────────────────────────────────────
  async function init() {
    _injectCSS();
    updateNavbar();
    if (_token) refreshMe().then(updateNavbar);
  }

  // ── OTP helpers ───────────────────────────────────────────────
  // sendOtp(email) → calls POST /auth/otp/send
  //   Returns {demo_otp} in dev mode so you can test without email
  // verifyOtp(email, otp) → calls POST /auth/otp/verify
  //   Returns {valid: true} on success, throws on failure
  async function sendOtp(email) {
    return _post("/auth/otp/send", { email });
  }
  async function verifyOtp(email, otp) {
    return _post("/auth/otp/verify", { email, otp: String(otp) });
  }

  return { isLoggedIn, getUser, getToken, signup, login, logout, refreshMe,
           requireAuth, redirectIfAuthed, updateNavbar, showLoginModal, init,
           sendOtp, verifyOtp };
})();

document.readyState === "loading"
  ? document.addEventListener("DOMContentLoaded", () => Auth.init())
  : Auth.init();
