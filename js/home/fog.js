const vertexShaderSource = `
  attribute vec2 aPosition;
  varying vec2 vUv;
  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const fragmentShaderSource = `
  precision mediump float;
  varying vec2 vUv;
  uniform vec2 uResolution;
  uniform vec2 uPointer;
  uniform float uTime;
  uniform float uDensity;
  uniform vec3 uFogColor;

  float random2(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(random2(i), random2(i + vec2(1.0, 0.0)), f.x),
      mix(random2(i + vec2(0.0, 1.0)), random2(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
      value += amplitude * noise2(p);
      p = p * 2.03 + vec2(17.13, 9.27);
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = vec2((vUv.x - 0.5) * aspect, vUv.y);

    float broad = fbm(p * vec2(2.1, 1.7) + vec2(uTime * 0.018, -uTime * 0.012));
    float wisps = fbm(p * vec2(4.8, 3.2) + vec2(-uTime * 0.026, uTime * 0.017) + vec2(8.3));
    float depth = fbm(p * vec2(1.15, 1.4) + vec2(uTime * 0.009, uTime * 0.006) + vec2(21.7));
    float field = broad * 0.53 + wisps * 0.29 + depth * 0.18;
    field += (1.0 - vUv.y) * 0.045;

    float opacity = smoothstep(0.36, 0.66, field) * uDensity;
    vec2 pointerDelta = (vUv - uPointer) * vec2(aspect, 1.0);
    float pointerRadius = length(pointerDelta) / 0.24;
    float clearing = 1.0 - smoothstep(0.12, 1.0, pointerRadius);
    opacity *= 1.0 - clearing * 0.92;

    gl_FragColor = vec4(uFogColor, opacity);
  }
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;

  console.warn("Fog shader compilation failed:", gl.getShaderInfoLog(shader));
  gl.deleteShader(shader);
  return null;
}

export function initFog() {
  const canvas = document.getElementById("mist-canvas");
  const gl = canvas?.getContext("webgl", {
    alpha: true,
    antialias: false,
    premultipliedAlpha: false,
  });
  if (!canvas || !gl) return;

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pointer = { x: -1, y: -1 };
  const targetPointer = { x: -1, y: -1 };
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  if (!vertexShader || !fragmentShader) return;

  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("Fog shader link failed:", gl.getProgramInfoLog(program));
    return;
  }

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW
  );

  const positionLocation = gl.getAttribLocation(program, "aPosition");
  const resolutionLocation = gl.getUniformLocation(program, "uResolution");
  const pointerLocation = gl.getUniformLocation(program, "uPointer");
  const timeLocation = gl.getUniformLocation(program, "uTime");
  const densityLocation = gl.getUniformLocation(program, "uDensity");
  const colorLocation = gl.getUniformLocation(program, "uFogColor");

  function resize() {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.25);
    canvas.width = Math.round(window.innerWidth * pixelRatio);
    canvas.height = Math.round(window.innerHeight * pixelRatio);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("pointermove", (event) => {
    targetPointer.x = event.clientX / Math.max(window.innerWidth, 1);
    targetPointer.y = 1 - event.clientY / Math.max(window.innerHeight, 1);
  }, { passive: true });

  resize();
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  function render(time) {
    if (document.getElementById("mode-overlay").hidden) return;

    pointer.x += (targetPointer.x - pointer.x) * 0.075;
    pointer.y += (targetPointer.y - pointer.y) * 0.075;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
    gl.uniform2f(pointerLocation, pointer.x, pointer.y);
    gl.uniform1f(timeLocation, reducedMotion ? 0 : time * 0.001);
    gl.uniform1f(densityLocation, 0.62);
    gl.uniform3f(colorLocation, 0.75, 0.74, 0.72);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
}
