// ai.js — ZenPin AI Generator Module
// Handles all AI generation UI and API calls for the AI page
// ─────────────────────────────────────────────────────────────

const AIModule = (() => {

  let _history = JSON.parse(localStorage.getItem("zenpin_ai_history") || "[]");

  // ── Run generation ────────────────────────────────────────────
  async function generate(topic, onStart, onResult, onError) {
    if (!topic?.trim()) return;

    // Auth guard
    if (typeof Auth !== "undefined" && !Auth.isLoggedIn()) {
      Auth.showLoginModal();
      return;
    }

    onStart?.();

    try {
      const result = await API.generateBoard(topic.trim());
      const entry  = { topic: topic.trim(), date: new Date().toLocaleDateString(), ideas: result.ideas };
      _history.unshift(entry);
      if (_history.length > 12) _history = _history.slice(0, 12);
      localStorage.setItem("zenpin_ai_history", JSON.stringify(_history));
      onResult?.(result);
    } catch (err) {
      onError?.(err.message || "Generation failed. Please try again.");
    }
  }

  // ── Render history list ───────────────────────────────────────
  function renderHistory(container) {
    if (!container) return;
    if (typeof container === "string") container = document.getElementById(container);
    if (!container) return;
    if (!_history.length) {
      container.innerHTML = `<p class="empty-note">Your generated boards will appear here.</p>`;
      return;
    }
    container.innerHTML = _history.map((h, i) => `
      <div class="ai-hist-item" data-idx="${i}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--purple)" stroke-width="2" style="flex-shrink:0">
          <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/>
        </svg>
        <span class="ai-hist-prompt">${h.topic}</span>
        <span class="ai-hist-date">${h.date}</span>
      </div>`).join("");
  }

  // ── Color palette generator (visual extra) ────────────────────
  function generatePalette(topic) {
    const palettes = {
      wabi:    ["#c9b99a","#8b7355","#6b5c45","#d4c5b0","#f0e8dc"],
      cyber:   ["#00ffff","#ff00ff","#7c3aed","#1a0a2e","#0a0a1a"],
      cottage: ["#7fb069","#a4c3a2","#e8d5b7","#c8a96e","#8b6914"],
      minimal: ["#f5f5f0","#e0ddd8","#b8b3ab","#6b6560","#1a1714"],
      japandi: ["#d4c5b0","#8b7355","#5c4a3a","#a8c5bd","#2d3b2e"],
      modern:  ["#1a1714","#7c3aed","#db2777","#f97316","#ffffff"],
      nature:  ["#2d5a27","#5a8f3c","#a8c5a0","#d4e8c8","#f0f7ec"],
      ocean:   ["#0a3d62","#1e6f9f","#48b8d0","#a8e6f0","#e8f8fc"],
    };
    const lower = topic.toLowerCase();
    const key   = Object.keys(palettes).find(k => lower.includes(k)) || "minimal";
    return palettes[key];
  }

  // ── Render palette swatches ───────────────────────────────────
  function renderPalette(colors, container) {
    if (!container) return;
    if (typeof container === "string") container = document.getElementById(container);
    if (!container) return;
    container.innerHTML = colors.map(c => `
      <div class="palette-swatch" style="background:${c}" title="${c}" data-color="${c}">
        <div class="swatch-label">${c}</div>
      </div>`).join("");
    container.querySelectorAll(".palette-swatch").forEach(sw => {
      sw.onclick = () => {
        navigator.clipboard?.writeText(sw.dataset.color);
        const lbl = sw.querySelector(".swatch-label");
        lbl.textContent = "Copied!";
        setTimeout(() => lbl.textContent = sw.dataset.color, 1500);
      };
    });
  }

  // ── Style tags ────────────────────────────────────────────────
  function getStyleTags(topic) {
    const lower = topic.toLowerCase();
    const all = ["Minimalist","Maximalist","Japandi","Wabi-sabi","Brutalist",
                 "Cottagecore","Cyberpunk","Art Deco","Bauhaus","Scandinavian",
                 "Industrial","Bohemian","Mediterranean","Nordic","Zen",
                 "Retro-Futuristic","Organic","Editorial","Geometric","Textural"];
    // pick 3–5 that loosely relate
    const matched = all.filter(t => lower.includes(t.toLowerCase().split("-")[0]));
    const random  = all.filter(t => !matched.includes(t)).sort(() => Math.random() - 0.5).slice(0, 4 - matched.length);
    return [...matched, ...random].slice(0, 4);
  }

  return { generate, renderHistory, generatePalette, renderPalette, getStyleTags };
})();
