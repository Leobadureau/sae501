import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { XRHandModelFactory } from "three/addons/webxr/XRHandModelFactory.js";
import { SparkRenderer, SplatMesh, SparkControls, SparkXr, utils } from "@sparkjsdev/spark";

const RENDER_TIMEOUT_MS = 5 * 1000;
const URL_BASE = ".";
const MAX_PIXEL_RATIO = 1.5;
const XR_SPLAT_BUDGET = 1000000;
const XR_HOVER_INTERVAL_MS = 50;
const SPAWN_POSITION = new THREE.Vector3(0, 1.5, -3.9);
const PC_CAMERA_HEIGHT_OFFSET = -0.15;
const SEATED_CAMERA_POSITION = new THREE.Vector3(
  0.1793437486,
  0.7647448313,
  -5.6177672547
);
const SEATED_CAMERA_ROTATION = new THREE.Quaternion(
  0.0310214188,
  0.0167849258,
  -0.0005210165,
  0.9993776395
).normalize();
const SEATED_MAX_LOOK_DOWN = THREE.MathUtils.degToRad(55);
const SEATED_MAX_LOOK_UP = THREE.MathUtils.degToRad(75);
const MOVEMENT_RADIUS = 2;

const scene = new THREE.Scene();
const movementPerimeter = new THREE.Mesh(
  new THREE.RingGeometry(MOVEMENT_RADIUS - 0.035, MOVEMENT_RADIUS, 96),
  new THREE.MeshBasicMaterial({
    color: 0xffc857,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
);
movementPerimeter.rotation.x = -Math.PI / 2;
movementPerimeter.position.set(SPAWN_POSITION.x, 0.015, SPAWN_POSITION.z);
movementPerimeter.renderOrder = 999;
scene.add(movementPerimeter);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 1000);
const audioListener = new THREE.AudioListener();
camera.add(audioListener);
const autoStartSounds = [];
const shepherdWalkSounds = [];
const shepherdSpeechSounds = [];
const activeFootstepSounds = new Set();
const revealSounds = [];
const pendingTriggeredSounds = new Set();
let revealSoundsScheduled = false;
let audioHasUserGesture = false;
let worldAudioEnabled = false;
const renderer = new THREE.WebGLRenderer({ alpha: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
renderer.domElement.style.display = "none";

const localFrame = new THREE.Group();
scene.add(localFrame);
localFrame.position.copy(SPAWN_POSITION);

const spark = new SparkRenderer({
  renderer,
  maxStdDev: Math.sqrt(5),
});
scene.add(spark);
localFrame.add(camera);

const markerOverlay = document.getElementById("marker-overlay");
const modeOverlay = document.getElementById("mode-overlay");
const loadingOverlay = document.getElementById("loading-overlay");
const loadingMessage = document.getElementById("loading-message");
const loadingSpinner = loadingOverlay?.querySelector(".loading-tiles");
const revealFlash = document.getElementById("reveal-flash");
const pcModeButton = document.getElementById("pc-mode");
const arModeButton = document.getElementById("ar-mode");
const pcModeInOverlay = document.getElementById("pc-mode-from-camera");
const markerDetection = {
  pcMode: false,
  enabled: false,
  locked: false,
  video: null,
  stream: null,
  canvas: document.createElement("canvas"),
  context: null,
  markerTemplate: null,
  threshold: 0.55,
};

function createGrayTemplate(imageData) {
  const pixels = imageData.data;
  const gray = new Float32Array(imageData.width * imageData.height);
  let index = 0;

  for (let i = 0; i < pixels.length; i += 4) {
    gray[index++] = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
  }

  return gray;
}

function prepareMarkerTemplate(imageData) {
  const values = createGrayTemplate(imageData);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let normSquared = 0;

  for (let index = 0; index < values.length; index += 1) {
    values[index] -= mean;
    normSquared += values[index] * values[index];
  }

  return { values, normSquared };
}

function updateMarkerOverlay(visible) {
  if (!markerOverlay) return;
  markerOverlay.classList.toggle("is-visible", !visible);
}

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
  if (event) unlockSpatialAudio();
  markerDetection.pcMode = true;
  markerDetection.locked = true;
  markerDetection.enabled = false;
  camera.position.y = PC_CAMERA_HEIGHT_OFFSET;
  movementPerimeter.visible = false;
  markerDetection.stream?.getTracks().forEach((track) => track.stop());
  markerDetection.video?.remove();
  markerDetection.stream = null;
  markerDetection.video = null;

  renderer.setClearAlpha(1);
  if (loadingOverlay) loadingOverlay.hidden = false;
  setWorldVisible(true);
  if (modeOverlay) modeOverlay.hidden = true;
}

function startReadySounds() {
  if (!worldAudioEnabled || !audioHasUserGesture || audioListener.context.state !== "running") return;
  for (const sound of autoStartSounds) {
    if (sound.buffer && !sound.isPlaying) sound.play();
  }
  for (const sound of activeFootstepSounds) {
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

function attachShepherdSpeech(model) {
  for (const sound of shepherdSpeechSounds) {
    model.add(sound);
    sound.position.set(0, 0.75, 0);
  }
}

function startShepherdSpeech(model) {
  attachShepherdSpeech(model);
  for (const sound of shepherdSpeechSounds) {
    pendingTriggeredSounds.add(sound);
  }
  startReadySounds();
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

renderer.domElement.addEventListener("pointerdown", unlockSpatialAudio);
document.addEventListener("keydown", () => {
  if (worldAudioEnabled) unlockSpatialAudio();
});

pcModeButton?.addEventListener("click", enterPcMode);
pcModeInOverlay?.addEventListener("click", enterPcMode);
arModeButton?.addEventListener("click", () => {
  unlockSpatialAudio();
  if (modeOverlay) modeOverlay.hidden = true;
  setupMarkerDetection();
});

function setWorldVisible(visible) {
  if (!visible) {
    worldAudioEnabled = false;
    for (const sound of [...autoStartSounds, ...shepherdWalkSounds]) {
      if (sound.isPlaying) sound.pause();
    }
    for (const sound of [...shepherdSpeechSounds, ...revealSounds.map(({ sound }) => sound)]) {
      if (!sound.isPlaying) continue;
      sound.pause();
      pendingTriggeredSounds.add(sound);
    }
  }
  renderer.domElement.style.display = visible ? "block" : "none";
  if (markerDetection.video) {
    markerDetection.video.style.display = "block";
  }
  updateMarkerOverlay(visible);
}

async function setupMarkerDetection() {
  if (markerDetection.locked) {
    renderer.setClearAlpha(1);
    setWorldVisible(true);
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    markerOverlay.innerHTML =
      'Caméra indisponible. Ouvrez cette page en HTTPS et autorisez la caméra, ou <button id="pc-mode-from-camera" class="pc-mode-link" type="button">Version PC</button>.';
    updateMarkerOverlay(false);
    document.getElementById("pc-mode-from-camera")?.addEventListener("click", enterPcMode);
    return;
  }

  try {
    if (!markerDetection.locked) {
      const markerImage = new Image();
      markerImage.crossOrigin = "anonymous";
      markerImage.src = "./assets/images/SCANNE.png";
      await markerImage.decode();

      const markerCanvas = document.createElement("canvas");
      markerCanvas.width = 24;
      markerCanvas.height = 24;
      const markerContext = markerCanvas.getContext("2d", { willReadFrequently: true });
      markerContext.drawImage(markerImage, 0, 0, markerCanvas.width, markerCanvas.height);
      markerDetection.markerTemplate = prepareMarkerTemplate(
        markerContext.getImageData(0, 0, markerCanvas.width, markerCanvas.height)
      );
    }

    const video = document.createElement("video");
    video.className = "marker-camera";
    video.playsInline = true;
    video.autoplay = true;
    video.muted = true;

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });

    markerDetection.video = video;
    markerDetection.stream = stream;
    video.srcObject = stream;
    document.body.appendChild(video);
    await video.play();

    const videoWidth = video.videoWidth || 160;
    const videoHeight = video.videoHeight || 120;
    const frameScale = 200 / Math.max(videoWidth, videoHeight);
    markerDetection.canvas.width = Math.round(videoWidth * frameScale);
    markerDetection.canvas.height = Math.round(videoHeight * frameScale);
    markerDetection.context = markerDetection.canvas.getContext("2d", { willReadFrequently: true });
    markerDetection.enabled = !markerDetection.locked;
    renderer.setClearAlpha(markerDetection.locked ? 0 : 1);
    setWorldVisible(markerDetection.locked);
    if (!markerDetection.locked) console.log("Marker detection ready using SCANNE.png");
  } catch (error) {
    console.warn("Marker detection unavailable; keeping world hidden.", error);
    markerOverlay.innerHTML =
      'Autorisez l’accès à la caméra pour scanner SCANNE.png, ou <button id="pc-mode-from-camera" class="pc-mode-link" type="button">Version PC</button>.';
    updateMarkerOverlay(false);
    document.getElementById("pc-mode-from-camera")?.addEventListener("click", enterPcMode);
  }
}

function detectMarkerFrame() {
  if (!markerDetection.enabled || !markerDetection.video || !markerDetection.markerTemplate) return false;

  const { canvas, context, video, markerTemplate, threshold } = markerDetection;
  const frameWidth = canvas.width;
  const frameHeight = canvas.height;

  context.drawImage(video, 0, 0, frameWidth, frameHeight);
  const frame = createGrayTemplate(context.getImageData(0, 0, frameWidth, frameHeight));
  const { values, normSquared } = markerTemplate;
  const templateSize = 24;
  const sampleCount = templateSize * templateSize;
  let bestSimilarity = 0;

  for (let side = 16; side <= Math.min(frameWidth, frameHeight); side += 8) {
    if (side > frameWidth || side > frameHeight) continue;

    for (let top = 0; top <= frameHeight - side; top += 8) {
      for (let left = 0; left <= frameWidth - side; left += 8) {
        let sum = 0;
        let sumSquared = 0;
        let dot = 0;
        let index = 0;

        for (let row = 0; row < templateSize; row += 1) {
          const y = top + Math.floor(((row + 0.5) * side) / templateSize);
          for (let column = 0; column < templateSize; column += 1) {
            const x = left + Math.floor(((column + 0.5) * side) / templateSize);
            const pixel = frame[y * frameWidth + x];
            sum += pixel;
            sumSquared += pixel * pixel;
            dot += pixel * values[index++];
          }
        }

        const patchNormSquared = sumSquared - (sum * sum) / sampleCount;
        if (patchNormSquared === 0) continue;
        const similarity = dot / Math.sqrt(patchNormSquared * normSquared);
        bestSimilarity = Math.max(bestSimilarity, similarity);
        if (bestSimilarity >= threshold) return true;
      }
    }
  }

  return false;
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
  const response = await fetch(`${URL_BASE}/data/scene.json`);
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
  const splatMesh = new SplatMesh({ url: `${URL_BASE}/${splat.filename}`, lod: true });
  splatMesh.position.fromArray(splat.transform?.translation ?? [0, 0, 0]);
  splatMesh.quaternion.fromArray(splat.transform?.quaternion ?? [0, 0, 0, 1]);
  const scale = splat.transform?.scale ?? 1;
  splatMesh.scale.set(scale, scale, scale);
  scene.add(splatMesh);
  splatMeshes.push(splatMesh);
}

const audioLoader = new THREE.AudioLoader();
for (const soundConfig of sounds) {
  const sound = soundConfig.spatial === false
    ? new THREE.Audio(audioListener)
    : new THREE.PositionalAudio(audioListener);
  sound.setLoop(soundConfig.loop ?? true);
  sound.setVolume(soundConfig.volume ?? 1);
  if (soundConfig.spatial !== false) {
    sound.setRefDistance(soundConfig.refDistance ?? 1);
    sound.setMaxDistance(soundConfig.maxDistance ?? 100);
    sound.setRolloffFactor(soundConfig.rolloffFactor ?? 1);
    sound.setDistanceModel("inverse");
    sound.position.fromArray(soundConfig.transform?.translation ?? [0, 0, 0]);
  }
  scene.add(sound);
  if (soundConfig.trigger === "shepherdWalk") {
    shepherdWalkSounds.push(sound);
  } else if (soundConfig.trigger === "shepherdSpeech") {
    shepherdSpeechSounds.push(sound);
  } else if (soundConfig.trigger === "shepherdReveal") {
    revealSounds.push({ sound, delayMs: soundConfig.delayMs ?? 0 });
  } else {
    autoStartSounds.push(sound);
  }

  audioLoader
    .loadAsync(`${URL_BASE}/${soundConfig.filename}`)
    .then((buffer) => {
      sound.setBuffer(buffer);
      if (audioHasUserGesture) startReadySounds();
    })
    .catch((error) => {
      console.error(`Failed to load spatial audio: ${soundConfig.filename}`, error);
    });
}

function extractAlbedoProperties(material) {
  let color = new THREE.Color(0x888888);
  let map = null;

  if (material.color instanceof THREE.Color) {
    color = material.color.clone();
  }
  if (material.map) {
    map = material.map;
  }

  return { color, map };
}

function convertToBasicMaterials(object) {
  object.traverse((child) => {
    if (child.isMesh) {
      const originalMaterial = child.material;
      const originalMaterials = Array.isArray(originalMaterial)
        ? originalMaterial
        : [originalMaterial];

      if (originalMaterials.length === 0) {
        child.material = new THREE.MeshBasicMaterial({
          color: 0x888888,
          side: THREE.DoubleSide,
        });
      } else {
        const newMaterials = originalMaterials.map((mat) => {
          const { color, map } = extractAlbedoProperties(mat);
          return new THREE.MeshBasicMaterial({
            color,
            map,
            side: THREE.DoubleSide,
          });
        });

        child.material = newMaterials.length === 1 ? newMaterials[0] : newMaterials;
      }
    }
  });
}

async function waitForTexture(texture) {
  const image = texture.image;
  if (!image || typeof image !== "object") return;

  if (image.complete === false && typeof image.addEventListener === "function") {
    await new Promise((resolve, reject) => {
      const onLoad = () => {
        image.removeEventListener("error", onError);
        resolve();
      };
      const onError = () => {
        image.removeEventListener("load", onLoad);
        reject(new Error(`Failed to load texture: ${image.src || "unknown image"}`));
      };
      image.addEventListener("load", onLoad, { once: true });
      image.addEventListener("error", onError, { once: true });
    });
  }

  if (image.complete && image.naturalWidth === 0) {
    throw new Error(`Texture image is empty: ${image.src || "unknown image"}`);
  }

  if (typeof image.decode === "function") {
    await image.decode();
  }
}

async function waitForModelTextures(model) {
  const textures = new Set();
  model.traverse((child) => {
    if (!child.isMesh) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value?.isTexture) textures.add(value);
      }
    }
  });
  await Promise.all([...textures].map(waitForTexture));
}

function createGlowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to create the sacoche glow texture.");
  }

  const gradient = context.createRadialGradient(64, 64, 12, 64, 64, 62);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(0.42, "rgba(255,255,255,0)");
  gradient.addColorStop(0.68, "rgba(255,255,255,0.2)");
  gradient.addColorStop(0.86, "rgba(255,255,255,0.1)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");

  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return new THREE.CanvasTexture(canvas);
}

const glowTexture = createGlowTexture();

function addModelGlow(model) {
  model.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const worldScale = model.getWorldScale(new THREE.Vector3());
  const localSize = new THREE.Vector3(
    size.x / Math.max(Math.abs(worldScale.x), 0.0001),
    size.y / Math.max(Math.abs(worldScale.y), 0.0001),
    size.z / Math.max(Math.abs(worldScale.z), 0.0001)
  );
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0xffffff,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    })
  );

  glow.position.copy(model.worldToLocal(center));
  glow.scale.set(
    Math.max(localSize.x * 2.4, localSize.y * 0.9),
    Math.max(localSize.y * 1.8, localSize.x * 1.4),
    1
  );
  glow.renderOrder = 1;
  model.add(glow);
}

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
    const stopFootsteps = startShepherdFootsteps(model);
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
  startShepherdSpeech(model);
  scheduleRevealSounds();
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

const interactionRaycaster = new THREE.Raycaster();
interactionRaycaster.far = 10;
const interactionPointer = new THREE.Vector2();
const interactionLocalRay = new THREE.Ray();
const interactionInverseMatrix = new THREE.Matrix4();
const interactionHitPoint = new THREE.Vector3();
let interactionPointerStart = null;
let hoveredModel = null;
let selectedModel = null;

function findInteractiveHit(event) {
  const bounds = renderer.domElement.getBoundingClientRect();
  interactionPointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  interactionPointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
  camera.updateMatrixWorld(true);
  interactionRaycaster.setFromCamera(interactionPointer, camera);

  return findInteractiveHitAtRay();
}

function findInteractiveModel(event) {
  return findInteractiveHit(event)?.model ?? null;
}

function revealModelsFor(model) {
  unlockSpatialAudio();

  for (const revealed of modelsRevealedByGrab.get(model.userData.filename) ?? []) {
    startModelReveal(revealed, model);
  }
}

let pointerGrab = null;
const grabPlane = new THREE.Plane();
const grabPlaneHit = new THREE.Vector3();

function beginPointerGrab(event, hit) {
  camera.getWorldDirection(grabPlane.normal);
  grabPlane.setFromNormalAndCoplanarPoint(grabPlane.normal, hit.point);

  const modelWorldPosition = hit.model.getWorldPosition(new THREE.Vector3());
  pointerGrab = {
    pointerId: event.pointerId,
    model: hit.model,
    offset: modelWorldPosition.sub(hit.point),
    moved: false,
    start: { x: event.clientX, y: event.clientY },
  };

  revealModelsFor(hit.model);
  selectedModel = hit.model;
  hoveredModel = hit.model;
  updateInteractionHighlights();
  renderer.domElement.setPointerCapture(event.pointerId);
}

function updatePointerGrab(event) {
  if (!pointerGrab) return false;

  const bounds = renderer.domElement.getBoundingClientRect();
  interactionPointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  interactionPointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
  camera.updateMatrixWorld(true);
  interactionRaycaster.setFromCamera(interactionPointer, camera);

  if (!interactionRaycaster.ray.intersectPlane(grabPlane, grabPlaneHit)) return true;

  const { model, offset } = pointerGrab;
  const parent = model.parent;
  parent.updateWorldMatrix(true, false);
  model.position.copy(parent.worldToLocal(grabPlaneHit.clone().add(offset)));
  model.updateWorldMatrix(true, true);

  if (Math.hypot(event.clientX - pointerGrab.start.x, event.clientY - pointerGrab.start.y) > 6) {
    pointerGrab.moved = true;
  }

  return true;
}

function endPointerGrab() {
  if (!pointerGrab) return;
  pointerGrab = null;
  updateInteractionHighlights();
}

function findInteractiveHitAtRay() {
  let closestHit = null;
  let closestDistance = interactionRaycaster.far;
  for (const { model, bounds } of interactiveModels) {
    if (!model.visible) continue;
    model.updateWorldMatrix(true, false);
    interactionInverseMatrix.copy(model.matrixWorld).invert();
    interactionLocalRay.copy(interactionRaycaster.ray).applyMatrix4(interactionInverseMatrix);
    if (!interactionLocalRay.intersectBox(bounds, interactionHitPoint)) continue;
    interactionHitPoint.applyMatrix4(model.matrixWorld);
    const distance = interactionRaycaster.ray.origin.distanceTo(interactionHitPoint);
    if (distance < interactionRaycaster.near || distance > closestDistance) continue;
    closestDistance = distance;
    closestHit = { model, point: interactionHitPoint.clone() };
  }
  return closestHit;
}

function findInteractiveModelAtRay() {
  return findInteractiveHitAtRay()?.model ?? null;
}

function findXrInteractiveHit(controller) {
  controller.updateWorldMatrix(true, false);
  const origin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
  const direction = new THREE.Vector3(0, 0, -1).transformDirection(controller.matrixWorld);
  interactionRaycaster.set(origin, direction);
  return findInteractiveHitAtRay();
}

function findXrInteractiveModel(controller) {
  return findXrInteractiveHit(controller)?.model ?? null;
}

function updateInteractionHighlights() {
  for (const { model, highlight } of interactiveModels) {
    highlight.visible = model.visible && (model === hoveredModel || model === selectedModel);
    if (highlight.visible) {
      model.updateWorldMatrix(true, true);
      highlight.update();
    }
  }
}

function toggleInteractiveSelection(model) {
  selectedModel = model === selectedModel ? null : model;
  hoveredModel = model;
  updateInteractionHighlights();
}

function beginXrGrab(interactionController) {
  const hit = findXrInteractiveHit(interactionController.controller);
  if (!hit) return;

  const { controller } = interactionController;
  interactionController.grabbed = {
    model: hit.model,
    localPosition: new THREE.Vector3(0, 0, -0.08),
    localQuaternion: new THREE.Quaternion(),
  };
  revealModelsFor(hit.model);
  selectedModel = hit.model;
  hoveredModel = hit.model;
  updateInteractionHighlights();
}

function toggleXrGrab(interactionController) {
  if (interactionController.grabbed) {
    interactionController.grabbed = null;
    return;
  }

  beginXrGrab(interactionController);
}

function updateXrGrab(interactionController) {
  const { controller, grabbed } = interactionController;
  if (!grabbed || !grabbed.model.parent) return;
  if (!grabbed.model.visible) {
    interactionController.grabbed = null;
    return;
  }

  controller.updateWorldMatrix(true, false);
  const worldPosition = grabbed.localPosition.clone().applyMatrix4(controller.matrixWorld);
  const worldQuaternion = controller
    .getWorldQuaternion(new THREE.Quaternion())
    .multiply(grabbed.localQuaternion);
  const parent = grabbed.model.parent;
  parent.updateWorldMatrix(true, false);
  grabbed.model.position.copy(parent.worldToLocal(worldPosition));
  grabbed.model.quaternion.copy(
    parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(worldQuaternion)
  );
  grabbed.model.updateWorldMatrix(true, true);
}

const xrInteractionControllers = [];
for (let index = 0; index < 2; index += 1) {
  const controller = renderer.xr.getController(index);
  const ray = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(0, 0, -1),
    ]),
    new THREE.LineBasicMaterial({ color: 0x65e6c5, transparent: true, opacity: 0.85 })
  );
  ray.scale.z = 10;
  ray.visible = false;
  controller.add(ray);
  const interactionController = { controller, ray, connected: false };
  controller.addEventListener("connected", () => {
    interactionController.connected = true;
  });
  controller.addEventListener("disconnected", () => {
    interactionController.connected = false;
    ray.visible = false;
    interactionController.grabbed = null;
  });
  controller.addEventListener("select", () => {
    toggleXrGrab(interactionController);
  });
  localFrame.add(controller);
  xrInteractionControllers.push(interactionController);
}

const handModelFactory = new XRHandModelFactory(
  null,
  (handModel) => convertToBasicMaterials(handModel)
);
for (let index = 0; index < 2; index += 1) {
  const hand = renderer.xr.getHand(index);
  hand.add(handModelFactory.createHandModel(hand, "mesh"));
  localFrame.add(hand);
}

let lastXrHoverUpdate = -Infinity;

function updateXrInteraction(time) {
  if (!renderer.xr.isPresenting) {
    for (const interactionController of xrInteractionControllers) {
      interactionController.ray.visible = false;
      interactionController.grabbed = null;
    }
    return;
  }

  let nextHoveredModel = null;
  const updateHover = time - lastXrHoverUpdate >= XR_HOVER_INTERVAL_MS;
  for (const interactionController of xrInteractionControllers) {
    const { controller, ray, connected } = interactionController;
    ray.visible = connected;
    if (!connected) continue;
    updateXrGrab(interactionController);
    if (updateHover) nextHoveredModel ??= findXrInteractiveModel(controller);
  }
  if (updateHover) {
    lastXrHoverUpdate = time;
    hoveredModel = nextHoveredModel;
    updateInteractionHighlights();
  }
}

let defaultRotateSpeed = null;

renderer.domElement.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;

  const hit = findInteractiveHit(event);
  interactionPointerStart = { x: event.clientX, y: event.clientY, model: hit?.model ?? null };
  if (hit) {
    defaultRotateSpeed ??= controls.pointerControls.rotateSpeed;
    beginPointerGrab(event, hit);
    controls.pointerControls.rotateSpeed = 0;
  }
});

renderer.domElement.addEventListener("pointermove", (event) => {
  if (updatePointerGrab(event)) return;

  hoveredModel = findInteractiveModel(event);
  renderer.domElement.style.cursor = hoveredModel ? "pointer" : "";
  updateInteractionHighlights();
});

renderer.domElement.addEventListener("pointerup", (event) => {
  if (event.button !== 0) return;
  const wasGrabbing = pointerGrab !== null;
  if (defaultRotateSpeed !== null) controls.pointerControls.rotateSpeed = defaultRotateSpeed;
  endPointerGrab();
  if (!interactionPointerStart) return;
  const movement = Math.hypot(
    event.clientX - interactionPointerStart.x,
    event.clientY - interactionPointerStart.y
  );
  const startModel = interactionPointerStart.model;
  interactionPointerStart = null;
  if (wasGrabbing || movement > 6) return;

  const model = findInteractiveModel(event);
  if (model === startModel) toggleInteractiveSelection(model);
});

renderer.domElement.addEventListener("pointerleave", () => {
  interactionPointerStart = null;
  if (defaultRotateSpeed !== null) controls.pointerControls.rotateSpeed = defaultRotateSpeed;
  endPointerGrab();
  hoveredModel = null;
  renderer.domElement.style.cursor = "";
  updateInteractionHighlights();
});

renderer.domElement.addEventListener("pointercancel", () => {
  interactionPointerStart = null;
  if (defaultRotateSpeed !== null) controls.pointerControls.rotateSpeed = defaultRotateSpeed;
  endPointerGrab();
});

window.addEventListener("blur", () => {
  interactionPointerStart = null;
  if (defaultRotateSpeed !== null) controls.pointerControls.rotateSpeed = defaultRotateSpeed;
  endPointerGrab();
});

window.THREE = THREE;
window.scene = scene;
window.renderer = renderer;

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

const controls = new SparkControls({
  canvas: renderer.domElement,
});
controls.pointerControls.reverseRotate = utils.isMobile();
controls.pointerControls.rotateSpeed *= 2.0;
controls.pointerControls.slideSpeed *= 0.75;

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
    lastXrHoverUpdate = -Infinity;
    spark.lodSplatCount = XR_SPLAT_BUDGET;
    spark.lodRenderScale = 1;
    unlockSpatialAudio();
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
    spark.lodSplatCount = undefined;
    spark.lodRenderScale = 1;
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
  frameBufferScaleFactor: 1,
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
    if (!worldAudioEnabled) {
      worldAudioEnabled = true;
      startReadySounds();
    }
  }
});

window.addEventListener("beforeunload", () => {
  if (markerDetection.stream) {
    markerDetection.stream.getTracks().forEach((track) => track.stop());
  }
});
