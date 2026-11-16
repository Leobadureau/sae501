import * as THREE from "three";

function extractAlbedoProperties(material) {
  const color = material.color instanceof THREE.Color
    ? material.color.clone()
    : new THREE.Color(0x888888);
  return { color, map: material.map ?? null };
}

export function convertToBasicMaterials(object) {
  object.traverse((child) => {
    if (!child.isMesh) return;

    const originalMaterials = Array.isArray(child.material)
      ? child.material
      : [child.material];

    if (originalMaterials.length === 0) {
      child.material = new THREE.MeshBasicMaterial({
        color: 0x888888,
        side: THREE.DoubleSide,
      });
      return;
    }

    const materials = originalMaterials.map((material) => {
      const { color, map } = extractAlbedoProperties(material);
      return new THREE.MeshBasicMaterial({ color, map, side: THREE.DoubleSide });
    });
    child.material = materials.length === 1 ? materials[0] : materials;
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
  if (typeof image.decode === "function") await image.decode();
}

export async function waitForModelTextures(model) {
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
  if (!context) throw new Error("Unable to create the bag glow texture.");

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

export function addModelGlow(model) {
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
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture,
    color: 0xffffff,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  }));

  glow.position.copy(model.worldToLocal(center));
  glow.scale.set(
    Math.max(localSize.x * 2.4, localSize.y * 0.9),
    Math.max(localSize.y * 1.8, localSize.x * 1.4),
    1
  );
  glow.renderOrder = 1;
  model.add(glow);
}
