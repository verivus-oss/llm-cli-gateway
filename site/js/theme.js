(function () {
  const root = document.documentElement;
  const storageKey = "verivus-site-theme";
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

  function preferredPreference() {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "system" || stored === "light" || stored === "dark") return stored;
    return "system";
  }

  function systemTheme() {
    return mediaQuery.matches ? "dark" : "light";
  }

  function oppositeTheme() {
    return systemTheme() === "dark" ? "light" : "dark";
  }

  function resolvedTheme(preference) {
    if (preference === "system") return systemTheme();
    return preference;
  }

  function applyTheme(preference) {
    const opposite = oppositeTheme();
    const visiblePreference = preference === opposite ? preference : "system";
    const theme = resolvedTheme(visiblePreference);
    root.dataset.theme = theme;
    root.dataset.themePreference = visiblePreference;
    root.style.colorScheme = theme;
    document.querySelectorAll("[data-theme-choice]").forEach(button => {
      const choice = button.dataset.themeChoice;
      button.hidden = choice !== "system" && choice !== opposite;
      const isSelected = choice === visiblePreference;
      button.classList.toggle("active", isSelected);
      button.setAttribute("aria-pressed", String(isSelected));
    });
  }

  applyTheme(preferredPreference());

  window.addEventListener("DOMContentLoaded", () => {
    applyTheme(preferredPreference());
    document.querySelectorAll("[data-theme-choice]").forEach(button => {
      button.addEventListener("click", () => {
        const preference = button.dataset.themeChoice;
        window.localStorage.setItem(storageKey, preference);
        applyTheme(preference);
      });
    });
  });

  mediaQuery.addEventListener("change", () => {
    if (preferredPreference() === "system") applyTheme("system");
  });
})();
