import { XRHandModelFactory } from "three/addons/webxr/XRHandModelFactory.js";

const XR_HOVER_INTERVAL_MS = 50;

export function createInteractionSystem({
  THREE,
  renderer,
  camera,
  localFrame,
  controls,
  interactiveModels,
  modelsRevealedByGrab,
  unlockAudio,
  revealModel,
  convertMaterials,
  isModelAction = () => false,
  onModelActivate = () => {},
  onInventoryToggle = () => {},
}) {
  const raycaster = new THREE.Raycaster();
  raycaster.far = 10;
  const pointer = new THREE.Vector2();
  const localRay = new THREE.Ray();
  const inverseMatrix = new THREE.Matrix4();
  const hitPoint = new THREE.Vector3();
  const grabPlane = new THREE.Plane();
  const grabPlaneHit = new THREE.Vector3();
  const controllers = [];
  const palmGestureStates = Array.from({ length: 2 }, () => ({ openSince: null, latched: false }));
  let pointerStart = null;
  let pointerGrab = null;
  let hoveredModel = null;
  let selectedModel = null;
  let defaultRotateSpeed = null;
  let lastHoverUpdate = -Infinity;
  let lastPalmGestureCheck = -Infinity;
  let lastPalmToggle = -Infinity;

  function findInteractiveHitAtRay() {
    let closestMeshHit = null;
    let closestMeshDistance = raycaster.far;

    for (const { model } of interactiveModels) {
      if (!model.visible || !isModelAction(model)) continue;
      model.updateWorldMatrix(true, true);
      const intersections = raycaster.intersectObject(model, true);
      const hit = intersections.find((intersection) =>
        intersection.distance >= raycaster.near
        && intersection.distance <= closestMeshDistance
      );
      if (!hit) continue;
      closestMeshDistance = hit.distance;
      closestMeshHit = { model, point: hit.point.clone() };
    }
    if (closestMeshHit) return closestMeshHit;

    let closestHit = null;
    let closestDistance = raycaster.far;

    for (const { model, bounds } of interactiveModels) {
      if (!model.visible) continue;
      model.updateWorldMatrix(true, false);
      inverseMatrix.copy(model.matrixWorld).invert();
      localRay.copy(raycaster.ray).applyMatrix4(inverseMatrix);
      if (!localRay.intersectBox(bounds, hitPoint)) continue;
      hitPoint.applyMatrix4(model.matrixWorld);
      const distance = raycaster.ray.origin.distanceTo(hitPoint);
      if (distance < raycaster.near || distance > closestDistance) continue;
      closestDistance = distance;
      closestHit = { model, point: hitPoint.clone() };
    }
    return closestHit;
  }

  function findPointerHit(event) {
    const bounds = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    camera.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
    return findInteractiveHitAtRay();
  }

  function findControllerHit(controller) {
    controller.updateWorldMatrix(true, false);
    const origin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
    const direction = new THREE.Vector3(0, 0, -1).transformDirection(controller.matrixWorld);
    raycaster.set(origin, direction);
    return findInteractiveHitAtRay();
  }

  function updateHighlights() {
    for (const { model, highlight } of interactiveModels) {
      highlight.visible = model.visible && (model === hoveredModel || model === selectedModel);
      if (!highlight.visible) continue;
      model.updateWorldMatrix(true, true);
      highlight.update();
    }
  }

  function revealModelsFor(model) {
    unlockAudio();
    for (const revealed of modelsRevealedByGrab.get(model.userData.filename) ?? []) {
      revealModel(revealed, model);
    }
  }

  function beginPointerGrab(event, hit) {
    camera.getWorldDirection(grabPlane.normal);
    grabPlane.setFromNormalAndCoplanarPoint(grabPlane.normal, hit.point);
    const worldPosition = hit.model.getWorldPosition(new THREE.Vector3());
    pointerGrab = {
      pointerId: event.pointerId,
      model: hit.model,
      offset: worldPosition.sub(hit.point),
      start: { x: event.clientX, y: event.clientY },
    };
    revealModelsFor(hit.model);
    selectedModel = hit.model;
    hoveredModel = hit.model;
    updateHighlights();
    renderer.domElement.setPointerCapture(event.pointerId);
  }

  function updatePointerGrab(event) {
    if (!pointerGrab) return false;
    const bounds = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    camera.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
    if (!raycaster.ray.intersectPlane(grabPlane, grabPlaneHit)) return true;

    const parent = pointerGrab.model.parent;
    parent.updateWorldMatrix(true, false);
    pointerGrab.model.position.copy(parent.worldToLocal(grabPlaneHit.clone().add(pointerGrab.offset)));
    pointerGrab.model.updateWorldMatrix(true, true);
    return true;
  }

  function endPointerGrab() {
    if (!pointerGrab) return;
    pointerGrab = null;
    updateHighlights();
  }

  function toggleSelection(model) {
    selectedModel = model === selectedModel ? null : model;
    hoveredModel = model;
    updateHighlights();
  }

  function beginControllerGrab(interactionController, hit = findControllerHit(interactionController.controller)) {
    if (!hit) return;
    interactionController.grabbed = {
      model: hit.model,
      localPosition: new THREE.Vector3(0, 0, -0.08),
      localQuaternion: new THREE.Quaternion(),
    };
    revealModelsFor(hit.model);
    selectedModel = hit.model;
    hoveredModel = hit.model;
    updateHighlights();
  }

  function toggleControllerGrab(interactionController) {
    if (interactionController.grabbed) interactionController.grabbed = null;
    else beginControllerGrab(interactionController);
  }

  function updateControllerGrab(interactionController) {
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

  for (let index = 0; index < 2; index += 1) {
    const controller = renderer.xr.getController(index);
    const ray = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: 0x65e6c5, transparent: true, opacity: 0.85 })
    );
    ray.scale.z = 10;
    ray.visible = false;
    controller.add(ray);

    const interactionController = { controller, ray, connected: false, handInput: false, grabbed: null };
    controller.addEventListener("connected", (event) => {
      interactionController.connected = true;
      interactionController.handInput = Boolean(event.data?.hand);
    });
    controller.addEventListener("disconnected", () => {
      interactionController.connected = false;
      interactionController.handInput = false;
      ray.visible = false;
      interactionController.grabbed = null;
    });
    controller.addEventListener("squeezestart", () => {
      unlockAudio();
      onInventoryToggle(controller);
    });
    controller.addEventListener("select", () => {
      if (interactionController.handInput) return;
      const hit = findControllerHit(controller);
      if (hit && isModelAction(hit.model)) {
        unlockAudio();
        onModelActivate(hit.model, controller);
        return;
      }
      toggleControllerGrab(interactionController);
    });
    localFrame.add(controller);
    controllers.push(interactionController);
  }

  const handModelFactory = new XRHandModelFactory(
    null,
    (handModel) => convertMaterials(handModel)
  );
  for (let index = 0; index < 2; index += 1) {
    const hand = renderer.xr.getHand(index);
    hand.add(handModelFactory.createHandModel(hand, "mesh"));
    localFrame.add(hand);
    const interactionController = controllers[index];
    hand.addEventListener("pinchend", () => {
      interactionController.grabbed = null;
    });
    hand.addEventListener("pinchstart", () => {
      if (!renderer.xr.isPresenting) return;
      const hit = findControllerHit(interactionController.controller);
      if (!hit) return;
      unlockAudio();
      if (isModelAction(hit.model)) onModelActivate(hit.model, interactionController.controller);
      else beginControllerGrab(interactionController, hit);
    });
  }

  renderer.domElement.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const hit = findPointerHit(event);
    pointerStart = { x: event.clientX, y: event.clientY, model: hit?.model ?? null };
    if (!hit) return;
    if (isModelAction(hit.model)) {
      pointerStart = null;
      unlockAudio();
      onModelActivate(hit.model);
      return;
    }
    defaultRotateSpeed ??= controls.pointerControls.rotateSpeed;
    beginPointerGrab(event, hit);
    controls.pointerControls.rotateSpeed = 0;
  });

  renderer.domElement.addEventListener("pointermove", (event) => {
    if (updatePointerGrab(event)) return;
    hoveredModel = findPointerHit(event)?.model ?? null;
    renderer.domElement.style.cursor = hoveredModel ? "pointer" : "";
    updateHighlights();
  });

  renderer.domElement.addEventListener("pointerup", (event) => {
    if (event.button !== 0) return;
    const wasGrabbing = pointerGrab !== null;
    if (defaultRotateSpeed !== null) controls.pointerControls.rotateSpeed = defaultRotateSpeed;
    endPointerGrab();
    if (!pointerStart) return;

    const distance = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
    const startModel = pointerStart.model;
    pointerStart = null;
    if (wasGrabbing || distance > 6) return;
    const model = findPointerHit(event)?.model ?? null;
    if (model !== startModel || !model) return;
    if (isModelAction(model)) onModelActivate(model);
    else toggleSelection(model);
  });

  renderer.domElement.addEventListener("pointerleave", () => {
    pointerStart = null;
    if (defaultRotateSpeed !== null) controls.pointerControls.rotateSpeed = defaultRotateSpeed;
    endPointerGrab();
    hoveredModel = null;
    renderer.domElement.style.cursor = "";
    updateHighlights();
  });

  renderer.domElement.addEventListener("pointercancel", () => {
    pointerStart = null;
    if (defaultRotateSpeed !== null) controls.pointerControls.rotateSpeed = defaultRotateSpeed;
    endPointerGrab();
  });

  window.addEventListener("blur", () => {
    pointerStart = null;
    if (defaultRotateSpeed !== null) controls.pointerControls.rotateSpeed = defaultRotateSpeed;
    endPointerGrab();
  });

  function isOpenPalmFacingViewer(hand, viewerPosition) {
    const joints = hand.joints;
    const wrist = joints?.wrist;
    const thumbTip = joints?.["thumb-tip"];
    const indexMetacarpal = joints?.["index-finger-metacarpal"];
    if (!wrist?.visible || !thumbTip?.visible || !indexMetacarpal?.visible) return false;

    hand.updateWorldMatrix(true, true);
    const wristPosition = wrist.getWorldPosition(new THREE.Vector3());
    const wristQuaternion = wrist.getWorldQuaternion(new THREE.Quaternion());
    const palmNormal = new THREE.Vector3(0, -1, 0).applyQuaternion(wristQuaternion).normalize();
    const towardViewer = viewerPosition.clone().sub(wristPosition).normalize();
    if (palmNormal.dot(towardViewer) < 0.65) return false;

    const extensionThresholds = [
      ["index-finger-tip", 0.15],
      ["middle-finger-tip", 0.16],
      ["ring-finger-tip", 0.15],
      ["pinky-finger-tip", 0.13],
    ];
    for (const [jointName, minimumDistance] of extensionThresholds) {
      const tip = joints[jointName];
      if (!tip?.visible || tip.getWorldPosition(new THREE.Vector3()).distanceTo(wristPosition) < minimumDistance) {
        return false;
      }
    }

    const thumbPosition = thumbTip.getWorldPosition(new THREE.Vector3());
    const indexBasePosition = indexMetacarpal.getWorldPosition(new THREE.Vector3());
    return thumbPosition.distanceTo(indexBasePosition) > 0.065;
  }

  function updatePalmGesture(time, xrFrame) {
    if (time - lastPalmGestureCheck < 100) return;
    lastPalmGestureCheck = time;

    const referenceSpace = renderer.xr.getReferenceSpace();
    const viewerPose = referenceSpace && xrFrame?.getViewerPose(referenceSpace);
    if (!viewerPose) {
      for (const state of palmGestureStates) {
        state.openSince = null;
        state.latched = false;
      }
      return;
    }

    localFrame.updateWorldMatrix(true, false);
    const viewerPosition = new THREE.Vector3(
      viewerPose.transform.position.x,
      viewerPose.transform.position.y,
      viewerPose.transform.position.z
    ).applyMatrix4(localFrame.matrixWorld);

    for (let index = 0; index < palmGestureStates.length; index += 1) {
      const state = palmGestureStates[index];
      const hand = renderer.xr.getHand(index);
      const interactionController = controllers[index];
      const openPalm = renderer.xr.isPresenting
        && interactionController.handInput
        && hand.visible
        && !hand.inputState?.pinching
        && !interactionController.grabbed
        && isOpenPalmFacingViewer(hand, viewerPosition);

      if (!openPalm) {
        state.openSince = null;
        state.latched = false;
        continue;
      }
      if (state.latched) continue;
      state.openSince ??= time;
      if (time - state.openSince < 650) continue;

      state.latched = true;
      if (time - lastPalmToggle < 1000) continue;
      lastPalmToggle = time;
      unlockAudio();
      onInventoryToggle(hand);
    }
  }

  function updateXrInteraction(time, xrFrame) {
    if (!renderer.xr.isPresenting) {
      for (const interactionController of controllers) {
        interactionController.ray.visible = false;
        interactionController.grabbed = null;
      }
      for (const state of palmGestureStates) {
        state.openSince = null;
        state.latched = false;
      }
      return;
    }

    updatePalmGesture(time, xrFrame);

    let nextHoveredModel = null;
    const updateHover = time - lastHoverUpdate >= XR_HOVER_INTERVAL_MS;
    for (const interactionController of controllers) {
      const { controller, ray, connected } = interactionController;
      ray.visible = connected;
      if (!connected) continue;
      if (interactionController.handInput) {
        updateControllerGrab(interactionController);
        continue;
      }
      updateControllerGrab(interactionController);
      if (updateHover && !nextHoveredModel) {
        nextHoveredModel = findControllerHit(controller)?.model ?? null;
      }
    }
    if (updateHover) {
      lastHoverUpdate = time;
      hoveredModel = nextHoveredModel;
      updateHighlights();
    }
  }

  return {
    controllers,
    updateHighlights,
    updateXrInteraction,
    resetHoverTimer() {
      lastHoverUpdate = -Infinity;
    },
  };
}
