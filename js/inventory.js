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
  let bagOwned = false;
  let opened = false;
  let pcActive = false;

  const vrPanel = new THREE.Group();
  vrPanel.name = "aldila-vr-inventory";
  vrPanel.visible = false;
  vrPanel.position.set(0, 0, -1.05);
  camera.add(vrPanel);

  const interactiveModels = [];
  const buttonViews = new Map();

  function makeLabel(text, width = 512, height = 128, small = false) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#eee5d8";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `${small ? "26px" : "36px"} Georgia, serif`;
    context.letterSpacing = "5px";
    context.fillText(text, width / 2, height / 2, width - 32);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  function makeButton(key, label, y) {
    const button = new THREE.Mesh(
      new THREE.PlaneGeometry(0.78, 0.2),
      new THREE.MeshBasicMaterial({
        color: 0x292622,
        transparent: true,
        opacity: 0.96,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      })
    );
    button.position.set(0, y, 0.004);
    button.renderOrder = 1001;
    button.userData.inventoryAction = key;

    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(0.78, 0.2)),
      new THREE.LineBasicMaterial({ color: 0xc8bba8, transparent: true, opacity: 0.7, depthTest: false })
    );
    border.position.z = 0.006;
    border.renderOrder = 1002;
    const text = new THREE.Mesh(
      new THREE.PlaneGeometry(0.54, 0.16),
      new THREE.MeshBasicMaterial({
        map: makeLabel(label),
        transparent: true,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      })
    );
    text.position.set(0.11, 0, 0.008);
    text.renderOrder = 1003;
    const iconMaterial = new THREE.MeshBasicMaterial({ color: 0xeee5d8, side: THREE.DoubleSide, depthTest: false });
    if (key === "corsica-map") {
      const shape = new THREE.Shape();
      shape.moveTo(0.012, 0.068);
      shape.quadraticCurveTo(0.048, 0.053, 0.037, 0.027);
      shape.lineTo(0.052, 0.006);
      shape.lineTo(0.028, -0.014);
      shape.lineTo(0.02, -0.052);
      shape.lineTo(-0.012, -0.071);
      shape.lineTo(-0.024, -0.038);
      shape.lineTo(-0.045, -0.018);
      shape.lineTo(-0.029, 0.014);
      shape.lineTo(-0.037, 0.037);
      shape.lineTo(-0.012, 0.057);
      shape.closePath();
      const island = new THREE.Mesh(new THREE.ShapeGeometry(shape), iconMaterial);
      island.position.set(-0.27, 0, 0.012);
      island.renderOrder = 1004;
      button.add(island);
    } else {
      for (let index = 0; index < 3; index += 1) {
        const loop = new THREE.Mesh(new THREE.TorusGeometry(0.034, 0.006, 6, 20), iconMaterial);
        loop.position.set(-0.29 + index * 0.024, 0, 0.012 + index * 0.001);
        loop.rotation.z = index * 0.12;
        loop.renderOrder = 1004 + index;
        button.add(loop);
      }
    }
    button.add(border, text);
    vrPanel.add(button);
    buttonViews.set(key, { button, border, text, iconMaterial });
    interactiveModels.push({
      model: button,
      highlight: new THREE.Object3D(),
      bounds: new THREE.Box3(
        new THREE.Vector3(-0.39, -0.1, -0.002),
        new THREE.Vector3(0.39, 0.1, 0.012)
      ),
    });
  }

  const backing = new THREE.Mesh(
    new THREE.PlaneGeometry(0.94, 0.78),
    new THREE.MeshBasicMaterial({
      color: 0x11100f,
      transparent: true,
      opacity: 0.96,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    })
  );
  backing.renderOrder = 1000;
  vrPanel.add(backing);

  const title = new THREE.Mesh(
    new THREE.PlaneGeometry(0.74, 0.11),
    new THREE.MeshBasicMaterial({
      map: makeLabel("INVENTAIRE", 512, 128, true),
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    })
  );
  title.position.set(0, 0.27, 0.003);
  title.renderOrder = 1001;
  vrPanel.add(title);

  const vrHint = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.07),
    new THREE.MeshBasicMaterial({
      map: makeLabel("GRIP · FERMER", 512, 128, true),
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    })
  );
  vrHint.position.set(0, -0.32, 0.003);
  vrHint.renderOrder = 1001;
  vrPanel.add(vrHint);

  const closeButtonMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.14, 0.14),
    new THREE.MeshBasicMaterial({
      map: makeLabel("×", 128, 128),
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    })
  );
  closeButtonMesh.position.set(0.38, 0.3, 0.006);
  closeButtonMesh.renderOrder = 1002;
  closeButtonMesh.userData.inventoryAction = "close";
  vrPanel.add(closeButtonMesh);
  interactiveModels.push({
    model: closeButtonMesh,
    highlight: new THREE.Object3D(),
    bounds: new THREE.Box3(new THREE.Vector3(-0.07, -0.07, -0.002), new THREE.Vector3(0.07, 0.07, 0.01)),
  });

  makeButton("corsica-map", "CARTE DE CORSE", 0.08);
  makeButton("rope", "CORDE", -0.17);

  function refresh() {
    if (bagStatus) bagStatus.textContent = bagOwned ? "Sacoche · portée" : "Sacoche · au sol";
    for (const [key, button] of itemButtons) {
      const usable = availableItems.has(key);
      button.disabled = !usable;
      button.setAttribute("aria-disabled", String(!usable));
      button.classList.toggle("is-available", usable);
    }
    for (const [key, view] of buttonViews) {
      const usable = availableItems.has(key);
      view.button.material.color.setHex(usable ? 0x292622 : 0x171615);
      view.button.material.opacity = usable ? 0.98 : 0.66;
      view.border.material.color.setHex(usable ? 0xc8bba8 : 0x77736d);
      view.border.material.opacity = usable ? 0.82 : 0.35;
      view.text.material.opacity = usable ? 1 : 0.45;
      view.iconMaterial.color.setHex(usable ? 0xeee5d8 : 0x7e7a74);
    }
  }

  function syncView() {
    const xrActive = renderer.xr.isPresenting;
    vrPanel.visible = opened && xrActive;
    for (const { button } of buttonViews.values()) button.visible = vrPanel.visible;
    closeButtonMesh.visible = vrPanel.visible;
    if (panel) panel.hidden = !opened || xrActive;
    if (toggleButton) toggleButton.hidden = xrActive || !pcActive;
    if (toggleButton) toggleButton.setAttribute("aria-expanded", String(opened));
  }

  function open() {
    if (!pcActive && !renderer.xr.isPresenting) return;
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
    if (key === "close") {
      close();
      return true;
    }
    if (!availableItems.has(key)) return false;
    const accepted = onSelectItem(key);
    if (accepted === false) return false;
    close();
    if (accepted && typeof accepted.then === "function") void accepted;
    return true;
  }

  for (const [key, button] of itemButtons) {
    button.addEventListener("click", () => select(key));
  }
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
  syncView();
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
    },
    setAvailableItems(items = []) {
      availableItems.clear();
      for (const item of items) availableItems.add(item);
      refresh();
    },
    getInteractiveModels: () => interactiveModels,
  };
}
