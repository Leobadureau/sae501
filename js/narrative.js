const NARRATION_FILES = Array.from(
  { length: 6 },
  (_, index) => `Narration%20FR/FR_${index + 1}.mp3`
);

export function createNarrativeController({ audio, getShepherd, getBag, onChange, animateArrival, animateDeparture }) {
  let started = false;
  let busy = false;
  let ready = false;
  let stage = "waiting-near-bag";

  function updateView(prompt = null, reward = false) {
    onChange({ prompt, reward });
  }

  async function play(index) {
    const shepherd = getShepherd();
    if (!shepherd) throw new Error("Le berger n’est pas encore chargé.");
    await audio.playNarration(index, shepherd);
  }

  async function runSequence() {
    try {
      // FR_1 : le berger appelle le joueur et l’invite à s’approcher.
      await play(0);
      stage = "approach";
      updateView({ label: "Approcher le berger", action: "approach" });
    } catch (error) {
      console.error("Impossible de lire la narration.", error);
      updateView({ label: "Réessayer le dialogue", action: "retry" });
    }
  }

  function update(playerPosition) {
    if (!ready || started || stage !== "waiting-near-bag") return;
    const bag = getBag();
    if (!bag) return;
    const distance = Math.hypot(playerPosition.x - bag.position.x, playerPosition.z - bag.position.z);
    if (distance > 1.8) return;
    started = true;
    stage = "first-line";
    void runSequence();
  }

  async function interact() {
    if (busy) return;
    busy = true;
    updateView();
    try {
      switch (stage) {
        case "approach": {
          stage = "arrival";
          const shepherd = getShepherd();
          if (shepherd) shepherd.visible = true;
          await animateArrival(shepherd);
          await play(1);
          stage = "map";
          updateView({ label: "Sortir la carte de Corse du sac", action: "map" });
          break;
        }
        case "map":
          stage = "map-taken";
          await play(2);
          stage = "rope";
          updateView({ label: "Sortir la corde du sac", action: "rope" });
          break;
        case "rope":
          stage = "rope-taken";
          await play(3);
          stage = "return-bag";
          updateView({ label: "Rendre le sac au berger", action: "return-bag" });
          break;
        case "return-bag": {
          stage = "reward";
          const bag = getBag();
          if (bag) bag.visible = false;
          updateView(null, true);
          await play(4);
          await play(5);
          await animateDeparture(getShepherd(), bag);
          stage = "complete";
          updateView(null, true);
          break;
        }
        case "retry":
          stage = "first-line";
          await runSequence();
          break;
        default:
          break;
      }
    } catch (error) {
      console.error("La séquence narrative a été interrompue.", error);
      updateView({ label: "Reprendre le récit", action: "retry" });
    } finally {
      busy = false;
    }
  }

  return {
    load: async () => {
      await audio.loadNarration(NARRATION_FILES, ".");
      ready = true;
    },
    update,
    interact,
  };
}
