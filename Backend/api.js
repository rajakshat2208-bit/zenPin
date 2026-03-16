// api.js
// ─────────────────────────────────────────────────────────────
// All API calls from ZenPin frontend → FastAPI backend.
//
// HOW TO USE IN script.js:
//   const ideas = await API.getIdeas({ category: "Art" });
//   const { token } = await API.login("me@email.com", "password");
//
// TOKEN STORAGE:
//   Token is stored in memory (API.token).
//   On page load we check localStorage as a fallback so users
//   stay logged in after refresh.
// ─────────────────────────────────────────────────────────────

const API = (() => {

  const BASE = "http://localhost:8000";

  // ── Token management ────────────────────────────────────────
  let _token = localStorage.getItem("zenpin_token") || null;
  let _user  = JSON.parse(localStorage.getItem("zenpin_user") || "null");

  function setToken(token, user) {
    _token = token;
    _user  = user;
    localStorage.setItem("zenpin_token", token);
    localStorage.setItem("zenpin_user", JSON.stringify(user));
  }

  function clearToken() {
    _token = null;
    _user  = null;
    localStorage.removeItem("zenpin_token");
    localStorage.removeItem("zenpin_user");
  }

  function getUser()  { return _user; }
  function getToken() { return _token; }
  function isLoggedIn() { return !!_token; }

  // ── Core fetch wrapper ───────────────────────────────────────
  // Adds auth header, parses JSON, throws on error.
  async function request(method, path, body = null, isForm = false) {
    const headers = {};

    if (_token) {
      headers["Authorization"] = `Bearer ${_token}`;
    }

    if (body && !isForm) {
      headers["Content-Type"] = "application/json";
    }

    const config = {
      method,
      headers,
      body: body
        ? isForm
          ? body                          // FormData — don't JSON.stringify
          : JSON.stringify(body)
        : undefined,
    };

    const res = await fetch(`${BASE}${path}`, config);

    // Parse JSON even for errors (FastAPI returns error details as JSON)
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = data.detail || `HTTP ${res.status}`;
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }

    return data;
  }


  // ══════════════════════════════════════════════════════════
  // AUTH
  // ══════════════════════════════════════════════════════════

  async function signup(username, email, password) {
    const data = await request("POST", "/auth/signup", { username, email, password });
    setToken(data.token, data.user);
    return data;
  }

  async function login(email, password) {
    const data = await request("POST", "/auth/login", { email, password });
    setToken(data.token, data.user);
    return data;
  }

  function logout() {
    clearToken();
  }

  async function getMe() {
    return request("GET", "/auth/me");
  }

  async function updateProfile(bio) {
    return request("PATCH", "/auth/me", { bio });
  }


  // ══════════════════════════════════════════════════════════
  // IDEAS
  // ══════════════════════════════════════════════════════════

  async function getIdeas({ category, search, sort, limit = 20, offset = 0 } = {}) {
    const params = new URLSearchParams();
    if (category && category !== "all") params.set("category", category);
    if (search)  params.set("search",   search);
    if (sort)    params.set("sort",     sort);
    params.set("limit",  limit);
    params.set("offset", offset);
    return request("GET", `/ideas?${params}`);
  }

  async function getIdea(id) {
    return request("GET", `/ideas/${id}`);
  }

  async function createIdea(data) {
    return request("POST", "/ideas", data);
  }

  async function deleteIdea(id) {
    return request("DELETE", `/ideas/${id}`);
  }


  // ══════════════════════════════════════════════════════════
  // SOCIAL
  // ══════════════════════════════════════════════════════════

  async function toggleSave(ideaId) {
    return request("POST", `/ideas/${ideaId}/save`);
  }

  async function toggleLike(ideaId) {
    return request("POST", `/ideas/${ideaId}/like`);
  }

  async function getSavedIdeas(userId) {
    return request("GET", `/users/${userId}/saves`);
  }


  // ══════════════════════════════════════════════════════════
  // BOARDS
  // ══════════════════════════════════════════════════════════

  async function getBoards() {
    return request("GET", "/boards");
  }

  async function createBoard(name, description = "", is_collab = false) {
    return request("POST", "/boards", { name, description, is_collab });
  }

  async function addToBoard(boardId, ideaId) {
    return request("POST", `/boards/${boardId}/ideas`, { idea_id: ideaId });
  }


  // ══════════════════════════════════════════════════════════
  // UPLOAD
  // ══════════════════════════════════════════════════════════

  async function uploadImage(file) {
    const form = new FormData();
    form.append("file", file);
    return request("POST", "/upload", form, true);
  }


  // ══════════════════════════════════════════════════════════
  // AI
  // ══════════════════════════════════════════════════════════

  async function generateBoard(topic) {
    return request("POST", "/ai/generate", { topic });
  }


  // ══════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════
  return {
    // Auth state
    isLoggedIn,
    getUser,
    getToken,
    logout,

    // Auth routes
    signup,
    login,
    getMe,
    updateProfile,

    // Ideas
    getIdeas,
    getIdea,
    createIdea,
    deleteIdea,

    // Social
    toggleSave,
    toggleLike,
    getSavedIdeas,

    // Boards
    getBoards,
    createBoard,
    addToBoard,

    // Upload
    uploadImage,

    // AI
    generateBoard,
  };
})();
