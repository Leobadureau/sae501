import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { SplatMesh, SparkControls, SparkXr, utils } from "@sparkjsdev/spark";
import { addModelGlow, convertToBasicMaterials, waitForModelTextures } from "./model-materials.js";
import { createMarkerDetection } from "./marker-detection.js?v=lower-scan-latency-20261116";
import { createAudioSystem } from "./audio.js";
import { createInteractionSystem } from "./interactions.js?v=palm-close-fist-20261117";
import { createNarrativeController } from "./narrative.js?v=wrong-choice-audio-20261117";
import { createInventorySystem } from "./inventory.js?v=palm-close-fist-20261117";
import { createXrTipsBanner } from "./xr-tips.js?v=vr-tips-sequence-20261118";
import {
  SPAWN_POSITION,
  PC_CAMERA_HEIGHT_OFFSET,
  SEATED_CAMERA_POSITION,
  SEATED_CAMERA_ROTATION,
  SEATED_MAX_LOOK_DOWN,
  SEATED_MAX_LOOK_UP,
  MOVEMENT_RADIUS,
  scene,
  movementPerimeter,
  camera,
  audioListener,
  renderer,
  localFrame,
} from "./scene.js";

const RENDER_TIMEOUT_MS = 5 * 1000;
const URL_BASE = ".";
const XR_RENDER_SCALE = 1.5;
const markerOverlay = document.getElementById("marker-overlay");
const modeOverlay = document.getElementById("mode-overlay");
const loadingOverlay = document.getElementById("loading-overlay");
const loadingMessage = document.getElementById("loading-message");
const loadingSpinner = loadingOverlay?.querySelector(".loading-tiles");
const revealFlash = document.getElementById("reveal-flash");
const pcModeButton = document.getElementById("pc-mode");
const arModeButton = document.getElementById("ar-mode");
const musicToggle = document.getElementById("music-toggle");
const xrButton = document.getElementById("vr-button");
const xrStatus = document.getElementById("xr-status");
const xrTipsBanner = createXrTipsBanner(THREE, camera);
const xrTipMessages = {
  1: "Pincez la sacoche pour la saisir.",
  2: "Pincez le berger pour lui parler.",
  3: "Tendez la main pour ouvrir l’inventaire.",
};
let xrTipStep = 0;

function showXrTip(step) {
  xrTipStep = step;
  xrTipsBanner?.show(xrTipMessages[step]);
}
const audio = createAudioSystem({ THREE, audioListener, scene, renderer, musicToggle });
let inventory = null;
const markerTracker = createMarkerDetection({
  markerOverlay,
  renderer,
  setWorldVisible,
  enterPcMode,
});
const {
  state: markerDetection,
  setup: setupMarkerDetection,
  detectFrame: detectMarkerFrame,
  updateOverlay: updateMarkerOverlay,
  stop: stopMarkerCamera,
} = markerTracker;

function playRevealFlash() {
  if (!revealFlash) return;
  revealFlash.classList.remove("is-active");
  void revealFlash.offsetWidth;
  revealFlash.classList.add("is-active");
}

revealFlash?.addEventListener("animationend", () => {
  revealFlash.classList.remove("is-active");
});

function showLoadingError(message) {
  if (loadingMessage) loadingMessage.textContent = message;
  if (loadingSpinner) loadingSpinner.hidden = true;
}

function enterPcMode(event) {
  if (event) audio.unlockSpatialAudio();
  markerDetection.pcMode = true;
  markerDetection.locked = true;
  markerDetection.enabled = false;
  xrButton.hidden = true;
  xrTipsBanner?.hide();
  camera.position.y = PC_CAMERA_HEIGHT_OFFSET;
  movementPerimeter.visible = false;
  stopMarkerCamera();

  renderer.setClearAlpha(1);
  if (loadingOverlay) loadingOverlay.hidden = false;
  setWorldVisible(true);
  inventory?.setPcActive(true);
  if (modeOverlay) modeOverlay.hidden = true;
}

pcModeButton?.addEventListener("click", enterPcMode);
arModeButton?.addEventListener("click", () => {
  audio.unlockSpatialAudio();
  if (modeOverlay) modeOverlay.hidden = true;
  setupMarkerDetection();
});

function setWorldVisible(visible) {
  if (!visible) audio.onWorldHidden();
  renderer.domElement.style.display = visible ? "block" : "none";
  if (markerDetection.video) {
    markerDetection.video.style.display = "block";
  }
  updateMarkerOverlay(visible);
}

const startInPcMode = new URLSearchParams(window.location.search).has("pc");
if (startInPcMode) {
  enterPcMode();
} else {
  markerOverlay.textContent = "Choisissez un mode pour commencer.";
  updateMarkerOverlay(false);
}

let sceneJson;
try {
  const response = await fetch(`${URL_BASE}/data/scene.json`, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Scene manifest request failed with status ${response.status}`);
  }
  sceneJson = await response.json();
} catch (error) {
  console.error("Failed to load the scene manifest.", error);
  showLoadingError("Impossible de charger le monde. Vérifiez votre connexion, puis rechargez la page.");
  throw error;
}
const splats = sceneJson.splats ?? [];
const meshes = sceneJson.meshes ?? [];
const sounds = sceneJson.sounds ?? [];
const splatMeshes = [];

for (const splat of splats) {
  const splatMesh = new SplatMesh({ url: `${URL_BASE}/${splat.filename}`, lod: false });
  splatMesh.position.fromArray(splat.transform?.translation ?? [0, 0, 0]);
  splatMesh.quaternion.fromArray(splat.transform?.quaternion ?? [0, 0, 0, 1]);
  const scale = splat.transform?.scale ?? 1;
  splatMesh.scale.set(scale, scale, scale);
  scene.add(splatMesh);
  splatMeshes.push(splatMesh);
}

audio.loadSounds(sounds, URL_BASE);

// ==========================================
// CHARGEMENT DES MODÈLES 3D
// ==========================================

const gltfLoader = new GLTFLoader();

// Initialisation du décompresseur Draco
const dracoLoader = new DRACOLoader();

dracoLoader.setDecoderPath(
  "https://www.gstatic.com/draco/versioned/decoders/1.5.7/"
);

// Association de Draco au GLTFLoader
gltfLoader.setDRACOLoader(dracoLoader);

const fbxLoader = new FBXLoader();

const interactiveModels = [];
const modelsRevealedByGrab = new Map();
const loadedModels = new Map();
let collectibleModel = null;
const shepherdAnimationStates = new WeakMap();
const activeAnimationMixers = new Set();
const ambientAnimationMixers = new Set();
const cameraFacingFires = new Set();
const activeWalks = new Map();
const activeObjectTransitions = new Set();
const activeModelFades = new Set();
const animationClock = new THREE.Clock();
const SHEPHERD_WALK_DISTANCE = 2.2;
const ANIMATION_CROSSFADE_DURATION = 0.45;
let seatedViewActive = false;
let pendingSeatedTeleport = false;
let seatedCameraTransition = null;
let desktopViewBeforeXr = null;
let interactionSystem = null;

function updateInteractionHighlights() {
  interactionSystem?.updateHighlights();
}

function applyDesktopSeatedView() {
  localFrame.quaternion.copy(SEATED_CAMERA_ROTATION);
  localFrame.position.copy(SEATED_CAMERA_POSITION).sub(
    camera.position.clone().applyQuaternion(localFrame.quaternion)
  );
  camera.quaternion.identity();
}

function enterSeatedView() {
  seatedViewActive = true;
  if (renderer.xr.isPresenting) {
    pendingSeatedTeleport = true;
  } else {
    const targetQuaternion = SEATED_CAMERA_ROTATION.clone();
    const targetPosition = SEATED_CAMERA_POSITION.clone().sub(
      camera.position.clone().applyQuaternion(targetQuaternion)
    );
    seatedCameraTransition = {
      startPosition: localFrame.position.clone(),
      startQuaternion: localFrame.quaternion.clone(),
      startCameraQuaternion: camera.quaternion.clone(),
      targetPosition,
      targetQuaternion,
      targetCameraQuaternion: new THREE.Quaternion(),
      elapsed: 0,
      duration: 0.9,
      xr: false,
    };
  }
  renderEnabled = true;
  lastMoved = performance.now();
}

function updateSeatedCameraTransition(delta) {
  const transition = seatedCameraTransition;
  if (!transition) return;
  transition.elapsed = Math.min(transition.elapsed + delta, transition.duration);
  const progress = transition.duration > 0 ? transition.elapsed / transition.duration : 1;
  const eased = progress * progress * (3 - 2 * progress);
  localFrame.position.lerpVectors(transition.startPosition, transition.targetPosition, eased);
  localFrame.quaternion.slerpQuaternions(
    transition.startQuaternion,
    transition.targetQuaternion,
    eased
  );
  if (!transition.xr && transition.targetCameraQuaternion) {
    camera.quaternion.slerpQuaternions(
      transition.startCameraQuaternion,
      transition.targetCameraQuaternion,
      eased
    );
  }
  localFrame.updateWorldMatrix(true, true);
  renderEnabled = true;
  lastMoved = performance.now();
  if (progress < 1) return;

  localFrame.position.copy(transition.targetPosition);
  localFrame.quaternion.copy(transition.targetQuaternion);
  if (!transition.xr && transition.targetCameraQuaternion) {
    camera.quaternion.copy(transition.targetCameraQuaternion);
  }
  seatedCameraTransition = null;
  if (transition.xr) {
    xrMovementCenter = null;
    xrMovementStart = null;
    xrMovementRotation = null;
  }
}

function clampSeatedViewPitch() {
  if (!seatedViewActive || !markerDetection.pcMode || xr.session) return;

  const rotation = new THREE.Euler().setFromQuaternion(localFrame.quaternion, "YXZ");
  rotation.x = THREE.MathUtils.clamp(
    rotation.x,
    -SEATED_MAX_LOOK_DOWN,
    SEATED_MAX_LOOK_UP
  );
  localFrame.quaternion.setFromEuler(rotation);
}

function amplifyAnimationRotations(clip, factor) {
  for (const track of clip.tracks) {
    if (!track.name.endsWith(".quaternion") || track.getValueSize() !== 4) continue;

    const values = track.values;
    const reference = new THREE.Quaternion(
      values[0],
      values[1],
      values[2],
      values[3]
    ).normalize();
    const inverseReference = reference.clone().invert();

    for (let index = 0; index < values.length; index += 4) {
      const current = new THREE.Quaternion(
        values[index],
        values[index + 1],
        values[index + 2],
        values[index + 3]
      ).normalize();
      const delta = inverseReference.clone().multiply(current).normalize();
      if (delta.w < 0) {
        delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
      }

      const halfAngle = Math.acos(THREE.MathUtils.clamp(delta.w, -1, 1));
      const sinHalfAngle = Math.sin(halfAngle);
      if (Math.abs(sinHalfAngle) < 1e-6) continue;

      const axis = new THREE.Vector3(
        delta.x / sinHalfAngle,
        delta.y / sinHalfAngle,
        delta.z / sinHalfAngle
      );
      delta.setFromAxisAngle(axis, halfAngle * 2 * factor);
      current.copy(reference).multiply(delta).normalize();
      values[index] = current.x;
      values[index + 1] = current.y;
      values[index + 2] = current.z;
      values[index + 3] = current.w;
    }
  }
}

function stabilizeWalkRoot(clip) {
  for (const track of clip.tracks) {
    if (!track.name.endsWith(".position") || !track.name.includes("Hips")) continue;
    const values = track.values;
    if (track.getValueSize() !== 3 || values.length < 3) continue;

    const initialY = values[1];
    for (let index = 1; index < values.length; index += 3) {
      values[index] = initialY;
    }
  }
  return clip;
}

function configureAnimatedFire(model, config) {
  const hiddenGeometry = new Set(config.hideGeometry ?? []);
  model.traverse((child) => {
    if (!child.isMesh) return;

    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];

    if (hiddenGeometry.has(child.name)) {
      for (const material of materials) {
        material.colorWrite = false;
        material.depthWrite = false;
      }
      return;
    }

    child.material = materials.map((material) => new THREE.MeshBasicMaterial({
      map: material.map ?? null,
      alphaMap: material.alphaMap ?? null,
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,
      alphaTest: 0.1,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
      toneMapped: false,
    }));
    child.renderOrder = 100;
    if (child.material.length === 1) child.material = child.material[0];
  });
}

function updateCameraFacingFires(camera) {
  const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
  for (const model of cameraFacingFires) {
    const firePosition = model.getWorldPosition(new THREE.Vector3());
    model.rotation.y = Math.atan2(
      cameraPosition.x - firePosition.x,
      cameraPosition.z - firePosition.z
    );
  }
}

function playAmbientAnimation(model, clipName) {
  const clip = model.animations.find((animation) => animation.name === clipName);
  if (!clip) {
    console.warn(
      `Animation "${clipName}" not found for ${model.userData.filename}. Available clips: ${model.animations.map((animation) => animation.name).join(", ")}`
    );
    return;
  }

  const mixer = new THREE.AnimationMixer(model);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.play();
  ambientAnimationMixers.add(mixer);
}

function prepareShepherdStandingPose(model) {
  const walkClip = (model.animations ?? []).find((animation) =>
    animation.name.toLocaleLowerCase().includes("walk")
  );
  if (!walkClip) return;

  const mixer = new THREE.AnimationMixer(model);
  const walkAction = mixer.clipAction(stabilizeWalkRoot(walkClip.clone()));
  walkAction.setLoop(THREE.LoopOnce, 1);
  walkAction.clampWhenFinished = true;
  walkAction.play();
  mixer.update(0);
  walkAction.paused = true;
  walkAction.time = 0;
  shepherdAnimationStates.set(model, {
    mixer,
    walkClip,
    walkAction,
    talkAction: null,
    prepared: true,
    departing: false,
  });
}

function playShepherdAnimation(model) {
  let finishArrival;
  const arrival = new Promise((resolve) => { finishArrival = resolve; });
  const clips = model.animations ?? [];
  if (clips.length === 0) {
    console.warn(`No animation clips found for ${model.userData.filename}`);
    finishArrival();
    return arrival;
  }

  const walkClip = clips.find((animation) =>
    animation.name.toLocaleLowerCase().includes("walk")
  );
  const talkClip = clips.find((animation) =>
    animation.name.toLocaleLowerCase().includes("parler en étant assis")
  );
  if (!walkClip) {
    console.warn(
      `Animation "walk.001" not found for ${model.userData.filename}. Available clips: ${clips.map((animation) => animation.name).join(", ")}`
    );
  }
  if (!talkClip) {
    console.warn(
      `Animation "parler en étant assis.001" not found for ${model.userData.filename}. Available clips: ${clips.map((animation) => animation.name).join(", ")}`
    );
  }
  if (!walkClip && !talkClip) {
    finishArrival();
    return arrival;
  }

  const finalPosition = model.userData.arrivalTarget?.clone() ?? model.position.clone();
  const preparedState = shepherdAnimationStates.get(model);
  const mixer = preparedState?.prepared
    ? preparedState.mixer
    : new THREE.AnimationMixer(model);
  const walkAction = walkClip
    ? (preparedState?.prepared
      ? preparedState.walkAction
      : mixer.clipAction(stabilizeWalkRoot(walkClip.clone())))
    : null;
  const visibleTalkClip = talkClip?.clone();
  if (visibleTalkClip) amplifyAnimationRotations(visibleTalkClip, 6);
  const talkAction = visibleTalkClip
    ? mixer.clipAction(visibleTalkClip)
    : null;
  const animationState = {
    mixer,
    walkClip,
    walkAction,
    talkAction,
    departing: false,
  };

  if (walkAction) {
    const forward = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(model.quaternion)
      .normalize();
    const startPosition = model.userData.arrivalPrepared
      ? model.position.clone()
      : finalPosition.clone().addScaledVector(forward, -SHEPHERD_WALK_DISTANCE);
    model.userData.arrivalPrepared = false;
    model.position.copy(startPosition);
    walkAction.reset();
    walkAction.setLoop(THREE.LoopOnce, 1);
    walkAction.clampWhenFinished = true;
    activeWalks.set(mixer, {
      model,
      startPosition,
      finalPosition,
      elapsed: 0,
      duration: walkClip.duration,
    });
    walkAction.play();
    const stopFootsteps = audio.startShepherdFootsteps(model);
    mixer.addEventListener("finished", (event) => {
      if (event.action !== walkAction) return;
      if (animationState.departing) return;
      if (talkAction) {
        window.setTimeout(() => {
          stopFootsteps();
        }, ANIMATION_CROSSFADE_DURATION * 1000);
        window.setTimeout(finishArrival, ANIMATION_CROSSFADE_DURATION * 1000);
      } else {
        stopFootsteps();
        finishArrival();
      }
    });
  }

  if (talkAction) {
    talkAction.setLoop(THREE.LoopRepeat, Infinity);
    talkAction.clampWhenFinished = true;

    if (!walkAction) {
      talkAction.play();
      finishArrival();
    }

    mixer.addEventListener("finished", (event) => {
      if (animationState.departing) return;
      if (event.action === walkAction) {
        const walk = activeWalks.get(mixer);
        if (walk) walk.model.position.copy(walk.finalPosition);
        activeWalks.delete(mixer);

        if (talkAction) {
          talkAction
            .crossFadeFrom(walkAction, ANIMATION_CROSSFADE_DURATION, false)
            .play();
          console.info(
            `Shepherd reached destination; playing ${talkClip.name}`
          );
          return;
        }
      } else if (event.action !== talkAction) {
        return;
      }

      activeWalks.delete(mixer);
      activeAnimationMixers.delete(mixer);
      // Keep the final seated pose.
      renderEnabled = true;
      lastMoved = performance.now();
    });
  } else {
    mixer.addEventListener("finished", () => {
      if (animationState.departing) return;
      activeWalks.delete(mixer);
      activeAnimationMixers.delete(mixer);
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      renderEnabled = true;
      lastMoved = performance.now();
    });
  }

  activeAnimationMixers.add(mixer);
  shepherdAnimationStates.set(model, animationState);
  console.info(
    `Playing shepherd arrival: ${walkClip?.name ?? "walking unavailable"}${talkClip ? `, then ${talkClip.name} (rotations amplified 6x)` : ""}`
  );
  return arrival;
}

function fadeModelOut(model, duration = 1.1) {
  const materials = [];
  model.traverse((child) => {
    if (!child.isMesh) return;
    const list = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of list) {
      if (!material) continue;
      material.transparent = true;
      material.needsUpdate = true;
      materials.push({ material, opacity: material.opacity ?? 1 });
    }
  });

  return new Promise((resolve) => {
    activeModelFades.add({ model, materials, elapsed: 0, duration, resolve });
    renderEnabled = true;
    lastMoved = performance.now();
  });
}

function playShepherdDeparture(model, bag) {
  if (!model) return Promise.resolve();
  const previous = shepherdAnimationStates.get(model);

  if (bag) {
    model.add(bag);
    bag.position.set(0.3, 0.65, 0.12);
    bag.quaternion.identity();
    bag.scale.setScalar(0.1);
    bag.visible = true;
  }

  const { walkClip, walkAction, talkAction, mixer } = previous ?? {};
  if (!walkClip || !walkAction || !mixer) {
    return fadeModelOut(model);
  }

  previous.departing = true;
  const startPosition = model.position.clone();
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(model.quaternion).normalize();
  const finalPosition = startPosition.clone().addScaledVector(forward, 4.5);
  activeWalks.set(mixer, {
    model,
    startPosition,
    finalPosition,
    elapsed: 0,
    duration: walkClip.duration,
  });
  activeAnimationMixers.add(mixer);
  const stopFootsteps = audio.startShepherdFootsteps(model);
  walkAction.reset();
  walkAction.setLoop(THREE.LoopOnce, 1);
  walkAction.clampWhenFinished = true;

  return new Promise((resolve) => {
    mixer.addEventListener("finished", (event) => {
      if (event.action !== walkAction) return;
      model.position.copy(finalPosition);
      activeWalks.delete(mixer);
      activeAnimationMixers.delete(mixer);
      stopFootsteps();
      window.setTimeout(() => {
        mixer.stopAllAction();
        mixer.uncacheRoot(model);
      }, 0);
      void fadeModelOut(model).then(resolve);
    });
    if (talkAction) walkAction.crossFadeFrom(talkAction, 0.65, false).play();
    else walkAction.play();
  });
}

function animateObjectTo(object, targetPosition, duration = 0.8, onComplete = () => {}) {
  return new Promise((resolve) => {
    activeObjectTransitions.add({
      object,
      startPosition: object.position.clone(),
      targetPosition: targetPosition.clone(),
      duration,
      elapsed: 0,
      onComplete: () => {
        onComplete();
        resolve();
      },
    });
    renderEnabled = true;
    lastMoved = performance.now();
  });
}

function advanceNarrativeVisuals(delta) {
  for (const transition of activeObjectTransitions) {
    transition.elapsed = Math.min(transition.elapsed + delta, transition.duration);
    const progress = transition.duration > 0 ? transition.elapsed / transition.duration : 1;
    const eased = progress * progress * (3 - 2 * progress);
    transition.object.position.lerpVectors(
      transition.startPosition,
      transition.targetPosition,
      eased
    );
    renderEnabled = true;
    lastMoved = performance.now();
    interactionSystem?.updateHighlights();
    if (progress < 1) continue;
    activeObjectTransitions.delete(transition);
    transition.object.position.copy(transition.targetPosition);
    transition.onComplete();
  }

  for (const fade of activeModelFades) {
    fade.elapsed = Math.min(fade.elapsed + delta, fade.duration);
    const progress = fade.duration > 0 ? fade.elapsed / fade.duration : 1;
    for (const entry of fade.materials) {
      entry.material.opacity = entry.opacity * (1 - progress);
    }
    renderEnabled = true;
    lastMoved = performance.now();
    interactionSystem?.updateHighlights();
    if (progress < 1) continue;
    activeModelFades.delete(fade);
    fade.model.visible = false;
    fade.resolve();
  }
}

function placeNarrativeVisualInFront(object, distance = 0.95) {
  camera.updateWorldMatrix(true, false);
  const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
  const cameraDirection = camera.getWorldDirection(new THREE.Vector3());
  object.position.copy(cameraPosition).addScaledVector(cameraDirection, distance);
  object.quaternion.copy(camera.getWorldQuaternion(new THREE.Quaternion()));
  scene.add(object);
  renderEnabled = true;
  lastMoved = performance.now();
  window.setTimeout(() => {
    scene.remove(object);
    object.traverse((child) => {
      child.geometry?.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        material?.map?.dispose();
        material?.dispose();
      }
    });
  }, 4200);
}

function showCorsicaMap() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 700;
  const context = canvas.getContext("2d");
  context.fillStyle = "#e8ddc8";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#685d4b";
  context.lineWidth = 5;
  context.strokeRect(18, 18, canvas.width - 36, canvas.height - 36);
  context.fillStyle = "#262722";
  context.font = "28px Georgia";
  context.textAlign = "center";
  context.fillText("CORSICA", 256, 82);
  context.font = "18px Georgia";
  context.fillText("MEDITERRANEU", 256, 620);
  context.beginPath();
  context.moveTo(264, 142);
  context.lineTo(305, 185);
  context.lineTo(296, 232);
  context.lineTo(318, 274);
  context.lineTo(298, 324);
  context.lineTo(283, 380);
  context.lineTo(260, 438);
  context.lineTo(233, 493);
  context.lineTo(211, 470);
  context.lineTo(223, 415);
  context.lineTo(207, 362);
  context.lineTo(226, 318);
  context.lineTo(214, 271);
  context.lineTo(232, 225);
  context.lineTo(224, 184);
  context.closePath();
  context.fillStyle = "#7a795f";
  context.fill();
  context.strokeStyle = "#443f34";
  context.lineWidth = 6;
  context.stroke();
  context.beginPath();
  context.moveTo(253, 175);
  context.bezierCurveTo(281, 244, 223, 300, 270, 352);
  context.bezierCurveTo(289, 394, 241, 434, 231, 478);
  context.strokeStyle = "#bd875e";
  context.lineWidth = 4;
  context.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const card = new THREE.Group();
  card.userData.narrativeItem = "corsica-map";
  card.renderOrder = 1000;
  const backing = new THREE.Mesh(
    new THREE.PlaneGeometry(0.34, 0.47),
    new THREE.MeshBasicMaterial({ color: 0x241f19, side: THREE.DoubleSide, depthTest: false, depthWrite: false })
  );
  backing.renderOrder = 1000;
  backing.position.z = -0.004;
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(0.32, 0.45),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, depthTest: false, depthWrite: false })
  );
  face.renderOrder = 1001;
  card.add(backing, face);
  placeNarrativeVisualInFront(card);
}

function showRope() {
  const rope = new THREE.Group();
  rope.userData.narrativeItem = "rope";
  const material = new THREE.MeshBasicMaterial({ color: 0xb2966d });
  for (let index = 0; index < 5; index += 1) {
    const loop = new THREE.Mesh(new THREE.TorusGeometry(0.095, 0.012, 8, 32), material);
    loop.material.depthTest = false;
    loop.renderOrder = 1000;
    loop.position.x = (index - 2) * 0.018;
    loop.rotation.z = (index - 2) * 0.14;
    rope.add(loop);
  }
  const tail = new THREE.Mesh(
    new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3([
        new THREE.Vector3(0.04, -0.07, 0),
        new THREE.Vector3(0.12, -0.13, 0.01),
        new THREE.Vector3(0.18, -0.08, 0.02),
      ]),
      20,
      0.012,
      8,
      false
    ),
    material
  );
  tail.renderOrder = 1000;
  rope.add(tail);
  placeNarrativeVisualInFront(rope, 0.8);
}

function animateBagHandoff(bag, shepherd) {
  if (!bag || !shepherd) return Promise.resolve();
  scene.attach(bag);
  const start = bag.getWorldPosition(new THREE.Vector3());
  const handOffset = new THREE.Vector3(0.2, 1.25, 0.2)
    .applyQuaternion(shepherd.getWorldQuaternion(new THREE.Quaternion()));
  const target = shepherd.getWorldPosition(new THREE.Vector3()).add(handOffset);
  bag.position.copy(start);
  bag.visible = true;
  return animateObjectTo(bag, target, 0.9, () => {
    shepherd.attach(bag);
    bag.position.set(0.3, 0.65, 0.12);
    bag.quaternion.identity();
    bag.scale.setScalar(0.1);
  });
}

function pickUpNarrativeBag(bag, controller = null) {
  if (!bag) return Promise.resolve();
  const holder = camera;
  holder.updateWorldMatrix(true, true);
  const localHoldPosition = new THREE.Vector3(0.28, -0.24, -0.58);
  const targetPosition = localHoldPosition.applyMatrix4(holder.matrixWorld);
  scene.attach(bag);
  bag.visible = true;
  return animateObjectTo(bag, targetPosition, 0.55, () => {
    holder.attach(bag);
    bag.position.copy(localHoldPosition);
    bag.quaternion.identity();
    bag.scale.setScalar(0.08);
    bag.visible = false;
    interactionSystem?.updateHighlights();
  });
}

function showCollectibleCard() {
  const shepherd = loadedModels.get("assets/models/old man 3d model/tripo_convert_ad709b62-a73c-451d-b686-15168f7a6180.fbx");
  if (!shepherd) return;
  const texture = new THREE.TextureLoader().load("./assets/images/Carte_Berger.jpg");
  texture.colorSpace = THREE.SRGBColorSpace;
  collectibleModel = new THREE.Group();
  collectibleModel.userData.narrativeCollectible = true;
  const card = new THREE.Mesh(
    new THREE.PlaneGeometry(0.28, 0.42),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, depthTest: false, depthWrite: false })
  );
  card.renderOrder = 1000;
  collectibleModel.add(card);
  const shepherdPosition = shepherd.getWorldPosition(new THREE.Vector3());
  const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
  const towardPlayer = cameraPosition.sub(shepherdPosition).normalize();
  collectibleModel.position.copy(shepherdPosition)
    .addScaledVector(towardPlayer, 0.6)
    .add(new THREE.Vector3(0, 1.7, 0));
  collectibleModel.lookAt(camera.getWorldPosition(new THREE.Vector3()));
  scene.add(collectibleModel);
  collectibleModel.updateWorldMatrix(true, true);
  const highlight = new THREE.BoxHelper(collectibleModel, 0xd8c9ae);
  highlight.material.depthTest = false;
  highlight.renderOrder = 1000;
  highlight.visible = false;
  scene.add(highlight);
  const bounds = new THREE.Box3().setFromObject(collectibleModel)
    .applyMatrix4(collectibleModel.matrixWorld.clone().invert())
    .expandByScalar(0.025);
  interactiveModels.push({ model: collectibleModel, highlight, bounds });
  renderEnabled = true;
  lastMoved = performance.now();
}

function collectNarrativeReward() {
  const collectible = {
    id: "ultimu-stregone",
    title: "L’ultimu Stregone",
    image: "./assets/images/Carte_Berger.jpg",
  };
  try {
    const collection = JSON.parse(localStorage.getItem("aldila-collection") ?? "[]");
    if (!collection.some((card) => card.id === collectible.id)) {
      collection.push(collectible);
      localStorage.setItem("aldila-collection", JSON.stringify(collection));
    }
  } catch (error) {
    console.warn("La carte n’a pas pu être enregistrée dans le stockage local.", error);
  }
  window.dispatchEvent(new CustomEvent("aldila:collection-updated", { detail: collectible }));
  if (collectibleModel) collectibleModel.visible = false;
  interactionSystem?.updateHighlights();
  const kicker = collectibleCard?.querySelector(".narrative-kicker");
  if (kicker) kicker.textContent = "AJOUTÉE À VOTRE COLLECTION";
  const claim = document.getElementById("collectible-claim");
  if (claim) {
    claim.textContent = "Ajoutée à votre collection";
    claim.disabled = true;
  }
}

async function loadMesh(mesh) {
  try {
    const isFbx = mesh.filename.toLowerCase().endsWith(".fbx");
    const loader = isFbx ? fbxLoader : gltfLoader;

    const loaded = await loader.loadAsync(
      `${URL_BASE}/${mesh.filename}`
    );

    const model = isFbx ? loaded : loaded.scene;
    await waitForModelTextures(model);

    model.userData.filename = mesh.filename;
    if (mesh.fireAnimation) {
      configureAnimatedFire(model, mesh.fireAnimation);
    } else {
      convertToBasicMaterials(model);
    }

    // Positionnement du modèle
    model.position.fromArray(
      mesh.transform?.translation ?? [0, 0, 0]
    );

    model.quaternion.fromArray(
      mesh.transform?.quaternion ?? [0, 0, 0, 1]
    );

    const meshScale = mesh.transform?.scale ?? [1, 1, 1];

    if (Array.isArray(meshScale)) {
      model.scale.set(
        meshScale[0],
        meshScale[1],
        meshScale[2]
      );
    } else {
      model.scale.setScalar(meshScale);
    }

    // Visibilité initiale
    model.visible = mesh.visible ?? true;

    scene.add(model);
    loadedModels.set(mesh.filename, model);
    if (mesh.fireAnimation) {
      playAmbientAnimation(model, mesh.fireAnimation.clip);
      if (mesh.fireAnimation.faceCamera) {
        cameraFacingFires.add(model);
      }
    }
    // Gestion de l'interactivité
    if (mesh.interactive !== false) {
      const highlight = new THREE.BoxHelper(
        model,
        0x65e6c5
      );

      highlight.material.depthTest = false;
      highlight.renderOrder = 1000;
      highlight.visible = false;

      scene.add(highlight);

      const bounds = new THREE.Box3().setFromObject(model)
        .applyMatrix4(model.matrixWorld.clone().invert());
      if (mesh.filename.includes("old man 3d model")) {
        bounds.union(new THREE.Box3(
          new THREE.Vector3(-0.8, 0, -0.7),
          new THREE.Vector3(0.8, 2.2, 0.7)
        ));
      }

      interactiveModels.push({
        model,
        highlight,
        bounds,
      });
    }
    if (mesh.glow) addModelGlow(model);

    // Gestion de l'apparition après récupération
    if (mesh.revealOnGrab) {
      const revealedModels =
        modelsRevealedByGrab.get(mesh.revealOnGrab) ?? [];

      revealedModels.push(model);

      modelsRevealedByGrab.set(
        mesh.revealOnGrab,
        revealedModels
      );
    }

    console.log(
      `Modèle chargé avec succès : ${mesh.filename}`
    );
    return model;
  } catch (error) {
    console.warn(
      `Failed to load mesh: ${mesh.filename}`,
      error
    );
    return null;
  }
}

for (const mesh of meshes) {
  // Prepare hidden characters during loading, before entering the headset.
  await loadMesh(mesh);
}

try {
  await Promise.all(splatMeshes.map((splatMesh) => splatMesh.initialized));
} catch (error) {
  console.error("Failed to load the 3D scene.", error);
  showLoadingError("Le chargement du monde a échoué. Vérifiez votre connexion, puis rechargez la page.");
  throw error;
}

window.THREE = THREE;
window.scene = scene;
window.renderer = renderer;

const controls = new SparkControls({ canvas: renderer.domElement });
controls.pointerControls.reverseRotate = utils.isMobile();
controls.pointerControls.rotateSpeed *= 2;
controls.pointerControls.slideSpeed *= 0.75;

interactionSystem = createInteractionSystem({
  THREE,
  renderer,
  camera,
  localFrame,
  controls,
  interactiveModels,
  modelsRevealedByGrab,
  unlockAudio: audio.unlockSpatialAudio,
  revealModel: () => {},
  convertMaterials: convertToBasicMaterials,
  isModelAction: (model) => inventory?.isAction(model)
    || model === loadedModels.get("assets/models/Sacoche1-optimized.glb")
    || model === loadedModels.get("assets/models/old man 3d model/tripo_convert_ad709b62-a73c-451d-b686-15168f7a6180.fbx")
    || model === collectibleModel,
  onModelActivate: (model, controller = null) => {
    audio.unlockSpatialAudio();
    if (inventory?.isAction(model)) {
      inventory.select(model.userData.inventoryAction);
      if (renderer.xr.isPresenting && xrTipStep === 3) {
        xrTipStep = 4;
        xrTipsBanner?.hide();
      }
    }
    else if (model === collectibleModel) narrative.activateCollectible();
    else if (model === loadedModels.get("assets/models/Sacoche1-optimized.glb")) {
      if (renderer.xr.isPresenting && xrTipStep === 1) {
        xrTipStep = 2;
        xrTipsBanner?.hide();
      }
      narrative.activateBag(controller);
    } else if (model === loadedModels.get("assets/models/old man 3d model/tripo_convert_ad709b62-a73c-451d-b686-15168f7a6180.fbx")) {
      if (renderer.xr.isPresenting && xrTipStep === 2) {
        xrTipStep = 3;
        xrTipsBanner?.hide();
      }
      narrative.activateShepherd();
    } else narrative.activateShepherd();
  },
  onInventoryToggle: () => {
    inventory?.toggle();
    if (renderer.xr.isPresenting && xrTipStep === 3) {
      xrTipStep = 4;
      xrTipsBanner?.hide();
    }
  },
  isInventoryOpen: () => inventory?.isOpen() ?? false,
});

const narrativePrompt = document.getElementById("narrative-prompt");
const narrativeText = document.getElementById("narrative-text");
const narrativeAction = document.getElementById("narrative-action");
const collectibleCard = document.getElementById("collectible-card");
const narrative = createNarrativeController({
  audio,
  getShepherd: () => loadedModels.get("assets/models/old man 3d model/tripo_convert_ad709b62-a73c-451d-b686-15168f7a6180.fbx"),
  getBag: () => loadedModels.get("assets/models/Sacoche1-optimized.glb"),
  onChange: ({ prompt, reward, availableItems }) => {
    if (narrativePrompt) narrativePrompt.hidden = !prompt;
    if (prompt && narrativeText && narrativeAction) {
      narrativeText.textContent = prompt.label;
      narrativeAction.textContent = prompt.label;
      narrativeAction.dataset.action = prompt.action;
    }
    if (renderer.xr.isPresenting && prompt) {
      if ((xrTipStep === 1 || xrTipStep === 2) && prompt.action === "shepherd") showXrTip(2);
      else if ((xrTipStep === 2 || xrTipStep === 3) && prompt.action === "inventory") showXrTip(3);
    }
    if (collectibleCard && reward) collectibleCard.hidden = false;
    inventory?.setAvailableItems(availableItems);
    const claim = document.getElementById("collectible-claim");
    if (claim) claim.hidden = prompt?.action !== "collectible";
  },
  revealShepherd: (model) => {
    if (!model || model.visible) return;
    model.userData.arrivalTarget = model.position.clone();
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(model.quaternion).normalize();
    model.position.copy(model.userData.arrivalTarget).addScaledVector(forward, -SHEPHERD_WALK_DISTANCE);
    model.userData.arrivalPrepared = true;
    prepareShepherdStandingPose(model);
    model.visible = true;
    playRevealFlash();
    renderEnabled = true;
    lastMoved = performance.now();
  },
  animateArrival: (model, { movePlayer = true, animateShepherd = true } = {}) => {
    if (movePlayer) enterSeatedView();
    if (model && animateShepherd) return playShepherdAnimation(model);
    return Promise.resolve();
  },
  pickupBag: pickUpNarrativeBag,
  setBagOwned: (owned) => inventory?.setBagOwned(owned),
  animateHandoff: animateBagHandoff,
  animateDeparture: playShepherdDeparture,
  showMap: showCorsicaMap,
  showRope,
  showCollectible: showCollectibleCard,
  collectReward: collectNarrativeReward,
  openInventory: () => {
    inventory?.open();
    if (renderer.xr.isPresenting && xrTipStep === 3) {
      xrTipStep = 4;
      xrTipsBanner?.hide();
    }
  },
  closeInventory: () => inventory?.close(),
});

const inventoryButtons = new Map(
  [...document.querySelectorAll("[data-inventory-item]")]
    .map((button) => [button.dataset.inventoryItem, button])
);
inventory = createInventorySystem({
  THREE,
  dracoLoader,
  camera,
  renderer,
  panel: document.getElementById("inventory-panel"),
  toggleButton: document.getElementById("inventory-toggle"),
  closeButton: document.getElementById("inventory-close"),
  bagStatus: document.getElementById("inventory-bag-status"),
  itemButtons: inventoryButtons,
  onSelectItem: (item) => narrative.selectInventoryItem(item),
});
interactiveModels.push(...inventory.getInteractiveModels());
inventory.setPcActive(markerDetection.pcMode);
narrative.load().catch((error) => {
  console.error("Impossible de charger les audios de narration.", error);
  if (narrativePrompt && narrativeText) {
    narrativePrompt.hidden = false;
    narrativeText.textContent = "Les dialogues du berger n’ont pas pu être chargés.";
  }
});
narrativeAction?.addEventListener("click", () => {
  audio.unlockSpatialAudio();
  void narrative.activatePrompt();
});
document.getElementById("collectible-claim")?.addEventListener("click", () => {
  void narrative.activateCollectible();
});
document.getElementById("collectible-close")?.addEventListener("click", () => {
  if (collectibleCard) collectibleCard.hidden = true;
});
const xrInteractionControllers = interactionSystem.controllers;
const updateXrInteraction = (time, xrFrame) => interactionSystem.updateXrInteraction(time, xrFrame);

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  inventory?.resizeDesktopPreviews();
}

window.addEventListener("resize", onWindowResize, false);

let renderEnabled = true;
let lastMoved = performance.now();
let lastAmbientAnimationUpdate = 0;
let lastPos = new THREE.Vector3().setScalar(Number.NEGATIVE_INFINITY);
let lastDir = new THREE.Vector3();

function updateMovement(xrFrame) {
  if (renderer.xr.isPresenting) {
    movementPerimeter.visible = true;
    const referenceSpace = renderer.xr.getReferenceSpace();
    const viewerPose = referenceSpace && xrFrame?.getViewerPose(referenceSpace);
    if (!viewerPose) return;
    if (seatedCameraTransition?.xr) return;

    const viewerPosition = viewerPose.transform.position;
    if (pendingSeatedTeleport) {
      const orientation = viewerPose.transform.orientation;
      const headRotation = new THREE.Euler().setFromQuaternion(
        new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w), "YXZ"
      );
      const targetRotation = new THREE.Euler().setFromQuaternion(SEATED_CAMERA_ROTATION, "YXZ");
      // Align yaw only; pitch and roll continue to follow the person's head.
      const targetQuaternion = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, targetRotation.y - headRotation.y, 0)
      );
      const targetPosition = SEATED_CAMERA_POSITION.clone().sub(
        new THREE.Vector3(viewerPosition.x, viewerPosition.y, viewerPosition.z)
          .applyQuaternion(targetQuaternion)
      );
      seatedCameraTransition = {
        startPosition: localFrame.position.clone(),
        startQuaternion: localFrame.quaternion.clone(),
        targetPosition,
        targetQuaternion,
        elapsed: 0,
        duration: 0.9,
        xr: true,
      };
      pendingSeatedTeleport = false;
      xrMovementCenter = null;
      xrMovementStart = null;
      xrMovementRotation = null;
      return;
    }
    if (!xrMovementCenter) {
      xrMovementCenter = new THREE.Vector3(viewerPosition.x, viewerPosition.y, viewerPosition.z);
      xrMovementStart = localFrame.position.clone();
      xrMovementRotation = localFrame.quaternion.clone();
      const centerOffset = xrMovementCenter.clone().applyQuaternion(xrMovementRotation);
      movementPerimeter.position.set(
        xrMovementStart.x + centerOffset.x,
        0.015,
        xrMovementStart.z + centerOffset.z
      );
      return;
    }

    const offsetX = viewerPosition.x - xrMovementCenter.x;
    const offsetZ = viewerPosition.z - xrMovementCenter.z;
    const distance = Math.hypot(offsetX, offsetZ);
    const scale = distance > MOVEMENT_RADIUS ? MOVEMENT_RADIUS / distance : 1;
    const correction = new THREE.Vector3(
      offsetX * scale - offsetX,
      0,
      offsetZ * scale - offsetZ
    ).applyQuaternion(xrMovementRotation);
    localFrame.position.copy(xrMovementStart).add(correction);
    return;
  }

  xrMovementCenter = null;
  xrMovementStart = null;
  xrMovementRotation = null;
  movementPerimeter.visible = !markerDetection.pcMode;
  if (!markerDetection.pcMode) {
    movementPerimeter.position.set(SPAWN_POSITION.x, 0.015, SPAWN_POSITION.z);
    const offsetX = localFrame.position.x - SPAWN_POSITION.x;
    const offsetZ = localFrame.position.z - SPAWN_POSITION.z;
    const distance = Math.hypot(offsetX, offsetZ);
    if (distance > MOVEMENT_RADIUS) {
      const scale = MOVEMENT_RADIUS / distance;
      localFrame.position.x = SPAWN_POSITION.x + offsetX * scale;
      localFrame.position.z = SPAWN_POSITION.z + offsetZ * scale;
    }
  }
  if (!seatedViewActive) localFrame.position.y = SPAWN_POSITION.y;
}

let xrReady = false;
let xrSupported = false;
let xrMovementCenter = null;
let xrMovementStart = null;
let xrMovementRotation = null;

xrButton.addEventListener("click", () => {
  markerDetection.stream?.getTracks().forEach((track) => track.stop());
  markerDetection.video?.remove();
  markerDetection.stream = null;
  markerDetection.video = null;
}, { capture: true, once: true });

const xr = new SparkXr({
  renderer,
  mode: "ar",
  allowMobileXr: true,
  enableHands: true,
  sessionInit: {
    optionalFeatures: ["dom-overlay"],
    domOverlay: { root: document.querySelector(".hud") },
  },
  element: xrButton,
  onReady: (supported) => {
    xrReady = true;
    xrSupported = supported;
    xrButton.hidden = !supported || !markerDetection.locked || markerDetection.pcMode;
    if (markerDetection.locked && !supported) {
      xrStatus.textContent = "La réalité augmentée immersive n’est pas prise en charge par cet appareil.";
      xrStatus.hidden = false;
    }
  },
  onEnterXr: () => {
    if (xrTipStep === 0) xrTipStep = 1;
    if (xrTipStep <= 3) xrTipsBanner?.show(xrTipMessages[xrTipStep]);
    desktopViewBeforeXr = {
      position: localFrame.position.clone(),
      quaternion: localFrame.quaternion.clone(),
      cameraPosition: camera.position.clone(),
      cameraQuaternion: camera.quaternion.clone(),
    };
    pendingSeatedTeleport = seatedViewActive;
    xrMovementCenter = null;
    xrMovementStart = null;
    xrMovementRotation = null;
    interactionSystem.resetHoverTimer();
    audio.unlockSpatialAudio();
    renderEnabled = true;
    lastMoved = performance.now();
    movementPerimeter.visible = true;
    renderer.setClearAlpha(xr.mode === "immersive-ar" ? 0 : 1);
    xrButton.textContent = "Quitter la VR";
  },
  onExitXr: () => {
    xrTipsBanner?.hide();
    seatedCameraTransition = null;
    if (desktopViewBeforeXr) {
      localFrame.position.copy(desktopViewBeforeXr.position);
      localFrame.quaternion.copy(desktopViewBeforeXr.quaternion);
      camera.position.copy(desktopViewBeforeXr.cameraPosition);
      camera.quaternion.copy(desktopViewBeforeXr.cameraQuaternion);
      desktopViewBeforeXr = null;
    }
    pendingSeatedTeleport = false;
    if (seatedViewActive) applyDesktopSeatedView();
    renderEnabled = true;
    lastMoved = performance.now();
    movementPerimeter.visible = !markerDetection.pcMode;
    renderer.setClearAlpha(1);
    for (const interactionController of xrInteractionControllers) {
      interactionController.grabbed = null;
    }
    xrMovementCenter = null;
    xrMovementStart = null;
    xrMovementRotation = null;
    xrButton.textContent = "Rentrer en VR";
    xrButton.hidden = markerDetection.pcMode || !xrSupported;
  },
  // Head tracking and scripted teleportation control the view in the headset.
  controllers: { moveSpeed: 0, rotateSpeed: 0, rollSpeed: 0 },
  fixedFoveation: 0,
  frameBufferScaleFactor: XR_RENDER_SCALE,
});

let lastMarkerCheck = 0;

document.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "p" || event.key === "\\") {
    const cameraPos = camera.getWorldPosition(new THREE.Vector3());
    const cameraQuat = camera.getWorldQuaternion(new THREE.Quaternion());
    const coordinates = {
      position: cameraPos.toArray().map((value) => Number(value.toFixed(3))),
      quaternion: cameraQuat.toArray().map((value) => Number(value.toFixed(4))),
    };
    const coordinateReadout = document.getElementById("position-readout");
    if (coordinateReadout) {
      coordinateReadout.textContent = `Position : ${JSON.stringify(coordinates.position)} · Orientation : ${JSON.stringify(coordinates.quaternion)}`;
      coordinateReadout.hidden = false;
    }
    console.info("Coordonnées de la caméra :", JSON.stringify(coordinates));
  }

  if (event.key.toLowerCase() === "o") {
    for (const { model } of interactiveModels) {
      const pos = model.getWorldPosition(new THREE.Vector3());
      const quat = model.getWorldQuaternion(new THREE.Quaternion());
      const scl = model.getWorldScale(new THREE.Vector3());
      console.log(
        `${model.userData.filename} position: ${JSON.stringify(pos.toArray())} quaternion: ${JSON.stringify(quat.toArray())} scale: ${JSON.stringify(scl.toArray())}`
      );
      console.log("  → translation:", JSON.stringify([+pos.x.toFixed(3), +pos.y.toFixed(3), +pos.z.toFixed(3)]), "quaternion:", JSON.stringify(quat.toArray().map((v) => +v.toFixed(4))), "scale:", JSON.stringify([+scl.x.toFixed(3), +scl.y.toFixed(3), +scl.z.toFixed(3)]));
    }
  }
});

renderer.setAnimationLoop(function animate(time, xrFrame) {
  const animationDelta = animationClock.getDelta();
  let ambientAnimationFrame = false;
  if (
    ambientAnimationMixers.size > 0
    && time - lastAmbientAnimationUpdate >= 50
  ) {
    const ambientDelta = lastAmbientAnimationUpdate === 0
      ? animationDelta
      : Math.min((time - lastAmbientAnimationUpdate) / 1000, 0.1);
    for (const mixer of ambientAnimationMixers) {
      mixer.update(ambientDelta);
    }
    lastAmbientAnimationUpdate = time;
    ambientAnimationFrame = true;
  }

  for (const walk of activeWalks.values()) {
    walk.elapsed = Math.min(walk.elapsed + animationDelta, walk.duration);
    const progress = walk.duration > 0 ? walk.elapsed / walk.duration : 1;
    walk.model.position.lerpVectors(
      walk.startPosition,
      walk.finalPosition,
      progress
    );
  }
  for (const mixer of activeAnimationMixers) {
    mixer.update(animationDelta);
  }
  advanceNarrativeVisuals(animationDelta);
  if (activeAnimationMixers.size > 0) {
    renderEnabled = true;
    lastMoved = performance.now();
  }

  if (markerDetection.enabled && time - lastMarkerCheck >= 150) {
    lastMarkerCheck = time;
    const markerFound = detectMarkerFrame();

    if (markerFound) {
      markerDetection.locked = true;
      markerDetection.enabled = false;
      renderer.setClearAlpha(0);
      setWorldVisible(true);
      if (xrReady && xrSupported) {
        xrButton.textContent = "Rentrer en VR";
        xrButton.hidden = markerDetection.pcMode;
      } else if (xrReady) {
        xrStatus.textContent = "La réalité augmentée immersive n’est pas prise en charge par cet appareil.";
        xrStatus.hidden = false;
      }
    } else {
      setWorldVisible(false);
    }
  }

  if (markerDetection.locked && !renderEnabled) {
    renderEnabled = true;
    lastMoved = performance.now();
  }

  if (!renderer.xr.isPresenting) controls.update(localFrame, camera);
  clampSeatedViewPitch();
  updateMovement(xrFrame);
  updateSeatedCameraTransition(animationDelta);
  updateXrInteraction(time, xrFrame);
  updateCameraFacingFires(camera);

  const now = performance.now();
  const dir = localFrame.getWorldDirection(new THREE.Vector3());
  if ((localFrame.position.distanceTo(lastPos) > 0.0001) || (dir.dot(lastDir) < 0.9999)) {
    lastMoved = now;
    renderEnabled = true;
    lastPos.copy(localFrame.position);
    lastDir.copy(dir);
  }
  if (!xr.session && (now - lastMoved) > RENDER_TIMEOUT_MS) {
    renderEnabled = false;
  }

  if ((renderEnabled || xr.session || ambientAnimationFrame) && renderer.domElement.style.display !== "none") {
    renderer.render(scene, camera);
    if (loadingOverlay && !loadingOverlay.hidden) {
      loadingOverlay.hidden = true;
    }
    audio.activateWorld();
  }
  inventory?.renderDesktopPreviews();
});

window.addEventListener("beforeunload", () => {
  if (markerDetection.stream) {
    markerDetection.stream.getTracks().forEach((track) => track.stop());
  }
});
