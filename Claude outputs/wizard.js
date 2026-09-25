/* wizard.js — DeathKO Prime XL
   Ana sayfadaki adım adım (video → program → kriterler → süreç → başvuru)
   akışını yönetir. Sadece #wizard elementi bulunan sayfada (index.html)
   çalışır; diğer tüm sayfalarda bu script no-op'tur. Başvuru formunun
   gönderim mantığı burada değil, site.js'te — form burada sadece bir
   "adım" olarak gösteriliyor, site.js onu id'siyle (basvuruForm) bulup
   kendi işini yapıyor. */
(function () {
  "use strict";

  var root = document.getElementById("wizard");
  if (!root) return;

  var panels = Array.prototype.slice.call(root.querySelectorAll(".wizard-panel"));
  var dots = Array.prototype.slice.call(root.querySelectorAll(".wizard-step-dot"));
  var fill = document.getElementById("wizardProgressFill");
  var prevBtn = document.getElementById("wizardPrevBtn");
  var nextBtn = document.getElementById("wizardNextBtn");
  var indicator = document.getElementById("wizardStepIndicator");
  var total = panels.length;
  var current = 1;
  var firstRender = true;

  function render() {
    panels.forEach(function (panel) {
      var step = Number(panel.getAttribute("data-step"));
      var isActive = step === current;
      panel.classList.toggle("is-active", isActive);
      if (isActive) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
    });

    dots.forEach(function (dot) {
      var step = Number(dot.getAttribute("data-step"));
      dot.classList.toggle("is-active", step === current);
      dot.classList.toggle("is-done", step < current);
      dot.setAttribute("aria-current", step === current ? "step" : "false");
    });

    if (fill) fill.style.width = (current / total) * 100 + "%";
    if (indicator) indicator.textContent = "Adım " + current + " / " + total;
    if (prevBtn) prevBtn.disabled = current === 1;
    if (nextBtn) {
      // Son adımda "İleri" yerine formun kendi "Başvurumu Gönder" butonu
      // devreye giriyor; wizard'ın kendi ileri butonuna gerek kalmıyor.
      nextBtn.hidden = current === total;
    }
  }

  function goTo(step) {
    current = Math.max(1, Math.min(total, step));
    render();
    if (!firstRender) {
      root.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    firstRender = false;
  }

  dots.forEach(function (dot) {
    dot.addEventListener("click", function () {
      goTo(Number(dot.getAttribute("data-step")));
    });
  });

  if (prevBtn) prevBtn.addEventListener("click", function () { goTo(current - 1); });
  if (nextBtn) nextBtn.addEventListener("click", function () { goTo(current + 1); });

  render();
})();
