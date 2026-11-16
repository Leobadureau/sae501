import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { SplatMesh, SparkControls, SparkXr, utils } from "@sparkjsdev/spark";
import { addModelGlow, convertToBasicMaterials, waitForModelTextures } from "./model-materials.js";
import { createMarkerDetection } from "./marker-detection.js?v=lower-scan-latency-20261116";
import { createAudioSystem } from "./audio.js";
import { createInteractionSystem } from "./interactions.js";
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
const audio = createAudioSystem({ THREE, audioListener, scene, renderer, musicToggle });
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
  camera.position.y = PC_CAMERA_HEIGHT_OFFSET;
  movementPerimeter.visible = false;
  stopMarkerCamera();

  renderer.setClearAlpha(1);
  if (loadingOverlay) loadingOverlay.hidden = false;
  setWorldVisible(true);
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
const revealedModels = new WeakSet();
const activeAnimationMixers = new Set();
const ambientAnimationMixers = new Set();
const cameraFacingFires = new Set();
const activeWalks = new Map();
const animationClock = new THREE.Clock();
const SHEPHERD_WALK_DISTANCE = 2.2;
const ANIMATION_CROSSFADE_DURATION = 0.45;
let seatedViewActive = false;
let pendingSeatedTeleport = false;
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
    // WebXR owns the camera pose: move its parent on the next tracked frame.
    pendingSeatedTeleport = true;
  } else {
    applyDesktopSeatedView();
  }
  renderEnabled = true;
  lastMoved = performance.now();
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

function playShepherdAnimation(model) {
  const clips = model.animations ?? [];
  if (clips.length === 0) {
    console.warn(`No animation clips found for ${model.userData.filename}`);
    return;
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
  if (!walkClip && !talkClip) return;

  const finalPosition = model.position.clone();
  const mixer = new THREE.AnimationMixer(model);
  const walkAction = walkClip
    ? mixer.clipAction(stabilizeWalkRoot(walkClip.clone()))
    : null;
  const visibleTalkClip = talkClip?.clone();
  if (visibleTalkClip) amplifyAnimationRotations(visibleTalkClip, 6);
  const talkAction = visibleTalkClip
    ? mixer.clipAction(visibleTalkClip)
    : null;

  if (walkAction) {
    const forward = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(model.quaternion)
      .normalize();
    const startPosition = finalPosition
      .clone()
      .addScaledVector(forward, -SHEPHERD_WALK_DISTANCE);
    model.position.copy(startPosition);
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
      if (talkAction) {
        window.setTimeout(() => {
          stopFootsteps();
        }, ANIMATION_CROSSFADE_DURATION * 1000);
      } else {
        stopFootsteps();
      }
    });
  }

  if (talkAction) {
    talkAction.setLoop(THREE.LoopRepeat, Infinity);
    talkAction.clampWhenFinished = true;

    if (!walkAction) {
      talkAction.play();
    }

    mixer.addEventListener("finished", (event) => {
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
      activeWalks.delete(mixer);
      activeAnimationMixers.delete(mixer);
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      renderEnabled = true;
      lastMoved = performance.now();
    });
  }

  activeAnimationMixers.add(mixer);
  console.info(
    `Playing shepherd arrival: ${walkClip?.name ?? "walking unavailable"}${talkClip ? `, then ${talkClip.name} (rotations amplified 6x)` : ""}`
  );
}

function startModelReveal(model, sourceModel = null) {
  if (revealedModels.has(model)) return;
  revealedModels.add(model);

  playRevealFlash();
  model.visible = true;
  enterSeatedView();
  playShepherdAnimation(model);
  audio.startShepherdSpeech(model);
  audio.scheduleRevealSounds();
  if (sourceModel) {
    sourceModel.visible = false;
    updateInteractionHighlights();
  }
  renderEnabled = true;
  lastMoved = performance.now();
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

      interactiveModels.push({
        model,
        highlight,
        bounds: new THREE.Box3().setFromObject(model)
          .applyMatrix4(model.matrixWorld.clone().invert()),
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
  revealModel: startModelReveal,
  convertMaterials: convertToBasicMaterials,
});
const xrInteractionControllers = interactionSystem.controllers;
const updateXrInteraction = (time) => interactionSystem.updateXrInteraction(time);

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
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

    const viewerPosition = viewerPose.transform.position;
    if (pendingSeatedTeleport) {
      const orientation = viewerPose.transform.orientation;
      const headRotation = new THREE.Euler().setFromQuaternion(
        new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w), "YXZ"
      );
      const targetRotation = new THREE.Euler().setFromQuaternion(SEATED_CAMERA_ROTATION, "YXZ");
      // Align yaw only; pitch and roll continue to follow the person's head.
      localFrame.rotation.set(0, targetRotation.y - headRotation.y, 0);
      localFrame.position.copy(SEATED_CAMERA_POSITION).sub(
        new THREE.Vector3(viewerPosition.x, viewerPosition.y, viewerPosition.z)
          .applyQuaternion(localFrame.quaternion)
      );
      pendingSeatedTeleport = false;
      xrMovementCenter = null;
      xrMovementStart = null;
      xrMovementRotation = null;
      localFrame.updateWorldMatrix(true, true);
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

const xrButton = document.getElementById("vr-button");
const xrStatus = document.getElementById("xr-status");
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
  element: xrButton,
  onReady: (supported) => {
    xrReady = true;
    xrSupported = supported;
    xrButton.hidden = !supported || !markerDetection.locked;
    if (markerDetection.locked && !supported) {
      xrStatus.textContent = "La réalité augmentée immersive n’est pas prise en charge par cet appareil.";
      xrStatus.hidden = false;
    }
  },
  onEnterXr: () => {
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
    xrButton.textContent = "Quitter AR";
  },
  onExitXr: () => {
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
    xrButton.textContent = "Entrer en AR";
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
  const animationDelta = Math.min(animationClock.getDelta(), 0.1);
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
        xrButton.textContent = "Entrer en AR";
        xrButton.hidden = false;
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
  updateXrInteraction(time);
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
});

window.addEventListener("beforeunload", () => {
  if (markerDetection.stream) {
    markerDetection.stream.getTracks().forEach((track) => track.stop());
  }
});
