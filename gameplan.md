# WEFT Coordinate Remapping Implementation Tasks

## Overview
Enable domain transformation by allowing strands to be remapped with custom coordinates, creating new instances with different input domains. This enables media-agnostic programming where any function can be evaluated in any coordinate space.

## Syntax Goal
```weft
load("img.png") :: img<r,g,b,w,h>

// Create new instances with remapped coordinates
swapped<r> = img@r(me@y, me@x)  // Swap x and y coordinates
scanline<audio> = img@r(me@sample % img@w, floor(me@sample / img@w))  // 2D to 1D mapping

play (scanline@audio)
display (swapped@r,0,0)
```

## 1. Parser Extensions

**1.1. Add Coordinate Remapping Syntax**
```javascript
// In parser.js grammar, extend PrimaryExpr:
PrimaryExpr = ...
            | ident sym<"@"> ident sym<"("> ListOf<Expr, ","> sym<")">  -- strandRemap

// Semantic action:
PrimaryExpr_strandRemap(base, _at, strand, _lp, coords, _rp) {
  return {
    type: 'StrandRemap',
    base: base.ast(),
    strand: strand.ast(),
    coordinates: coords.ast()
  };
}
```

**1.2. Update AST Node Types**
```javascript
// Add to ast-node.js:
class StrandRemapExpr extends ASTNode {
  constructor(base, strand, coordinates) {
    super('StrandRemap');
    this.base = base;           // Instance name (e.g., 'img')
    this.strand = strand;       // Strand name (e.g., 'r')
    this.coordinates = coordinates;  // Array of coordinate expressions
  }
}
```

**1.3. Allow StrandRemap in Direct Assignments**
```javascript
// Update grammar to allow coordinate remapping in direct assignments:
InstanceBinding = ident space* OutputSpec space* sym<"="> space* Expr  -- direct
                | StrandRemapExpr sym<"::"> ident OutputSpec           -- remap
```

## 2. Runtime Extensions

**2.1. Modify load() Builtin for Metadata**
✅ **COMPLETED** - Added width, height, duration metadata strands

**2.2. Create StrandRemap Evaluation**
```javascript
// In runtime.js, add handler for StrandRemap expressions:
function evalStrandRemap(node, me, env) {
  // 1. Get the source strand function
  const baseInstance = env.instances.get(node.base.name);
  const sourceStrand = baseInstance.outs[node.strand];

  // 2. Evaluate coordinate expressions
  const coords = node.coordinates.map(coordExpr =>
    evalExpr(coordExpr, me, env)
  );

  // 3. Create new evaluation context with remapped coordinates
  const remappedMe = {
    ...me,
    x: coords[0] || me.x,
    y: coords[1] || me.y,
    z: coords[2] || me.z
  };

  // 4. Evaluate source strand with new coordinates
  return sourceStrand.evalAt(remappedMe, env);
}
```

**2.3. Support StrandRemap in Instance Creation**
```javascript
// In runtime.js, handle StrandRemap in direct assignments:
function createRemappedInstance(remapExpr, instanceName, outputs, env) {
  const instanceOuts = {};

  outputs.forEach(outName => {
    instanceOuts[outName] = {
      kind: 'strand',
      evalAt: (me, env) => evalStrandRemap(remapExpr, me, env)
    };
  });

  const inst = makeSimpleInstance(instanceName, instanceOuts);
  env.instances.set(instanceName, inst);
  return inst;
}
```

## 3. Audio Renderer Integration

**3.1. Compile StrandRemap in Audio Worklet**
```javascript
// In audio-worklet-renderer.js, add compilation for StrandRemap:
compileToJS(expr) {
  // ... existing cases ...

  case 'StrandRemap':
    return this.compileStrandRemap(expr);
}

compileStrandRemap(expr) {
  // 1. Get source instance info
  const baseKey = `${expr.base.name}@${expr.strand}`;
  const sourceVar = this.instanceOutputs[baseKey];

  if (!sourceVar) {
    return '0.0'; // Fallback if source not found
  }

  // 2. Compile coordinate expressions
  const coords = expr.coordinates.map(coord => this.compileToJS(coord));

  // 3. Generate coordinate override code
  return `(() => {
    const originalMe = me;
    const remappedMe = {
      ...me,
      x: ${coords[0] || 'me.x'},
      y: ${coords[1] || 'me.y'}
    };
    me = remappedMe;
    const result = this.${sourceVar}; // Evaluate with remapped coordinates
    me = originalMe;
    return result;
  })()`;
}
```

**3.2. Handle Cross-Context Remapping**
```javascript
// Ensure remapped instances are available across contexts
collectCrossContextParams(ast) {
  // ... existing logic ...

  // Find StrandRemap expressions used across contexts
  const remapExprs = findNodes(ast, 'StrandRemap');
  remapExprs.forEach(remap => {
    if (this.isUsedInAudio(remap) && !this.hasAudioRoute(remap)) {
      this.crossContextParams.push({
        name: remap.generatedName,
        type: 'remap',
        expression: remap
      });
    }
  });
}
```

## 4. WebGL Renderer Integration

**4.1. Compile StrandRemap to GLSL**
```javascript
// In webgl-renderer.js, add GLSL generation for StrandRemap:
compileStrandRemap(stmt, glslCode, instanceOutputs) {
  const baseKey = `${stmt.base.name}@${stmt.strand}`;
  const sourceVar = instanceOutputs[baseKey];

  if (!sourceVar) return;

  // Generate coordinate expressions in GLSL
  const coords = stmt.coordinates.map(coord => this.compileToGLSL(coord));

  // Generate remapped sampling
  stmt.outs.forEach(outName => {
    const varName = `${stmt.inst}_${outName}`;
    glslCode.push(`
      vec2 remappedCoords = vec2(${coords[0] || 'uv.x'}, ${coords[1] || 'uv.y'});
      float ${varName} = texture2D(${sourceVar.texture}, remappedCoords).r;
    `);
    instanceOutputs[`${stmt.inst}@${outName}`] = varName;
  });
}
```

## 5. CPU Renderer Integration

**5.1. Support Remapping in Direct Evaluation**
```javascript
// CPU renderer already uses runtime evaluation, so StrandRemap
// support comes automatically through runtime.js changes
```

## 6. Testing Implementation

**6.1. Basic Coordinate Remapping Test**
```weft
// Test coordinate swapping
load("test.png") :: img<r,g,b,w,h>
swapped<r> = img@r(me@y, me@x)
display (swapped@r,0,0)
```

**6.2. Audio Scanline Test**
```weft
// Test image-to-audio conversion
load("test.png") :: img<r,g,b,w,h>
scanline<audio> = img@r(me@sample % img@w, floor(me@sample / img@w))
play(scanline@audio)
```

**6.3. Cross-Context Test**
```weft
// Test same remapping used in both contexts
load("test.png") :: img<r,g,b,w,h>
rotated<r> = img@r(cos(me@time) * me@x - sin(me@time) * me@y,
                   sin(me@time) * me@x + cos(me@time) * me@y)
display (rotated@radian,0,0)
play(rotated@r)  // Same rotation applied to audio
```

## Implementation Priority

1. **Parser extensions** - Add StrandRemap syntax and AST nodes
2. **Runtime support** - Handle StrandRemap evaluation and instance creation
3. **Audio renderer** - Compile coordinate remapping to JavaScript
4. **WebGL renderer** - Compile coordinate remapping to GLSL
5. **Integration testing** - Verify cross-context functionality

This enables WEFT's media-agnostic vision where any function can be evaluated in any coordinate space, opening up creative possibilities like image sonification, audio visualization, and domain-specific coordinate transformations.

---

# Audio Renderer Enhancement Tasks

## Overview
Bring the audio renderer to full parity with the visual renderer by implementing universal media loading, improved compilation, and cross-media integration. Focus on making the audio system as robust and functional as the WebGL renderer.

## 7. Universal Media Loading for Audio

**7.1. Extend Audio Renderer to Access All Media Types**
```javascript
// In audio-worklet-renderer.js, add universal media access:
async processAllLoadStatements(statements) {
  for (const stmt of statements) {
    if (stmt.type === 'CallInstance' && stmt.callee === 'load') {
      const mediaPath = stmt.args[0]?.v;
      if (mediaPath) {
        // Get the shared Sampler instance from environment
        const sampler = this.env.instances.get(stmt.inst)?.sampler;
        if (sampler) {
          await this.createMediaAccessors(sampler, stmt.inst, stmt.outs);
        }
      }
    }
  }
}

async createMediaAccessors(sampler, instName, outputs) {
  for (const output of outputs) {
    const outName = output.alias || output;
    const varName = `${instName}_${outName}`;

    // Create accessor based on media type and output name
    if (sampler.kind === 'image' || sampler.kind === 'video') {
      this.generateImageAudioAccess(varName, instName, outName, sampler);
    } else if (sampler.kind === 'audio') {
      this.generateAudioAccess(varName, instName, outName, sampler);
    }

    this.instanceOutputs[`${instName}@${outName}`] = varName;
  }
}
```

**7.2. Add Image/Video Sampling for Audio**
```javascript
// Generate methods for sampling visual media as audio
generateImageAudioAccess(varName, instName, outName, sampler) {
  const sampleMethod = this.createImageSampler(instName, sampler);

  // Map output names to image channels or metadata
  if (outName === 'r' || outName === 'red') {
    this.jsCode.push(`this.${varName} = (x, y) => ${sampleMethod}(x, y, 0);`);
  } else if (outName === 'g' || outName === 'green') {
    this.jsCode.push(`this.${varName} = (x, y) => ${sampleMethod}(x, y, 1);`);
  } else if (outName === 'b' || outName === 'blue') {
    this.jsCode.push(`this.${varName} = (x, y) => ${sampleMethod}(x, y, 2);`);
  } else if (outName === 'w' || outName === 'width') {
    this.jsCode.push(`this.${varName} = ${sampler.width || 0};`);
  } else if (outName === 'h' || outName === 'height') {
    this.jsCode.push(`this.${varName} = ${sampler.height || 0};`);
  }
}

createImageSampler(instName, sampler) {
  const samplerData = this.copyImageDataToWorklet(sampler);
  return `this.sampleImage_${instName}`;
}
```

## 8. Audio Worklet Data Transfer

**8.1. Copy Visual Media to Audio Worklet**
```javascript
// Transfer image/video data to audio worklet for sampling
copyImageDataToWorklet(sampler) {
  if (!sampler.ready || !sampler.pixels) return null;

  // Convert ImageData to transferable arrays
  const width = sampler.width;
  const height = sampler.height;
  const pixels = Array.from(sampler.pixels); // RGBA data

  // Store in worklet-accessible format
  const dataId = `imageData_${this.mediaCounter++}`;

  this.jsCode.push(`
    this.${dataId} = {
      width: ${width},
      height: ${height},
      data: [${pixels.join(',')}]
    };
  `);

  return dataId;
}
```

**8.2. Add Sampling Methods to Worklet**
```javascript
// Generate image sampling methods in audio worklet
generateImageSamplingMethods() {
  return `
    // Sample image data with coordinate wrapping/clamping
    this.sampleImageData = function(imageData, x, y, channel = 0) {
      if (!imageData || !imageData.data) return 0.0;

      // Normalize coordinates to [0,1] range
      x = Math.max(0, Math.min(1, x));
      y = Math.max(0, Math.min(1, y));

      // Convert to pixel coordinates
      const px = Math.floor(x * (imageData.width - 1));
      const py = Math.floor(y * (imageData.height - 1));
      const index = (py * imageData.width + px) * 4 + channel;

      // Return normalized value [0,1]
      return (imageData.data[index] || 0) / 255.0;
    };

    // 1D sampling for audio (flatten 2D image to 1D)
    this.sampleImageAs1D = function(imageData, sample, channel = 0) {
      if (!imageData || !imageData.data) return 0.0;

      const totalPixels = imageData.width * imageData.height;
      const pixelIndex = Math.floor(sample * totalPixels) % totalPixels;
      const dataIndex = pixelIndex * 4 + channel;

      return (imageData.data[dataIndex] || 0) / 255.0;
    };
  `;
}
```

## 9. Improved Audio Compilation Pipeline

**9.1. Create Unified Compilation Architecture**
```javascript
// Make audio compilation match WebGL renderer structure
async compile(playStatements) {
  // 1. Reset compilation state
  this.resetCompilationState();

  // 2. Process all media loading (not just audio files)
  await this.processAllLoadStatements(this.env.currentProgram.statements);

  // 3. Build instance graph like WebGL renderer
  this.buildInstanceGraph(this.env.currentProgram);

  // 4. Compile expressions to optimized JavaScript
  this.compileExpressionsToJS(playStatements);

  // 5. Generate and deploy audio worklet
  await this.generateAndDeployWorklet();

  // 6. Setup parameter synchronization
  this.setupParameterSync();
}

resetCompilationState() {
  this.instanceOutputs = {};
  this.crossContextParams = [];
  this.jsCode = [];
  this.mediaData = new Map();
  this.compiledExpressions = new Map();
}
```

**9.2. Add Expression Caching and Optimization**
```javascript
// Cache compiled expressions for performance
compileExpressionsToJS(playStatements) {
  this.compiledExpressions.clear();

  playStatements.forEach(stmt => {
    const leftExpr = this.extractAudioExpression(stmt, 'left');
    const rightExpr = this.extractAudioExpression(stmt, 'right');

    if (leftExpr) {
      this.compiledExpressions.set('left', this.compileOptimized(leftExpr));
    }
    if (rightExpr) {
      this.compiledExpressions.set('right', this.compileOptimized(rightExpr));
    }
  });
}

compileOptimized(expr) {
  // Add expression optimization passes
  const optimized = this.optimizeExpression(expr);
  return this.compileToJS(optimized);
}

optimizeExpression(expr) {
  // Constant folding, common subexpression elimination, etc.
  if (expr.type === 'Bin' && expr.left.type === 'Num' && expr.right.type === 'Num') {
    return { type: 'Num', v: this.evaluateConstant(expr) };
  }
  return expr;
}
```

## 10. Cross-Media Parameter Synchronization

**10.1. Improve Parameter Updates**
```javascript
// More efficient parameter synchronization
updateCrossContextParams() {
  if (!this.workletNode?.port) return;

  const paramUpdates = {};
  let hasUpdates = false;

  this.crossContextParams.forEach(param => {
    try {
      const newValue = this.evaluateParameter(param);
      const key = this.getParameterKey(param);

      // Only update if value changed
      if (this.lastParamValues[key] !== newValue) {
        paramUpdates[key] = newValue;
        this.lastParamValues[key] = newValue;
        hasUpdates = true;
      }
    } catch (error) {
      this.warn('Failed to evaluate parameter:', param.name, error);
    }
  });

  if (hasUpdates) {
    this.workletNode.port.postMessage({
      type: 'updateCrossContext',
      params: paramUpdates,
      timestamp: performance.now()
    });
  }
}

// Initialize parameter tracking
constructor(env) {
  // ... existing constructor ...
  this.lastParamValues = {};
  this.paramUpdateInterval = 16; // ~60fps parameter updates
}
```

## 11. Audio Buffer Management and Memory

**11.1. Add Audio Buffer Pooling**
```javascript
// Efficient memory management for audio buffers
class AudioBufferPool {
  constructor() {
    this.buffers = new Map();
    this.maxBuffers = 32;
    this.bufferSizes = [1024, 2048, 4096, 8192, 16384];
  }

  getBuffer(size, channels = 2) {
    const key = `${size}_${channels}`;
    if (!this.buffers.has(key)) {
      this.buffers.set(key, []);
    }

    const pool = this.buffers.get(key);
    if (pool.length > 0) {
      return pool.pop();
    }

    // Create new buffer if pool empty
    return new Float32Array(size * channels);
  }

  releaseBuffer(buffer, size, channels = 2) {
    const key = `${size}_${channels}`;
    const pool = this.buffers.get(key) || [];

    if (pool.length < this.maxBuffers) {
      buffer.fill(0); // Clear buffer
      pool.push(buffer);
    }
  }
}
```

**11.2. Optimize Worklet Memory Usage**
```javascript
// Reduce memory allocation in audio worklet
generateProcessorCode(playStmt) {
  return `
    class WEFTAudioProcessor extends AudioWorkletProcessor {
      constructor() {
        super();

        // Pre-allocate working buffers
        this.workingBuffer = new Float32Array(128);
        this.tempValues = new Float32Array(16);

        // Initialize all data structures
        ${this.generateInitialization()}
      }

      process(inputs, outputs, parameters) {
        const output = outputs[0];
        const blockSize = output[0].length;

        // Reuse pre-allocated buffer instead of creating new arrays
        for (let i = 0; i < blockSize; i++) {
          const me = this.calculateMeValues(i);
          const leftSample = ${this.compiledExpressions.get('left') || '0.0'};
          const rightSample = ${this.compiledExpressions.get('right') || leftSample};

          output[0][i] = this.clampSample(leftSample);
          if (output[1]) output[1][i] = this.clampSample(rightSample);
        }

        return true;
      }

      clampSample(sample) {
        return Math.max(-1, Math.min(1, isFinite(sample) ? sample : 0));
      }
    }
  `;
}
```

## 12. Enhanced DSP and Effects

**12.1. Add More Audio Processing Functions**
```javascript
// Extend audio function library in worklet
generateAdvancedDSPMethods() {
  return `
    // State-variable filter (more stable than one-pole)
    this.svfFilter = function(signal, cutoff, resonance, type = 'lowpass') {
      const filterId = 'svf_' + Math.floor(cutoff) + '_' + type;
      if (!this.filterState[filterId]) {
        this.filterState[filterId] = { low: 0, high: 0, band: 0, notch: 0 };
      }

      const state = this.filterState[filterId];
      const f = 2.0 * Math.sin(Math.PI * Math.min(0.25, cutoff / sampleRate));
      const q = Math.max(0.5, resonance);
      const qres = 1.0 / q;

      state.low += f * state.band;
      state.high = signal - state.low - qres * state.band;
      state.band += f * state.high;
      state.notch = state.high + state.low;

      switch(type) {
        case 'lowpass': return state.low;
        case 'highpass': return state.high;
        case 'bandpass': return state.band;
        case 'notch': return state.notch;
        default: return state.low;
      }
    };

    // Multi-tap delay with feedback
    this.multiDelay = function(signal, delayTimes, feedbacks, mix = 0.5) {
      let output = signal;

      for (let i = 0; i < delayTimes.length; i++) {
        const delayed = this.delayLine(signal, delayTimes[i], feedbacks[i] || 0.0);
        output += delayed * mix / delayTimes.length;
      }

      return output;
    };

    // Granular synthesis
    this.granularSample = function(buffer, position, grainSize, overlap = 0.5) {
      // Implementation for granular sampling of loaded audio/image data
      if (!buffer || !buffer.data) return 0.0;

      const grainSamples = Math.floor(grainSize * sampleRate);
      const hopSize = Math.floor(grainSamples * (1.0 - overlap));

      // Simplified granular synthesis
      const index = Math.floor(position * buffer.data.length) % buffer.data.length;
      return buffer.data[index] || 0.0;
    };
  `;
}
```

## Implementation Priority for Audio Enhancement

1. **Universal media loading** - Make `load()` work for all media types in audio context
2. **Worklet data transfer** - Copy image/video data to audio worklet for sampling
3. **Improved compilation** - Match WebGL renderer's compilation architecture
4. **Memory optimization** - Add buffer pooling and reduce allocations
5. **Enhanced DSP** - Add more audio processing functions
6. **Parameter sync** - Optimize cross-context parameter updates
7. **Testing** - Verify media-agnostic functionality works correctly

This brings the audio renderer to full parity with the visual renderer while maintaining WEFT's function-based, media-agnostic philosophy.