export const appScript = `"use strict";
document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", async () => {
    const selector = button.getAttribute("data-copy-target");
    const target = selector ? document.querySelector(selector) : null;
    if (!(target instanceof HTMLInputElement)) return;
    const value = new URL(target.value, location.origin).href;
    try {
      await navigator.clipboard.writeText(value);
      const previous = button.textContent;
      button.textContent = "Copied";
      button.classList.add("is-copied");
      setTimeout(() => {
        button.textContent = previous;
        button.classList.remove("is-copied");
      }, 1600);
    } catch {
      target.value = value;
      target.focus();
      target.select();
    }
  });
});`;
