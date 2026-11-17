const NARRATION_FILES = Array.from(
  { length: 6 },
  (_, index) => `Narration%20FR/FR_${index + 1}.mp3`
).concat("Narration%20FR/FR_erreur.mp3");

export function createNarrativeController({
  audio,
  getShepherd,
  getBag,
  onChange,
  revealShepherd,
  animateArrival,
  pickupBag,
  setBagOwned,
  animateHandoff,
  animateDeparture,
  showMap,
  showRope,
  showCollectible,
  collectReward,
  openInventory,
  closeInventory,
}) {
  let started = false;
  let busy = false;
  let stage = "waiting-near-bag";
  let loadingPromise = Promise.resolve();

  function updateView(prompt = null, reward = false, availableItems = []) {
    onChange({ prompt, reward, availableItems });
  }

  async function play(index) {
    await loadingPromise;
    const shepherd = getShepherd();
    if (!shepherd) throw new Error("Le berger n’est pas encore chargé.");
    await audio.playNarration(index, shepherd);
  }

  async function beginFromBag(controller = null) {
    if ((started && stage !== "pickup-error") || busy) return false;
    started = true;
    busy = true;
    stage = "picking-up-bag";
    updateView();

    try {
      await pickupBag(getBag(), controller);
      setBagOwned(true);
      stage = "first-line";
      const shepherd = getShepherd();
      revealShepherd(shepherd);
      const arrival = animateArrival(shepherd, { movePlayer: false });
      await Promise.all([arrival, play(0)]);
      stage = "approach";
      updateView({ label: "Approcher le berger", action: "shepherd" });
      return true;
    } catch (error) {
      console.error("Impossible de ramasser le sac ou de lancer le récit.", error);
      stage = "pickup-error";
      updateView({ label: "Réessayer", action: "retry" });
      return false;
    } finally {
      busy = false;
    }
  }

  async function activateBag(controller = null) {
    if (stage !== "waiting-near-bag") return false;
    return beginFromBag(controller);
  }

  async function selectInventoryItem(item) {
    if (busy) return false;
    if (stage === "map" && item !== "corsica-map") {
      playWrongChoice();
      return false;
    }
    if (stage === "rope" && item !== "rope") {
      playWrongChoice();
      return false;
    }
    if (stage !== "map" && stage !== "rope") return false;

    busy = true;
    updateView();
    try {
      if (stage === "map") {
        stage = "map-story";
        showMap();
        await play(2);
        stage = "rope";
        updateView({ label: "Ouvrir l’inventaire et choisir la corde", action: "inventory" }, false, ["corsica-map", "rope"]);
      } else {
        stage = "rope-story";
        showRope();
        await play(3);
        stage = "return-to-shepherd";
        updateView({ label: "Rendre le sac au berger", action: "shepherd" });
      }
      return true;
    } catch (error) {
      console.error("Impossible de poursuivre le récit.", error);
      updateView({ label: "Reprendre le récit", action: "retry" });
      return false;
    } finally {
      busy = false;
    }
  }

  function playWrongChoice() {
    if (!getShepherd()) return;
    busy = true;
    void play(6)
      .catch((error) => console.error("Impossible de lire FR_erreur.", error))
      .finally(() => { busy = false; });
  }

  async function activateShepherd() {
    if (busy) return;
    busy = true;
    updateView();
    try {
      if (stage === "approach") {
        stage = "arrival";
        await animateArrival(getShepherd(), { movePlayer: true, animateShepherd: false });
        stage = "seated-story";
        await play(1);
        stage = "map";
        updateView({ label: "Ouvrir l’inventaire et choisir la carte", action: "inventory" }, false, ["corsica-map", "rope"]);
      } else if (stage === "return-to-shepherd") {
        closeInventory();
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
    if (stage === "map" || stage === "rope") {
      openInventory();
      return;
    }
    if (stage === "reward") return activateCollectible();
    if (stage === "waiting-near-bag") return beginFromBag();
    if (stage === "pickup-error") return beginFromBag();
  }

  return {
    load: async () => {
      loadingPromise = audio.loadNarration(NARRATION_FILES, ".");
      await loadingPromise;
    },
    activateBag,
    activateShepherd,
    activateCollectible,
    activatePrompt,
    selectInventoryItem,
  };
}
