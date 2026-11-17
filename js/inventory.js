import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

const ITEM_MODELS = {
  "corsica-map": "./assets/models/Carte.glb",
  rope: "./assets/models/Corde.glb",
};

export function createInventorySystem({
  THREE,
  dracoLoader,
  camera,
  renderer,
  panel,
  toggleButton,
  closeButton,
  bagStatus,
  itemButtons,
  onSelectItem = () => false,
}) {
  const availableItems = new Set();
  const gltfLoader = new GLTFLoader();
  const inventoryDracoLoader = dracoLoader ?? new DRACOLoader();
  if (!dracoLoader) {
    inventoryDracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
  }
  gltfLoader.setDRACOLoader(inventoryDracoLoader);
  let bagOwned = false;
  let opened = false;
  let pcActive = false;

  const desktopPreviewScene = new THREE.Scene();
  const desktopPreviewCamera = new THREE.PerspectiveCamera(32, 1, 0.01, 20);
  desktopPreviewCamera.position.set(0, 0, 3.1);
  desktopPreviewScene.add(new THREE.AmbientLight(0xffffff, 1.8));
  const previewKeyLight = new THREE.DirectionalLight(0xffffff, 2.4);
  previewKeyLight.position.set(-2, 3, 4);
  desktopPreviewScene.add(previewKeyLight);
  const desktopPreviewModels = new Map();
  const previewCanvas = document.createElement("canvas");
  previewCanvas.className = "inventory-preview-canvas";
  previewCanvas.setAttribute("aria-hidden", "true");
  document.body.append(previewCanvas);
  const previewRenderer = new THREE.WebGLRenderer({ canvas: previewCanvas, alpha: true, antialias: true });
  previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  previewRenderer.setSize(window.innerWidth, window.innerHeight, false);
  previewRenderer.setClearColor(0x000000, 0);
  previewRenderer.outputColorSpace = THREE.SRGBColorSpace;
  previewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  previewRenderer.toneMappingExposure = 1.15;

  const vrPanel = new THREE.Group();
  vrPanel.name = "aldila-vr-inventory";
  vrPanel.visible = false;
  vrPanel.position.set(0, 0, -1.2);
  vrPanel.scale.setScalar(1.2);
  camera.add(vrPanel);

  const vrToggle = new THREE.Group();
  vrToggle.name = "aldila-vr-inventory-toggle";
  vrToggle.position.set(0, -0.58, -1.05);
  camera.add(vrToggle);
  const vrToggleButton = new THREE.Mesh(
    new THREE.PlaneGeometry(0.46, 0.16),
    new THREE.MeshBasicMaterial({
      color: 0x171512,
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    })
  );
  vrToggleButton.userData.inventoryAction = "inventory-toggle";
  vrToggleButton.renderOrder = 1005;
  vrToggle.add(vrToggleButton);
  const vrToggleLabel = new THREE.Mesh(
    new THREE.PlaneGeometry(0.42, 0.11),
    new THREE.MeshBasicMaterial({
      map: makeLabel("Pincer · inventaire"),
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    })
  );
  vrToggleLabel.position.z = 0.003;
  vrToggleLabel.renderOrder = 1006;
  vrToggle.add(vrToggleLabel);

  const interactiveModels = [];
  const buttonViews = new Map();
  vrToggle.visible = false;
  interactiveModels.push({
    model: vrToggleButton,
    highlight: new THREE.Object3D(),
    bounds: new THREE.Box3(
      new THREE.Vector3(-0.23, -0.08, -0.01),
      new THREE.Vector3(0.23, 0.08, 0.01)
    ),
  });

  function makeLabel(text) {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#eee8df";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = "italic 52px Georgia, serif";
    context.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width - 20);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  function makeButton(key, label, x) {
    const button = new THREE.Mesh(
      new THREE.PlaneGeometry(0.76, 1.06),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      })
    );
    button.position.set(x, -0.02, 0.02);
    button.userData.inventoryAction = key;
    button.renderOrder = 1001;

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xe5ddd1,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.0017, 4, 96), ringMaterial);
    ring.position.set(x, 0.13, 0.035);
    ring.scale.y = 0.78;
    ring.renderOrder = 1003;
    vrPanel.add(ring);

    const labelMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.7, 0.14),
      new THREE.MeshBasicMaterial({
        map: makeLabel(label),
        transparent: true,
        opacity: 0.68,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      })
    );
    labelMesh.position.set(x, -0.4, 0.035);
    labelMesh.renderOrder = 1003;
    vrPanel.add(labelMesh);

    const ruleMaterial = new THREE.LineBasicMaterial({
      color: 0xe5ddd1,
      transparent: true,
      opacity: 0.48,
      depthTest: false,
    });
    const rule = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x - 0.31, -0.51, 0.035),
        new THREE.Vector3(x - 0.04, -0.51, 0.035),
        new THREE.Vector3(x + 0.04, -0.51, 0.035),
        new THREE.Vector3(x + 0.31, -0.51, 0.035),
      ]),
      ruleMaterial
    );
    rule.renderOrder = 1003;
    vrPanel.add(rule);

    const diamond = new THREE.Mesh(
      new THREE.PlaneGeometry(0.025, 0.025),
      new THREE.MeshBasicMaterial({ color: 0xe5ddd1, side: THREE.DoubleSide, depthTest: false })
    );
    diamond.position.set(x, -0.51, 0.038);
    diamond.rotation.z = Math.PI / 4;
    diamond.renderOrder = 1004;
    vrPanel.add(diamond);

    vrPanel.add(button);
    button.visible = false;
    buttonViews.set(key, { button, ringMaterial, labelMaterial: labelMesh.material, ruleMaterial });
    interactiveModels.push({
      model: button,
      highlight: new THREE.Object3D(),
      bounds: new THREE.Box3(
        new THREE.Vector3(-0.38, -0.53, -0.01),
        new THREE.Vector3(0.38, 0.53, 0.01)
      ),
    });
  }

  makeButton("corsica-map", "Carte de Corse", -0.47);
  makeButton("rope", "Corde", 0.47);

  function normalizeModel(model, maxSize, orientForScreen = false) {
    model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const scale = maxSize / Math.max(size.x, size.y, size.z, 0.001);
    model.scale.setScalar(scale);
    model.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
    // These props are authored lying flat; tilt them toward the desktop camera.
    if (orientForScreen && size.y < Math.max(size.x, size.z) * 0.25) {
      model.rotation.x = -Math.PI / 2;
    }
    model.traverse((child) => {
      if (!child.isMesh) return;
      child.material = Array.isArray(child.material)
        ? child.material.map((material) => material.clone())
        : child.material.clone();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (orientForScreen) material.side = THREE.DoubleSide;
        material.userData.inventoryOriginalOpacity = material.opacity;
        material.userData.inventoryOriginalTransparent = material.transparent;
      }
    });
    return model;
  }

  function setPreviewAvailability(key, model) {
    const available = availableItems.has(key);
    model.traverse((child) => {
      if (!child.isMesh) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        material.opacity = available ? material.userData.inventoryOriginalOpacity : 0.58;
        material.transparent = available || material.userData.inventoryOriginalTransparent
          ? material.userData.inventoryOriginalTransparent
          : true;
        material.needsUpdate = true;
      }
    });
  }

  async function loadVrPreview(key, x) {
    try {
      const loaded = await gltfLoader.loadAsync(ITEM_MODELS[key]);
      const source = loaded.scene;
      const desktopModel = normalizeModel(source.clone(true), 1.55, true);
      desktopPreviewScene.add(desktopModel);
      desktopPreviewModels.set(key, desktopModel);
      setPreviewAvailability(key, desktopModel);

      const model = normalizeModel(source.clone(true), 0.56);
      model.position.add(new THREE.Vector3(x, 0.13, 0.065));
      model.traverse((child) => { if (child.isMesh) child.renderOrder = 1004; });
      vrPanel.add(model);
    } catch (error) {
      console.warn(`Aperçu 3D indisponible pour ${key}.`, error);
    }
  }

  void Promise.all([
    loadVrPreview("corsica-map", -0.47),
    loadVrPreview("rope", 0.47),
  ]);

  function syncView() {
    const xrActive = renderer.xr.isPresenting;
    vrPanel.visible = opened && bagOwned && xrActive;
    vrToggle.visible = bagOwned && xrActive;
    vrToggleButton.visible = vrToggle.visible;
    for (const { button } of buttonViews.values()) button.visible = vrPanel.visible;
    if (panel) panel.hidden = !opened || !bagOwned || xrActive;
    if (toggleButton) {
      toggleButton.hidden = xrActive || !pcActive || !bagOwned;
      toggleButton.setAttribute("aria-expanded", String(opened));
      toggleButton.setAttribute("aria-label", opened ? "Fermer l’inventaire" : "Ouvrir l’inventaire");
    }
    document.body.classList.toggle("inventory-open", opened && bagOwned && !xrActive);
  }

  function refresh() {
    if (bagStatus) bagStatus.textContent = bagOwned ? "Sacoche portée" : "Sacoche au sol";
    for (const [key, button] of itemButtons) {
      const usable = availableItems.has(key);
      button.disabled = !usable;
      button.setAttribute("aria-disabled", String(!usable));
      button.classList.toggle("is-available", usable);
    }
    for (const [key, view] of buttonViews) {
      const usable = availableItems.has(key);
      view.ringMaterial.opacity = usable ? 0.78 : 0.38;
      view.labelMaterial.opacity = usable ? 1 : 0.62;
      view.ruleMaterial.opacity = usable ? 0.78 : 0.4;
      const model = desktopPreviewModels.get(key);
      if (model) setPreviewAvailability(key, model);
    }
    syncView();
  }

  function open() {
    if (!bagOwned || (!pcActive && !renderer.xr.isPresenting)) return;
    opened = true;
    syncView();
  }

  function close() {
    opened = false;
    syncView();
  }

  function toggle() {
    if (opened) close();
    else open();
  }

  function renderDesktopPreviews() {
    const visible = opened && bagOwned && pcActive && !renderer.xr.isPresenting;
    previewCanvas.style.display = visible ? "block" : "none";
    if (!visible || desktopPreviewModels.size === 0) return;

    const canvasBounds = previewCanvas.getBoundingClientRect();
    if (!canvasBounds.width || !canvasBounds.height) return;
    previewRenderer.setScissorTest(true);

    for (const [key, model] of desktopPreviewModels) {
      const art = itemButtons.get(key)?.querySelector(".inventory-art");
      if (!art) continue;
      const bounds = art.getBoundingClientRect();
      const left = bounds.left - canvasBounds.left;
      const bottom = canvasBounds.bottom - bounds.bottom;
      desktopPreviewCamera.aspect = bounds.width / Math.max(bounds.height, 1);
      desktopPreviewCamera.updateProjectionMatrix();
      previewRenderer.setViewport(left, bottom, bounds.width, bounds.height);
      previewRenderer.setScissor(left, bottom, bounds.width, bounds.height);
      previewRenderer.clear(true, true, true);
      for (const [otherKey, otherModel] of desktopPreviewModels) {
        otherModel.visible = otherKey === key;
      }
      model.rotation.y += 0.0018;
      previewRenderer.render(desktopPreviewScene, desktopPreviewCamera);
    }
    for (const model of desktopPreviewModels.values()) model.visible = true;
    previewRenderer.setScissorTest(false);
  }

  function select(key) {
    if (key === "inventory-toggle") {
      toggle();
      return true;
    }
    if (!availableItems.has(key)) return false;
    const accepted = onSelectItem(key);
    if (accepted === false) return false;
    close();
    if (accepted && typeof accepted.then === "function") void accepted;
    return true;
  }

  for (const [key, button] of itemButtons) button.addEventListener("click", () => select(key));
  toggleButton?.addEventListener("click", toggle);
  closeButton?.addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() !== "i" || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
    event.preventDefault();
    toggle();
  });

  refresh();
  renderer.xr.addEventListener("sessionstart", syncView);
  renderer.xr.addEventListener("sessionend", syncView);

  return {
    toggle,
    open,
    close,
    select,
    refresh,
    setPcActive(value) {
      pcActive = Boolean(value);
      if (!pcActive && !renderer.xr.isPresenting) close();
      syncView();
    },
    isAction: (model) => Boolean(model?.userData?.inventoryAction)
      && renderer.xr.isPresenting
      && bagOwned
      && (model.userData.inventoryAction === "inventory-toggle" || opened),
    setBagOwned(value) {
      bagOwned = Boolean(value);
      refresh();
      if (!bagOwned) close();
    },
    setAvailableItems(items = []) {
      availableItems.clear();
      for (const item of items) availableItems.add(item);
      refresh();
    },
    getInteractiveModels: () => interactiveModels,
    renderDesktopPreviews,
    resizeDesktopPreviews() {
      previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      previewRenderer.setSize(window.innerWidth, window.innerHeight, false);
    },
  };
}
