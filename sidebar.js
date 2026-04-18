// Rabbit Hole - Firefox Sidebar Logic
// Orchestrates Gemini 2.5 Flash Lite calls with client-side rate limiting
// and local response caching.

const api = globalThis.browser ?? globalThis.chrome;

const els = {
  empty: document.getElementById("empty-state"),
  loading: document.getElementById("loading-state"),
  content: document.getElementById("content"),
  error: document.getElementById("error-state"),
  selectionText: document.getElementById("selection-text"),
  pageSource: document.getElementById("page-source"),
  depthBadge: document.getElementById("depth-badge"),
  summary: document.getElementById("summary"),
  facts: document.getElementById("facts"),
  questions: document.getElementById("questions"),
  topics: document.getElementById("topics"),
  breadcrumbs: document.getElementById("breadcrumbs"),
  errorTitle: document.getElementById("error-title"),
  errorMessage: document.getElementById("error-message"),
  retryBtn: document.getElementById("retry-btn"),
  followUpInput: document.getElementById("follow-up-input"),
  followUpSend: document.getElementById("follow-up-send"),
  settingsLink: document.getElementById("settings-link")
};

// Flavorful label + emoji for each depth tier. The user sees the current layer
// badge evolve as they burrow further in.
const DEPTH_STAGES = [
  { emoji: "🐇", label: "Burrow entrance" },      // Layer 1
  { emoji: "🕳️", label: "Going deeper" },          // Layer 2
  { emoji: "🌀", label: "Down the spiral" },       // Layer 3
  { emoji: "✨", label: "Through the looking glass" }, // Layer 4
  { emoji: "🌌", label: "Into Wonderland" },       // Layer 5
  { emoji: "🔮", label: "Deep in the warren" }      // Layer 6+
];

function depthStage(depth) {
  const i = Math.max(0, Math.min(DEPTH_STAGES.length - 1, depth - 1));
  return DEPTH_STAGES[i];
}

const trail = [];       // full exploration history (never destroyed by nav)
let cursor = -1;        // current position in `trail`; -1 = empty
let lastPayload = null;
let pendingRetryTimer = null;

// In-memory response cache for this session, keyed by (mode + text). Survives
// until the sidebar is closed — saves an API call if the user revisits a node.
const responseCache = new Map();
const cacheKey = (ctx) => `${ctx.mode || "selection"}::${ctx.text.trim().slice(0, 500)}`;

const SYSTEM_INSTRUCTION = `You are Rabbit Hole, a witty guide who turns curiosity into quick, delightful discoveries. You are given a snippet of text the user selected on a webpage plus optional page context.

Return STRICT JSON matching this schema:
{
  "summary": "1 sentence — the crisp plain-language gist",
  "facts": ["exactly 3 short surprising facts, 1 sentence each, the 'wait, really?' kind"],
  "questions": ["exactly 3 intriguing follow-up questions to explore next"],
  "topics": ["exactly 3 short related topic labels (1-3 words each)"]
}

Tone: curious, playful, concise. No filler, no preamble, no markdown — just the JSON.`;

// ---- View management ----

function setView(view) {
  els.empty.hidden = view !== "empty";
  els.loading.hidden = view !== "loading";
  els.content.hidden = view !== "content";
  els.error.hidden = view !== "error";
}

function renderPayload(payload, context) {
  els.selectionText.textContent = context.text;
  if (context.pageTitle || context.pageUrl) {
    const parts = [];
    if (context.pageTitle) parts.push(context.pageTitle);
    if (context.pageUrl) {
      try { parts.push(new URL(context.pageUrl).hostname); } catch (_) {}
    }
    els.pageSource.textContent = parts.join(" · ");
  } else {
    els.pageSource.textContent = "";
  }

  renderDepthBadge();

  els.summary.textContent = payload.summary || "";

  els.facts.innerHTML = "";
  (payload.facts || []).forEach((f) => {
    const li = document.createElement("li");
    li.textContent = f;
    els.facts.appendChild(li);
  });

  els.questions.innerHTML = "";
  (payload.questions || []).forEach((q) => {
    const btn = document.createElement("button");
    btn.className = "rh-question-btn";
    btn.textContent = q;
    btn.addEventListener("click", () => exploreNext(q, "question"));
    els.questions.appendChild(btn);
  });

  els.topics.innerHTML = "";
  (payload.topics || []).forEach((t) => {
    const chip = document.createElement("span");
    chip.className = "rh-topic";
    chip.textContent = t;
    chip.addEventListener("click", () => exploreNext(t, "topic"));
    els.topics.appendChild(chip);
  });

  renderBreadcrumbs();
  setView("content");
}

function renderDepthBadge() {
  if (!els.depthBadge) return;
  const depth = Math.max(1, cursor + 1);
  const stage = depthStage(depth);
  const canBack = cursor > 0;
  const canForward = cursor < trail.length - 1;
  const positionLabel = trail.length > 1 ? ` of ${trail.length}` : "";

  els.depthBadge.innerHTML = `
    <button class="rh-nav-btn" id="rh-nav-back" ${canBack ? "" : "disabled"} aria-label="Previous layer" title="Previous layer">←</button>
    <span class="rh-depth-main">
      <span class="rh-depth-emoji">${stage.emoji}</span>
      <span class="rh-depth-text">Layer ${depth}${positionLabel} · ${stage.label}</span>
    </span>
    <button class="rh-nav-btn" id="rh-nav-forward" ${canForward ? "" : "disabled"} aria-label="Next layer" title="Next layer">→</button>
  `;

  document.getElementById("rh-nav-back")?.addEventListener("click", goBack);
  document.getElementById("rh-nav-forward")?.addEventListener("click", goForward);
}

function renderBreadcrumbs() {
  els.breadcrumbs.innerHTML = "";
  trail.forEach((item, idx) => {
    const chip = document.createElement("button");
    const isActive = idx === cursor;
    const isForward = idx > cursor;
    chip.className = "rh-breadcrumb"
      + (isActive ? " active" : "")
      + (isForward ? " forward" : "");
    const label = item.text.length > 30 ? item.text.slice(0, 28) + "…" : item.text;
    chip.textContent = label;
    chip.title = item.text;
    chip.addEventListener("click", () => {
      if (!item.payload) return;
      cursor = idx;                    // move cursor, don't destroy forward history
      lastPayload = item.payload;
      renderPayload(item.payload, item);
    });
    els.breadcrumbs.appendChild(chip);
  });
}

// ---- Main explore flow ----

function addToHistory(entry) {
  // Standard browser-history semantics: discard any forward history, then push.
  trail.splice(cursor + 1);
  trail.push(entry);
  cursor = trail.length - 1;
}

function replaceCurrent(entry) {
  // Used on retries — swap the current node without changing cursor/history.
  if (cursor >= 0) trail[cursor] = entry;
  else addToHistory(entry);
}

function goBack() {
  if (cursor <= 0) return;
  cursor -= 1;
  const entry = trail[cursor];
  lastPayload = entry.payload;
  renderPayload(entry.payload, entry);
}

function goForward() {
  if (cursor >= trail.length - 1) return;
  cursor += 1;
  const entry = trail[cursor];
  lastPayload = entry.payload;
  renderPayload(entry.payload, entry);
}

async function exploreSelection(context, { push = true, retryCount = 0 } = {}) {
  clearRetryTimer();

  // Try local cache first — zero API cost
  const key = cacheKey(context);
  const cached = responseCache.get(key);
  if (cached) {
    const entry = { ...context, payload: cached, cached: true };
    if (push) addToHistory(entry); else replaceCurrent(entry);
    lastPayload = cached;
    renderPayload(cached, context);
    return;
  }

  setView("loading");
  const prompt = buildPrompt(context);
  try {
    const response = await sendToGemini(prompt, SYSTEM_INSTRUCTION, true);
    const payload = parseJsonSafely(response.text);
    if (!payload) throw new Error("Gemini returned an unexpected response.");
    responseCache.set(key, payload);
    const entry = { ...context, payload };
    if (push) addToHistory(entry); else replaceCurrent(entry);
    lastPayload = payload;
    renderPayload(payload, context);
  } catch (err) {
    // Client-side rate-limit rejections (never hit the network)
    if (err.code === "DAILY_LIMIT") return showDailyLimit(err);
    if (err.code === "MINUTE_LIMIT" || err.code === "TPM_LIMIT") {
      return handleClientRateLimit(err, context, { push, retryCount });
    }
    // Server-side 429 fallback (shouldn't fire if our limiter works)
    if (err.status === 429) {
      return handleServerRateLimit(err, context, { push, retryCount });
    }
    showError(err);
  }
}

function clearRetryTimer() {
  if (pendingRetryTimer) {
    clearInterval(pendingRetryTimer);
    pendingRetryTimer = null;
  }
}

// ---- Rate-limit UX ----

function showDailyLimit(err) {
  clearRetryTimer();
  const resetStr = err.resetAt ? formatResetTime(err.resetAt) : "tomorrow";
  els.errorTitle.textContent = "Daily limit reached 🌙";
  els.errorMessage.innerHTML = `You've used all <b>20</b> rabbit holes for today on the free tier. Your quota resets at <b>${resetStr}</b>. Cached explorations in this session are still browsable from the breadcrumb trail above.`;
  els.retryBtn.hidden = true;
  setView("error");
}

function handleClientRateLimit(err, context, { push, retryCount }) {
  // Safe to auto-retry — we predicted this before sending anything to the API.
  const waitSec = Math.max(1, Math.ceil((err.waitMs || 1000) / 1000));
  els.errorTitle.textContent = err.code === "TPM_LIMIT" ? "Token budget cooling down" : "Slowing down…";
  els.errorMessage.innerHTML = `Staying under the <b>${err.code === "TPM_LIMIT" ? "250K tokens" : "10 requests"}/minute</b> limit. Auto-retrying in <b id="countdown">${waitSec}</b>s…`;
  els.retryBtn.hidden = false;
  setView("error");

  let remaining = waitSec;
  pendingRetryTimer = setInterval(() => {
    remaining -= 1;
    const el = document.getElementById("countdown");
    if (el) el.textContent = String(Math.max(0, remaining));
    if (remaining <= 0) {
      clearRetryTimer();
      exploreSelection(context, { push, retryCount: retryCount + 1 });
    }
  }, 1000);
}

function handleServerRateLimit(err, context, { push, retryCount }) {
  // Belt-and-suspenders: the server 429'd anyway (clock skew, other tabs, etc.)
  const maxAutoRetries = err.isZeroQuota ? 0 : 2;
  const canAutoRetry = retryCount < maxAutoRetries;
  const delay = Math.max(err.retryAfterSeconds || 3, 1) + retryCount * 2;

  els.errorTitle.textContent = err.isZeroQuota ? "No quota available" : "Gemini asked us to slow down";
  els.errorMessage.innerHTML = err.isZeroQuota
    ? 'Your Google AI project shows <code>limit: 0</code>. Create a fresh key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">aistudio.google.com/app/apikey</a> in a new project, or enable billing.'
    : `${canAutoRetry ? `Auto-retrying in <b id="countdown">${delay}</b>s…` : "Try again in a moment."}`;
  els.retryBtn.hidden = false;
  setView("error");

  if (canAutoRetry) {
    let remaining = delay;
    pendingRetryTimer = setInterval(() => {
      remaining -= 1;
      const el = document.getElementById("countdown");
      if (el) el.textContent = String(Math.max(0, remaining));
      if (remaining <= 0) {
        clearRetryTimer();
        exploreSelection(context, { push, retryCount: retryCount + 1 });
      }
    }, 1000);
  }
}

function formatResetTime(epochMs) {
  try {
    const d = new Date(epochMs);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + " (your time)";
  } catch (_) {
    return "midnight UTC";
  }
}

// ---- Prompt + helpers ----

function buildPrompt(context) {
  const parts = [];
  parts.push(`Selected text: """${context.text}"""`);
  if (context.pageTitle) parts.push(`Page title: ${context.pageTitle}`);
  if (context.pageUrl) parts.push(`Page URL: ${context.pageUrl}`);
  if (context.mode === "question") {
    parts.push(`The user wants to explore this question in depth as the next step in their rabbit hole journey.`);
  } else if (context.mode === "topic") {
    parts.push(`The user picked this related topic to explore next.`);
  } else if (context.mode === "followup") {
    parts.push(`The user typed this as a free-form follow-up question.`);
  }
  parts.push("Generate the rabbit hole JSON.");
  return parts.join("\n\n");
}

async function exploreNext(text, mode) {
  const rootText = trail[0]?.text ?? "exploration";
  const ctx = {
    text,
    pageTitle: lastPayload ? `(from rabbit hole: ${rootText})` : "",
    pageUrl: "",
    mode
  };
  await exploreSelection(ctx, { push: true });
}

function parseJsonSafely(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch (_) {} }
    return null;
  }
}

function showError(errOrMessage) {
  clearRetryTimer();
  const message = typeof errOrMessage === "string"
    ? errOrMessage
    : (errOrMessage?.message || "An unknown error occurred.");
  els.errorMessage.textContent = message;
  if (message && message.toLowerCase().includes("api key")) {
    els.errorTitle.textContent = "API key needed";
  } else {
    els.errorTitle.textContent = "Something went wrong";
  }
  els.retryBtn.hidden = false;
  setView("error");
}

async function sendToGemini(prompt, systemInstruction, jsonMode) {
  const res = await api.runtime.sendMessage({
    type: "GEMINI_REQUEST",
    prompt,
    systemInstruction,
    jsonMode
  });
  if (!res) throw new Error("No response from background script.");
  if (!res.ok) {
    const err = new Error(res.error || "Gemini call failed.");
    err.code = res.code;
    err.status = res.status;
    err.apiMessage = res.apiMessage;
    err.retryAfterSeconds = res.retryAfterSeconds;
    err.waitMs = res.waitMs;
    err.resetAt = res.resetAt;
    err.quotaViolations = res.quotaViolations;
    err.isZeroQuota = res.isZeroQuota;
    throw err;
  }
  return res.data;
}

// ---- Event wiring ----

api.runtime.onMessage.addListener((msg) => {
  if (msg.type === "NEW_RABBIT_HOLE") {
    trail.length = 0;
    cursor = -1;
    exploreSelection({
      text: msg.text,
      pageTitle: msg.pageTitle,
      pageUrl: msg.pageUrl
    });
  }
});

els.retryBtn.addEventListener("click", () => {
  clearRetryTimer();
  if (cursor >= 0 && trail[cursor]) {
    exploreSelection(trail[cursor], { push: false });
  } else {
    setView("empty");
  }
});

els.settingsLink.addEventListener("click", (e) => {
  e.preventDefault();
  api.runtime.openOptionsPage();
});

els.followUpSend.addEventListener("click", submitFollowUp);
els.followUpInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitFollowUp();
});

function submitFollowUp() {
  const q = els.followUpInput.value.trim();
  if (!q) return;
  els.followUpInput.value = "";
  exploreNext(q, "followup");
}

// Keyboard navigation — Alt+Left / Alt+Right for back/forward, like a browser.
document.addEventListener("keydown", (e) => {
  if (!e.altKey) return;
  if (document.activeElement === els.followUpInput) return; // let the user type
  if (e.key === "ArrowLeft") { e.preventDefault(); goBack(); }
  else if (e.key === "ArrowRight") { e.preventDefault(); goForward(); }
});

setView("empty");
