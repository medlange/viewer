/* =====================================================================================
 * The viewport: a WebGL2 stack renderer. ~200 lines, and it is the whole "viewer" part.
 *
 * WHY THE GPU HOLDS STORED VALUES AND NOT GREY LEVELS
 * ----------------------------------------------------
 * The obvious implementation windows on the CPU -- map HU to 0..255, upload a LUMINANCE
 * texture, re-upload on every window change. That costs a full re-encode and re-upload per
 * mouse move, and it throws away the measurement: once the texture holds grey levels, the
 * value under the cursor is a display artefact and cannot be reported in HU.
 *
 * So the texture is `R16I` -- the raw stored integers, exactly as they came off the wire --
 * and the fragment shader does `hu = slope * stored + intercept` then the window ramp.
 * Consequences, all of them wanted:
 *   * window/level is two uniforms, so dragging is free and never re-uploads;
 *   * the value under the cursor is readable in HU from the CPU copy, which is what
 *     `MOS-IMG-039`/`MOS-IMG-041` require of anything the platform calls a measurement;
 *   * there is no place in the pipeline where a codec could be needed, which is the
 *     property the Viewer row of docs/adr/BUILD_VS_ADOPT.md is spending its budget on.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * -----------------------------------
 * No MPR, no volume rendering, no 4D, and -- `MOS-UI-204`, which survived the reversal of
 * `MOS-CORE-038` unchanged -- no brush, no eraser, no scissors, no region grow, no
 * interpolation, no segmentation undo stack. "Forbidden regardless of how small the first
 * version looks, because the second version is a segmentation editor." A reviewer who
 * finds drawing code in this file should treat it as a defect and not as a feature.
 *
 * Spec: MOS-IMG-039, MOS-IMG-041, MOS-UI-204, MOS-CORE-038 (reversed at 0.4.0).
 * ===================================================================================== */

import { NO_TRANSFORM, fitOf, viewOf } from './transform.js';

const VERTEX = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
uniform vec2 u_scale;
uniform vec2 u_translate;
uniform mat2 u_transform;
void main() {
  // v_uv stays attached to the UNTRANSFORMED corner, so the texture travels with the
  // quad rather than sliding across it: the rotation moves where each corner is drawn,
  // not which texel it shows. Transforming v_uv instead would rotate the sampling grid
  // inside a stationary quad, which crops the picture and looks like a pan.
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4((u_transform * a_pos) * u_scale + u_translate, 0.0, 1.0);
}`;

/*
 * `isampler2D` because the texture is integer-typed. `texelFetch` rather than `texture`
 * so there is no filtering: a CT slice displayed with bilinear interpolation shows values
 * that are not in the data, and at diagnostic zoom that is an invented edge. Nearest is
 * the honest sampler here.
 */
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp isampler2D;
precision highp usampler2D;

in vec2 v_uv;
out vec4 fragColor;

uniform isampler2D u_image;      // stored pixel values, R16I
uniform usampler2D u_overlay;    // segment index per pixel, R8UI; 0 = none
uniform bool  u_hasOverlay;
uniform float u_slope;
uniform float u_intercept;
uniform float u_center;
uniform float u_width;
uniform float u_overlayAlpha;
uniform bool  u_invert;
uniform int   u_voiFunction;   // 0 LINEAR, 1 LINEAR_EXACT, 2 SIGMOID
uniform ivec2 u_size;

// A SECOND ACQUISITION, ALREADY RESAMPLED ONTO THIS FRAME'S GRID (image/fusion.js).
// NOTE TO ANYONE EDITING THIS SHADER: it is a TEMPLATE LITERAL, so a backtick in a
// comment terminates it. The first version of these lines carried two, and the page
// died on an Unexpected-identifier error pointing at a uniform twenty lines above.
// R32F and not R16I: the values arrive as the measurement -- BQML on a PET -- rather than
// as stored integers, because interpolating stored values across frames whose Modality
// LUTs differ would be arithmetic on two different scales. There is no slope here for the
// same reason; there is nothing left to apply one to.
uniform sampler2D u_fusion;
uniform bool  u_hasFusion;
uniform float u_fusionCenter;
uniform float u_fusionWidth;
uniform float u_fusionAlpha;

// Distinct, colour-blind-safe-ish segment colours. Index 0 is never drawn.
const vec3 SEGMENT_COLOURS[8] = vec3[8](
  vec3(0.0, 0.0, 0.0),
  vec3(0.90, 0.24, 0.24),
  vec3(0.22, 0.78, 0.35),
  vec3(0.31, 0.56, 0.98),
  vec3(0.98, 0.75, 0.18),
  vec3(0.76, 0.35, 0.90),
  vec3(0.20, 0.82, 0.82),
  vec3(0.98, 0.52, 0.20)
);

/* The hot-metal ramp: black, red, orange, yellow, white.
 *
 * NOT A RAINBOW. A rainbow map is not monotonic in lightness, so two different values
 * come out equally bright and a reader ordering them by eye orders them wrong -- which on
 * an uptake map is the one judgement being made. Hot metal rises in lightness the whole
 * way, which is why every PET workstation uses it or its inverse. */
vec3 hotMetal(float t) {
  return clamp(vec3(t * 3.0, t * 3.0 - 1.0, t * 3.0 - 2.0), 0.0, 1.0);
}

void main() {
  ivec2 texel = ivec2(v_uv * vec2(u_size));
  texel.y = u_size.y - 1 - texel.y;               // DICOM rows run top-down
  if (texel.x < 0 || texel.y < 0 || texel.x >= u_size.x || texel.y >= u_size.y) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float stored = float(texelFetch(u_image, texel, 0).r);
  float hu     = u_slope * stored + u_intercept;

  // (0028,1056) VOILUTFunction. PS3.3 C.11.2.1.2 and C.11.2.1.3.
  //
  // THE THREE ARE NOT INTERCHANGEABLE AND ONLY ONE WAS IMPLEMENTED. LINEAR is the default
  // and the only one a CT normally carries; SIGMOID appears on MR from several vendors.
  // Rendered as LINEAR, a SIGMOID window clips both tails hard, so tissue the acquisition
  // intended to keep visible at the top and bottom of the range flattens to pure white and
  // pure black. The result is a plausible, slightly harsher version of the intended image
  // with nothing on screen saying a different function was asked for.
  float grey;
  if (u_voiFunction == 2) {
    // SIGMOID, C.11.2.1.3.1. Soft-shouldered: it never reaches 0 or 1, which is the whole
    // point -- no clipping at either end, contrast compressed away from the centre.
    grey = 1.0 / (1.0 + exp(-4.0 * (hu - u_center) / max(u_width, 1e-6)));
  } else if (u_voiFunction == 1) {
    // LINEAR_EXACT, C.11.2.1.3.2. Centred on c over a width of w -- NOT c-0.5 over w-1.
    // The half-unit offsets in LINEAR exist because it is defined over stored integers;
    // LINEAR_EXACT is defined over the real line and dropping them is the difference.
    grey = clamp((hu - u_center) / max(u_width, 1e-6) + 0.5, 0.0, 1.0);
  } else {
    // LINEAR, C.11.2.1.2: the ramp is centred on c-0.5 over a width of w-1.
    float lo = u_center - 0.5 - (u_width - 1.0) * 0.5;
    grey = clamp((hu - lo) / max(u_width - 1.0, 1.0), 0.0, 1.0);
  }
  if (u_invert) grey = 1.0 - grey;
  vec3 rgb = vec3(grey);

  // THE SECOND ACQUISITION, UNDER THE SEGMENTATION AND OVER THE ANATOMY.
  //
  // ORDER IS AN ARGUMENT, not a convenience. A segmentation is an ASSERTION somebody
  // authored and a fusion is a second MEASUREMENT; hiding the assertion under the
  // measurement would let uptake cover a boundary a reader is checking it against.
  if (u_hasFusion) {
    float v = texelFetch(u_fusion, texel, 0).r;
    float lo = u_fusionCenter - u_fusionWidth * 0.5;
    float t = clamp((v - lo) / max(u_fusionWidth, 1e-6), 0.0, 1.0);

    // ALPHA RISES WITH THE VALUE, and this is the whole difference between a fusion and a
    // coloured fog. At constant alpha the overlay's COLD background -- which on a PET is
    // most of the patient -- is painted over the anatomy everywhere at the same strength,
    // and the CT underneath is a haze with a bright spot in it. Scaling by t makes the
    // cold end transparent: the anatomy is untouched where there is nothing to report, and
    // the uptake is opaque where there is.
    rgb = mix(rgb, hotMetal(t), u_fusionAlpha * t);
  }

  if (u_hasOverlay) {
    uint seg = texelFetch(u_overlay, texel, 0).r;
    if (seg > 0u) {
      vec3 c = SEGMENT_COLOURS[int(min(seg, 7u))];
      rgb = mix(rgb, c, u_overlayAlpha);
    }
  }
  fragColor = vec4(rgb, 1.0);
}`;

function compile(gl, type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(`shader compile failed: ${gl.getShaderInfoLog(s)}`);
  }
  return s;
}

export class Viewport {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false });
    if (!gl) {
      // Named rather than swallowed: WebGL2 is the floor, and a viewer that silently
      // degrades to canvas2d would be a second rendering path with no verification.
      throw new Error('WebGL2 is unavailable in this browser. This viewer requires it.');
    }
    this.canvas = canvas;
    this.gl = gl;

    const program = gl.createProgram();
    const vertexShader = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragmentShader = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    // THE SHADER OBJECTS ARE THE COMPILER'S COPIES and the linked program does not need
    // them. Detached and deleted here rather than in `dispose`, because that is the only
    // point at which "nothing will attach these again" is certainly true.
    for (const shader of [vertexShader, fragmentShader]) {
      gl.detachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.useProgram(program);
    this.program = program;

    const quad = gl.createBuffer();
    // HELD, so `dispose` can give it back. Everything else this constructor creates was
    // already a field; the buffer was the one local, and a local cannot be released.
    this.quad = quad;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = Object.fromEntries(
      ['u_image', 'u_overlay', 'u_hasOverlay', 'u_slope', 'u_intercept', 'u_center',
        'u_width', 'u_overlayAlpha', 'u_invert', 'u_voiFunction', 'u_size',
        'u_scale', 'u_translate', 'u_transform',
        'u_fusion', 'u_hasFusion', 'u_fusionCenter', 'u_fusionWidth',
        'u_fusionAlpha']
        .map((n) => [n, gl.getUniformLocation(program, n)]),
    );

    this.imageTexture = gl.createTexture();
    this.overlayTexture = gl.createTexture();
    this.fusionTexture = gl.createTexture();
    for (const t of [this.imageTexture, this.overlayTexture, this.fusionTexture]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    this.zoom = 1;
    this.pan = [0, 0];
    this.transform = NO_TRANSFORM;
    // A ZOOM MODE rather than a zoom: see the 1:1 control. `false` is 'whatever zoom
    // the reader has chosen', which is the ordinary case.
    this.oneToOne = false;
    this.overlayAlpha = 0.45;
    this.invert = false;
    /** 32768 when the current frame is unsigned and had to be offset into Int16. */
    this.storedOffset = 0;
  }

  /** Upload one frame's stored values. Int16Array or Uint16Array, both land as R16I. */
  setFrame(frame) {
    const gl = this.gl;
    this.frame = frame;

    // NULL IS A REAL ARGUMENT HERE, and it used to throw. `app.js` calls `setFrame(null)`
    // in the branch that catches a refusal from `reslice` -- so the one path whose whole
    // job is to replace a picture with an explanation instead raised
    // `TypeError: Cannot read properties of null (reading 'pixels')` from inside a catch
    // block, and the reader got an uncaught error where a sentence was meant to be.
    if (!frame) { this.render(); return; }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // UNSIGNED 16-BIT DOES NOT FIT AN R16I TEXTURE, and `new Int16Array(uint16)` does not
    // say so -- it converts element by element and wraps, so a stored 49344 arrives as
    // -16192. The whole upper half of the range rendered pure black, with the cliff
    // exactly at 32768, and the HU readout beneath the cursor reported the negative.
    //
    // The fix is an OFFSET, not a wider texture. Storing (u - 32768) puts every unsigned
    // value in Int16's range exactly, and the shader gets its original meaning back by
    // adding slope * 32768 to the intercept:
    //
    //     slope * (u - 32768) + (intercept + slope * 32768)  ==  slope * u + intercept
    //
    // Exact in float32 for every 16-bit input, since the mantissa holds integers well past
    // 65535. The alternative -- an R16UI texture and a second shader path -- would double
    // the sampling code for a case this arithmetic handles in one line, and two shader
    // paths is two things to keep agreeing about windowing.
    //
    // `frame.pixels` is NOT touched. `measure.js` reads it for every ROI and caliper, and
    // an offset applied there would move the defect from the picture into the numbers.
    let data;
    if (frame.pixels instanceof Int16Array) {
      this.storedOffset = 0;
      data = frame.pixels;
    } else {
      this.storedOffset = 32768;
      data = new Int16Array(frame.pixels.length);
      for (let i = 0; i < data.length; i++) data[i] = frame.pixels[i] - 32768;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16I, frame.columns, frame.rows, 0,
      gl.RED_INTEGER, gl.SHORT, data);
  }

  /** Upload a per-pixel segment index for the current frame, or null to clear. */
  setOverlay(indices, columns, rows) {
    const gl = this.gl;
    this.hasOverlay = Boolean(indices);
    if (!indices) return;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.overlayTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, columns, rows, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, indices);
  }

  setWindow(center, width) { this.window = { center, width }; }

  /**
   * Upload a second acquisition, already resampled onto this frame's grid.
   *
   * `null` clears it. The window is the FUSED series' own -- a PET's BQML range, not the
   * CT's HU -- because the two are on different scales and one window cannot serve both;
   * that is the same reason `units.js` exists.
   *
   * THE ALPHA HERE IS A CEILING, not the alpha drawn. The shader multiplies it by the
   * normalised value so the cold end stays transparent; see the fragment source.
   */
  setFusion(sampled, window, alpha) {
    const gl = this.gl;
    this.hasFusion = Boolean(sampled && sampled.values && window);
    if (!this.hasFusion) return;
    this.fusionWindow = window;
    this.fusionAlpha = alpha;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.fusionTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // R32F. The values are the measurement itself, so there is no Modality LUT left to
    // apply and no integer range to squeeze them through -- a second quantisation here
    // would be a loss of precision with nothing asking for it.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, sampled.columns, sampled.rows, 0,
      gl.RED, gl.FLOAT, sampled.values);
  }

  /** Give the graphics context back. Call this before dropping a panel, always.
   *
   * A WEBGL CONTEXT IS NOT GARBAGE THE WAY AN OBJECT IS. Dropping the canvas releases the
   * context only when the canvas is collected, which is neither prompt nor promised, and
   * a browser caps how many it will keep alive at once -- 16 in Chrome. Past that cap it
   * does not refuse the new one: it FORCE-LOSES an old one, which fires `webglcontextlost`
   * on whichever panel owned it.
   *
   * MEASURED on the running viewer, with the layout buttons and nothing else:
   *
   *     2x2 <-> 1x1, six times    31 contexts created, 1 canvas on screen
   *     after cycle 3             16 alive  -- the cap
   *     after cycle 6             16 alive, 15 FORCE-LOST by the browser
   *
   * So the viewer's own layout button was manufacturing the failure its
   * `webglcontextlost` handler exists to report, five contexts at a time, and every one
   * of those thirty-one held a linked program, a vertex buffer and two textures -- the
   * image texture being a whole 512x512 R16I frame. `WEBGL_lose_context.loseContext()` is
   * the only way to hand a context back on purpose; the deletes above it are not
   * redundant so much as honest about what was held.
   *
   * IDEMPOTENT, and silent on an already-lost context: `dispose` runs on the teardown
   * path, which is also the path a real loss leaves a panel on. */
  dispose() {
    const gl = this.gl;
    if (!gl || this.disposed) return;
    this.disposed = true;
    this.frame = null;
    if (gl.isContextLost()) return;
    gl.deleteTexture(this.imageTexture);
    gl.deleteTexture(this.overlayTexture);
    gl.deleteTexture(this.fusionTexture);
    gl.deleteBuffer(this.quad);
    gl.deleteProgram(this.program);
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  }

  /** Stored -> HU for one pixel, on the CPU, for readout. The shader's arithmetic, once. */
  huAt(x, y) {
    const f = this.frame;
    if (!f || x < 0 || y < 0 || x >= f.columns || y >= f.rows) return null;
    return f.slope * f.pixels[y * f.columns + x] + f.intercept;
  }

  /**
   * The backing store this canvas SHOULD have for its current CSS size.
   *
   * `render` resizes the canvas to this, and anything that needs the device size before
   * the render must ask here rather than read `canvas.width` -- that still holds the
   * PREVIOUS frame's size until the render runs. `draw` re-derives the 1:1 zoom before
   * rendering, on purpose, so that the picture and the percentage beside it agree; reading
   * the stale backing store there made a window resize magnify the picture by the ratio of
   * the two sizes while the control went on claiming one image pixel per device pixel.
   */
  deviceSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return {
      width: Math.max(1, Math.floor(this.canvas.clientWidth * dpr)),
      height: Math.max(1, Math.floor(this.canvas.clientHeight * dpr)),
    };
  }

  render() {
    const gl = this.gl;
    const f = this.frame;

    // NO FRAME MEANS BLACK, not "whatever was here before". This returned without touching
    // the canvas, so a panel that lost its frame -- a refused reconstruction, a study that
    // does not fill every panel -- went on displaying the last image it successfully drew,
    // under whatever labels the surface had since moved on to. The HUD said one thing and
    // the pixels said another, which is the one failure mode a viewer must not have.
    if (!f) {
      const { width: bw, height: bh } = this.deviceSize();
      if (bw && bh) {
        if (this.canvas.width !== bw || this.canvas.height !== bh) {
          this.canvas.width = bw; this.canvas.height = bh;
        }
        gl.viewport(0, 0, bw, bh);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      return;
    }

    const { width: w, height: h } = this.deviceSize();
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Fit the image to the canvas preserving the PHYSICAL aspect ratio: pixel spacing is
    // not guaranteed isotropic, and stretching a 0.7x0.9 mm pixel to square changes every
    // shape on screen.
    // THE SAME FIT `transform.js` COMPUTES, asked for rather than repeated here. This was
    // an inline copy of that arithmetic, and it was already one of two implementations
    // before the transform existed; a rotation the shader applied and the hit-testing did
    // not would put every caliper a quarter turn away from the pixel it measured.
    const view = viewOf(this);
    const shape = fitOf(f, { width: w, height: h }, view);
    if (!shape) return;
    const fit = [shape.sx / this.zoom, shape.sy / this.zoom];

    gl.useProgram(this.program);
    gl.uniform2f(this.u.u_scale, fit[0] * this.zoom, fit[1] * this.zoom);
    gl.uniform2f(this.u.u_translate, this.pan[0], this.pan[1]);
    // GLSL mat2 takes COLUMNS. The matrix is stored row-major [a, b, c, d], so the columns
    // are (a, c) and (b, d) -- transposing it here by accident is a rotation the other way
    // that looks entirely deliberate.
    const m = this.transform || NO_TRANSFORM;
    gl.uniformMatrix2fv(this.u.u_transform, false, new Float32Array([m[0], m[2], m[1], m[3]]));
    gl.uniform2i(this.u.u_size, f.columns, f.rows);
    gl.uniform1f(this.u.u_slope, f.slope);
    // The offset setFrame applied to fit unsigned data into R16I is undone here, so the
    // shader's `hu` is the value the archive stored regardless of how it was carried.
    gl.uniform1f(this.u.u_intercept, f.intercept + f.slope * (this.storedOffset || 0));
    // The frame says which transfer function its window was authored for. Absent, LINEAR,
    // and anything unrecognised all fall to LINEAR, which is the standard's own default --
    // a viewer that refused an unknown value would refuse studies it can render correctly.
    const voi = { LINEAR_EXACT: 1, SIGMOID: 2 }[f.voiFunction] ?? 0;
    gl.uniform1i(this.u.u_voiFunction, voi);
    gl.uniform1f(this.u.u_center, this.window.center);
    gl.uniform1f(this.u.u_width, this.window.width);
    gl.uniform1f(this.u.u_overlayAlpha, this.overlayAlpha);
    gl.uniform1i(this.u.u_hasOverlay, this.hasOverlay ? 1 : 0);
    // POLARITY IS TWO FACTS XORed, and the order does not matter but the combination does.
    //
    //   frame.photometric  what the DATA says: MONOCHROME1 means minimum stored = white.
    //   this.invert        what the READER asked for with the invert button.
    //
    // A MONOCHROME1 image displayed per spec is not "inverted", it is CORRECT, so the
    // button must still mean "show me the other polarity" rather than becoming a no-op on
    // half the modalities. `a !== b` on two booleans is exactly that: the reader's toggle
    // flips whatever the data's own encoding established.
    const monochrome1 = Boolean(this.frame && this.frame.photometric === 'MONOCHROME1');
    gl.uniform1i(this.u.u_invert, (Boolean(this.invert) !== monochrome1) ? 1 : 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.uniform1i(this.u.u_image, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.overlayTexture);
    gl.uniform1i(this.u.u_overlay, 1);

    gl.uniform1i(this.u.u_hasFusion, this.hasFusion ? 1 : 0);
    if (this.hasFusion) {
      gl.uniform1f(this.u.u_fusionCenter, this.fusionWindow.center);
      gl.uniform1f(this.u.u_fusionWidth, this.fusionWindow.width);
      gl.uniform1f(this.u.u_fusionAlpha, this.fusionAlpha);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.fusionTexture);
      gl.uniform1i(this.u.u_fusion, 2);
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
