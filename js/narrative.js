const NARRATION_FILES = Array.from(
  { length: 6 },
  (_, index) => `Narration%20FR/FR_${index + 1}.mp3`
);

export function createNarrativeController({
  audio,
  getShepherd,
  getBag,
  onChange,
  revealShepherd,
  animateArrival,
  animateHandoff,
  animateDeparture,
  showMap,
  showRope,
  showCollectible,
  collectReward,
}) {
  let started = false;
  let busy = false;
  let stage = "waiting-near-bag";
  let loadingPromise = Promise.resolve();

  function updateView(prompt = null, reward = false) {
    onChange({ prompt, reward });
  }

  async function play(index) {
    await loadingPromise;
    const shepherd = getShepherd();
    if (!shepherd) throw new Error("Le berger n’est pas encore chargé.");
    await audio.playNarration(index, shepherd);
  }

  async function runFirstLine() {
    try {
      await play(0);
      stage = "approach";
      updateView({ label: "Approcher le berger", action: "shepherd" });
    } catch (error) {
      console.error("Impossible de lire le premier dialogue.", error);
      updateView({ label: "Réessayer le dialogue", action: "retry" });
    }
  }

  function startFirstLine() {
    if (started) return;
    started = true;
    stage = "first-line";
    revealShepherd(getShepherd());
    void runFirstLine();
  }

  function update(playerPosition) {
    if (started || stage !== "waiting-near-bag") return;
    const bag = getBag();
    if (!bag) return;
    const distance = Math.hypot(playerPosition.x - bag.position.x, playerPosition.z - bag.position.z);
    if (distance <= 1.8) startFirstLine();
  }

  async function activateBag() {
    if (busy) return;
    if (stage === "waiting-near-bag") {
      startFirstLine();
      return;
    }

    busy = true;
    updateView();
    try {
      if (stage === "map") {
        stage = "map-story";
        showMap();
        await play(2);
        stage = "rope";
        updateView({ label: "Sortir la corde du sac", action: "bag" });
      } else if (stage === "rope") {
        stage = "rope-story";
        showRope();
        await play(3);
        stage = "return-bag";
        updateView({ label: "Prendre le sac", action: "bag" });
      } else if (stage === "return-bag") {
        stage = "return-to-shepherd";
        updateView({ label: "Rendre le sac au berger", action: "shepherd" });
      }
    } catch (error) {
      console.error("Impossible de poursuivre le récit.", error);
      updateView({ label: "Réessayer", action: "retry" });
    } finally {
      busy = false;
    }
  }

  async function activateShepherd() {
    if (busy) return;
    busy = true;
    updateView();
    try {
      if (stage === "approach") {
        stage = "arrival";
        await animateArrival(getShepherd());
        stage = "seated-story";
        await play(1);
        stage = "map";
        updateView({ label: "Sortir la carte de Corse du sac", action: "bag" });
      } else if (stage === "return-to-shepherd") {
        stage = "handoff";
        await animateHandoff(getBag(), getShepherd());
        showCollectible();
        stage = "reward-story";
        updateView(null, true);
        await play(4);
        stage = "reward";
        updateView({ label: "Récupérer la carte", action: "collectible" }, true);
      }
    } catch (error) {
      console.error("La séquence du berger a été interrompue.", error);
      updateView({ label: "Reprendre", action: "retry" });
    } finally {
      busy = false;
    }
  }

  async function activateCollectible() {
    if (busy || stage !== "reward") return;
    busy = true;
    stage = "farewell";
    updateView(null, true);
    try {
      collectReward();
      await play(5);
      stage = "departure";
      updateView(null, true);
      await animateDeparture(getShepherd(), getBag());
      stage = "complete";
      updateView(null, true);
    } catch (error) {
      console.error("Impossible de terminer le récit.", error);
      updateView({ label: "Reprendre les dernières paroles", action: "collectible" }, true);
    } finally {
      busy = false;
    }
  }

  function activatePrompt() {
    if (stage === "approach" || stage === "return-to-shepherd") return activateShepherd();
    if (stage === "reward") return activateCollectible();
    return activateBag();
  }

  return {
    load: async () => {
      loadingPromise = audio.loadNarration(NARRATION_FILES, ".");
      await loadingPromise;
    },
    activateBag,
    activateCollectible,
    activatePrompt,
    activateShepherd,
    update,
  };
}
