// Light by default. Dark only when the visitor picks it; the choice is remembered.
// Loaded in <head> so the saved theme applies before first paint.
(function () {
  "use strict";
  var KEY = "whydenied-theme";
  var root = document.documentElement;

  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function apply(theme) {
    if (theme === "dark") root.setAttribute("data-theme", "dark");
    else root.removeAttribute("data-theme");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#000000" : "#FFFFFF");
    var btn = document.getElementById("theme-toggle");
    if (btn) {
      btn.textContent = theme === "dark" ? "Light" : "Dark";
      btn.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
      btn.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
    }
  }

  apply(saved());

  document.addEventListener("DOMContentLoaded", function () {
    apply(saved());
    var btn = document.getElementById("theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      try { localStorage.setItem(KEY, next); } catch (e) { /* private mode: still switch */ }
      apply(next);
    });
  });
})();
