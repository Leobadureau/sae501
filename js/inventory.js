import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const ITEM_ART = {
  "corsica-map": "./assets/images/inventory-map.svg",
  rope: "./assets/images/inventory-rope.svg",
};

const ITEM_MODELS = {
  "corsica-map": "./assets/models/Carte.glb",
  rope: "./assets/models/Corde.glb",
};

export function createInventorySystem({
  THREE,
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
  const textureLoader = new THREE.TextureLoader();
  const gltfLoader = new GLTFLoader();
  const itemArtTextures = new Map();
  let bagOwned = false;
  let opened = false;
  let pcActive = false;

  const vrPanel = new THREE.Group();
  vrPanel.name = "aldila-vr-inventory";
  vrPanel.visible = false;
  vrPanel.position.set(0, 0, -1.2);
  vrPanel.scale.setScalar(1.2);
  camera.add(vrPanel);

  const interactiveModels = [];
  const buttonViews = new Map();

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

  function getArtTexture(key) {
    if (!itemArtTextures.has(key)) {
      const texture = textureLoader.load(ITEM_ART[key]);
      texture.colorSpace = THREE.SRGBColorSpace;
      itemArtTextures.set(key, texture);
    }
    return itemArtTextures.get(key);
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

    const artMaterial = new THREE.MeshBasicMaterial({
      map: getArtTexture(key),
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    const art = new THREE.Mesh(new THREE.PlaneGeometry(0.58, 0.42), artMaterial);
    art.position.set(x, 0.13, 0.03);
    art.renderOrder = 1002;
    vrPanel.add(art);

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
    buttonViews.set(key, { button, art, artMaterial, ringMaterial, labelMaterial: labelMesh.material, ruleMaterial });
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

  async function loadVrPreview(key, x) {
    try {
      const loaded = await gltfLoader.loadAsync(ITEM_MODELS[key]);
      const model = loaded.scene;
      model.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(model);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const scale = 0.56 / Math.max(size.x, size.y, size.z, 0.001);
      model.scale.setScalar(scale);
      model.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
      model.position.add(new THREE.Vector3(x, 0.13, 0.065));
      model.traverse((child) => {
        if (!child.isMesh) return;
        child.material = Array.isArray(child.material)
          ? child.material.map((material) => material.clone())
          : child.material.clone();
        child.renderOrder = 1004;
      });
      vrPanel.add(model);
      const view = buttonViews.get(key);
      if (view) view.art.visible = false;
    } catch (error) {
      console.warn(`Aperçu VR indisponible pour ${key}.`, error);
    }
  }

  void Promise.all([
    loadVrPreview("corsica-map", -0.47),
    loadVrPreview("rope", 0.47),
  ]);

  function syncView() {
    const xrActive = renderer.xr.isPresenting;
    vrPanel.visible = opened && bagOwned && xrActive;
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
      const opacity = usable ? 1 : 0.58;
      view.artMaterial.opacity = opacity;
      view.ringMaterial.opacity = usable ? 0.78 : 0.38;
      view.labelMaterial.opacity = usable ? 1 : 0.62;
      view.ruleMaterial.opacity = usable ? 0.78 : 0.4;
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

  function select(key) {
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
      && opened
      && renderer.xr.isPresenting,
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
  };
}
