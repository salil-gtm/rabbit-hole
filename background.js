// Rabbit Hole - Firefox Background Event Page
// Handles Gemini 2.5 Flash Lite API calls, client-side rate limiting,
// sidebar management, and the context menu.

const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const api = globalThis.browser ?? globalThis.chrome;

// ---- Rate limits, matched 1:1 to Gemini 2.5 Flash Lite free tier ----
// If the server ever 429s anyway (clock skew, another tab on the same key),
// the sidebar's handleServerRateLimit() auto-retries using the server's retryDelay.
const LIMITS = {
  rpm: 10,          // requests per minute
  tpm: 250_000,     // tokens per minute
  rpd: 20           // requests per day
};

const STATE_KEY = "rateLimiterState";

function nextUtcMidnight() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

async function loadState() {
  const { [STATE_KEY]: state } = await api.storage.local.get([STATE_KEY]);
  const now = Date.now();
  const s = state || { rpmTimestamps: [], tpmEvents: [], rpdCount: 0, rpdResetAt: nextUtcMidnight() };

  // Roll the daily window if we've crossed midnight UTC
  if (now >= s.rpdResetAt) {
    s.rpdCount = 0;
    s.rpdResetAt = nextUtcMidnight();
  }

  // Prune anything older than 60s from the rolling RPM and TPM windows
  const cutoff = now - 60_000;
  s.rpmTimestamps = s.rpmTimestamps.filter((t) => t > cutoff);
  s.tpmEvents = s.tpmEvents.filter((e) => e.t > cutoff);

  return s;
}

async function saveState(s) {
  await api.storage.local.set({ [STATE_KEY]: s });
}

function estimateTokens(text) {
  if (!text) return 0;
  // Rough heuristic — Gemini tokenizes close to ~4 chars per token for English.
  return Math.ceil(String(text).length / 4);
}

// Throws a structured error if we'd exceed any limit; otherwise records the reservation.
async function reserveBudget(estimatedTokens) {
  const s = await loadState();
  const now = Date.now();

  // 1. Daily cap — hardest failure mode, can't auto-retry
  if (s.rpdCount >= LIMITS.rpd) {
    const err = new Error(`Daily request limit reached (${LIMITS.rpd}/day).`);
    err.code = "DAILY_LIMIT";
    err.resetAt = s.rpdResetAt;
    throw err;
  }

  // 2. Per-minute request cap — wait until oldest request falls out of window
  if (s.rpmTimestamps.length >= LIMITS.rpm) {
    const oldest = s.rpmTimestamps[0];
    const waitMs = Math.max(0, oldest + 60_000 - now);
    const err = new Error(`Minute request limit reached (${LIMITS.rpm}/min).`);
    err.code = "MINUTE_LIMIT";
    err.waitMs = waitMs;
    throw err;
  }

  // 3. Per-minute token cap — same logic, but using estimated tokens
  const tokensInWindow = s.tpmEvents.reduce((sum, e) => sum + e.n, 0);
  if (tokensInWindow + estimatedTokens > LIMITS.tpm) {
    const oldest = s.tpmEvents[0];
    const waitMs = oldest ? Math.max(0, oldest.t + 60_000 - now) : 1000;
    const err = new Error(`Minute token limit reached (${LIMITS.tpm}/min).`);
    err.code = "TPM_LIMIT";
    err.waitMs = waitMs;
    throw err;
  }

  // All good — record the reservation optimistically
  s.rpmTimestamps.push(now);
  s.rpdCount += 1;
  s.tpmEvents.push({ t: now, n: estimatedTokens });
  await saveState(s);
}

// Adjust the most recent TPM event with the real token count reported by the server.
async function recordActualTokens(actualTokens) {
  if (!Number.isFinite(actualTokens) || actualTokens <= 0) return;
  const s = await loadState();
  if (s.tpmEvents.length > 0) {
    s.tpmEvents[s.tpmEvents.length - 1].n = actualTokens;
    await saveState(s);
  }
}

// If the API call failed for a non-quota reason, refund the reservation so the
// user isn't penalized for errors they didn't cause.
async function refundBudget() {
  const s = await loadState();
  if (s.rpmTimestamps.length) s.rpmTimestamps.pop();
  if (s.tpmEvents.length) s.tpmEvents.pop();
  if (s.rpdCount > 0) s.rpdCount -= 1;
  await saveState(s);
}

async function getQuotaStatus() {
  const s = await loadState();
  const tokensInWindow = s.tpmEvents.reduce((sum, e) => sum + e.n, 0);
  return {
    rpd: { used: s.rpdCount, limit: LIMITS.rpd, resetAt: s.rpdResetAt },
    rpm: { used: s.rpmTimestamps.length, limit: LIMITS.rpm },
    tpm: { used: tokensInWindow, limit: LIMITS.tpm }
  };
}

// ---- Context menu + sidebar lifecycle ----

api.runtime.onInstalled.addListener(() => {
  api.contextMenus.create({
    id: "rabbit-hole-explore",
    title: "Down the Rabbit Hole 🐇",
    contexts: ["selection"]
  });
});

api.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "rabbit-hole-explore" || !info.selectionText) return;
  try { await api.sidebarAction.open(); } catch (err) { console.warn("Rabbit Hole:", err); }
  setTimeout(() => {
    api.runtime.sendMessage({
      type: "NEW_RABBIT_HOLE",
      text: info.selectionText,
      pageTitle: tab?.title,
      pageUrl: tab?.url
    }).catch(() => {});
  }, 250);
});

api.action.onClicked.addListener(async () => {
  try { await api.sidebarAction.toggle(); }
  catch (_) { try { await api.sidebarAction.open(); } catch (_) {} }
});

// ---- Message router ----

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "OPEN_SIDEBAR_WITH_SELECTION") {
    (async () => {
      try { await api.sidebarAction.open(); } catch (err) { console.warn("Rabbit Hole:", err); }
      setTimeout(() => {
        api.runtime.sendMessage({
          type: "NEW_RABBIT_HOLE",
          text: msg.text,
          pageTitle: sender.tab?.title,
          pageUrl: sender.tab?.url
        }).catch(() => {});
      }, 250);
    })();
    return false;
  }

  if (msg.type === "GET_QUOTA") {
    getQuotaStatus().then(sendResponse);
    return true;
  }

  if (msg.type === "GEMINI_REQUEST") {
    callGemini(msg.prompt, msg.systemInstruction, msg.jsonMode)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({
        ok: false,
        error: err.message,
        code: err.code,
        status: err.status,
        apiMessage: err.apiMessage,
        apiStatus: err.apiStatus,
        retryAfterSeconds: err.retryAfterSeconds,
        waitMs: err.waitMs,
        resetAt: err.resetAt,
        quotaViolations: err.quotaViolations,
        isZeroQuota: err.isZeroQuota
      }));
    return true;
  }
});

// ---- Gemini call ----

async function callGemini(userPrompt, systemInstruction, jsonMode = false) {
  const { geminiApiKey } = await api.storage.sync.get(["geminiApiKey"]);
  if (!geminiApiKey) {
    const err = new Error("No API key set. Open extension options and paste your Gemini API key.");
    err.code = "NO_KEY";
    throw err;
  }

  // Estimate tokens up-front so we can reserve budget before firing the request.
  // Input + system + a generous guess for the JSON response.
  const estimatedIn = estimateTokens(userPrompt) + estimateTokens(systemInstruction);
  const estimatedOut = 800;
  const estimatedTotal = estimatedIn + estimatedOut;

  // This throws DAILY_LIMIT / MINUTE_LIMIT / TPM_LIMIT if we'd overshoot.
  await reserveBudget(estimatedTotal);

  const body = {
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.9,
      topP: 0.95,
      maxOutputTokens: 1024
    }
  };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
  if (jsonMode) body.generationConfig.responseMimeType = "application/json";

  let res;
  try {
    res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(geminiApiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (networkErr) {
    await refundBudget();
    throw networkErr;
  }

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Gemini API error (${res.status})`);
    err.status = res.status;
    err.rawBody = errText;

    try {
      const parsed = JSON.parse(errText);
      err.apiMessage = parsed?.error?.message || "";
      err.apiStatus = parsed?.error?.status || "";
      if (Array.isArray(parsed?.error?.details)) {
        for (const d of parsed.error.details) {
          if (d["@type"]?.endsWith("RetryInfo") && typeof d.retryDelay === "string") {
            const m = d.retryDelay.match(/([\d.]+)s/);
            if (m) err.retryAfterSeconds = Math.ceil(parseFloat(m[1]));
          }
          if (d["@type"]?.endsWith("QuotaFailure") && Array.isArray(d.violations)) {
            err.quotaViolations = d.violations.map((v) => ({ metric: v.quotaMetric, quotaId: v.quotaId }));
          }
        }
      }
      if (/limit:\s*0/.test(err.apiMessage)) err.isZeroQuota = true;
    } catch (_) { /* keep rawBody */ }

    // Only keep the daily count if the server 429'd (we did consume quota);
    // for any other error, give the budget back.
    if (res.status !== 429) {
      await refundBudget();
    }
    throw err;
  }

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";

  // Reconcile our estimate with the server's real token usage so TPM accounting
  // stays accurate over time.
  const actualIn = json?.usageMetadata?.promptTokenCount;
  const actualOut = json?.usageMetadata?.candidatesTokenCount;
  const actualTotal = (actualIn || 0) + (actualOut || 0);
  if (actualTotal > 0) await recordActualTokens(actualTotal);

  return { text, raw: json };
}
