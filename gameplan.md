# WEFT Refactor Gameplan - Speed Run Edition
**Goal:** You write ~2580 lines of core logic. I handle all UI/integration. Go fast.

---

## Current State
- **Total:** 12,523 lines across 27 files
- **Problem:** Over-abstracted renderer system, bloated runtime
- **Target:** ~4380 lines total, you write the important ~2580

---

## YOUR SCOPE (What You Write)

### Phase 1: Language Core (~1030 lines)
- Parser: 400 lines (includes StrandRemap syntax ✓)
- Runtime: 430 lines (includes evalStrandRemap + load builtin)
- Compiler tweaks: 200 lines

### Phase 2: Renderers (~1550 lines)
- Shared base: 100 lines
- CPU: 380 lines (includes media loading)
- WebGL: 650 lines (includes StrandRemap + texture sampling)
- Audio: 420 lines (includes StrandRemap + visual sampling)

**Total you write: ~2580 lines** (was 2200, added critical features)

---

## MY SCOPE (I'll Handle)

- All UI code (main.js, widgets, overlays): ~800 lines
- Integration & glue code: ~200 lines
- Testing & examples: ~300 lines
- Utilities cleanup: ~100 lines

// Store StrandRemap nodes for runtime evaluation
const strandRemapNodes = new Map();

export function getStrandRemapNode(nodeId) {
  return strandRemapNodes.get(nodeId);
}

// ========== FUNCTION WRAPPER GENERATION ==========
function createFunction(jsCode, needsGetVar, needsGetInstance, needsStrandRemap) {
  // Create optimized function with minimal parameter list

  let params = ['x', 'y', 't', 'f', 'w', 'h', 'mx', 'my'];
  let body = '';

  // Inject getVar helper if needed
  if (needsGetVar) {
    params.push('getVar');
    body += `
    function getVar(name) {
      const val = env.vars.get(name);
      if (val === undefined) return 0;
      if (typeof val === 'number') return val;
      // It's an AST node - need to evaluate it (rare case)
      return evalExpr(val, env, {x, y});
    }
    `;
  }

  // Inject getInstance helper if needed
  if (needsGetInstance) {
    params.push('getInstance');
    body += `
    function getInstance(baseName, strandName) {
      const inst = env.instances.get(baseName);
      if (!inst) return 0;

      // If instance has accessor functions (e.g., from media)
      if (typeof inst[strandName] === 'function') {
        return inst[strandName]();
      }

      // If instance stores data directly
      if (inst[strandName] !== undefined) {
        return inst[strandName];
      }

      return 0;
    }
    `;
  }

  // Inject evalStrandRemap helper if needed
  if (needsStrandRemap) {
    params.push('evalStrandRemap');
    body += `
    function evalStrandRemap(nodeId) {
      const node = getStrandRemapNode(nodeId);
      if (!node) return 0;

      // Import from runtime-new.js
      return runtimeEvalStrandRemap(node, env, {x, y});
    }
    `;
  }

  // Add environment variables to function scope
  body += `
  const startTime = env.startTime;
  const absFrame = env.frame;
  const fps = env.targetFps;
  const loop = env.loop;
  const bpm = env.bpm;
  const timesigNum = env.timesig_num;

  return (${jsCode});
  `;

  try {
    return new Function(...params, 'env', 'evalExpr', 'runtimeEvalStrandRemap', 'getStrandRemapNode', body);
  } catch (e) {
    console.error('[js-compiler] Function creation failed:', e);
    console.error('Generated code:', body);
    return null;
  }
}

// ========== PUBLIC API ==========
export function compile(node, env) {
  // Main compilation entry point
  // Returns a function: (me, env, ...contextVars) => result

  const cacheKey = getCacheKey(node);

  // Check cache
  if (fnCache.has(cacheKey)) {
    return fnCache.get(cacheKey);
  }

  // Generate JS code
  const jsCode = compileToJS(node, env);

  // Analyze what helpers are needed
  const needsGetVar = jsCode.includes('getVar(');
  const needsGetInstance = jsCode.includes('getInstance(');
  const needsStrandRemap = jsCode.includes('evalStrandRemap(');

  // Create function
  const fn = createFunction(jsCode, needsGetVar, needsGetInstance, needsStrandRemap);

  if (!fn) {
    // Fallback to returning 0
    return () => 0;
  }

  // Wrapper function that extracts context variables from me object
  const wrapper = (me, envCtx, evalExprFn, runtimeEvalStrandRemapFn, getNodeFn) => {
    return fn(
      me.x, me.y,  // Spatial
      ((envCtx.frame % envCtx.loop) / envCtx.targetFps),  // time
      envCtx.frame % envCtx.loop,  // frame
      envCtx.resW, envCtx.resH,  // dimensions
      envCtx.mouse.x, envCtx.mouse.y,  // mouse
      envCtx,  // full env for helpers
      evalExprFn,  // For evaluating var expressions
      runtimeEvalStrandRemapFn,  // From runtime-new.js
      getNodeFn  // For looking up StrandRemap nodes
    );
  };

  fnCache.set(cacheKey, wrapper);
  return wrapper;
}

// Legacy export for compatibility
export { compile as compileExpr };
```

**Key changes from old compiler:**
1. **No route parameter** - this ONLY compiles to JS (CPU renderer)
2. **No strand system** - uses simple variable/instance lookup
3. **StrandRemap uses runtime helper** - stores nodes in Map, looks up at runtime
4. **Simplified caching** - WeakMap for objects, Map for compiled functions
5. **Removed evalExprToStrand injection** - doesn't exist in new runtime

**Your tasks:**
1. Delete old js-compiler.js
2. Create new js-compiler.js with the structure above
3. Implement each case in `compileToJS()`
4. Test with simple expressions: `me@x`, `me@x + me@y`, `sin(me@time)`
5. Import `evalStrandRemap` from runtime-new.js for StrandRemap support

**Delete after:**
- Nothing to delete - this is a full rewrite

**Integration points:**
- CPURenderer imports `{ compile }` and uses it to compile display() expressions
- Runtime-new.js exports `evalStrandRemap(node, env, me)` for coordinate remapping
- WebGL/Audio renderers have their own `compileToGLSL()` / `compileToAudio()` methods

---

## PHASE 2: RENDERERS

### 2.1 Base Renderer (~100 lines)

**File:** `src/renderers/base-renderer.js`

**What YOU write:**

```javascript
// base-renderer.js - Thin shared base for lifecycle
export class BaseRenderer {
  constructor(env, name) {
    this.env = env;
    this.name = name;
    this.isRunning = false;
    this.statements = [];  // Filtered statements for this renderer
  }

  // Abstract lifecycle methods (override in subclasses)
  async init() {
    throw new Error(`${this.name}: init() not implemented`);
  }

  async compile(ast) {
    throw new Error(`${this.name}: compile() not implemented`);
  }

  render() {
    throw new Error(`${this.name}: render() not implemented`);
  }

  cleanup() {
    // Optional override
  }

  // Shared helper: filter statements by type
  filterStatements(ast, type) {
    return ast.statements.filter(s => s.type === type);
  }

  // Shared helper: logging
  log(msg, level = 'info') {
    console.log(`[${this.name}] ${msg}`);
  }

  // Shared helper: find used variables (for dependency tracking)
  findUsedVars(statements) {
    const vars = new Set();

    const traverse = (node) => {
      if (!node) return;

      if (node.type === 'Var') {
        vars.add(node.name);
      } else if (node.type === 'StrandAccess') {
        vars.add(node.base);
      }

      // Traverse children
      Object.values(node).forEach(v => {
        if (typeof v === 'object') traverse(v);
        if (Array.isArray(v)) v.forEach(traverse);
      });
    };

    statements.forEach(s => traverse(s));
    return vars;
  }
}
```

**Your tasks:**
1. Write thin base class with lifecycle hooks
2. Add only genuinely shared helpers (filtering, logging, traversal)
3. NO parameter systems, NO cross-context managers

---

### 2.2 CPU Renderer (~380 lines)

**File:** `src/renderers/cpu-renderer.js`

**What YOU write:**

```javascript
// cpu-renderer.js - Pixel-by-pixel CPU rendering
import { BaseRenderer } from './base-renderer.js';
import { compileExpr } from '../compilers/js-compiler.js';
import { evalStrandRemap } from '../runtime/runtime-new.js';

export class CPURenderer extends BaseRenderer {
  constructor(canvas, env) {
    super(env, 'CPU');

    this.canvas = canvas;
    this.ctx = null;  // Delay to avoid WebGL conflicts
    this.imageData = null;
    this.displayFns = [];
  }

  async init() {
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!this.ctx) {
      throw new Error('Failed to get 2D context');
    }

    this.imageData = this.ctx.createImageData(this.env.resW, this.env.resH);
    this.log('Initialized');
  }

  async compile(ast) {
    // 1. Process load() statements for media
    await this.loadMediaFiles(ast);

    // 2. Filter display() statements
    this.statements = this.filterStatements(ast, 'DisplayStmt');

    if (this.statements.length === 0) {
      this.displayFns = [];
      return;
    }

    // 3. Compile each display() expression to JavaScript function
    this.displayFns = this.statements.map((stmt, i) => {
      const expr = stmt.args[0];  // First arg is the color expression
      const code = compileExpr(expr, this.env, 'cpu');

      // Create function with pixel coordinates and env
      // x, y are normalized 0-1
      const fn = new Function('x', 'y', 'env', 'evalStrandRemap', `
        const me = env.instances.get('me');
        env.currentX = x;
        env.currentY = y;

        return (${code});
      `);

      this.log(`Compiled display ${i}: ${code.slice(0, 50)}...`);
      return { fn, code };
    });
  }

  async loadMediaFiles(ast) {
    // Find all load() calls
    for (const stmt of ast.statements) {
      if (stmt.type === 'InstanceBinding' && stmt.expr?.type === 'Call' && stmt.expr.name === 'load') {
        const path = stmt.expr.args[0]?.v;
        if (path) {
          await this.env.loadMedia(path, stmt.instanceName);
          this.createMediaAccessors(stmt.instanceName, stmt.outputs);
        }
      }
    }
  }

  createMediaAccessors(instName, outputs) {
    const sampler = this.env.getMedia(instName);
    if (!sampler) return;

    const instance = {};

    for (const output of outputs) {
      const outName = typeof output === 'string' ? output : output.name;

      // Create accessor functions for each output
      switch (outName) {
        case 'r':
        case 'red':
          instance[outName] = () => {
            const x = this.env.currentX;
            const y = this.env.currentY;
            return sampler.sample(x, y, 0);
          };
          break;
        case 'g':
        case 'green':
          instance[outName] = () => {
            const x = this.env.currentX;
            const y = this.env.currentY;
            return sampler.sample(x, y, 1);
          };
          break;
        case 'b':
        case 'blue':
          instance[outName] = () => {
            const x = this.env.currentX;
            const y = this.env.currentY;
            return sampler.sample(x, y, 2);
          };
          break;
        case 'w':
        case 'width':
          instance[outName] = () => sampler.width || 0;
          break;
        case 'h':
        case 'height':
          instance[outName] = () => sampler.height || 0;
          break;
      }
    }

    this.env.instances.set(instName, instance);
  }

  render() {
    if (!this.displayFns || this.displayFns.length === 0) {
      this.ctx.clearRect(0, 0, this.env.resW, this.env.resH);
      return;
    }

    const pixels = this.imageData.data;
    const w = this.env.resW;
    const h = this.env.resH;

    // Render each display function
    for (const { fn } of this.displayFns) {
      for (let py = 0; py < h; py++) {
        const y = py / h;

        for (let px = 0; px < w; px++) {
          const x = px / w;

          try {
            const color = fn(x, y, this.env, evalStrandRemap);
            const i = (py * w + px) * 4;

            // Handle different color formats
            if (typeof color === 'number') {
              // Grayscale
              pixels[i] = pixels[i+1] = pixels[i+2] = color * 255;
              pixels[i+3] = 255;
            } else if (color.r !== undefined) {
              // RGB object
              pixels[i] = color.r * 255;
              pixels[i+1] = color.g * 255;
              pixels[i+2] = color.b * 255;
              pixels[i+3] = 255;
            } else if (Array.isArray(color)) {
              // Tuple [r, g, b]
              pixels[i] = (color[0] || 0) * 255;
              pixels[i+1] = (color[1] || 0) * 255;
              pixels[i+2] = (color[2] || 0) * 255;
              pixels[i+3] = 255;
            }
          } catch (err) {
            // Silent fail for individual pixels
          }
        }
      }
    }

    this.ctx.putImageData(this.imageData, 0, 0);
  }

  cleanup() {
    this.displayFns = [];
  }
}
```

**Your tasks:**
1. Extend BaseRenderer
2. **Add media loading support (loadMediaFiles + createMediaAccessors)**
3. Compile display() statements to JS functions
4. Double loop over pixels, call functions
5. Handle color formats (grayscale, RGB, tuple)
6. **StrandRemap works automatically via evalStrandRemap helper**
7. Test with images and coordinate remapping

---

### 2.3 WebGL Renderer (~650 lines)

**File:** `src/renderers/webgl-renderer.js`

**What YOU write:**

```javascript
// webgl-renderer.js - GPU shader rendering
import { BaseRenderer } from './base-renderer.js';

export class WebGLRenderer extends BaseRenderer {
  constructor(canvas, env) {
    super(env, 'WebGL');

    this.canvas = canvas;
    this.gl = null;
    this.program = null;
    this.vertexBuffer = null;
    this.uniforms = {};
  }

  async init() {
    this.gl = this.canvas.getContext('webgl2') || this.canvas.getContext('webgl');
    if (!this.gl) {
      throw new Error('WebGL not supported');
    }

    this.setupQuad();
    this.log('Initialized');
  }

  setupQuad() {
    // Fullscreen quad geometry
    const vertices = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1
    ]);

    this.vertexBuffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertexBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.STATIC_DRAW);
  }

  async compile(ast) {
    // 1. Load media files as textures
    await this.loadMediaTextures(ast);

    // 2. Filter display() statements
    this.statements = this.filterStatements(ast, 'DisplayStmt');

    if (this.statements.length === 0) {
      this.program = null;
      return;
    }

    // 3. Generate GLSL shader
    const fragShader = this.buildFragmentShader(this.statements);
    const vertShader = this.buildVertexShader();

    // 4. Compile shader program
    this.program = this.createProgram(vertShader, fragShader);

    // 5. Get uniform locations
    this.uniforms = {
      time: this.gl.getUniformLocation(this.program, 'u_time'),
      resolution: this.gl.getUniformLocation(this.program, 'u_resolution'),
      mouse: this.gl.getUniformLocation(this.program, 'u_mouse'),
      frame: this.gl.getUniformLocation(this.program, 'u_frame')
    };

    // 6. Get texture uniform locations
    for (const [name, tex] of this.textures.entries()) {
      this.uniforms[`u_${name}`] = this.gl.getUniformLocation(this.program, `u_${name}`);
    }
  }

  async loadMediaTextures(ast) {
    let textureUnit = 0;

    for (const stmt of ast.statements) {
      if (stmt.type === 'InstanceBinding' && stmt.expr?.type === 'Call' && stmt.expr.name === 'load') {
        const path = stmt.expr.args[0]?.v;
        if (path) {
          const sampler = await this.env.loadMedia(path, stmt.instanceName);

          // Create WebGL texture
          if (sampler.kind === 'image' || sampler.kind === 'video') {
            const texture = this.createTexture(sampler);
            this.textures.set(stmt.instanceName, {
              texture,
              unit: textureUnit++,
              sampler
            });
          }
        }
      }
    }
  }

  createTexture(sampler) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);

    // Upload image data
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sampler.element);

    // Set texture parameters
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    return texture;
  }

  buildVertexShader() {
    return `
      attribute vec2 a_position;
      varying vec2 v_pos;

      void main() {
        v_pos = a_position * 0.5 + 0.5;  // -1..1 -> 0..1
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;
  }

  buildFragmentShader(statements) {
    // Compile WEFT expressions to GLSL
    const glslExprs = statements.map(stmt => {
      return this.compileToGLSL(stmt.args[0]);
    });

    // Combine into fragment shader
    return `
      precision highp float;
      varying vec2 v_pos;

      uniform float u_time;
      uniform vec2 u_resolution;
      uniform vec2 u_mouse;
      uniform float u_frame;

      void main() {
        vec2 pos = v_pos;

        // Compile display expressions
        ${glslExprs.map((expr, i) => `
          vec3 color${i} = ${expr};
        `).join('\n')}

        // Use last display as output
        gl_FragColor = vec4(color${glslExprs.length - 1}, 1.0);
      }
    `;
  }

  compileToGLSL(node) {
    // Convert WEFT AST to GLSL
    switch (node.type) {
      case 'Num':
        return String(node.v);

      case 'Me':
        switch (node.field) {
          case 'x': return 'v_pos.x';
          case 'y': return 'v_pos.y';
          case 'time': return 'u_time';
          case 'frame': return 'u_frame';
          default: return '0.0';
        }

      case 'Mouse':
        return node.field === 'x' ? 'u_mouse.x' : 'u_mouse.y';

      case 'Bin':
        const left = this.compileToGLSL(node.left);
        const right = this.compileToGLSL(node.right);
        const op = this.glslOp(node.op);
        return `(${left} ${op} ${right})`;

      case 'Unary':
        if (node.op === '-') {
          return `(-${this.compileToGLSL(node.expr)})`;
        }
        // Map function names
        const glslFn = this.glslFunction(node.op);
        return `${glslFn}(${this.compileToGLSL(node.expr)})`;

      case 'Call':
        const args = node.args.map(a => this.compileToGLSL(a)).join(', ');
        const fn = this.glslFunction(node.name);
        return `${fn}(${args})`;

      case 'Tuple':
        // vec3(r, g, b)
        const components = node.elements.map(e => this.compileToGLSL(e)).join(', ');
        return `vec3(${components})`;

      case 'StrandAccess': {
        // img@r - access strand from instance
        const texInfo = this.textures.get(node.base);
        if (texInfo) {
          const channel = this.getTextureChannel(node.strand);
          return `texture2D(u_${node.base}, v_pos).${channel}`;
        }
        return '0.0';
      }

      case 'StrandRemap': {
        // img@r(me@y, me@x) - coordinate remapping
        const texInfo = this.textures.get(node.base);
        if (texInfo) {
          const coords = node.coords.map(c => this.compileToGLSL(c));
          const channel = this.getTextureChannel(node.strand);
          return `texture2D(u_${node.base}, vec2(${coords[0]}, ${coords[1]})).${channel}`;
        }
        return '0.0';
      }

      default:
        console.warn('Unhandled GLSL node:', node.type);
        return '0.0';
    }
  }

  getTextureChannel(strandName) {
    switch (strandName) {
      case 'r':
      case 'red': return 'r';
      case 'g':
      case 'green': return 'g';
      case 'b':
      case 'blue': return 'b';
      case 'a':
      case 'alpha': return 'a';
      default: return 'r';
    }
  }

  glslOp(op) {
    const opMap = {
      '+': '+', '-': '-', '*': '*', '/': '/',
      '^': 'pow',  // Special case: need to convert to function
      '<': '<', '>': '>', '<=': '<=', '>=': '>=',
      '==': '==', '!=': '!='
    };
    return opMap[op] || op;
  }

  glslFunction(name) {
    const fnMap = {
      'sin': 'sin', 'cos': 'cos', 'tan': 'tan',
      'sqrt': 'sqrt', 'abs': 'abs', 'floor': 'floor',
      'ceil': 'ceil', 'round': 'round',
      'min': 'min', 'max': 'max',
      'clamp': 'clamp', 'mix': 'mix',
      'fract': 'fract', 'sign': 'sign'
    };
    return fnMap[name] || name;
  }

  createProgram(vertSource, fragSource) {
    const gl = this.gl;

    // Compile shaders
    const vertShader = this.compileShader(gl.VERTEX_SHADER, vertSource);
    const fragShader = this.compileShader(gl.FRAGMENT_SHADER, fragSource);

    // Link program
    const program = gl.createProgram();
    gl.attachShader(program, vertShader);
    gl.attachShader(program, fragShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      throw new Error('Shader program failed to link');
    }

    return program;
  }

  compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(shader));
      console.log('Source:', source);
      throw new Error('Shader failed to compile');
    }

    return shader;
  }

  render() {
    if (!this.program) return;

    const gl = this.gl;

    gl.useProgram(this.program);

    // Set uniforms
    gl.uniform1f(this.uniforms.time, (this.env.frame % this.env.loop) / this.env.targetFps);
    gl.uniform2f(this.uniforms.resolution, this.env.resW, this.env.resH);
    gl.uniform2f(this.uniforms.mouse, this.env.mouse.x, this.env.mouse.y);
    gl.uniform1f(this.uniforms.frame, this.env.frame % this.env.loop);

    // Bind textures
    for (const [name, texInfo] of this.textures.entries()) {
      gl.activeTexture(gl.TEXTURE0 + texInfo.unit);
      gl.bindTexture(gl.TEXTURE_2D, texInfo.texture);
      gl.uniform1i(this.uniforms[`u_${name}`], texInfo.unit);
    }

    // Bind vertex buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    const posLoc = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Draw
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  cleanup() {
    // Clean up textures
    for (const texInfo of this.textures.values()) {
      this.gl.deleteTexture(texInfo.texture);
    }
    this.textures.clear();

    if (this.program) {
      this.gl.deleteProgram(this.program);
      this.program = null;
    }
  }
}
```

**Your tasks:**
1. Extend BaseRenderer
2. **Add texture loading (loadMediaTextures + createTexture)**
3. Compile WEFT AST to GLSL (similar to JS compiler)
4. **Add StrandAccess and StrandRemap cases to compileToGLSL**
5. Generate vertex + fragment shaders with texture uniforms
6. Set uniforms and bind textures in render()
7. Test with images and coordinate remapping

---

### 2.4 Audio Renderer (~420 lines)

**File:** `src/renderers/audio-renderer.js`

**What YOU write:**

```javascript
// audio-renderer.js - Audio worklet renderer
import { BaseRenderer } from './base-renderer.js';

export class AudioRenderer extends BaseRenderer {
  constructor(env) {
    super(env, 'Audio');

    this.audioContext = null;
    this.workletNode = null;
    this.processorName = 'weft-processor';
    this.processorVersion = 0;
  }

  async init() {
    this.audioContext = new AudioContext();
    this.log('Initialized AudioContext');
  }

  async compile(ast) {
    // 1. Load media files (images for visual sampling)
    await this.loadMediaForAudio(ast);

    // 2. Filter play() statements
    this.statements = this.filterStatements(ast, 'PlayStmt');

    if (this.statements.length === 0) {
      this.stopAudio();
      return;
    }

    // 3. Generate audio processing code
    const processorCode = this.generateProcessor(this.statements);

    // 4. Create worklet with generated code
    await this.loadWorklet(processorCode);

    // 5. Connect to output
    if (this.workletNode) {
      this.workletNode.connect(this.audioContext.destination);
    }
  }

  async loadMediaForAudio(ast) {
    for (const stmt of ast.statements) {
      if (stmt.type === 'InstanceBinding' && stmt.expr?.type === 'Call' && stmt.expr.name === 'load') {
        const path = stmt.expr.args[0]?.v;
        if (path) {
          const sampler = await this.env.loadMedia(path, stmt.instanceName);

          // Store media data for worklet access
          if (sampler.kind === 'image' || sampler.kind === 'video') {
            this.mediaData.set(stmt.instanceName, {
              width: sampler.width,
              height: sampler.height,
              pixels: Array.from(sampler.pixels || [])
            });
          }
        }
      }
    }
  }

  generateProcessor(statements) {
    // Compile play() expressions to audio processing JavaScript

    // Include media sampling functions
    const mediaSamplingCode = this.generateMediaSamplingFunctions();

    const processExprs = statements.map((stmt, i) => {
      const expr = stmt.args[0];
      const code = this.compileToAudio(expr);
      return `const sample${i} = ${code};`;
    }).join('\n      ');

    const outputExpr = statements.length > 0 ? `sample${statements.length - 1}` : '0';

    return `
      class WeftProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.frame = 0;
          this.startTime = currentTime;

          // Media data for visual sampling
          ${this.generateMediaDataInit()}
        }

        ${mediaSamplingCode}

        process(inputs, outputs, parameters) {
          const output = outputs[0];
          const channel = output[0];

          for (let i = 0; i < channel.length; i++) {
            // Normalized time (0-1 within loop)
            const t = (this.frame / sampleRate) % 1;

            // Compute sample
            ${processExprs}

            // Write to output (clamp to -1..1)
            channel[i] = Math.max(-1, Math.min(1, ${outputExpr}));

            this.frame++;
          }

          return true;
        }
      }

      registerProcessor('${this.processorName}-${this.processorVersion}', WeftProcessor);
    `;
  }

  generateMediaDataInit() {
    let code = '';
    for (const [name, data] of this.mediaData.entries()) {
      code += `this.${name}_data = ${JSON.stringify(data)};\n          `;
    }
    return code;
  }

  generateMediaSamplingFunctions() {
    return `
      sampleImage(imageData, x, y, channel = 0) {
        if (!imageData || !imageData.pixels) return 0;

        x = Math.max(0, Math.min(1, x));
        y = Math.max(0, Math.min(1, y));

        const px = Math.floor(x * (imageData.width - 1));
        const py = Math.floor(y * (imageData.height - 1));
        const index = (py * imageData.width + px) * 4 + channel;

        return (imageData.pixels[index] || 0) / 255.0;
      }
    `;
  }

  compileToAudio(node) {
    // Convert WEFT AST to JavaScript audio expressions
    switch (node.type) {
      case 'Num':
        return String(node.v);

      case 'Me':
        switch (node.field) {
          case 'time': return 't';
          case 'frame': return 'this.frame';
          case 'sample': return 'this.frame';  // For audio, sample = frame
          default: return '0';
        }

      case 'Bin':
        const left = this.compileToAudio(node.left);
        const right = this.compileToAudio(node.right);
        return `(${left} ${node.op} ${right})`;

      case 'Unary':
        if (node.op === '-') {
          return `(-${this.compileToAudio(node.expr)})`;
        }
        return `Math.${node.op}(${this.compileToAudio(node.expr)})`;

      case 'Call':
        const args = node.args.map(a => this.compileToAudio(a)).join(', ');
        return `Math.${node.name}(${args})`;

      case 'StrandAccess': {
        // Access media in audio context: img@r
        const channelMap = { r: 0, g: 1, b: 2 };
        const channel = channelMap[node.strand] || 0;
        return `this.sampleImage(this.${node.base}_data, 0.5, 0.5, ${channel})`;
      }

      case 'StrandRemap': {
        // Coordinate remapping in audio: img@r(x, y)
        const coords = node.coords.map(c => this.compileToAudio(c));
        const channelMap = { r: 0, g: 1, b: 2 };
        const channel = channelMap[node.strand] || 0;
        return `this.sampleImage(this.${node.base}_data, ${coords[0]}, ${coords[1]}, ${channel})`;
      }

      default:
        return '0';
    }
  }

  async loadWorklet(code) {
    // Create blob URL for worklet code
    const blob = new Blob([code], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);

    try {
      // Load worklet module
      await this.audioContext.audioWorklet.addModule(url);

      // Disconnect old node
      if (this.workletNode) {
        this.workletNode.disconnect();
      }

      // Create new worklet node
      this.workletNode = new AudioWorkletNode(
        this.audioContext,
        `${this.processorName}-${this.processorVersion}`
      );

      this.processorVersion++;
      this.log('Loaded worklet');

    } catch (err) {
      console.error('Worklet load error:', err);
      throw err;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  render() {
    // Audio rendering happens in worklet, nothing to do here
    // Just update timing parameters if needed
  }

  stopAudio() {
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
  }

  cleanup() {
    this.stopAudio();
    if (this.audioContext) {
      this.audioContext.close();
    }
  }
}
```

**Your tasks:**
1. Extend BaseRenderer
2. **Add visual media loading for audio (loadMediaForAudio)**
3. **Generate media sampling functions in worklet**
4. Compile play() statements to audio worklet JavaScript
5. **Add StrandAccess and StrandRemap cases to compileToAudio**
6. Generate worklet processor code dynamically
7. Load via blob URL (avoid separate file)
8. Test with sine wave AND image→audio conversion

---

## EXECUTION PLAN

### Day 1: Parser
- Morning: Read current parser.js completely
- Afternoon: Write parser-new.js (400 lines)
- **Includes:** StrandRemap syntax ✓
- Test: `parse("display(img@r(me@y, me@x))")`

### Day 2: Runtime
- Morning: Write runtime-new.js (430 lines)
- Afternoon: Test with Executor
- **Includes:** evalStrandRemap, media loading ✓
- Verify: env.instances populated, media loads

### Day 3: Compiler
- Morning: Review js-compiler.js
- Afternoon: Add route parameter (200 line delta)
- Test: Compile to both JS and GLSL

### Day 4: Base + CPU Renderer
- Morning: Write base-renderer.js (100 lines)
- Afternoon: Write cpu-renderer.js (380 lines)
- **Includes:** Media loading, StrandRemap support ✓
- Test: Render display() with load() and coordinate remapping

### Day 5: WebGL Renderer
- All day: Write webgl-renderer.js (650 lines)
- **Includes:** Texture loading, StrandAccess, StrandRemap in GLSL ✓
- Test: GPU rendering with images and remapping

### Day 6: Audio Renderer
- Morning: Write audio-renderer.js (420 lines)
- **Includes:** Visual sampling, StrandRemap for audio ✓
- Afternoon: Test sine wave + image→audio
- Evening: Full integration testing

### Day 7: Integration & Polish
- Morning: I write main-new.js with renderer coordination
- Afternoon: Integration testing all features
- Evening: Bug fixes, cleanup, delete old files

---

## I'LL HANDLE (While You Code)

### Integration Layer
**File:** `src/ui/main-new.js` (I write this)

```javascript
// Coordinate all renderers
// Hook up editor events
// Manage render loop
// Error handling
```

### UI Components
**Files:** I'll write/refactor:
- `src/ui/widgets.js` — consolidated UI controls
- `src/ui/debug-overlay.js` — coordinate probe, clock, etc.

### Testing
I'll create test suite with examples for each phase.

---

## FILE DELETION SCHEDULE

After Phase 1 (Language Core):
```
rm src/lang/tagging.js
rm src/runtime/core/parameter-strand.js
rm src/runtime/core/errors.js
rm src/runtime/evaluation/builtins-math.js
```

After Phase 2 (Renderers):
```
rm src/renderers/abstract-renderer.js
rm src/renderers/renderer-manager.js
rm src/renderers/parameter-system.js
rm src/renderers/shared-utils.js
rm src/renderers/renderer.js  # old CPU
rm src/renderers/webgl-renderer.js  # old WebGL
rm src/renderers/audio-worklet-renderer.js  # old Audio
```

After Integration:
```
rm src/ui/widget-manager.js
rm src/ui/hover-detector.js
rm src/ui/coordinate-probe.js
# (I'll merge these into simplified versions)
```

---

## TESTING STRATEGY

### Phase 1 Test (Parser + Runtime):
```javascript
const src = `
  spindle test(x) :: <out> {
    out = x * 2
  }

  let a = 10
  test(a)::result<doubled>
  display(result@doubled)
`;

const ast = parse(src);
const executor = new Executor(env);
executor.execute(ast);

// Verify:
// - ast.statements has SpindleDef, LetBinding, InstanceBinding, DisplayStmt
// - env.spindles.has('test')
// - env.instances.has('result')
```

### Phase 2 Test (CPU Renderer):
```javascript
const src = `display(me@x)`;
const ast = parse(src);

const cpuRenderer = new CPURenderer(canvas, env);
await cpuRenderer.init();
await cpuRenderer.compile(ast);
cpuRenderer.render();

// Should see: horizontal gradient (black to white)
```

### Phase 2 Test (WebGL Renderer):
```javascript
const src = `display((me@x, me@y, 0))`;
const ast = parse(src);

const webglRenderer = new WebGLRenderer(canvas, env);
await webglRenderer.init();
await webglRenderer.compile(ast);
webglRenderer.render();

// Should see: red-green gradient
```

### Phase 2 Test (Audio Renderer):
```javascript
const src = `play(sin(me@time * 440 * 3.14159 * 2))`;
const ast = parse(src);

const audioRenderer = new AudioRenderer(env);
await audioRenderer.init();
await audioRenderer.compile(ast);

// Should hear: 440 Hz sine wave
```

---

## RULES

1. **Write, don't copy.** Read my templates, then write your version.
2. **Test after each phase.** Don't move on until current phase works.
3. **Keep it simple.** No premature optimization.
4. **Ask questions.** If unclear, stop and ask.
5. **Use `-new.js` suffix** until tested, then rename.

---

## SUCCESS METRICS

- **Line count:** ~4380 total (vs 12,500) — 65% reduction ✓
- **Your contribution:** ~2580 lines of core logic
- **Time to complete:** 6-7 days of focused work
- **Understanding:** You can explain the entire pipeline in 15 minutes
- **Features preserved:** 100% — all media loading, StrandRemap, three renderers ✓

---

## STARTING CHECKLIST

Before you begin Day 1:

- [ ] Read current `src/lang/parser.js` completely
- [ ] Read current `src/runtime/runtime.js` completely
- [ ] Understand AST node types in `src/ast/ast-node.js`
- [ ] Have test WEFT files ready (`test_gradient.wft`, `test_sine.wft`)
- [ ] Create `work-log.md` to track your progress

---

## QUICK REFERENCE

### File Map (After Refactor)

**YOU WRITE (~2580 lines):**
```
src/lang/parser-new.js          400 lines (includes StrandRemap)
src/runtime/runtime-new.js      430 lines (includes evalStrandRemap + media)
src/compilers/js-compiler.js    400 lines (modify existing)
src/renderers/base-renderer.js  100 lines
src/renderers/cpu-renderer.js   380 lines (includes media loading)
src/renderers/webgl-renderer.js 650 lines (includes textures + StrandRemap)
src/renderers/audio-renderer.js 420 lines (includes visual sampling)
```

**I WRITE (~800 lines):**
```
src/ui/main-new.js              300 lines
src/ui/widgets.js               250 lines
src/ui/debug-overlay.js         150 lines
src/ui/test-runner.js           100 lines
```

**KEEP AS-IS (~1000 lines):**
```
src/ast/ast-node.js             392 lines
src/utils/math.js                31 lines
src/utils/noise.js               97 lines
src/utils/logger.js             287 lines (simplify to 100)
src/runtime/media/sampler.js    229 lines
src/ui/clock-display.js         108 lines
public/index.html               105 lines
public/standard.weft             60 lines
```

**DELETE (~8000 lines):**
All the over-abstracted files listed above.

---

---

## ADVANCED ARCHITECTURE: Orchestrator + GPU Backend Abstraction

### Problem: Multimedia Cross-Context Rendering

WEFT is a **multimedia system** where:
- Audio samples from visual pixels: `play(img@r(me@sample, 0))`
- Visuals need GPU acceleration (WebGL now, Metal later)
- Audio needs access to GPU-rendered pixels
- Must coordinate render pipeline across contexts

**Solution:** Orchestrator + Backend Abstraction

---

### Architecture Overview

```
┌─────────────────────────────────────────────────┐
│           RenderOrchestrator                    │
│  - Analyzes dependencies (RenderGraph)          │
│  - Chooses rendering strategy                   │
│  - Coordinates GPU→Audio pixel transfer         │
└─────────────────────────────────────────────────┘
              │
      ┌───────┼───────┐
      ▼       ▼       ▼
   CPU    GPUBackend  Audio
Renderer  (abstract)  Renderer
            │
      ┌─────┴─────┐
      ▼           ▼
  WebGL        Metal
  Backend      Backend
  (now)        (future)
```

---

### Component 1: RenderGraph (~80 lines)

**File:** `src/core/render-graph.js`

Analyzes AST to determine:
- What instances exist (media loads, computed values)
- What contexts consume them (visual, audio, compute)
- Cross-context dependencies (visual→audio, etc.)

```javascript
const graph = new RenderGraph(ast);
const plan = graph.analyze();

// Returns:
// {
//   media: [{ name: 'img', stmt: {...} }],
//   visual: [DisplayStmt, DisplayStmt],
//   audio: [PlayStmt],
//   dependencies: Map { DisplayStmt → ['img'], PlayStmt → ['img'] },
//   crossContext: [{ instance: 'img', contexts: ['visual', 'audio'] }]
// }
```

**Key insight:** Cross-context usage detection tells orchestrator when GPU→CPU transfer is needed.

---

### Component 2: GPUBackend Interface (~50 lines)

**File:** `src/renderers/gpu-backend.js`

Abstract interface that both WebGL and Metal implement:

```javascript
export class GPUBackend {
  constructor(canvas, env) { /* ... */ }

  // Lifecycle
  async init() { throw new Error('Not implemented'); }
  async compile(ast) { throw new Error('Not implemented'); }
  render() { throw new Error('Not implemented'); }
  cleanup() { throw new Error('Not implemented'); }

  // Cross-context data access
  getPixelData(options) {
    // WebGL: gl.readPixels() - slow synchronous copy
    // Metal: shared buffer access - zero-copy!
    throw new Error('Not implemented');
  }

  supportsSharedMemory() {
    // WebGL: false
    // Metal: true
    return false;
  }

  getCapabilities() {
    return {
      maxTextureSize: 0,
      sharedMemory: false,
      asyncCompute: false,
      backend: 'unknown'
    };
  }
}
```

---

### Component 3: WebGLBackend (~500 lines)

**File:** `src/renderers/webgl-backend.js`

Current implementation (Day 5):

```javascript
export class WebGLBackend extends GPUBackend {
  supportsSharedMemory() { return false; }

  getPixelData(options = {}) {
    const w = options.width || this.env.resW;
    const h = options.height || this.env.resH;

    if (!this.pixelReadBuffer) {
      this.pixelReadBuffer = new Uint8ClampedArray(w * h * 4);
    }

    // Synchronous GPU→CPU copy (WebGL limitation)
    this.gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.pixelReadBuffer);

    return this.pixelReadBuffer;
  }

  // ... rest of WebGL implementation from gameplan
}
```

---

### Component 4: MetalBackend (~500 lines)

**File:** `src/renderers/metal-backend.js` (future - post v1.0)

Uses WebGPU API or native Metal bridge:

```javascript
export class MetalBackend extends GPUBackend {
  async init() {
    // Initialize Metal via WebGPU or native bridge
    this.device = await navigator.gpu.requestAdapter();
    this.commandQueue = this.device.createCommandQueue();

    // Create shared buffer for pixel data
    const w = this.env.resW;
    const h = this.env.resH;
    this.sharedPixelBuffer = this.device.createBuffer({
      size: w * h * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.MAP_READ,
      // Metal StorageModeShared - CPU and GPU access same memory!
    });
  }

  supportsSharedMemory() { return true; }

  async getPixelData(options = {}) {
    // Zero-copy access via shared buffer
    await this.sharedPixelBuffer.mapAsync(GPUMapMode.READ);
    const arrayBuffer = this.sharedPixelBuffer.getMappedRange();

    // Return view into shared memory (no copy!)
    return new Uint8ClampedArray(arrayBuffer);
  }

  render() {
    // Render directly to shared buffer
    const commandBuffer = this.commandQueue.createCommandBuffer();
    const renderPass = commandBuffer.createRenderPass({
      colorAttachments: [{
        view: this.sharedPixelBuffer, // Audio can read this directly!
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });

    // ... encode draw commands ...

    renderPass.end();
    commandBuffer.commit();
  }
}
```

---

### Component 5: RenderOrchestrator (~120 lines)

**File:** `src/core/orchestrator.js`

Coordinates all renderers based on dependency graph:

```javascript
export class RenderOrchestrator {
  constructor(cpuRenderer, gpuBackend, audioRenderer, env) {
    this.cpu = cpuRenderer;
    this.gpu = gpuBackend; // WebGLBackend or MetalBackend
    this.audio = audioRenderer;
    this.env = env;

    this.activeVisualRenderer = null; // 'cpu' | 'gpu'
    this.pixelTransferMode = null; // 'sync-copy' | 'shared-memory' | 'none'
  }

  async compile(ast) {
    // 1. Analyze dependencies
    const graph = new RenderGraph(ast);
    const plan = graph.analyze();

    // 2. Determine strategy
    const strategy = this.determineStrategy(plan);

    // 3. Detect pixel transfer mode
    if (strategy.needsPixelSync) {
      const caps = this.gpu.getCapabilities();

      if (caps.sharedMemory) {
        this.pixelTransferMode = 'shared-memory'; // Metal
        console.log('Using zero-copy shared memory for GPU→Audio');
      } else {
        this.pixelTransferMode = 'sync-copy'; // WebGL
        console.log('Using synchronous readPixels for GPU→Audio');
      }
    }

    // 4. Load media
    await this.loadAllMedia(plan.media);

    // 5. Compile renderers
    await this.compileRenderers(ast, strategy);
  }

  determineStrategy(plan) {
    const hasVisual = plan.visual.length > 0;
    const hasAudio = plan.audio.length > 0;
    const hasVisualToAudio = plan.crossContext.some(cc =>
      cc.contexts.includes('visual') && cc.contexts.includes('audio')
    );

    if (hasVisual && hasAudio && hasVisualToAudio) {
      return {
        visual: 'gpu',
        audio: 'active',
        dataFlow: 'gpu-to-audio',
        needsPixelSync: true
      };
    }

    if (hasVisual && hasAudio && !hasVisualToAudio) {
      return {
        visual: 'gpu',
        audio: 'active',
        dataFlow: 'independent',
        needsPixelSync: false
      };
    }

    // ... other cases
  }

  render() {
    // Visual render
    if (this.activeVisualRenderer === 'gpu') {
      this.gpu.render();

      // Transfer pixels to audio if needed
      if (this.pixelTransferMode === 'sync-copy') {
        // WebGL: slow copy
        const pixels = this.gpu.getPixelData();
        this.audio.updatePixelBuffer(pixels);
      } else if (this.pixelTransferMode === 'shared-memory') {
        // Metal: audio already has access via shared buffer
        this.audio.notifyVisualFrameComplete();
      }
    } else if (this.activeVisualRenderer === 'cpu') {
      this.cpu.render();

      if (this.pixelTransferMode !== 'none') {
        this.audio.updatePixelBuffer(this.cpu.imageData.data);
      }
    }
  }
}
```

I'll be here to answer questions, review code, and handle all the UI/integration work.

You focus on the core. Write clean. Write simple. Write fast. 🚀

---

## RENDERER ARCHITECTURE: CONTEXT-AGNOSTIC DATA, SPECIALIZED RENDERERS

### Core Principle

**WEFT instances are context-agnostic until render time.**

```weft
Ncolor<r> = me@x * me@y
color<g> = sin(me@time)
wave<audio> = sin(color@r * 440)  // Audio uses visual value!

display(color@r, color@g, 0)      // Visual context
play(wave@audio)                   // Audio context
```

The same data (`color<r>`) can be used in `display()`, `play()`, or `compute()`. Contexts are just different **output targets**, not different data types.

### Architecture: Coordinator + Thin Renderers

**Coordinator responsibilities:**
- Build dependency graph (RenderGraph)
- CPU evaluator for ALL instances (cross-context interop)
- Frame timing and FPS control
- Activate appropriate renderers based on output statements
- Route cross-context value requests

**Renderer responsibilities (minimal):**
- `init()` - Set up rendering context (WebGL, Audio, etc.)
- `compile(ast, env)` - Translate AST to target language (GLSL, native audio, etc.)
- `render()` - Execute one frame/buffer in specialized environment
- `cleanup()` - Release resources

**That's it!** Renderers are thin wrappers around their specialized execution environments.

### How Cross-Context Interop Works

**The two-tier compilation system:**

1. **CPU Evaluator (mandatory)** - Compiles ALL instances to JavaScript functions
   - Uses js-compiler.js
   - Maps `color@r` → executable JS function `(x,y,t) => x * y`
   - Provides `eval(instanceName, outputName, x, y, t)` interface

2. **Specialized Renderers (optional, for performance)** - Compile to native targets
   - WebGL: visual instances → GLSL fragment shader
   - Audio: audio instances → native audio code
   - Can call `coordinator.getValue()` to access cross-context values

**Example flow:**

```
Audio needs visual value:
  play(sin(color@r * 440))
       └─────┬─────┘
             │
  audio renderer calls: this.getValue('color', 'r', 0, 0, t)
             │
  coordinator routes to: cpuEvaluator.eval('color', 'r', 0, 0, t)
             │
  cpuEvaluator executes: colorRfn(0, 0, t)  // Pre-compiled JS function
             │
  returns: 0.5
             │
  audio continues: sin(0.5 * 440)
```

### Implementation

**1. BaseRenderer (minimal):**
```javascript
// base-renderer.js (~25 lines)
export class BaseRenderer {
  constructor(env, name) {
    this.env = env;
    this.name = name;
    this.coordinator = null;
  }

  async init() { throw new Error('implement'); }
  async compile(ast, env) { throw new Error('implement'); }
  render() { throw new Error('implement'); }
  cleanup() {}

  // Cross-context helper
  getValue(inst, out, x, y, t) {
    return this.coordinator?.getValue(inst, out, x, y, t) ?? 0;
  }
}
```

**2. CPUEvaluator (uses js-compiler.js):**
```javascript
// cpu-evaluator.js (~50 lines)
import { compile } from '../compilers/js-compiler.js';

export class CPUEvaluator {
  constructor(graph, env) {
    this.graph = graph;
    this.env = env;
    this.functions = new Map();
  }

  compile() {
    for (const [instName, node] of this.graph.nodes) {
      for (const [outName, exprAST] of node.outputs) {
        const key = `${instName}@${outName}`;
        // compile() returns executable function: (me, env) => value
        const fn = compile(exprAST, this.env);
        this.functions.set(key, fn);
      }
    }
  }

  eval(instName, outName, x, y, t) {
    const key = `${instName}@${outName}`;
    const fn = this.functions.get(key);
    if (!fn) return 0;

    const me = {x, y, time: t};
    return fn(me, this.env);
  }
}
```

**Note:** `js-compiler.js` needs rewrite (YOU WRITE) - current version is bloated, not authored by you.

**3. Coordinator (owns timing + interop):**
```javascript
// coordinator.js (~150 lines total)
export class Coordinator {
  constructor(ast, env) {
    this.ast = ast;
    this.env = env;

    // Graph and evaluator
    this.graph = null;
    this.cpuEvaluator = null;

    // Renderers
    this.gpuRenderer = null;
    this.audioRenderer = null;
    this.activeRenderers = new Set();

    // Timing
    this.running = false;
    this.frameId = null;
    this.lastFrameTime = 0;
  }

  async compile() {
    // 1. Build graph
    this.graph = new RenderGraph(this.ast, this.env);
    this.graph.build();

    // 2. Tag contexts
    const outputStmts = this.ast.statements.filter(s =>
      s.type === 'DisplayStmt' || s.type === 'PlayStmt' ||
      s.type === 'RenderStmt' || s.type === 'ComputeStmt'
    );
    this.graph.tagContexts(outputStmts);
    const contexts = this.graph.getContextsNeeded();

    // 3. Build CPU evaluator (mandatory!)
    this.cpuEvaluator = new CPUEvaluator(this.graph, this.env);
    this.cpuEvaluator.compile();

    // 4. Compile active renderers
    const promises = [];

    if (contexts.has('visual') && this.gpuRenderer) {
      this.gpuRenderer.coordinator = this;
      promises.push(this.gpuRenderer.compile(this.ast, this.env));
      this.activeRenderers.add('gpu');
    }

    if (contexts.has('audio') && this.audioRenderer) {
      this.audioRenderer.coordinator = this;
      promises.push(this.audioRenderer.compile(this.ast, this.env));
      this.activeRenderers.add('audio');
    }

    await Promise.all(promises);
  }

  start() {
    this.running = true;
    this.mainLoop();
  }

  mainLoop() {
    if (!this.running) return;

    const now = performance.now();
    const delta = now - this.lastFrameTime;
    const targetDelta = 1000 / this.env.targetFps;

    if (delta >= targetDelta) {
      this.env.frame++;

      // Render active contexts
      if (this.activeRenderers.has('gpu')) {
        this.gpuRenderer.render();
      }

      this.lastFrameTime = now;
    }

    this.frameId = requestAnimationFrame(() => this.mainLoop());
  }

  stop() {
    this.running = false;
    if (this.frameId) cancelAnimationFrame(this.frameId);
  }

  // Cross-context value access
  getValue(instName, outName, x, y, t) {
    return this.cpuEvaluator.eval(instName, outName, x, y, t);
  }

  cleanup() {
    this.stop();
    this.gpuRenderer?.cleanup();
    this.audioRenderer?.cleanup();
  }
}
```

### Audio Renderer Strategy

**Current (Web):** Use ScriptProcessorNode on main thread
- Simple implementation
- Direct access to `coordinator.getValue()` for cross-context
- Deprecated API but fine for prototyping
- Can call `this.getValue('color', 'r', 0, 0, t)` directly

**Future (Native):** Rust/Metal/CoreAudio
- High-performance native audio
- SharedArrayBuffer or compile-time baking for cross-context
- Clean swap because of BaseRenderer interface

**Don't optimize Web Audio yet** - focus on getting the architecture right. Native audio will replace it anyway.

### Renderer Types

**Implemented:**
- `WebGLRenderer` - GPU fragment shaders (GLSL)
- `ScriptProcessorAudioRenderer` - Main thread audio (Web Audio API)

**Future:**
- `MetalRenderer` - Native GPU (Rust/Metal)
- `NativeAudioRenderer` - Native audio (Rust/CoreAudio)
- `WebGPURenderer` - Modern GPU compute + 3D
- `DataExportRenderer` - Output to CSV/JSON
- `VideoRenderer` - Encode to video file

All extend `BaseRenderer`, all get access to `coordinator.getValue()`.

### JS Compiler Rewrite (YOU WRITE)

**Current state:** `js-compiler.js` is 331 lines, not written by you, bloated with optimizations

**Goal:** Clean rewrite (~150 lines) that compiles AST to JavaScript functions

**Interface:**
```javascript
// js-compiler.js
export function compile(exprAST, env) {
  // Returns executable function: (me, env) => number
  // me: {x, y, time}
  // env: runtime environment
}
```

**What it needs to handle:**
```javascript
// Numbers and operations
Num → return node.v;
Bin → (left op right)
Unary → Math.sin(arg), Math.cos(arg), etc.

// Environment access
Me → me.x, me.y, me.time
Mouse → env.mouse.x, env.mouse.y

// Control flow
If → (cond ? then : else)
Call → Math.sin(arg), noise(x,y,t), etc.

// Variables (will be rare in new system)
Var → env.getVar(name)

// Strand access (IMPORTANT!)
StrandAccess → coordinator.getValue(base, strand, me.x, me.y, me.time)
StrandRemap → coordinator.getValue(base, strand, remappedX, remappedY, me.time)
```

**Simplifications vs old version:**
- No caching (CPUEvaluator caches the compiled functions)
- No multiple compilation levels (just one: AST → function)
- No route parameter (that's renderer-specific)
- Straightforward recursive compilation

**Example output:**
```javascript
// Input AST: sin(me@x * 440)
compile(sinCallNode, env) →
  (me, env) => Math.sin(me.x * 440)

// Input AST: color@r (StrandAccess)
compile(strandAccessNode, env) →
  (me, env) => env.coordinator.getValue('color', 'r', me.x, me.y, me.time)
```

### Next Steps

1. **Rewrite js-compiler.js** (~150 lines, YOU WRITE)
2. **Write minimal BaseRenderer** (~25 lines, YOU WRITE)
3. **Write CPUEvaluator** (~50 lines, YOU WRITE)
4. **Enhance Coordinator** with timing + cpuEvaluator (~150 lines total, YOU WRITE)
5. **Refactor WebGLRenderer** - remove AbstractRenderer bloat, extend BaseRenderer
6. **Write ScriptProcessorAudioRenderer** - simple main-thread audio (~100 lines, YOU WRITE)
7. **Delete abstract-renderer.js** - no longer needed

Then test cross-context access with simple example:
```weft
color<r> = me@x
wave<audio> = sin(color@r * 440)

display(color@r, 0, 0)
play(wave@audio)
```

---

## REFERENCE: JS Compiler Skeleton (For You to Type)

**File:** `src/compilers/js-compiler-new.js`

**Structure using Pattern Matching:**

```javascript
// js-compiler-new.js - Clean AST → JavaScript function compiler
import { match, _, inst } from '../utils/match.js';
// Import AST node classes (check ast/ast-node.js for exact names)
// import { Num, Bin, Unary, Me, Mouse, Call, If, Var, StrandAccess, StrandRemap } from '../ast/ast-node.js';

// ========== COMPILATION CORE ==========

function compileToJS(node, env) {
  // Handle arrays (edge case)
  if (Array.isArray(node)) {
    return node.length === 1 ? compileToJS(node[0], env) : '0';
  }

  return match(node,
    // ===== LITERALS =====
    inst(Num, _), (v) => String(v),

    inst(Str, _), (v) => `"${v.replace(/"/g, '\\"')}"`,

    // ===== ENVIRONMENT ACCESS =====
    inst(Me, _), (field) => match(field,
      "x", () => "x",
      "y", () => "y",
      "time", () => "t",
      "frame", () => "f",
      "width", () => "w",
      "height", () => "h",
      _, () => "0"
    ),

    inst(Mouse, _), (field) => field === "x" ? "mx" : field === "y" ? "my" : "0",

    // ===== OPERATIONS =====
    inst(Bin, _, _, _), (left, op, right) => {
      const leftCode = compileToJS(left, env);
      const rightCode = compileToJS(right, env);

      // TODO(human): Implement all operators
      // Examples:
      // return match(op,
      //   "+", () => `(${leftCode}+${rightCode})`,
      //   "-", () => `(${leftCode}-${rightCode})`,
      //   "*", () => `(${leftCode}*${rightCode})`,
      //   "/", () => `(${leftCode}/(${rightCode}||1e-9))`,
      //   "^", () => `Math.pow(${leftCode},${rightCode})`,
      //   "%", () => `((${leftCode}%${rightCode}+${rightCode})%${rightCode})`,
      //   "==", () => `(${leftCode}===${rightCode}?1:0)`,
      //   "!=", () => `(${leftCode}!==${rightCode}?1:0)`,
      //   "<", () => `(${leftCode}<${rightCode}?1:0)`,
      //   ">", () => `(${leftCode}>${rightCode}?1:0)`,
      //   "<=", () => `(${leftCode}<=${rightCode}?1:0)`,
      //   ">=", () => `(${leftCode}>=${rightCode}?1:0)`,
      //   "AND", () => `(${leftCode}&&${rightCode}?1:0)`,
      //   "OR", () => `(${leftCode}||${rightCode}?1:0)`,
      //   _, () => "0"
      // );

      return "0"; // Placeholder
    },

    inst(Unary, _, _), (op, expr) => {
      const arg = compileToJS(expr, env);

      return match(op,
        "-", () => `(-${arg})`,
        "NOT", () => `(${arg}?0:1)`,
        _, () => {
          const mathFn = getMathFunction(op);
          return mathFn ? `${mathFn}(${arg})` : `(-${arg})`;
        }
      );
    },

    // ===== CONTROL FLOW =====
    inst(If, _, _, _), (condition, thenExpr, elseExpr) => {
      const cond = compileToJS(condition, env);
      const thenCode = compileToJS(thenExpr, env);
      const elseCode = compileToJS(elseExpr, env);
      return `(${cond}?${thenCode}:${elseCode})`;
    },

    inst(Call, _, _), (name, args) => {
      const argCodes = args.map(arg => compileToJS(arg, env));

      // Check for built-in math functions
      const mathFn = getMathFunction(name);
      if (mathFn) {
        return `${mathFn}(${argCodes.join(',')})`;
      }

      // Special functions
      return match(name,
        "clamp", () => {
          if (argCodes.length === 3) {
            return `(${argCodes[0]}<${argCodes[1]}?${argCodes[1]}:${argCodes[0]}>${argCodes[2]}?${argCodes[2]}:${argCodes[0]})`;
          }
          return `(${argCodes[0]}<0?0:${argCodes[0]}>1?1:${argCodes[0]})`;
        },
        "noise", () => `env.__noise3(${argCodes[0]}*3.1,${argCodes[1]}*3.1,${argCodes[2]}*0.5)`,
        _, () => `Math.sin(${argCodes.join(',')})`
      );
    },

    // ===== VARIABLES & INSTANCES =====
    inst(Var, _), (name) => `getVar("${name}")`,

    inst(StrandAccess, _, _), (base, out) => `getInstance("${base}","${out}")`,

    inst(StrandRemap, _, _, _), (base, out, coords) => `evalStrandRemap(${JSON.stringify(node)})`,

    // Default case
    _, () => {
      console.warn('[js-compiler] Unhandled node:', node);
      return "0";
    }
  );
}

// ========== HELPER FUNCTIONS ==========

function getMathFunction(name) {
  const MAP = {
    sin: 'Math.sin', cos: 'Math.cos', tan: 'Math.tan',
    sqrt: 'Math.sqrt', abs: 'Math.abs', exp: 'Math.exp', log: 'Math.log',
    min: 'Math.min', max: 'Math.max', floor: 'Math.floor',
    ceil: 'Math.ceil', round: 'Math.round', atan2: 'Math.atan2'
  };
  return MAP[name];
}

function createFunction(jsCode, needsGetVar, needsGetInstance, needsStrandRemap) {
  let params = ['x', 'y', 't', 'f', 'w', 'h', 'mx', 'my'];
  let body = '';

  // Inject getVar helper if needed
  if (needsGetVar) {
    params.push('getVar');
    body += `
    function getVar(name) {
      const val = env.vars.get(name);
      if (val === undefined) return 0;
      if (typeof val === 'number') return val;
      return evalExpr(val, env, {x, y});
    }
    `;
  }

  // Inject getInstance helper if needed
  if (needsGetInstance) {
    params.push('getInstance');
    body += `
    function getInstance(baseName, strandName) {
      const inst = env.instances.get(baseName);
      if (!inst) return 0;
      if (typeof inst[strandName] === 'function') return inst[strandName]();
      if (inst[strandName] !== undefined) return inst[strandName];
      return 0;
    }
    `;
  }

  // Inject evalStrandRemap helper if needed
  if (needsStrandRemap) {
    params.push('evalStrandRemap');
    body += `
    function evalStrandRemap(node) {
      return runtimeEvalStrandRemap(node, env, {x, y});
    }
    `;
  }

  body += `
  const startTime = env.startTime;
  const absFrame = env.frame;
  const fps = env.targetFps;
  const loop = env.loop;
  const bpm = env.bpm;
  const timesigNum = env.timesig_num;

  return (${jsCode});
  `;

  try {
    return new Function(...params, 'env', 'evalExpr', 'runtimeEvalStrandRemap', body);
  } catch (e) {
    console.error('[js-compiler] Function creation failed:', e);
    console.error('Generated code:', body);
    return null;
  }
}

// ========== PUBLIC API ==========

export function compile(node, env) {
  const jsCode = compileToJS(node, env);

  const needsGetVar = jsCode.includes('getVar(');
  const needsGetInstance = jsCode.includes('getInstance(');
  const needsStrandRemap = jsCode.includes('evalStrandRemap(');

  const fn = createFunction(jsCode, needsGetVar, needsGetInstance, needsStrandRemap);

  if (!fn) return () => 0;

  return (me, envCtx, evalExprFn, runtimeEvalStrandRemapFn) => {
    const currentTime = ((envCtx.frame % envCtx.loop) / envCtx.targetFps);
    return fn(
      me.x, me.y, currentTime, envCtx.frame % envCtx.loop,
      envCtx.resW, envCtx.resH, envCtx.mouse.x, envCtx.mouse.y,
      envCtx, evalExprFn, runtimeEvalStrandRemapFn
    );
  };
}

export { compile as compileExpr };
```