import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
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
renderer.setClearColor(0x000000, 1);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const localFrame = new THREE.Group();
scene.add(localFrame);
localFrame.position.copy(SPAWN_POSITION);

const spark = new SparkRenderer({
  renderer,
  maxStdDev: Math.sqrt(5),
});
scene.add(spark);
localFrame.add(camera);

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
let lastMoved = 0;
let lastPos = new THREE.Vector3().setScalar(Number.NEGATIVE_INFINITY);
let lastDir = new THREE.Vector3();

const controls = new SparkControls({
  canvas: renderer.domElement,
});
controls.pointerControls.reverseRotate = utils.isMobile();
controls.pointerControls.rotateSpeed *= 2.0;
controls.pointerControls.slideSpeed *= 0.75;

const motionButton = document.getElementById("motion-button");
const motionStatus = document.getElementById("motion-status");
let motionEnabled = false;
let referenceAlpha = null;
let referenceYaw = 0;
let hasOrientationData = false;
let sensorTimeoutId;

function updateDeviceOrientation(event) {
  if (!Number.isFinite(event.alpha)) return;
  if (!hasOrientationData) {
    referenceAlpha = event.alpha;
    referenceYaw = localFrame.rotation.y;
    hasOrientationData = true;
    motionStatus.textContent = "Tourne sur toi-même pour regarder autour de toi.";
    return;
  }

  const alphaDifference = ((event.alpha - referenceAlpha + 180) % 360 + 360) % 360 - 180;
  localFrame.rotation.y = referenceYaw - THREE.MathUtils.degToRad(alphaDifference);
}

motionButton.addEventListener("click", async () => {
  if (motionEnabled) {
    motionEnabled = false;
    window.removeEventListener("deviceorientation", updateDeviceOrientation, true);
    clearTimeout(sensorTimeoutId);
    controls.pointerControls.enable = true;
    motionButton.textContent = "Activer le regard gyroscopique";
    motionStatus.hidden = true;
    return;
  }

  const orientationEvent = window.DeviceOrientationEvent;
  if (!window.isSecureContext || !orientationEvent) {
    motionStatus.textContent = "Capteur de rotation indisponible sur ce navigateur.";
    motionStatus.hidden = false;
    return;
  }

  try {
    if (typeof orientationEvent.requestPermission === "function") {
      const permission = await orientationEvent.requestPermission();
      if (permission !== "granted") throw new Error("Permission refusée");
    }

    motionEnabled = true;
    referenceAlpha = null;
    hasOrientationData = false;
    controls.pointerControls.enable = false;
    motionButton.textContent = "Désactiver le regard gyroscopique";
    motionStatus.textContent = "Garde le téléphone face à la vue souhaitée pour le calibrer.";
    motionStatus.hidden = false;
    window.addEventListener("deviceorientation", updateDeviceOrientation, true);
    sensorTimeoutId = setTimeout(() => {
      if (!hasOrientationData) motionStatus.textContent = "Aucun capteur d’orientation détecté.";
    }, 2500);
  } catch (error) {
    motionStatus.textContent = "Autorise l’accès aux capteurs pour activer le mouvement.";
    motionStatus.hidden = false;
  }
});

let xrMovementCenter = null;
let xrMovementStart = null;
let xrMovementRotation = null;

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
  if (!xr.session) {
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
}

const xrButton = document.getElementById("vr-button");
const xrStatus = document.getElementById("xr-status");
const motionControl = document.getElementById("motion-control");

const xr = new SparkXr({
  renderer,
  mode: "ar",
  allowMobileXr: true,
  element: xrButton,
  onMouseLeaveOpacity: 0.5,
  onReady: (supported) => {
    console.log(`SparkXr initialized: XR ${supported ? "supported" : "not supported"}`);
    xrButton.hidden = !supported;
    motionControl.hidden = supported;
    xrStatus.hidden = supported;
    if (supported) xrButton.textContent = "Entrer en AR";
    if (!supported) xrStatus.textContent = "AR indisponible ici ; le regard gyroscopique reste disponible.";
  },
  onEnterXr: () => {
    renderEnabled = true;
    lastMoved = performance.now();
    if (motionEnabled) {
      motionEnabled = false;
      window.removeEventListener("deviceorientation", updateDeviceOrientation, true);
      clearTimeout(sensorTimeoutId);
      controls.pointerControls.enable = true;
      motionButton.textContent = "Activer le regard gyroscopique";
      motionStatus.hidden = true;
    }
    renderer.setClearAlpha(xr.mode === "immersive-ar" ? 0 : 1);
    xrButton.textContent = "Quitter AR";
    console.log("Enter XR");
  },
  onExitXr: () => {
    renderEnabled = true;
    lastMoved = performance.now();
    renderer.setClearAlpha(1);
    xrMovementCenter = null;
    xrMovementStart = null;
    xrMovementRotation = null;
    xrButton.textContent = "Entrer en AR";
    console.log("Exit XR");
  },
  controllers: {},
});

let lastTime = 0;
let rotation = 0;
let xrTime = 0;

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

  xr.updateControllers(camera);
  controls.update(localFrame, camera);
  updateMovement(xrFrame);

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

  if (renderEnabled || xr.session) {
    renderer.render(scene, camera);
  }
});
