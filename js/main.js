import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { XRHandModelFactory } from "three/addons/webxr/XRHandModelFactory.js";
import { SparkRenderer, SplatMesh, SparkControls, SparkXr, utils } from "@sparkjsdev/spark";

const RENDER_TIMEOUT_MS = 5 * 1000;
const URL_BASE = ".";
const SPAWN_POSITION = new THREE.Vector3(0, 1.5, -3.9);
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
const renderer = new THREE.WebGLRenderer({ alpha: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(window.devicePixelRatio);
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
const markerDetection = {
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

function setWorldVisible(visible) {
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
    markerOverlay.textContent = "Caméra indisponible. Ouvrez cette page en HTTPS et autorisez la caméra.";
    if (markerDetection.locked) {
      renderer.setClearAlpha(1);
      setWorldVisible(true);
    } else {
      setWorldVisible(false);
    }
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
    markerOverlay.textContent = "Autorisez l’accès à la caméra pour scanner SCANNE.png.";
    if (markerDetection.locked) {
      renderer.setClearAlpha(1);
      setWorldVisible(true);
    } else {
      setWorldVisible(false);
    }
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

setupMarkerDetection();

const sceneJson = await fetch(`${URL_BASE}/data/scene.json`).then((response) => response.json());
const splats = sceneJson.splats ?? [];
const meshes = sceneJson.meshes ?? [];

for (const splat of splats) {
  const splatMesh = new SplatMesh({ url: `${URL_BASE}/${splat.filename}`, lod: true });
  splatMesh.position.fromArray(splat.transform?.translation ?? [0, 0, 0]);
  splatMesh.quaternion.fromArray(splat.transform?.quaternion ?? [0, 0, 0, 1]);
  const scale = splat.transform?.scale ?? 1;
  splatMesh.scale.set(scale, scale, scale);
  scene.add(splatMesh);
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

const gltfLoader = new GLTFLoader();
const interactiveModels = [];
const modelsRevealedByGrab = new Map();
for (const mesh of meshes) {
  try {
    const gltf = await gltfLoader.loadAsync(`${URL_BASE}/${mesh.filename}`);
    const model = gltf.scene;
    convertToBasicMaterials(model);
    model.userData.filename = mesh.filename;

    model.position.fromArray(mesh.transform?.translation ?? [0, 0, 0]);
    model.quaternion.fromArray(mesh.transform?.quaternion ?? [0, 0, 0, 1]);
    const meshScale = mesh.transform?.scale ?? [1, 1, 1];
    model.scale.set(meshScale[0], meshScale[1], meshScale[2]);
    model.visible = mesh.visible ?? true;
    scene.add(model);

    if (mesh.interactive !== false) {
      const highlight = new THREE.BoxHelper(model, 0x65e6c5);
      highlight.material.depthTest = false;
      highlight.renderOrder = 1000;
      highlight.visible = false;
      scene.add(highlight);
      interactiveModels.push({ model, highlight });
    }

    if (mesh.revealOnGrab) {
      const revealedModels = modelsRevealedByGrab.get(mesh.revealOnGrab) ?? [];
      revealedModels.push(model);
      modelsRevealedByGrab.set(mesh.revealOnGrab, revealedModels);
    }
  } catch (error) {
    console.warn(`Failed to load mesh: ${mesh.filename}`, error);
  }
}

const interactionRaycaster = new THREE.Raycaster();
interactionRaycaster.far = 10;
const interactionPointer = new THREE.Vector2();
let interactionPointerStart = null;
let hoveredModel = null;
let selectedModel = null;

function findInteractiveModel(event) {
  const bounds = renderer.domElement.getBoundingClientRect();
  interactionPointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  interactionPointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
  camera.updateMatrixWorld(true);
  interactionRaycaster.setFromCamera(interactionPointer, camera);

  return findInteractiveModelAtRay();
}

function findInteractiveHitAtRay() {
  const intersections = interactionRaycaster.intersectObjects(
    interactiveModels.map(({ model }) => model),
    true
  );
  const intersection = intersections[0];
  let object = intersection?.object;

  while (object) {
    const entry = interactiveModels.find(({ model }) => model === object);
    if (entry) return { model: entry.model, point: intersection.point.clone() };
    object = object.parent;
  }

  return null;
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
    highlight.visible = model === hoveredModel || model === selectedModel;
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
  for (const model of modelsRevealedByGrab.get(hit.model.userData.filename) ?? []) {
    model.visible = true;
  }
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

function updateXrInteraction() {
  if (!renderer.xr.isPresenting) {
    for (const interactionController of xrInteractionControllers) {
      interactionController.ray.visible = false;
      interactionController.grabbed = null;
    }
    return;
  }

  let nextHoveredModel = null;
  for (const interactionController of xrInteractionControllers) {
    const { controller, ray, connected } = interactionController;
    ray.visible = connected;
    if (!connected) continue;
    updateXrGrab(interactionController);
    nextHoveredModel ??= findXrInteractiveModel(controller);
  }
  hoveredModel = nextHoveredModel;
  updateInteractionHighlights();
}

renderer.domElement.addEventListener("pointerdown", (event) => {
  if (event.button === 0) {
    interactionPointerStart = { x: event.clientX, y: event.clientY };
  }
});

renderer.domElement.addEventListener("pointermove", (event) => {
  hoveredModel = findInteractiveModel(event);
  renderer.domElement.style.cursor = hoveredModel ? "pointer" : "";
  updateInteractionHighlights();
});

renderer.domElement.addEventListener("pointerup", (event) => {
  if (!interactionPointerStart) return;
  const movement = Math.hypot(
    event.clientX - interactionPointerStart.x,
    event.clientY - interactionPointerStart.y
  );
  interactionPointerStart = null;
  if (movement > 6) return;

  toggleInteractiveSelection(findInteractiveModel(event));
});

renderer.domElement.addEventListener("pointerleave", () => {
  hoveredModel = null;
  renderer.domElement.style.cursor = "";
  updateInteractionHighlights();
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
let lastPos = new THREE.Vector3().setScalar(Number.NEGATIVE_INFINITY);
let lastDir = new THREE.Vector3();

const controls = new SparkControls({
  canvas: renderer.domElement,
});
controls.pointerControls.reverseRotate = utils.isMobile();
controls.pointerControls.rotateSpeed *= 2.0;
controls.pointerControls.slideSpeed *= 0.75;

function updateMovement(xrFrame) {
  if (xr.session && xr.mode === "immersive-ar") {
    const referenceSpace = renderer.xr.getReferenceSpace();
    const viewerPose = referenceSpace && xrFrame?.getViewerPose(referenceSpace);
    if (!viewerPose) return;

    const viewerPosition = viewerPose.transform.position;
    if (!xrMovementCenter) {
      xrMovementCenter = new THREE.Vector3(viewerPosition.x, viewerPosition.y, viewerPosition.z);
      xrMovementStart = localFrame.position.clone();
      xrMovementRotation = localFrame.quaternion.clone();
      const centerOffset = xrMovementCenter.clone().applyQuaternion(xrMovementRotation);
      movementPerimeter.position.set(
        xrMovementStart.x + centerOffset.x,
        xrMovementStart.y + centerOffset.y - SPAWN_POSITION.y + 0.015,
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
  movementPerimeter.position.set(SPAWN_POSITION.x, 0.015, SPAWN_POSITION.z);
  const offsetX = localFrame.position.x - SPAWN_POSITION.x;
  const offsetZ = localFrame.position.z - SPAWN_POSITION.z;
  const distance = Math.hypot(offsetX, offsetZ);
  if (distance > MOVEMENT_RADIUS) {
    const scale = MOVEMENT_RADIUS / distance;
    localFrame.position.x = SPAWN_POSITION.x + offsetX * scale;
    localFrame.position.z = SPAWN_POSITION.z + offsetZ * scale;
  }
  localFrame.position.y = SPAWN_POSITION.y;
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
    renderEnabled = true;
    lastMoved = performance.now();
    renderer.setClearAlpha(xr.mode === "immersive-ar" ? 0 : 1);
    xrButton.textContent = "Quitter AR";
  },
  onExitXr: () => {
    renderEnabled = true;
    lastMoved = performance.now();
    renderer.setClearAlpha(1);
    for (const interactionController of xrInteractionControllers) {
      interactionController.grabbed = null;
    }
    xrMovementCenter = null;
    xrMovementStart = null;
    xrMovementRotation = null;
    xrButton.textContent = "Entrer en AR";
  },
  controllers: {},
});

let lastMarkerCheck = 0;

document.addEventListener("keydown", (event) => {
  if (event.key === "\\") {
    const cameraPos = camera.getWorldPosition(new THREE.Vector3());
    const cameraQuat = camera.getWorldQuaternion(new THREE.Quaternion());
    console.log("camera position: ", JSON.stringify(cameraPos.toArray()), "quaternion: ", JSON.stringify(cameraQuat.toArray()));
  }
});

renderer.setAnimationLoop(function animate(time, xrFrame) {
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

  xr.updateControllers(camera);
  controls.update(localFrame, camera);
  updateMovement(xrFrame);
  updateXrInteraction();

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

  if ((renderEnabled || xr.session) && renderer.domElement.style.display !== "none") {
    renderer.render(scene, camera);
  }
});

window.addEventListener("beforeunload", () => {
  if (markerDetection.stream) {
    markerDetection.stream.getTracks().forEach((track) => track.stop());
  }
});
