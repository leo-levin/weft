# WEFT Render Pipeline — How It All Works Together

## High-Level Overview

```
User writes WEFT code
    ↓
Parser → AST
    ↓
Executor → Populates Env (instances, spindles, vars)
    ↓
    ├→ CPU Renderer → display() → Canvas pixels
    ├→ WebGL Renderer → display() → GPU shaders → Canvas
    └→ Audio Renderer → play() → Audio worklet → Speakers
```

---

## Phase 1: Parsing (User Code → AST)

**What happens:**
```javascript
const source = `
  load("cat.jpg")::img<r,g,b>
  display(img@r(me@y, me@x))  // Swap coordinates
  play(img@r(me@sample % 100, 0))  // Sonify first row
`;

const ast = parse(source);
```

**AST structure:**
```javascript
{
  type: 'Program',
  statements: [
    {
      type: 'InstanceBinding',
      instanceName: 'img',
      expr: { type: 'Call', name: 'load', args: [{ type: 'Str', v: 'cat.jpg' }] },
      outputs: ['r', 'g', 'b']
    },
    {
      type: 'DisplayStmt',
      args: [{
        type: 'StrandRemap',
        base: 'img',
        strand: 'r',
        coords: [{ type: 'Me', field: 'y' }, { type: 'Me', field: 'x' }]
      }]
    },
    {
      type: 'PlayStmt',
      args: [/* ... */]
    }
  ]
}
```

**Key point:** Parser just builds the AST. No execution yet.

---

## Phase 2: Runtime Execution (AST → Env)

**What happens:**
```javascript
const env = new Env();
const executor = new Executor(env);
executor.execute(ast);
```

**Executor walks AST and populates Env:**

### 2.1 Processing `load("cat.jpg")::img<r,g,b>`

```javascript
// Executor sees InstanceBinding with load() call
if (stmt.expr.name === 'load') {
  // Load media into env
  const sampler = await env.loadMedia("cat.jpg", "img");

  // Sampler now contains:
  // - sampler.kind = 'image'
  // - sampler.width = 800
  // - sampler.height = 600
  // - sampler.pixels = Uint8ClampedArray (RGBA data)
  // - sampler.element = <img> DOM element
}
```

### 2.2 Creating instance accessors

**CPU renderer** creates:
```javascript
env.instances.set('img', {
  r: () => sampler.sample(env.currentX, env.currentY, 0),  // Red channel
  g: () => sampler.sample(env.currentX, env.currentY, 1),  // Green
  b: () => sampler.sample(env.currentX, env.currentY, 2),  // Blue
  w: () => sampler.width,
  h: () => sampler.height
});
```

**Key point:** Instances are just closures that capture current coordinates.

---

## Phase 3: Renderer Compilation (AST → Executable Code)

Each renderer compiles the AST into its own execution format:

### 3.1 CPU Renderer Compilation

```javascript
await cpuRenderer.compile(ast);

// Internally:
// 1. Load media
await this.loadMediaFiles(ast);  // Creates img instance

// 2. Filter display() statements
const displayStmts = ast.statements.filter(s => s.type === 'DisplayStmt');

// 3. Compile to JavaScript functions
this.displayFns = displayStmts.map(stmt => {
  const expr = stmt.args[0];  // img@r(me@y, me@x)

  // compileExpr converts AST to JS string:
  const code = compileExpr(expr, env, 'cpu');
  // Returns: "evalStrandRemap({base:'img', strand:'r', coords:[...]}, env)"

  // Create function
  return new Function('x', 'y', 'env', 'evalStrandRemap', `
    env.currentX = x;
    env.currentY = y;
    return (${code});
  `);
});
```

**Result:** Array of JavaScript functions ready to call per pixel.

### 3.2 WebGL Renderer Compilation

```javascript
await webglRenderer.compile(ast);

// Internally:
// 1. Load images as WebGL textures
await this.loadMediaTextures(ast);
// Creates: this.textures.set('img', { texture: WebGLTexture, unit: 0 })

// 2. Filter display() statements
const displayStmts = ast.statements.filter(s => s.type === 'DisplayStmt');

// 3. Compile to GLSL
const glslCode = displayStmts.map(stmt => {
  const expr = stmt.args[0];  // img@r(me@y, me@x)

  // compileToGLSL converts AST to GLSL:
  // StrandRemap case:
  const coords = expr.coords.map(c => this.compileToGLSL(c));
  // coords[0] = "v_pos.y"  (me@y)
  // coords[1] = "v_pos.x"  (me@x)

  const channel = 'r';  // from expr.strand

  return `texture2D(u_img, vec2(${coords[0]}, ${coords[1]})).${channel}`;
  // Result: "texture2D(u_img, vec2(v_pos.y, v_pos.x)).r"
});

// 4. Build shader
const fragmentShader = `
  precision highp float;
  varying vec2 v_pos;
  uniform sampler2D u_img;

  void main() {
    float color = ${glslCode[0]};
    gl_FragColor = vec4(color, color, color, 1.0);
  }
`;

// 5. Compile and link
this.program = this.createProgram(vertexShader, fragmentShader);
```

**Result:** Compiled GLSL shader program ready to run on GPU.

### 3.3 Audio Renderer Compilation

```javascript
await audioRenderer.compile(ast);

// Internally:
// 1. Load visual media for audio sampling
await this.loadMediaForAudio(ast);
// Stores pixel data: this.mediaData.set('img', { width, height, pixels })

// 2. Filter play() statements
const playStmts = ast.statements.filter(s => s.type === 'PlayStmt');

// 3. Compile to JavaScript for worklet
const processExprs = playStmts.map(stmt => {
  const expr = stmt.args[0];  // img@r(me@sample % 100, 0)

  // compileToAudio converts AST to JS:
  // StrandRemap case:
  const coords = expr.coords.map(c => this.compileToAudio(c));
  // coords[0] = "(this.frame % 100)"  (me@sample % 100)
  // coords[1] = "0"

  const channel = 0;  // 'r' = red = 0

  return `this.sampleImage(this.img_data, ${coords[0]}, ${coords[1]}, ${channel})`;
  // Result: "this.sampleImage(this.img_data, (this.frame % 100), 0, 0)"
});

// 4. Generate worklet code
const workletCode = `
  class WeftProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.frame = 0;
      // Embed pixel data
      this.img_data = ${JSON.stringify(mediaData)};
    }

    sampleImage(imageData, x, y, channel) {
      // Normalize, clamp, sample pixel
      const px = Math.floor(x * imageData.width);
      const py = Math.floor(y * imageData.height);
      return imageData.pixels[(py * width + px) * 4 + channel] / 255;
    }

    process(inputs, outputs, parameters) {
      const output = outputs[0][0];
      for (let i = 0; i < output.length; i++) {
        const sample = ${processExprs[0]};
        output[i] = Math.max(-1, Math.min(1, sample));
        this.frame++;
      }
      return true;
    }
  }
`;

// 5. Load worklet
const blob = new Blob([workletCode], { type: 'application/javascript' });
await this.audioContext.audioWorklet.addModule(URL.createObjectURL(blob));
```

**Result:** Audio worklet running in separate thread, processing audio samples.

---

## Phase 4: Rendering Loop (Execution)

### 4.1 CPU Renderer Execution

```javascript
cpuRenderer.render();

// Internally:
const pixels = this.imageData.data;  // Uint8ClampedArray
const w = env.resW, h = env.resH;

for (const { fn } of this.displayFns) {
  for (let py = 0; py < h; py++) {
    const y = py / h;  // Normalize 0-1

    for (let px = 0; px < w; px++) {
      const x = px / w;  // Normalize 0-1

      // Call compiled function
      const color = fn(x, y, env, evalStrandRemap);

      // evalStrandRemap gets called:
      // 1. Looks up env.instances.get('img')
      // 2. Gets img.r function
      // 3. Sets env.currentX = y, env.currentY = x  (swapped!)
      // 4. Calls img.r()
      // 5. img.r() reads env.currentX/Y and samples pixel
      // 6. Returns pixel value

      const i = (py * w + px) * 4;
      pixels[i] = color * 255;      // R
      pixels[i+1] = color * 255;    // G
      pixels[i+2] = color * 255;    // B
      pixels[i+3] = 255;            // A
    }
  }
}

this.ctx.putImageData(this.imageData, 0, 0);
```

**Result:** Canvas displays swapped-coordinate image.

### 4.2 WebGL Renderer Execution

```javascript
webglRenderer.render();

// Internally:
this.gl.useProgram(this.program);

// Set uniforms
this.gl.uniform1f(this.uniforms.time, time);
this.gl.uniform2f(this.uniforms.mouse, mx, my);

// Bind texture
this.gl.activeTexture(this.gl.TEXTURE0);
this.gl.bindTexture(this.gl.TEXTURE_2D, textures.get('img').texture);
this.gl.uniform1i(this.uniforms.u_img, 0);

// Draw fullscreen quad
// GPU runs fragment shader for every pixel:
//   vec2 coord = vec2(v_pos.y, v_pos.x);  // Swapped!
//   color = texture2D(u_img, coord).r;
//   gl_FragColor = vec4(color, color, color, 1.0);

this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
```

**Result:** GPU renders swapped image in parallel, much faster.

### 4.3 Audio Renderer Execution

Audio worklet runs **continuously** in separate thread:

```javascript
// Inside worklet (runs at 48kHz sample rate)
process(inputs, outputs, parameters) {
  const output = outputs[0][0];  // Audio buffer (128 samples)

  for (let i = 0; i < output.length; i++) {
    // Each iteration processes one audio sample

    // Evaluate: img@r(me@sample % 100, 0)
    const x = (this.frame % 100) / this.img_data.width;  // Normalize
    const y = 0 / this.img_data.height;

    // Sample pixel
    const px = Math.floor(x * this.img_data.width);
    const py = Math.floor(y * this.img_data.height);
    const index = (py * width + px) * 4 + 0;  // Red channel
    const pixelValue = this.img_data.pixels[index] / 255;  // 0-1

    // Write to audio output (scale to -1..1)
    output[i] = (pixelValue - 0.5) * 2;

    this.frame++;
  }

  return true;
}
```

**Result:** First 100 pixels of image sonified as audio waveform.

---

## Key Coordination Points

### How Renderers Share Data

1. **Env is shared:**
   ```javascript
   const env = new Env();
   const cpuRenderer = new CPURenderer(canvas, env);
   const webglRenderer = new WebGLRenderer(canvas, env);
   const audioRenderer = new AudioRenderer(env);
   ```

2. **Media loaded once:**
   ```javascript
   // First renderer to compile loads it
   await env.loadMedia("cat.jpg", "img");

   // Stored in env.media Map
   // All renderers can access via env.getMedia("img")
   ```

3. **Each renderer creates its own accessors:**
   - CPU: Closures that sample pixels
   - WebGL: Textures bound to GPU
   - Audio: Pixel arrays copied to worklet

### StrandRemap Magic

**Same syntax, different implementations:**

```weft
img@r(me@y, me@x)
```

**CPU:** Runtime evaluation
```javascript
evalStrandRemap(node, env) {
  const inst = env.instances.get('img');
  const strand = inst['r'];  // Function

  env.currentX = eval(node.coords[0]);  // me@y
  env.currentY = eval(node.coords[1]);  // me@x

  return strand();  // Calls img.r() with swapped coords
}
```

**WebGL:** Compile-time GLSL generation
```javascript
compileToGLSL(node) {
  const coords = node.coords.map(c => this.compileToGLSL(c));
  // ['v_pos.y', 'v_pos.x']

  return `texture2D(u_img, vec2(${coords[0]}, ${coords[1]})).r`;
  // "texture2D(u_img, vec2(v_pos.y, v_pos.x)).r"
}
```

**Audio:** Generate JavaScript for worklet
```javascript
compileToAudio(node) {
  const coords = node.coords.map(c => this.compileToAudio(c));
  // ['t', 'this.frame % 100']

  return `this.sampleImage(this.img_data, ${coords[0]}, ${coords[1]}, 0)`;
}
```

---

## Render Loop Integration (main.js)

**I'll write this part:**

```javascript
// main-new.js (simplified)

async function compile(source) {
  // 1. Parse
  const ast = parse(source);

  // 2. Execute (populate env)
  executor.execute(ast);

  // 3. Compile all renderers
  await cpuRenderer.compile(ast);
  await webglRenderer.compile(ast);
  await audioRenderer.compile(ast);
}

function renderLoop() {
  env.frame++;

  // Choose renderer (simple heuristic)
  if (hasGPUFeatures(ast)) {
    webglRenderer.render();
  } else {
    cpuRenderer.render();
  }

  // Audio runs independently in worklet

  requestAnimationFrame(renderLoop);
}

// When editor changes
editor.addEventListener('input', async () => {
  await compile(editor.value);
  if (!isRunning) {
    isRunning = true;
    renderLoop();
  }
});
```

---

## Example: Full Pipeline

**WEFT Code:**
```weft
load("cat.jpg")::img<r,g,b,w,h>

// Display: swap x and y
display(img@r(me@y, me@x), 0, 0)

// Audio: sonify top row
play(img@r(me@sample % img@w, 0))
```

**Pipeline:**

1. **Parse** → AST with 3 statements

2. **Execute** →
   - Load cat.jpg → Sampler
   - Create img instance in env

3. **CPU Compile** →
   - Load media
   - Compile: `evalStrandRemap({base:'img', strand:'r', coords:[Me('y'), Me('x')]})`
   - Create function

4. **WebGL Compile** →
   - Load texture
   - Compile: `texture2D(u_img, vec2(v_pos.y, v_pos.x)).r`
   - Build shader

5. **Audio Compile** →
   - Copy pixels to array
   - Compile: `this.sampleImage(this.img_data, this.frame % img.width, 0, 0)`
   - Load worklet

6. **Render** →
   - Visual: GPU draws swapped image 30fps
   - Audio: Worklet plays pixel data 48kHz

**Result:** See swapped cat, hear cat pixels as audio!

---

## Summary: Why This Architecture Works

1. **Single source of truth:** AST drives everything
2. **Shared environment:** One Env, multiple renderers access it
3. **Lazy evaluation:** Instances are closures, evaluated when needed
4. **Three compilation targets:** Same AST → JS, GLSL, or Audio JS
5. **StrandRemap abstraction:** Coordinate remapping works across all contexts
6. **Minimal coupling:** Renderers don't know about each other

**Clean. Simple. Powerful.** 🚀
