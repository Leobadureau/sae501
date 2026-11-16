const translations = {
  fr: {
    tagline: "Entrez dans l’expérience narrative.",
    language: "LANGUE",
    pc: "Version ordinateur",
    vr: "Version réalité virtuelle",
  },
  co: {
    tagline: "Entrate in l’esperienza narrativa.",
    language: "LINGUA",
    pc: "Versione urdinatore",
    vr: "Versione realtà virtuale",
  },
};

export function initLanguagePicker() {
  const tagline = document.querySelector('[data-copy="tagline"]');
  const languageLabel = document.querySelector('[data-copy="language"]');
  const pcButton = document.getElementById("pc-mode");
  const vrButton = document.getElementById("ar-mode");

  document.querySelectorAll(".language-button").forEach((button) => {
    button.addEventListener("click", () => {
      const language = button.dataset.language;
      const selected = translations[language] ?? translations.fr;
      document.documentElement.lang = language;
      tagline.textContent = selected.tagline;
      languageLabel.textContent = selected.language;
      pcButton.setAttribute("aria-label", selected.pc);
      vrButton.setAttribute("aria-label", selected.vr);

      document.querySelectorAll(".language-button").forEach((option) => {
        const active = option === button;
        option.classList.toggle("is-active", active);
        option.setAttribute("aria-pressed", String(active));
      });
    });
  });
}
