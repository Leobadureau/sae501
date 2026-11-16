function toGrayPixels(imageData) {
  const pixels = imageData.data;
  const gray = new Float32Array(imageData.width * imageData.height);
  for (let source = 0, target = 0; source < pixels.length; source += 4, target += 1) {
    gray[target] = 0.299 * pixels[source] + 0.587 * pixels[source + 1] + 0.114 * pixels[source + 2];
  }
  return gray;
}

function createMarkerTemplate(imageData) {
  const values = toGrayPixels(imageData);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let normSquared = 0;
  for (let index = 0; index < values.length; index += 1) {
    values[index] -= mean;
    normSquared += values[index] * values[index];
  }
  return { values, normSquared };
}

const MARKER_TEMPLATE_WIDTH = 36;
const MIN_MARKER_HEIGHT = 40;
const MARKER_SCAN_STEP = 4;
const MARKER_SCALE_STEP = 6;
const REQUIRED_MARKER_CONFIRMATIONS = 4;

export function createMarkerDetection({ markerOverlay, renderer, setWorldVisible, enterPcMode }) {
  const state = {
    pcMode: false,
    enabled: false,
    locked: false,
    video: null,
    stream: null,
    canvas: document.createElement("canvas"),
    context: null,
    markerTemplate: null,
    markerAspectRatio: null,
    pendingMatch: null,
    threshold: 0.74,
  };

  function updateOverlay(visible) {
    markerOverlay?.classList.toggle("is-visible", !visible);
  }

  function stop() {
    state.stream?.getTracks().forEach((track) => track.stop());
    state.video?.remove();
    state.stream = null;
    state.video = null;
    state.enabled = false;
    state.pendingMatch = null;
  }

  function showCameraFallback(message) {
    if (!markerOverlay || state.pcMode) return;
    markerOverlay.innerHTML = `${message} <button id="pc-mode-from-camera" class="pc-mode-link" type="button">Version PC</button>`;
    updateOverlay(false);
    document.getElementById("pc-mode-from-camera")?.addEventListener("click", enterPcMode);
  }

  async function setup() {
    if (state.locked) {
      renderer.setClearAlpha(1);
      setWorldVisible(true);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      showCameraFallback("Caméra indisponible. Ouvrez cette page en HTTPS et autorisez la caméra, ou");
      return;
    }

    try {
      const markerImage = new Image();
      markerImage.src = "./assets/images/Carte_Berger.jpg";
      await markerImage.decode();

      if (state.pcMode || state.locked) return;

      const markerCanvas = document.createElement("canvas");
      markerCanvas.width = MARKER_TEMPLATE_WIDTH;
      const crop = {
        x: markerImage.naturalWidth * 0.105,
        y: markerImage.naturalHeight * 0.082,
        width: markerImage.naturalWidth * 0.79,
        height: markerImage.naturalHeight * 0.735,
      };
      state.markerAspectRatio = crop.width / crop.height;
      markerCanvas.height = Math.round(MARKER_TEMPLATE_WIDTH / state.markerAspectRatio);
      const markerContext = markerCanvas.getContext("2d", { willReadFrequently: true });
      markerContext.drawImage(
        markerImage,
        crop.x, crop.y, crop.width, crop.height,
        0, 0, markerCanvas.width, markerCanvas.height
      );
      state.markerTemplate = createMarkerTemplate(
        markerContext.getImageData(0, 0, markerCanvas.width, markerCanvas.height)
      );

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      if (state.pcMode || state.locked) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const video = document.createElement("video");
      video.className = "marker-camera";
      video.playsInline = true;
      video.autoplay = true;
      video.muted = true;
      video.srcObject = stream;
      state.video = video;
      state.stream = stream;
      document.body.appendChild(video);
      await video.play();

      const frameScale = 200 / Math.max(video.videoWidth || 160, video.videoHeight || 120);
      state.canvas.width = Math.round((video.videoWidth || 160) * frameScale);
      state.canvas.height = Math.round((video.videoHeight || 120) * frameScale);
      state.context = state.canvas.getContext("2d", { willReadFrequently: true });
      state.enabled = true;
      renderer.setClearAlpha(1);
      setWorldVisible(false);
    } catch (error) {
      console.warn("Marker detection unavailable; keeping world hidden.", error);
      stop();
      showCameraFallback("Autorisez l’accès à la caméra pour scanner Carte_Berger.jpg, ou");
    }
  }

  function detectFrame() {
    if (!state.enabled || !state.video || !state.markerTemplate || !state.context) return false;

    const { canvas, context, video, markerTemplate, threshold } = state;
    const frameWidth = canvas.width;
    const frameHeight = canvas.height;
    context.drawImage(video, 0, 0, frameWidth, frameHeight);
    const frame = toGrayPixels(context.getImageData(0, 0, frameWidth, frameHeight));
    const { values, normSquared } = markerTemplate;
    const templateWidth = MARKER_TEMPLATE_WIDTH;
    const templateHeight = values.length / templateWidth;
    const sampleCount = values.length;
    const minimumTextureVariance = sampleCount * 64;
    let bestMatch = null;
    const maxMarkerHeight = Math.min(
      frameHeight,
      Math.floor(frameWidth / state.markerAspectRatio)
    );

    for (let markerHeight = MIN_MARKER_HEIGHT;
      markerHeight <= maxMarkerHeight;
      markerHeight += MARKER_SCALE_STEP) {
      const markerWidth = Math.round(markerHeight * state.markerAspectRatio);
      if (markerWidth < 1 || markerWidth > frameWidth) continue;

      for (let top = 0; top <= frameHeight - markerHeight; top += MARKER_SCAN_STEP) {
        for (let left = 0; left <= frameWidth - markerWidth; left += MARKER_SCAN_STEP) {
          let sum = 0;
          let sumSquared = 0;
          let dot = 0;
          let index = 0;
          for (let row = 0; row < templateHeight; row += 1) {
            const y = top + Math.floor(((row + 0.5) * markerHeight) / templateHeight);
            for (let column = 0; column < templateWidth; column += 1) {
              const x = left + Math.floor(((column + 0.5) * markerWidth) / templateWidth);
              const pixel = frame[y * frameWidth + x];
              sum += pixel;
              sumSquared += pixel * pixel;
              dot += pixel * values[index++];
            }
          }

          const patchNormSquared = sumSquared - (sum * sum) / sampleCount;
          if (patchNormSquared < minimumTextureVariance) continue;
          const similarity = dot / Math.sqrt(patchNormSquared * normSquared);
          if (!bestMatch || similarity > bestMatch.similarity) {
            bestMatch = { left, top, width: markerWidth, height: markerHeight, similarity };
          }
        }
      }
    }

    if (!bestMatch || bestMatch.similarity < threshold) {
      state.pendingMatch = null;
      return false;
    }

    const previousMatch = state.pendingMatch;
    const sameMatch = previousMatch
      && Math.hypot(
        (bestMatch.left + bestMatch.width / 2) - previousMatch.centerX,
        (bestMatch.top + bestMatch.height / 2) - previousMatch.centerY
      ) <= Math.max(8, bestMatch.height * 0.22)
      && Math.abs(bestMatch.height - previousMatch.height) <= Math.max(
        MARKER_SCALE_STEP * 1.5,
        previousMatch.height * 0.25
      );

    state.pendingMatch = {
      centerX: bestMatch.left + bestMatch.width / 2,
      centerY: bestMatch.top + bestMatch.height / 2,
      height: bestMatch.height,
      confirmations: sameMatch ? previousMatch.confirmations + 1 : 1,
    };

    return state.pendingMatch.confirmations >= REQUIRED_MARKER_CONFIRMATIONS;
  }

  return { state, setup, detectFrame, updateOverlay, stop };
}
