export function createXrTipsBanner(THREE, camera) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 220;

  const context = canvas.getContext("2d");
  if (!context) return null;

  function draw(message) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.shadowColor = "rgba(0, 0, 0, 0.55)";
    context.shadowBlur = 20;
    context.shadowOffsetY = 8;
    context.beginPath();
    context.moveTo(27, 13);
    context.lineTo(205, 9);
    context.lineTo(410, 13);
    context.lineTo(620, 8);
    context.lineTo(817, 13);
    context.lineTo(995, 10);
    context.lineTo(1006, 36);
    context.lineTo(1001, 85);
    context.lineTo(1007, 128);
    context.lineTo(1000, 183);
    context.lineTo(990, 207);
    context.lineTo(793, 211);
    context.lineTo(600, 205);
    context.lineTo(401, 212);
    context.lineTo(205, 206);
    context.lineTo(32, 211);
    context.lineTo(18, 188);
    context.lineTo(24, 141);
    context.lineTo(16, 91);
    context.lineTo(25, 45);
    context.closePath();

    const paper = context.createLinearGradient(0, 0, 0, canvas.height);
    paper.addColorStop(0, "#f1d5a5");
    paper.addColorStop(0.52, "#e3bd83");
    paper.addColorStop(1, "#c9955c");
    context.fillStyle = paper;
    context.fill();

    context.shadowColor = "transparent";
    context.shadowBlur = 0;
    context.shadowOffsetY = 0;
    context.strokeStyle = "rgba(83, 51, 28, 0.48)";
    context.lineWidth = 2;
    context.stroke();

    context.strokeStyle = "rgba(255, 239, 207, 0.48)";
    context.lineWidth = 1;
    context.strokeRect(38, 27, 948, 166);

    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#674426";
    context.font = '600 22px Georgia, "Times New Roman", serif';
    context.fillText("CONSEIL · GESTES VR", canvas.width / 2, 63);

    context.fillStyle = "#281c12";
    context.font = '30px Georgia, "Times New Roman", serif';
    context.fillText(message, canvas.width / 2, 132, 900);
  }

  draw("Pincez la sacoche pour la saisir.");

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const banner = new THREE.Mesh(
    new THREE.PlaneGeometry(1.16, 0.25),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    })
  );
  banner.name = "aldila-vr-tips-banner";
  banner.position.set(0, 0.38, -1.25);
  banner.renderOrder = 9999;
  banner.frustumCulled = false;
  banner.visible = false;
  camera.add(banner);

  let hideTimer = null;

  function hide() {
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = null;
    banner.visible = false;
  }

  function show(message, durationMs = 6500) {
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    draw(message);
    texture.needsUpdate = true;
    banner.visible = true;
    hideTimer = window.setTimeout(() => {
      hideTimer = null;
      banner.visible = false;
    }, durationMs);
  }

  return { show, hide };
}
