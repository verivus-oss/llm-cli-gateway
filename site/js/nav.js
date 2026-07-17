// Shared navbar behavior for the secondary pages: scroll shadow + mobile
// menu toggle. The home page uses homepage.js, which already carries this
// logic, so nav.js is not loaded there. All lookups are guarded so the
// script is a no-op on any page that omits the navbar.
const navbar = document.getElementById("navbar");
const navToggle = document.getElementById("nav-toggle");
const navLinks = document.getElementById("nav-links");

if (navbar) {
  window.addEventListener(
    "scroll",
    () => navbar.classList.toggle("scrolled", window.scrollY > 20),
    { passive: true },
  );
}

navToggle?.addEventListener("click", () => {
  const expanded = navToggle.getAttribute("aria-expanded") === "true";
  navToggle.setAttribute("aria-expanded", String(!expanded));
  navLinks?.classList.toggle("open");
});
