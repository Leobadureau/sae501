import * as THREE from "three";
import { SparkRenderer } from "@sparkjsdev/spark";

export const SPAWN_POSITION = new THREE.Vector3(0, 1.5, -3.9);
export const PC_CAMERA_HEIGHT_OFFSET = -0.15;
export const SEATED_CAMERA_POSITION = new THREE.Vector3(
  0.348,
  1.368,
  -5.438
);
export const SEATED_CAMERA_ROTATION = new THREE.Quaternion(
  -0.2423,
  -0.0436,
  -0.0109,
  0.9692
).normalize();
export const SEATED_MAX_LOOK_DOWN = THREE.MathUtils.degToRad(55);
export const SEATED_MAX_LOOK_UP = THREE.MathUtils.degToRad(75);
export const MOVEMENT_RADIUS = 2;

export const scene = new THREE.Scene();
export const movementPerimeter = new THREE.Mesh(
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

export const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.01,
  1000
);
export const audioListener = new THREE.AudioListener();
camera.add(audioListener);

export const renderer = new THREE.WebGLRenderer({ alpha: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
renderer.domElement.style.display = "none";

export const localFrame = new THREE.Group();
scene.add(localFrame);
localFrame.position.copy(SPAWN_POSITION);

const spark = new SparkRenderer({
  renderer,
  maxStdDev: Math.sqrt(5),
  enableLod: false,
});
scene.add(spark);
localFrame.add(camera);
