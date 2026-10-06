import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { SparkRenderer, SplatMesh, SparkControls, utils } from "@sparkjsdev/spark";

const RENDER_TIMEOUT_MS = 5 * 1000;
const URL_BASE = ".";
const SPAWN_POSITION = new THREE.Vector3(0, 1.5, -3.9);
const MOVEMENT_RADIUS = 2;
const MARKER_SCAN_STORAGE_KEY = "sae501-marker-scanned";

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
function hasSavedMarkerScan() {
  try {
    return localStorage.getItem(MARKER_SCAN_STORAGE_KEY) === "true";
  } catch (error) {
    console.warn("Could not read saved marker state.", error);
    return false;
  }
}

const markerDetection = {
  enabled: false,
  locked: hasSavedMarkerScan(),
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
      markerImage.src = "./SCANNE.png";
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

const markerDetectionReady = setupMarkerDetection();

const sceneJson = await fetch(`${URL_BASE}/scene.json`).then((response) => response.json());
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
for (const mesh of meshes) {
  try {
    const gltf = await gltfLoader.loadAsync(`${URL_BASE}/${mesh.filename}`);
    const model = gltf.scene;
    convertToBasicMaterials(model);

    model.position.fromArray(mesh.transform?.translation ?? [0, 0, 0]);
    model.quaternion.fromArray(mesh.transform?.quaternion ?? [0, 0, 0, 1]);
    const meshScale = mesh.transform?.scale ?? [1, 1, 1];
    model.scale.set(meshScale[0], meshScale[1], meshScale[2]);
    scene.add(model);
  } catch (error) {
    console.warn(`Failed to load mesh: ${mesh.filename}`, error);
  }
}

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

function updateMovement() {
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

let lastTime = 0;
let rotation = 0;
let xrTime = 0;
let lastMarkerCheck = 0;

document.addEventListener("keydown", (event) => {
  if (event.key === "\\") {
    const cameraPos = camera.getWorldPosition(new THREE.Vector3());
    const cameraQuat = camera.getWorldQuaternion(new THREE.Quaternion());
    console.log("camera position: ", JSON.stringify(cameraPos.toArray()), "quaternion: ", JSON.stringify(cameraQuat.toArray()));
  }
});

renderer.setAnimationLoop(function animate(time, xrFrame) {
  const deltaTime = time - (lastTime || time);
  lastTime = time;

  if (markerDetection.enabled && time - lastMarkerCheck >= 150) {
    lastMarkerCheck = time;
    const markerFound = detectMarkerFrame();

    if (markerFound) {
      markerDetection.locked = true;
      markerDetection.enabled = false;
      try {
        localStorage.setItem(MARKER_SCAN_STORAGE_KEY, "true");
      } catch (error) {
        console.warn("Could not save marker state for the next visit.", error);
      }
      renderer.setClearAlpha(0);
      setWorldVisible(true);
    } else {
      setWorldVisible(false);
    }
  }

  if (markerDetection.locked && !renderEnabled) {
    renderEnabled = true;
    lastMoved = performance.now();
  }

  controls.update(localFrame, camera);
  updateMovement();

  const now = performance.now();
  const dir = localFrame.getWorldDirection(new THREE.Vector3());
  if ((localFrame.position.distanceTo(lastPos) > 0.0001) || (dir.dot(lastDir) < 0.9999)) {
    lastMoved = now;
    renderEnabled = true;
    lastPos.copy(localFrame.position);
    lastDir.copy(dir);
  }
  if ((now - lastMoved) > RENDER_TIMEOUT_MS) {
    renderEnabled = false;
  }

  if (renderEnabled && renderer.domElement.style.display !== "none") {
    renderer.render(scene, camera);
  }
});

window.addEventListener("beforeunload", () => {
  if (markerDetection.stream) {
    markerDetection.stream.getTracks().forEach((track) => track.stop());
  }
});
