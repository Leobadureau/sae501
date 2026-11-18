export function createAudioSystem({ THREE, audioListener, scene, renderer, musicToggle }) {
  const autoStartSounds = [];
  const musicSounds = [];
  const shepherdWalkSounds = [];
  const shepherdSpeechSounds = [];
  const activeFootstepSounds = new Set();
  const revealSounds = [];
  const narrationFr3Sounds = new Set();
  const pendingTriggeredSounds = new Set();
  const activeNarrationSounds = new Set();
  let narrationBuffers = [];
  let musicMuted = false;
  let revealSoundsScheduled = false;
  let fr3SoundsScheduled = false;
  let audioBaseUrl = ".";
  let audioHasUserGesture = false;
  let worldAudioEnabled = false;

  function startReadySounds() {
    if (!worldAudioEnabled || !audioHasUserGesture || audioListener.context.state !== "running") return;
    for (const sound of [...autoStartSounds, ...activeFootstepSounds]) {
      if (sound.buffer && !sound.isPlaying) sound.play();
    }
    for (const sound of pendingTriggeredSounds) {
      if (!sound.buffer) continue;
      if (!sound.isPlaying) sound.play();
      pendingTriggeredSounds.delete(sound);
    }
  }

  function startShepherdFootsteps(model) {
    for (const sound of shepherdWalkSounds) {
      model.add(sound);
      sound.position.set(0, 0, 0);
      activeFootstepSounds.add(sound);
    }
    startReadySounds();

    return () => {
      for (const sound of shepherdWalkSounds) {
        activeFootstepSounds.delete(sound);
        if (sound.isPlaying) sound.stop();
      }
    };
  }

  function startShepherdSpeech(model) {
    for (const sound of shepherdSpeechSounds) {
      model.add(sound);
      sound.position.set(0, 0.75, 0);
      pendingTriggeredSounds.add(sound);
    }
    startReadySounds();
  }

  function loadNarration(paths, baseUrl) {
    const loader = new THREE.AudioLoader();
    return Promise.all(paths.map((path) => loader.loadAsync(`${baseUrl}/${path}`)))
      .then((buffers) => { narrationBuffers = buffers; });
  }

  function scheduleFr3Sounds() {
    if (fr3SoundsScheduled) return;
    fr3SoundsScheduled = true;
    const loader = new THREE.AudioLoader();
    const cues = [
      {
        filename: "assets/Songs/Brebis.wav",
        delayMs: 43000,
        // 43 s → 49.8 s, leaving 0.2 s before the dog cue at 50 s.
        duration: 6.8,
        volume: 0.8,
        position: [9.989, 1.35, -5.257],
        refDistance: 5,
        maxDistance: 24,
      },
      {
        filename: "assets/Songs/chien.wav",
        delayMs: 50000,
        duration: 1.5,
        volume: 1,
        position: [2.347, 1.354, 0.625],
        refDistance: 5,
        maxDistance: 24,
      },
    ];

    for (const cue of cues) {
      const sound = cue.position
        ? new THREE.PositionalAudio(audioListener)
        : new THREE.Audio(audioListener);
      sound.setLoop(false);
      sound.setVolume(cue.volume);
      if (cue.position) {
        sound.position.fromArray(cue.position);
        sound.setRefDistance(cue.refDistance);
        sound.setMaxDistance(cue.maxDistance);
        sound.setRolloffFactor(1);
        sound.setDistanceModel("inverse");
      }
      scene.add(sound);
      narrationFr3Sounds.add(sound);

      const handleThreeEnded = sound.onEnded.bind(sound);
      sound.onEnded = () => {
        handleThreeEnded();
        pendingTriggeredSounds.delete(sound);
        narrationFr3Sounds.delete(sound);
        scene.remove(sound);
        sound.disconnect();
      };

      const url = `${audioBaseUrl.replace(/\/$/, "")}/${cue.filename}`;
      const bufferPromise = loader.loadAsync(url).catch((error) => {
        console.error(`Failed to load narration sound: ${cue.filename}`, error);
        return null;
      });
      window.setTimeout(() => {
        void bufferPromise.then((buffer) => {
          if (!buffer) {
            narrationFr3Sounds.delete(sound);
            scene.remove(sound);
            sound.disconnect();
            return;
          }
          sound.setBuffer(buffer);
          sound.duration = cue.duration;
          pendingTriggeredSounds.add(sound);
          startReadySounds();
        });
      }, cue.delayMs);
    }
  }

  function playNarration(index, model) {
    const buffer = narrationBuffers[index];
    if (!buffer || !model) return Promise.reject(new Error(`Narration FR_${index + 1} unavailable.`));

    const sound = new THREE.PositionalAudio(audioListener);
    sound.setBuffer(buffer);
    sound.setLoop(false);
    sound.setVolume(0.95);
    sound.setRefDistance(1.2);
    sound.setMaxDistance(24);
    sound.setRolloffFactor(1);
    sound.position.set(0, 0.75, 0);
    model.add(sound);
    activeNarrationSounds.add(sound);

    return new Promise((resolve) => {
      const handleThreeEnded = sound.onEnded.bind(sound);
      sound.onEnded = () => {
        handleThreeEnded();
        activeNarrationSounds.delete(sound);
        model.remove(sound);
        sound.disconnect();
        resolve();
      };
      const start = () => {
        if (!worldAudioEnabled || !audioHasUserGesture || audioListener.context.state !== "running") {
          window.setTimeout(start, 100);
          return;
        }
        sound.play();
        if (index === 2) scheduleFr3Sounds();
      };
      start();
    });
  }

  function scheduleRevealSounds() {
    if (revealSoundsScheduled) return;
    revealSoundsScheduled = true;
    for (const { sound, delayMs } of revealSounds) {
      window.setTimeout(() => {
        pendingTriggeredSounds.add(sound);
        startReadySounds();
      }, delayMs);
    }
  }

  function unlockSpatialAudio() {
    audioHasUserGesture = true;
    if (audioListener.context.state === "suspended") {
      audioListener.context.resume().then(startReadySounds).catch((error) => {
        console.error("Failed to start spatial audio.", error);
      });
      return;
    }
    startReadySounds();
  }

  function setWorldVisible(visible) {
    if (visible) return;
    worldAudioEnabled = false;
    if (musicToggle) musicToggle.hidden = true;
    for (const sound of [...autoStartSounds, ...shepherdWalkSounds]) {
      if (sound.isPlaying) sound.pause();
    }
    for (const sound of [
      ...shepherdSpeechSounds,
      ...revealSounds.map(({ sound }) => sound),
      ...narrationFr3Sounds,
    ]) {
      if (!sound.isPlaying) continue;
      sound.pause();
      pendingTriggeredSounds.add(sound);
    }
  }

  function activateWorld() {
    if (worldAudioEnabled) return;
    worldAudioEnabled = true;
    if (musicToggle) musicToggle.hidden = false;
    startReadySounds();
  }

  function loadSounds(configs, baseUrl) {
    audioBaseUrl = baseUrl;
    const loader = new THREE.AudioLoader();
    for (const config of configs) {
      const sound = config.spatial === false
        ? new THREE.Audio(audioListener)
        : new THREE.PositionalAudio(audioListener);
      sound.setLoop(config.loop ?? true);
      sound.setVolume(config.volume ?? 1);
      if (config.category === "music") {
        musicSounds.push({ sound, volume: config.volume ?? 1 });
      }
      if (config.spatial !== false) {
        sound.setRefDistance(config.refDistance ?? 1);
        sound.setMaxDistance(config.maxDistance ?? 100);
        sound.setRolloffFactor(config.rolloffFactor ?? 1);
        sound.setDistanceModel("inverse");
        sound.position.fromArray(config.transform?.translation ?? [0, 0, 0]);
      }
      scene.add(sound);

      if (config.trigger === "shepherdWalk") shepherdWalkSounds.push(sound);
      else if (config.trigger === "shepherdSpeech") shepherdSpeechSounds.push(sound);
      else if (config.trigger === "shepherdReveal") {
        revealSounds.push({ sound, delayMs: config.delayMs ?? 0 });
      } else autoStartSounds.push(sound);

      loader.loadAsync(`${baseUrl}/${config.filename}`)
        .then((buffer) => {
          sound.setBuffer(buffer);
          if (musicMuted) sound.setVolume(0);
          if (audioHasUserGesture) startReadySounds();
        })
        .catch((error) => {
          console.error(`Failed to load audio: ${config.filename}`, error);
        });
    }
  }

  renderer.domElement.addEventListener("pointerdown", unlockSpatialAudio);
  musicToggle?.addEventListener("click", () => {
    musicMuted = !musicMuted;
    for (const { sound, volume } of musicSounds) {
      sound.setVolume(musicMuted ? 0 : volume);
    }
    musicToggle.setAttribute("aria-pressed", String(musicMuted));
    musicToggle.textContent = musicMuted ? "Activer la musique" : "Couper la musique";
    unlockSpatialAudio();
  });
  document.addEventListener("keydown", () => {
    if (worldAudioEnabled) unlockSpatialAudio();
  });

  return {
    activateWorld,
    loadSounds,
    loadNarration,
    onWorldHidden: () => setWorldVisible(false),
    playNarration,
    scheduleRevealSounds,
    startShepherdFootsteps,
    startShepherdSpeech,
    unlockSpatialAudio,
  };
}
