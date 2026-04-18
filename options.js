const api = globalThis.browser ?? globalThis.chrome;

const input = document.getElementById("api-key");
const saveBtn = document.getElementById("save");
const revealBtn = document.getElementById("toggle-reveal");
const status = document.getElementById("status");

// Hydrate existing value
api.storage.sync.get(["geminiApiKey"]).then(({ geminiApiKey }) => {
  if (geminiApiKey) input.value = geminiApiKey;
});

saveBtn.addEventListener("click", async () => {
  const key = input.value.trim();
  if (!key) {
    status.textContent = "Please paste a key first.";
    status.className = "status err";
    return;
  }
  if (!key.startsWith("AIza")) {
    status.textContent = "That doesn't look like a Gemini key (should start with AIza).";
    status.className = "status err";
    return;
  }
  await api.storage.sync.set({ geminiApiKey: key });
  status.textContent = "Saved. Select text on any webpage to start exploring.";
  status.className = "status ok";
});

revealBtn.addEventListener("click", () => {
  if (input.type === "password") {
    input.type = "text";
    revealBtn.textContent = "Hide";
  } else {
    input.type = "password";
    revealBtn.textContent = "Show";
  }
});
