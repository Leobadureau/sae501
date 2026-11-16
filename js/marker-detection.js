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

const MARKER_TEMPLATE_WIDTH = 24;
const SMALL_MARKER_TEMPLATE_WIDTH = 16;
const TINY_MARKER_TEMPLATE_WIDTH = 12;
const SMALL_MARKER_MAX_HEIGHT = 30;
const TINY_MARKER_MAX_HEIGHT = 18;
const MIN_MARKER_HEIGHT = 10;
const MARKER_SCAN_STEP = 6;
const MARKER_SCALE_RATIO = 1.12;
const REQUIRED_MARKER_CONFIRMATIONS = 3;

function getMarkerHeights(maxHeight, minHeight) {
  const heights = [];
  let height = maxHeight;

  while (height >= minHeight) {
    heights.push(Math.round(height));
    const nextHeight = Math.floor(height / MARKER_SCALE_RATIO);
    if (nextHeight >= height) break;
    height = nextHeight;
  }

  return heights;
}

export function createMarkerDetection({ markerOverlay, renderer, setWorldVisible, enterPcMode }) {
  const state = {
    pcMode: false,
    enabled: false,
    locked: false,
    video: null,
    stream: null,
    canvas: document.createElement("canvas"),
    context: null,
    markerTemplates: null,
    markerAspectRatio: null,
    pendingMatch: null,
    threshold: 0.58,
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

  function getCameraFallbackMessage(error) {
    if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
      return "Autorisez l’accès à la caméra extérieure pour scanner la carte, ou";
    }

    if (/OculusBrowser|Quest/i.test(navigator.userAgent)) {
      return "Le navigateur Quest ne donne pas accès à la caméra extérieure pour scanner la carte. Il faut une application Quest native, ou";
    }

    return "Caméra extérieure indisponible. Ouvrez la page sur un appareil avec une caméra arrière, ou";
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

      const crop = {
        x: markerImage.naturalWidth * 0.105,
        y: markerImage.naturalHeight * 0.082,
        width: markerImage.naturalWidth * 0.79,
        height: markerImage.naturalHeight * 0.735,
      };
      state.markerAspectRatio = crop.width / crop.height;
      state.markerTemplates = [
        TINY_MARKER_TEMPLATE_WIDTH,
        SMALL_MARKER_TEMPLATE_WIDTH,
        MARKER_TEMPLATE_WIDTH,
      ].map((width) => {
        const markerCanvas = document.createElement("canvas");
        markerCanvas.width = width;
        markerCanvas.height = Math.round(width / state.markerAspectRatio);
        const markerContext = markerCanvas.getContext("2d", { willReadFrequently: true });
        markerContext.drawImage(
          markerImage,
          crop.x, crop.y, crop.width, crop.height,
          0, 0, markerCanvas.width, markerCanvas.height
        );
        return {
          width,
          height: markerCanvas.height,
          ...createMarkerTemplate(
            markerContext.getImageData(0, 0, markerCanvas.width, markerCanvas.height)
          ),
        };
      });

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { exact: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          aspectRatio: { ideal: 16 / 9 },
        },
        audio: false,
      });
      if (state.pcMode || state.locked) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const videoTrack = stream.getVideoTracks()[0];
      const zoomRange = videoTrack.getCapabilities?.().zoom;
      console.info("Camera stream settings:", videoTrack.getSettings());
      if (zoomRange && Number.isFinite(zoomRange.min)) {
        try {
          await videoTrack.applyConstraints({
            facingMode: { exact: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            aspectRatio: { ideal: 16 / 9 },
            advanced: [{ zoom: zoomRange.min }],
          });
        } catch (error) {
          console.info("Camera zoom could not be adjusted by the browser.", error);
        }
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

      const frameScale = 160 / Math.max(video.videoWidth || 160, video.videoHeight || 120);
      state.canvas.width = Math.round((video.videoWidth || 160) * frameScale);
      state.canvas.height = Math.round((video.videoHeight || 120) * frameScale);
      state.context = state.canvas.getContext("2d", { willReadFrequently: true });
      state.enabled = true;
      renderer.setClearAlpha(1);
      setWorldVisible(false);
    } catch (error) {
      console.warn("Marker detection unavailable; keeping world hidden.", error);
      stop();
      showCameraFallback(getCameraFallbackMessage(error));
    }
  }

  function detectFrame() {
    if (!state.enabled || !state.video || !state.markerTemplates || !state.context) return false;

    const { canvas, context, video, markerTemplates, threshold } = state;
    const frameWidth = canvas.width;
    const frameHeight = canvas.height;
    context.drawImage(video, 0, 0, frameWidth, frameHeight);
    const frame = toGrayPixels(context.getImageData(0, 0, frameWidth, frameHeight));
    let bestMatch = null;
    const previousMatch = state.pendingMatch;
    const maxMarkerHeight = Math.min(
      frameHeight,
      Math.floor(frameWidth / state.markerAspectRatio)
    );
    const heightSearchRadius = previousMatch ? previousMatch.height * 0.25 : 0;
    const minMarkerHeight = previousMatch
      ? Math.max(MIN_MARKER_HEIGHT, Math.floor(previousMatch.height - heightSearchRadius))
      : MIN_MARKER_HEIGHT;
    const maxSearchMarkerHeight = previousMatch
      ? Math.min(maxMarkerHeight, Math.ceil(previousMatch.height + heightSearchRadius))
      : maxMarkerHeight;
    const markerHeights = getMarkerHeights(maxSearchMarkerHeight, minMarkerHeight);

    scanCandidates:
    for (const markerHeight of markerHeights) {
      const markerWidth = Math.round(markerHeight * state.markerAspectRatio);
      if (markerWidth < 1 || markerWidth > frameWidth) continue;
      const templateIndex = markerHeight <= TINY_MARKER_MAX_HEIGHT
        ? 0
        : markerHeight <= SMALL_MARKER_MAX_HEIGHT ? 1 : 2;
      const markerTemplate = markerTemplates[templateIndex];
      const { width: templateWidth, height: templateHeight, values, normSquared } = markerTemplate;
      const sampleCount = values.length;
      const minimumTextureVariance = sampleCount * 64;
      const markerScanStep = Math.min(
        MARKER_SCAN_STEP,
        Math.max(2, Math.round(markerHeight * 0.12))
      );

      const positionSearchRadius = previousMatch
        ? Math.max(4, markerHeight * 0.28)
        : 0;
      const minTop = previousMatch
        ? Math.max(0, Math.floor(previousMatch.centerY - markerHeight / 2 - positionSearchRadius))
        : 0;
      const maxTop = previousMatch
        ? Math.min(frameHeight - markerHeight, Math.ceil(previousMatch.centerY - markerHeight / 2 + positionSearchRadius))
        : frameHeight - markerHeight;
      const minLeft = previousMatch
        ? Math.max(0, Math.floor(previousMatch.centerX - markerWidth / 2 - positionSearchRadius))
        : 0;
      const maxLeft = previousMatch
        ? Math.min(frameWidth - markerWidth, Math.ceil(previousMatch.centerX - markerWidth / 2 + positionSearchRadius))
        : frameWidth - markerWidth;

      for (let top = minTop; top <= maxTop; top += markerScanStep) {
        for (let left = minLeft; left <= maxLeft; left += markerScanStep) {
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
          if (similarity >= 0.82) {
            bestMatch = { left, top, width: markerWidth, height: markerHeight, similarity };
            break scanCandidates;
          }
        }
      }
    }

    if (!bestMatch || bestMatch.similarity < threshold) {
      state.pendingMatch = null;
      return false;
    }

    const sameMatch = previousMatch
      && Math.hypot(
        (bestMatch.left + bestMatch.width / 2) - previousMatch.centerX,
        (bestMatch.top + bestMatch.height / 2) - previousMatch.centerY
      ) <= Math.max(4, bestMatch.height * 0.25)
      && Math.abs(bestMatch.height - previousMatch.height) <= Math.max(
        2,
        previousMatch.height * 0.2
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
