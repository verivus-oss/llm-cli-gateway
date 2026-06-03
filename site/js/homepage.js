const page = document.querySelector(".hp-page");
const buttons = [...document.querySelectorAll(".hp-picker__option")];
const navbar = document.getElementById("navbar");
const navToggle = document.getElementById("nav-toggle");
const navLinks = document.getElementById("nav-links");
const announce = document.getElementById("copy-announce");

function showVariant(variant) {
  page.classList.remove("hp-page--picking", "hp-page--install", "hp-page--demo", "hp-page--compare");
  page.classList.add(`hp-page--${variant}`);
  buttons.forEach(button => button.classList.toggle("active", button.dataset.variant === variant));
}

buttons.forEach(button => {
  button.addEventListener("click", () => showVariant(button.dataset.variant));
});

window.addEventListener("keydown", event => {
  if (event.key === "1") showVariant("install");
  if (event.key === "2") showVariant("demo");
  if (event.key === "3") showVariant("compare");
});

window.addEventListener(
  "scroll",
  () => navbar.classList.toggle("scrolled", window.scrollY > 20),
  { passive: true }
);

navToggle?.addEventListener("click", () => {
  const expanded = navToggle.getAttribute("aria-expanded") === "true";
  navToggle.setAttribute("aria-expanded", String(!expanded));
  navLinks?.classList.toggle("open");
});

document.querySelectorAll(".hp-copy").forEach(button => {
  button.addEventListener("click", async () => {
    const text = button.dataset.copy;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "copied";
      if (announce) announce.textContent = "Copied to clipboard";
      setTimeout(() => {
        button.textContent = "copy";
        if (announce) announce.textContent = "";
      }, 1800);
    } catch {
      button.textContent = "failed";
      setTimeout(() => {
        button.textContent = "copy";
      }, 1800);
    }
  });
});
