(function () {
  try {
    const preference = localStorage.getItem("grok-light.theme");
    const dark = preference === "dark" || (preference !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#161a21" : "#eceeeb");
  } catch {}
})();
