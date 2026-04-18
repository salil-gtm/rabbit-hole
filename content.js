// Rabbit Hole - Content Script (Firefox)
// Shows a floating "🐇 Down the Rabbit Hole" button next to text selections.

(function () {
  const api = globalThis.browser ?? globalThis.chrome;
  const BUTTON_ID = "__rabbit_hole_btn__";

  function removeButton() {
    const existing = document.getElementById(BUTTON_ID);
    if (existing) existing.remove();
  }

  function showButton(x, y, selectionText) {
    removeButton();
    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.className = "rabbit-hole-float-btn";
    btn.innerHTML = '<span class="rh-emoji">🐇</span><span class="rh-label">Down the Rabbit Hole</span>';
    btn.style.top = `${y + window.scrollY + 8}px`;
    btn.style.left = `${x + window.scrollX}px`;

    btn.addEventListener("mousedown", (e) => {
      // Don't clear the selection when the user presses down on the button
      e.preventDefault();
      e.stopPropagation();
    });

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Sending the message from inside this click handler preserves the user-input
      // privilege Firefox needs to call sidebarAction.open() in the background script.
      const sending = api.runtime.sendMessage({
        type: "OPEN_SIDEBAR_WITH_SELECTION",
        text: selectionText
      });
      if (sending && typeof sending.catch === "function") {
        sending.catch(() => { /* no-op */ });
      }
      removeButton();
    });

    document.body.appendChild(btn);
  }

  document.addEventListener("mouseup", (e) => {
    if (e.target && e.target.closest && e.target.closest(`#${BUTTON_ID}`)) return;

    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (text.length < 3) {
        removeButton();
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      showButton(rect.left, rect.bottom, text);
    }, 10);
  });

  document.addEventListener("mousedown", (e) => {
    if (e.target && e.target.closest && e.target.closest(`#${BUTTON_ID}`)) return;
    removeButton();
  });

  document.addEventListener("scroll", () => removeButton(), { passive: true });
})();
