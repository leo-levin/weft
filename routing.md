# WEFT Routing Architecture

The routing system determines how different parts of the WEFT AST get compiled and executed across different computational contexts (GPU, CPU, Audio).

## Core Principles

### Display-Driven Routing
**Key insight**: The execution context should be determined by **display statements**, not by internal dependencies within expressions.

This means users write expressions with abstract placeholders (`me.x`, `me.y`, `me.time`) and the display statement determines:
- What execution context to use (GPU visual, Audio worklet, CPU)
- What coordinate system to resolve placeholders to
- What refresh rate/resolution to target

### Abstract Environment Placeholders
Environment variables like `me.x`, `me.y`, `me.time` are **abstract coordinate placeholders** that get resolved differently based on display context:

```weft
// Same expression, different contexts
pattern = sin(me.x * 10) * cos(me.y * 10)

display(r: pattern, g: 0, b: 0, width: 1920, height: 1080, fps: 60)
// me.x: 0-1920, me.y: 0-1080, me.time: frame time (60fps)

display(r: pattern, g: 0, b: 0, width: 256, height: 256, fps: 30)
// me.x: 0-256, me.y: 0-256, me.time: frame time (30fps)

display(audio: pattern * 0.1, rate: 44100)
// me.x: undefined?, me.y: undefined?, me.time: sample time
```

## Time Hierarchy

WEFT supports multiple time domains, inspired by TouchDesigner:

- **Absolute time**: Continuous, infinite time that keeps going
- **Project time**: Continuous but loops/cycles over project duration
- **Frame time**: Discrete visual samples (60fps, 120fps, etc.)
- **Sample time**: Discrete audio samples (44.1kHz, 48kHz, etc.)
- **Beat time**: Musical time divisions (tempo-synced, BPM-based)

The abstract `me.time` gets resolved to the appropriate time domain based on display context.

## Execution Routes & Compilation Strategies

### 1. GPU Visual (WebGL Fragment Shader)
- **Trigger**: Display statements with visual parameters (width, height, fps)
- **Purpose**: Parallel pixel computation at specified framerate
- **Compilation Process**:
  - Analyze WEFT AST for mathematical expressions
  - Generate GLSL fragment shader code
  - Map `me.x` → `gl_FragCoord.x`, `me.y` → `gl_FragCoord.y`
  - Inject reactive inputs as `uniform` declarations
  - Compile shader once, update uniforms per frame
- **Coordinate resolution**:
  - `me.x`, `me.y` → pixel coordinates (0 to width/height)
  - `me.time` → frame time domain
- **Reactive inputs**: `mouse@x` → `uniform float u_mouseX`
- **Update frequency**: Specified fps (default 60fps)
- **Time domain**: Frame time (discrete visual samples)
- **Performance**: Massively parallel (thousands of pixels simultaneously)
- **Limitations**: No dynamic control flow, limited memory access

### 2. Audio (Web Audio API / Audio Worklet)
- **Trigger**: Display statements with audio parameters (rate, channels)
- **Purpose**: Sample-rate audio generation
- **Compilation Process**:
  - Generate Audio Worklet processor JavaScript
  - Set up parameter automation for reactive inputs
  - Handle sample-by-sample computation
  - Map `me.time` to sample position in audio buffer
- **Coordinate resolution**:
  - `me.time` → sample time domain (sample index / sample rate)
  - `me.x`, `me.y` → undefined or repurposed (e.g., stereo pan, frequency)
- **Reactive inputs**: `mouse@x` → audio parameter (frequency, amplitude, etc.)
- **Update frequency**: Audio sample rate (44.1kHz = 44,100 samples/second)
- **Time domain**: Sample time (discrete audio samples)
- **Performance**: Real-time constraint, must process 128-sample blocks quickly
- **Limitations**: Limited computation per sample, real-time requirements

### 3. CPU (JavaScript)
- **Trigger**: Complex logic, fallback, explicit CPU display targets
- **Purpose**: Sequential computation, I/O, dynamic control flow
- **Compilation Process**:
  - Direct AST interpretation (current runtime.js approach)
  - Recursive expression evaluation
  - Dynamic variable resolution
  - Support for complex control structures
- **Coordinate resolution**: Flexible, context-dependent
- **Reactive inputs**: All inputs naturally reactive through variable system
- **Update frequency**: On-demand / event-driven
- **Time domain**: Event time (user interactions, timers)
- **Performance**: Sequential, slower but flexible
- **Use cases**: Complex logic, debugging, prototyping, I/O operations

### 4. Extensions (Optional)
- **Storage/Network routes**: Only added when `me.storage` or `me.network` features are needed
- **Web Workers**: For CPU-intensive tasks that need to run off main thread
- **Not core**: These extend the basic 3-route system for specialized use cases

## Display Statement Design

### Named Arguments Syntax
```weft
// Visual output - GPU Visual route
display(r: red_expr, g: green_expr, b: blue_expr, width: 1920, height: 1080, fps: 60)

// Packed color - GPU Visual route
display(rgb: color_expr, width: 1920, height: 1080, fps: 60)

// Audio output - Audio Worklet route
display(audio: stereo_expr, rate: 44100, channels: 2)
display(left: left_expr, right: right_expr, rate: 44100)

// Debug/logging - CPU route
display(value: debug_expr, target: "console", throttle: 100)

// Storage - Storage route
display(data: state_expr, target: "storage", key: "session_data")

// Network - Network route
display(stream: data_expr, target: "websocket", endpoint: "ws://...")

// Heavy computation - Web Worker route
display(result: complex_expr, target: "worker", batch_size: 1000)
```

### Route Selection Logic
The router analyzes display parameters to choose execution route:

- **Visual parameters** (`width`, `height`, `fps`) → GPU Visual
- **Audio parameters** (`rate`, `channels`, `audio`) → Audio Worklet
- **Target: "console"** → CPU Immediate
- **Target: "storage"** → Storage/Persistence
- **Target: "websocket"** → Network/Streaming
- **Target: "worker"** → CPU Background
- **Complex expressions** → CPU fallback

### Defaults and Inference
```weft
display(r: expr, g: expr, b: expr)           // Default: 720p@60fps (GPU Visual)
display(rgb: expr)                           // Default: 720p@60fps (GPU Visual)
display(audio: expr)                         // Default: 44.1kHz stereo (Audio Worklet)
display(value: expr)                         // Default: console (CPU Immediate)
```

## Router Implementation Strategy

### Static Analysis Phase
1. **Find display statements**: Scan AST for all display calls
2. **Determine contexts**: Each display statement defines an execution context
3. **Analyze dependencies**: What expressions feed into each display
4. **Tag expressions with routes**: Mark each expression with its execution context(s)
5. **Classify expressions**:
   - `STATIC`: Pure math, constants → compile once
   - `UNIFORM`: Depends on reactive inputs → pass as uniform/parameter
   - `DYNAMIC`: Complex logic → force CPU execution
   - `CROSS_CONTEXT`: Used by multiple routes → needs data bridges

## AST Route Tagging System

### Expression Route Tags
Each AST node gets tagged with route information during analysis:

```javascript
class ASTNode {
  constructor(type, value) {
    this.type = type;
    this.value = value;
    this.routes = new Set();        // Which routes need this expression
    this.primaryRoute = null;       // Where this expression executes
    this.dependencies = new Set();  // What this expression depends on
    this.crossContext = false;      // Does this span multiple contexts?
  }
}

// Example tagging process
function tagExpressionRoutes(ast) {
  // 1. Find all display statements and their required routes
  const displays = findDisplayStatements(ast);
  const routeMap = new Map();
  
  displays.forEach(display => {
    const route = determineRoute(display.parameters);
    routeMap.set(display.id, route);
  });
  
  // 2. Propagate route tags backward through dependencies
  displays.forEach(display => {
    const route = routeMap.get(display.id);
    propagateRouteTags(display.expressions, route);
  });
  
  // 3. Identify cross-context expressions
  identifyCrossContextExpressions(ast);
  
  return ast;
}

function propagateRouteTags(expressions, route) {
  expressions.forEach(expr => {
    expr.routes.add(route);
    
    // Recursively tag dependencies
    expr.dependencies.forEach(dep => {
      dep.routes.add(route);
      propagateRouteTags([dep], route);
    });
  });
}
```

### Route Assignment Rules

**Single Route (Most Common)**:
```weft
// Simple GPU visual expression
pattern = sin(me.x * 10) * cos(me.y * 10)
display(rgb: pattern, fps: 60)
// → pattern tagged: { routes: ['gpu'], primaryRoute: 'gpu' }
```

**Multi-Route (Cross-Context)**:
```weft
// Expression used by both GPU and Audio
freq = mouse@x * 440
visual_wave = sin(me.x * freq)    // GPU route
audio_wave = sin(me.time * freq)  // Audio route
display(rgb: visual_wave, fps: 60)
display(audio: audio_wave, rate: 44100)
// → freq tagged: { routes: ['gpu', 'audio'], primaryRoute: 'cpu', crossContext: true }
```

### Multi-Route Assignment Strategy

When expressions are needed by multiple routes, the system uses these rules:

**Primary Route Selection**:
```javascript
function selectPrimaryRoute(expression) {
  const routes = expression.routes;
  
  // Rule 1: If only one route needs it, that's primary
  if (routes.size === 1) {
    return routes.values().next().value;
  }
  
  // Rule 2: If expression contains route-specific constructs, prefer that route
  if (containsGPUConstructs(expression)) return 'gpu';
  if (containsAudioConstructs(expression)) return 'audio';
  
  // Rule 3: Complex logic goes to CPU
  if (hasComplexLogic(expression)) return 'cpu';
  
  // Rule 4: Default hierarchy: CPU → GPU → Audio
  if (routes.has('cpu')) return 'cpu';
  if (routes.has('gpu')) return 'gpu';
  return 'audio';
}

function containsGPUConstructs(expr) {
  // Check for me.x, me.y (spatial coordinates)
  return hasEnvironmentAccess(expr, ['x', 'y']);
}

function containsAudioConstructs(expr) {
  // Check for high-frequency time access (sample rate)
  return hasHighFrequencyTime(expr);
}
```

**Cross-Context Data Bridge Creation**:
```javascript
function createDataBridges(expression) {
  if (!expression.crossContext) return [];
  
  const bridges = [];
  const primaryRoute = expression.primaryRoute;
  
  // Create bridges from primary route to all other routes that need this data
  expression.routes.forEach(targetRoute => {
    if (targetRoute !== primaryRoute) {
      const bridge = new DataBridge(
        primaryRoute, 
        targetRoute, 
        inferDataType(expression)
      );
      bridges.push(bridge);
    }
  });
  
  return bridges;
}
```

### Compilation Phase
1. **Generate execution artifacts**:
   - GPU Visual → Fragment shader with uniform placeholders
   - GPU Compute → Compute shader with buffer management
   - Audio → Audio Worklet processor JavaScript
   - CPU → Direct AST interpretation setup
   - Storage → Query/transaction generators
   - Network → Protocol handlers and serializers
   - Workers → Serialized computation with message passing
2. **Resolve coordinate systems**: Map abstract placeholders to concrete coordinates
3. **Handle reactive inputs**: Set up uniform/parameter passing for dynamic values
4. **Time domain mapping**: Translate abstract `me.time` to appropriate time context

### Runtime Coordination
1. **Update uniforms/parameters**: Push reactive values to compiled artifacts
2. **Synchronize contexts**: Coordinate data flow between execution contexts
3. **Handle time domains**: Manage different update frequencies
4. **Cross-context communication**: Enable data flow between routes

## Cross-Context Data Flow & Coordinator Architecture

### The Problem
Different execution routes (GPU, Audio, CPU) run at different frequencies and have different data flow requirements:
- GPU Visual: 60fps frame-based updates
- Audio: 44.1kHz sample-based processing  
- CPU: Event-driven or on-demand computation

When expressions span multiple contexts, the system needs orchestrated execution with proper dependency resolution.

### Example Scenarios
```weft
// Scenario 1: Audio frequency controls visual pattern
freq = audio_analysis(mic_input)  // CPU route (audio analysis)
pattern = sin(me.x * freq * 10)   // GPU route (visual)
display(rgb: pattern, fps: 60)

// Scenario 2: Visual analytics drive audio synthesis
brightness = avg(visual_pattern)  // GPU→CPU reduction
tone = brightness * 440          // CPU computation
display(audio: sin(me.time * tone * 2 * pi), rate: 44100)

// Scenario 3: Multi-rate temporal coordination
beat = tempo_sync(120)           // CPU route (timing)
flash = beat > 0.8 ? 1 : 0      // CPU route (logic)
wobble = sin(me.time * 5)       // Audio rate computation
display(r: flash, g: 0, b: 0, fps: 60)      // GPU visual
display(audio: wobble * flash, rate: 44100)  // Audio output
```

### Coordinator Architecture

The **Coordinator** is the central orchestration system that manages execution order, data flow, and synchronization across all routes.

#### Coordinator Responsibilities
1. **Dependency Analysis**: Build execution graph from AST dependencies
2. **Execution Scheduling**: Order route execution based on data dependencies  
3. **Data Bridge Management**: Handle data flow between different execution contexts
4. **Time Domain Synchronization**: Coordinate different update frequencies
5. **Buffer Management**: Manage shared data buffers between routes
6. **Error Handling**: Graceful degradation when routes fail

#### Coordinator Data Structures

```javascript
class ExecutionCoordinator {
  constructor() {
    this.routes = new Map();           // route_id → RouteExecutor
    this.dependencies = new Graph();   // execution dependency graph
    this.dataBridges = new Map();     // cross-context data channels
    this.timeSync = new TimeManager(); // time domain coordination
    this.buffers = new BufferPool();   // shared memory management
  }
}

class RouteExecutor {
  constructor(type, context, compiledArtifact) {
    this.type = type;           // 'gpu', 'audio', 'cpu'
    this.context = context;     // WebGL context, AudioWorklet, etc.
    this.artifact = compiledArtifact;  // shader, worklet, function
    this.inputs = new Map();    // input data channels
    this.outputs = new Map();   // output data channels
    this.frequency = null;      // update frequency (60fps, 44.1kHz, etc.)
  }
}
```

### Dependency Resolution & Execution Ordering

#### Static Analysis Phase
```javascript
// 1. Build dependency graph from AST
function analyzeDependencies(ast) {
  const graph = new DependencyGraph();
  
  // Find all display statements (execution endpoints)
  const displays = findDisplayStatements(ast);
  
  // Trace backwards through expression dependencies
  displays.forEach(display => {
    const route = determineRoute(display);
    const deps = traceExpressionDependencies(display.expressions);
    graph.addRoute(route, deps);
  });
  
  // Detect cross-context dependencies
  const crossContextDeps = findCrossContextDependencies(graph);
  
  return { graph, crossContextDeps };
}

// 2. Determine execution order
function createExecutionPlan(dependencyGraph) {
  // Topological sort to determine execution order
  const executionOrder = topologicalSort(dependencyGraph);
  
  // Group by update frequency for batched execution
  const frequencyGroups = groupByFrequency(executionOrder);
  
  return { executionOrder, frequencyGroups };
}
```

#### Data Bridge System
Cross-context data flow requires **Data Bridges** - managed data channels between routes:

```javascript
class DataBridge {
  constructor(sourceRoute, targetRoute, dataType) {
    this.source = sourceRoute;
    this.target = targetRoute;
    this.dataType = dataType;      // 'scalar', 'array', 'texture', 'audio_buffer'
    this.buffer = null;            // shared data buffer
    this.lastUpdate = 0;           // timestamp tracking
    this.interpolation = 'hold';   // 'hold', 'linear', 'cubic'
  }
  
  // Handle frequency mismatch between source and target
  resample(sourceData, sourceFrequency, targetFrequency) {
    // No resampling needed if frequencies match
    if (sourceFrequency === targetFrequency) return sourceData;
    
    switch(this.interpolation) {
      case 'hold': return this.holdLast(sourceData, targetFrequency);
      case 'linear': return this.linearInterpolate(sourceData, sourceFrequency, targetFrequency);
      case 'cubic': return this.cubicInterpolate(sourceData, sourceFrequency, targetFrequency);
    }
  }
  
  // Hold-and-sample resampling (zero-order hold)
  holdLast(sourceData, targetFrequency) {
    // Simply repeat the last value until new data arrives
    // Used for: CPU(event) → GPU(60fps), CPU(event) → Audio(44.1kHz)
    return this.lastValue !== null ? this.lastValue : sourceData;
  }
  
  // Linear interpolation resampling
  linearInterpolate(sourceData, sourceFreq, targetFreq) {
    // Used for: GPU(60fps) ↔ Audio(44.1kHz) conversions
    const ratio = sourceFreq / targetFreq;
    
    if (ratio > 1) {
      // Downsampling: source faster than target
      return this.downsample(sourceData, ratio);
    } else {
      // Upsampling: source slower than target  
      return this.upsample(sourceData, ratio);
    }
  }
  
  downsample(data, ratio) {
    // Take every Nth sample where N = ratio
    const result = [];
    for (let i = 0; i < data.length; i += Math.floor(ratio)) {
      result.push(data[i]);
    }
    return result;
  }
  
  upsample(data, ratio) {
    // Interpolate between samples
    const result = [];
    const expandFactor = Math.floor(1 / ratio);
    
    for (let i = 0; i < data.length - 1; i++) {
      result.push(data[i]);
      
      // Add interpolated values between samples
      for (let j = 1; j < expandFactor; j++) {
        const t = j / expandFactor;
        const interpolated = data[i] * (1 - t) + data[i + 1] * t;
        result.push(interpolated);
      }
    }
    
    return result;
  }

## Resampling Scenarios & Strategies

### Common Resampling Cases

**1. CPU Event → GPU Visual (Event → 60fps)**
```javascript
// mouse@x changes sporadically, GPU needs 60fps updates
const bridge = new DataBridge('cpu', 'gpu', 'scalar');
bridge.interpolation = 'hold';  // Hold last mouse position

// Runtime resampling:
// CPU: mouse@x = 0.5 (at t=100ms)
// GPU: uniform u_mouseX = 0.5 (held for frames 6,7,8,9,10...)
```

**2. GPU Visual → CPU Analysis (60fps → Event)**
```javascript  
// Analyze average brightness from GPU texture
const bridge = new DataBridge('gpu', 'cpu', 'texture');
bridge.interpolation = 'hold';  // CPU reads latest GPU result when needed

// Runtime resampling:
// GPU: renders 60fps → texture buffer
// CPU: reads texture data on-demand for analysis
```

**3. GPU Visual ↔ Audio (60fps ↔ 44.1kHz)**
```javascript
// Visual frequency controls audio, or audio analysis controls visuals
const bridge = new DataBridge('gpu', 'audio', 'array');
bridge.interpolation = 'linear';  // Smooth interpolation between different rates

// Runtime resampling:
// 60fps → 44.1kHz: upsample by factor of ~735x (44100/60)
// 44.1kHz → 60fps: downsample by factor of ~735x
```

**4. CPU → Audio (Event → 44.1kHz)**
```javascript
// BPM tempo affects audio synthesis
const bridge = new DataBridge('cpu', 'audio', 'scalar');
bridge.interpolation = 'hold';  // Hold tempo until next beat

// Runtime resampling:
// CPU: bpm = 120 (at beat boundaries)
// Audio: parameter held constant between beat events
```

### Resampling Implementation

**Buffer Management for Different Frequencies**:
```javascript
class ResamplingBuffer {
  constructor(sourceFreq, targetFreq, bufferSize = 1024) {
    this.sourceFreq = sourceFreq;
    this.targetFreq = targetFreq;
    this.ratio = sourceFreq / targetFreq;
    this.buffer = new Float32Array(bufferSize);
    this.writeIndex = 0;
    this.readIndex = 0;
  }
  
  // Write data from source route
  write(data) {
    // Handle array or scalar data
    if (Array.isArray(data)) {
      data.forEach(sample => this.writeSample(sample));
    } else {
      this.writeSample(data);
    }
  }
  
  // Read data for target route with resampling
  read(numSamples) {
    const output = new Float32Array(numSamples);
    
    for (let i = 0; i < numSamples; i++) {
      output[i] = this.readSampleWithInterpolation();
    }
    
    return output;
  }
  
  readSampleWithInterpolation() {
    // Linear interpolation between buffer samples
    const exactIndex = this.readIndex;
    const lowerIndex = Math.floor(exactIndex);
    const upperIndex = Math.ceil(exactIndex);
    const fraction = exactIndex - lowerIndex;
    
    const lowerSample = this.buffer[lowerIndex % this.buffer.length];
    const upperSample = this.buffer[upperIndex % this.buffer.length];
    
    this.readIndex += this.ratio;
    
    return lowerSample * (1 - fraction) + upperSample * fraction;
  }
}
}
```

## Complete AST Tagging & Resampling Workflow

### Phase 1: AST Analysis & Tagging
```javascript
function analyzeAndTagAST(ast) {
  // Step 1: Find all display statements
  const displays = findDisplayStatements(ast);
  
  // Step 2: Determine route for each display
  const routeAssignments = new Map();
  displays.forEach(display => {
    const route = determineRoute(display.parameters);
    routeAssignments.set(display.id, route);
  });
  
  // Step 3: Propagate route tags through dependency graph
  displays.forEach(display => {
    const route = routeAssignments.get(display.id);
    tagExpressionTree(display.expressions, route);
  });
  
  // Step 4: Identify cross-context expressions
  const crossContextExprs = findCrossContextExpressions(ast);
  
  // Step 5: Select primary routes for cross-context expressions
  crossContextExprs.forEach(expr => {
    expr.primaryRoute = selectPrimaryRoute(expr);
    expr.crossContext = true;
  });
  
  return { ast, crossContextExprs, routeAssignments };
}

function tagExpressionTree(expressions, route) {
  expressions.forEach(expr => {
    expr.routes.add(route);
    
    // Recursively tag all dependencies
    if (expr.dependencies) {
      tagExpressionTree(expr.dependencies, route);
    }
  });
}
```

### Phase 2: Data Bridge Creation
```javascript
function createDataBridges(crossContextExprs) {
  const bridges = new Map();
  
  crossContextExprs.forEach(expr => {
    const primaryRoute = expr.primaryRoute;
    
    // Create bridges from primary route to all consumer routes
    expr.routes.forEach(targetRoute => {
      if (targetRoute !== primaryRoute) {
        const bridgeKey = `${expr.id}_${primaryRoute}_${targetRoute}`;
        
        const bridge = new DataBridge(
          primaryRoute,
          targetRoute,
          inferDataType(expr),
          selectInterpolationMethod(primaryRoute, targetRoute)
        );
        
        bridges.set(bridgeKey, bridge);
      }
    });
  });
  
  return bridges;
}

function selectInterpolationMethod(sourceRoute, targetRoute) {
  // Event-driven sources use 'hold'
  if (sourceRoute === 'cpu') return 'hold';
  
  // High-frequency conversions use 'linear'
  if ((sourceRoute === 'gpu' && targetRoute === 'audio') ||
      (sourceRoute === 'audio' && targetRoute === 'gpu')) {
    return 'linear';
  }
  
  // Default to 'hold' for safety
  return 'hold';
}
```

### Phase 3: Runtime Execution & Resampling
```javascript
class RuntimeCoordinator {
  constructor(ast, bridges, routeExecutors) {
    this.ast = ast;
    this.bridges = bridges;
    this.executors = routeExecutors;
    this.lastExecutionTime = performance.now();
  }
  
  // Main execution loop
  tick() {
    const currentTime = performance.now();
    
    // 1. Determine which routes need updates
    const routesToUpdate = this.scheduleRoutes(currentTime);
    
    // 2. Execute routes in dependency order
    routesToUpdate.forEach(routeType => {
      this.executeRoute(routeType, currentTime);
    });
    
    // 3. Update data bridges with resampling
    this.updateDataBridges(currentTime);
    
    this.lastExecutionTime = currentTime;
  }
  
  executeRoute(routeType, currentTime) {
    const executor = this.executors.get(routeType);
    
    // Execute route and capture outputs
    const outputs = executor.execute(currentTime);
    
    // Store outputs in bridges for cross-context access
    outputs.forEach((value, expressionId) => {
      this.updateBridgeOutputs(expressionId, routeType, value, currentTime);
    });
  }
  
  updateBridgeOutputs(expressionId, sourceRoute, value, currentTime) {
    // Find all bridges where this expression is the source
    this.bridges.forEach((bridge, bridgeKey) => {
      if (bridgeKey.startsWith(`${expressionId}_${sourceRoute}`)) {
        // Write to bridge with timestamp
        bridge.write(value, currentTime);
      }
    });
  }
  
  updateDataBridges(currentTime) {
    this.bridges.forEach(bridge => {
      // Get target route executor
      const targetExecutor = this.executors.get(bridge.target);
      
      // Read resampled data from bridge
      const resampledData = bridge.readForTarget(
        targetExecutor.getRequiredSamples(),
        targetExecutor.frequency,
        currentTime
      );
      
      // Update target route with resampled data
      targetExecutor.updateCrossContextInputs(bridge.expressionId, resampledData);
    });
  }
}
```

### Time Synchronization & Buffer Management

#### Multi-Rate Synchronization
Different routes update at different frequencies, requiring careful synchronization:

```javascript
class TimeManager {
  constructor() {
    this.masterClock = performance.now();
    this.contexts = new Map([
      ['visual', { frequency: 60, lastUpdate: 0, phase: 0 }],
      ['audio', { frequency: 44100, lastUpdate: 0, phase: 0 }],
      ['cpu', { frequency: 'event', lastUpdate: 0, phase: 0 }]
    ]);
  }
  
  // Coordinate execution timing across contexts
  scheduleExecution() {
    const currentTime = performance.now();
    const readyRoutes = [];
    
    this.contexts.forEach((context, type) => {
      if (this.shouldUpdate(context, currentTime)) {
        readyRoutes.push(type);
      }
    });
    
    return readyRoutes;
  }
  
  // Handle time domain conversion
  convertTime(time, fromDomain, toDomain) {
    // Convert between frame time, sample time, absolute time, etc.
    switch(`${fromDomain}->${toDomain}`) {
      case 'frame->sample': return time * (44100 / 60);
      case 'sample->frame': return time * (60 / 44100);
      case 'absolute->frame': return (time * 60) % Number.MAX_SAFE_INTEGER;
      // ... other conversions
    }
  }
}
```

#### Buffer Pool Management
Efficient memory management for cross-context data:

```javascript
class BufferPool {
  constructor() {
    this.scalarBuffers = new Map();    // single values
    this.arrayBuffers = new Map();     // Float32Array, etc.
    this.textureBuffers = new Map();   // WebGL textures
    this.audioBuffers = new Map();     // AudioBuffer objects
  }
  
  // Get or create shared buffer for cross-context data
  getBuffer(key, type, size) {
    const bufferMap = this.getBufferMap(type);
    
    if (!bufferMap.has(key)) {
      bufferMap.set(key, this.createBuffer(type, size));
    }
    
    return bufferMap.get(key);
  }
  
  // Handle GPU↔CPU data transfer
  transferGPUtoCPU(textureBuffer) {
    // Read texture data back to CPU (expensive operation)
    const pixels = new Float32Array(textureBuffer.width * textureBuffer.height * 4);
    gl.readPixels(0, 0, textureBuffer.width, textureBuffer.height, gl.RGBA, gl.FLOAT, pixels);
    return pixels;
  }
}

## Reactive Input Handling

### Problem
GPU shaders and Audio Worklets can't be dynamically rebuilt for reactive inputs like `mouse@x`.

### Solution: Uniform/Parameter Injection
```weft
// WEFT expression
sin(mouse@x * me.x)

// GPU Visual compilation
sin(u_mouseX * gl_FragCoord.x)

// Audio Worklet compilation
sin(this.mouseX.value * sampleTime)

// CPU compilation
sin(mouse.x * env.x)
```

**Workflow**:
1. **Compile once**: Generate artifacts with placeholders
2. **Update parameters**: Push reactive values each frame/block/event
3. **Artifacts stay static**: Enable optimization, avoid recompilation

## Benefits

### For Users
- **Simple mental model**: Write expressions with abstract coordinates
- **Flexible reuse**: Same expression works across multiple contexts
- **No route confusion**: Display parameters determine execution automatically
- **Performance transparency**: Router chooses optimal execution strategy

### For Implementation
- **Clean separation**: Display context determines execution route
- **Performance**: Static compilation with dynamic parameters
- **Extensibility**: Easy to add new execution routes
- **Unified system**: Single routing architecture for all contexts

### For Language Design
- **Media agnostic**: Core expressions work across visual/audio/data domains
- **Named arguments**: Extensible parameter system
- **Abstract placeholders**: Flexible coordinate-dependent computation
- **Optimal execution**: Each route optimized for its specific use case