# WEFT Routing System Implementation Tasks

## 1. AST Route Tagging System

**1.1. Extend AST Node Structure**
```javascript
// In parser.js, modify AST node creation:
class ASTNode {
  constructor(type, value) {
    this.type = type;
    this.value = value;
    this.routes = new Set();        // NEW: execution routes
    this.primaryRoute = null;       // NEW: primary execution route  
    this.dependencies = new Set();  // NEW: expression dependencies
    this.crossContext = false;      // NEW: cross-context flag
  }
}
```

**1.2. Create Route Determination Logic**
```javascript
// NEW FILE: src/routing/route-analyzer.js
function determineRoute(displayParams) {
  if (displayParams.width || displayParams.height || displayParams.fps) return 'gpu';
  if (displayParams.audio || displayParams.rate || displayParams.channels) return 'audio';  
  if (displayParams.target === 'console') return 'cpu';
  return 'cpu'; // default
}
```

**1.3. Build Dependency Graph**
```javascript
// In route-analyzer.js
function buildDependencyGraph(ast) {
  const graph = new Map();
  
  function traverse(node, parent = null) {
    if (parent) {
      if (!graph.has(parent)) graph.set(parent, new Set());
      graph.get(parent).add(node);
      node.dependencies.add(parent);
    }
    
    if (node.children) {
      node.children.forEach(child => traverse(child, node));
    }
  }
  
  traverse(ast);
  return graph;
}
```

**1.4. Implement Route Propagation**
```javascript
// In route-analyzer.js
function tagExpressionRoutes(ast) {
  // 1. Find display statements
  const displays = findNodes(ast, 'DisplayStmt');
  
  // 2. Tag display expressions with routes
  displays.forEach(display => {
    const route = determineRoute(display.parameters);
    propagateRoute(display.expressions, route);
  });
  
  // 3. Identify cross-context expressions
  markCrossContextExpressions(ast);
}

function propagateRoute(expressions, route) {
  expressions.forEach(expr => {
    expr.routes.add(route);
    if (expr.dependencies) {
      propagateRoute(Array.from(expr.dependencies), route);
    }
  });
}
```

## 2. Route Executor Interface

**2.1. Create Base Route Executor**
```javascript
// NEW FILE: src/routing/executors/base-executor.js
class RouteExecutor {
  constructor(type) {
    this.type = type;
    this.frequency = null;
    this.inputs = new Map();
    this.outputs = new Map();
  }
  
  // Abstract methods - must implement in subclasses
  compile(expressions) { throw new Error('Must implement compile()'); }
  execute(currentTime) { throw new Error('Must implement execute()'); }
  updateInputs(inputs) { throw new Error('Must implement updateInputs()'); }
  getRequiredSamples() { throw new Error('Must implement getRequiredSamples()'); }
}
```

**2.2. Extract GPU Route Executor**
```javascript  
// NEW FILE: src/routing/executors/gpu-executor.js
class GPURouteExecutor extends RouteExecutor {
  constructor(gl) {
    super('gpu');
    this.gl = gl;
    this.frequency = 60; // fps
    this.shader = null;
    this.uniforms = new Map();
  }
  
  compile(expressions) {
    // Move GLSL generation logic from webgl-renderer.js here
    const glslCode = this.generateGLSL(expressions);
    this.shader = this.compileShader(glslCode);
  }
  
  execute(currentTime) {
    // Move rendering logic from webgl-renderer.js here  
    this.updateUniforms(currentTime);
    this.renderFrame();
    return this.outputs;
  }
  
  generateGLSL(expressions) {
    // Extract from existing webgl-renderer.js
    // Convert WEFT expressions to GLSL fragment shader code
  }
}
```

**2.3. Extract CPU Route Executor**
```javascript
// NEW FILE: src/routing/executors/cpu-executor.js  
class CPURouteExecutor extends RouteExecutor {
  constructor() {
    super('cpu');
    this.frequency = 'event'; // event-driven
    this.environment = new Environment();
  }
  
  compile(expressions) {
    // No compilation needed - direct AST interpretation
    this.expressions = expressions;
  }
  
  execute(currentTime) {
    // Move evaluation logic from runtime.js here
    const results = new Map();
    
    this.expressions.forEach(expr => {
      const value = this.evaluateExpression(expr, this.environment);
      results.set(expr.id, value);
    });
    
    return results;
  }
  
  evaluateExpression(expr, env) {
    // Extract from existing runtime.js
  }
}
```

## 3. Execution Coordinator

**3.1. Create Coordinator Class**
```javascript
// NEW FILE: src/routing/coordinator.js
class ExecutionCoordinator {
  constructor() {
    this.routes = new Map();           // route_type → RouteExecutor
    this.dependencies = new Map();     // dependency graph
    this.dataBridges = new Map();      // cross-context data flow
    this.lastExecutionTime = 0;
  }
  
  addRoute(type, executor) {
    this.routes.set(type, executor);
  }
  
  compile(ast) {
    // 1. Tag routes
    tagExpressionRoutes(ast);
    
    // 2. Group expressions by route
    const routeExpressions = this.groupExpressionsByRoute(ast);
    
    // 3. Compile each route
    routeExpressions.forEach((expressions, routeType) => {
      const executor = this.routes.get(routeType);
      executor.compile(expressions);
    });
    
    // 4. Create data bridges for cross-context expressions
    this.createDataBridges(ast);
  }
  
  execute() {
    const currentTime = performance.now();
    
    // Execute routes in dependency order
    const executionOrder = this.calculateExecutionOrder();
    
    executionOrder.forEach(routeType => {
      const executor = this.routes.get(routeType);
      const outputs = executor.execute(currentTime);
      this.updateDataBridges(routeType, outputs, currentTime);
    });
  }
}
```

**3.2. Add Route Grouping Logic**
```javascript
// In coordinator.js
groupExpressionsByRoute(ast) {
  const routeGroups = new Map();
  
  function traverse(node) {
    if (node.routes && node.routes.size > 0) {
      // Single route expression
      if (node.routes.size === 1) {
        const route = Array.from(node.routes)[0];
        if (!routeGroups.has(route)) routeGroups.set(route, []);
        routeGroups.get(route).push(node);
      }
      // Cross-context expression - goes to primary route
      else {
        const primaryRoute = node.primaryRoute;
        if (!routeGroups.has(primaryRoute)) routeGroups.set(primaryRoute, []);
        routeGroups.get(primaryRoute).push(node);
      }
    }
    
    if (node.children) {
      node.children.forEach(child => traverse(child));
    }
  }
  
  traverse(ast);
  return routeGroups;
}
```

## 4. Audio Route Implementation  

**4.1. Create Audio Route Executor**
```javascript
// NEW FILE: src/routing/executors/audio-executor.js
class AudioRouteExecutor extends RouteExecutor {
  constructor(audioContext) {
    super('audio');
    this.audioContext = audioContext;
    this.frequency = 44100; // sample rate
    this.workletNode = null;
    this.parameters = new Map();
  }
  
  async compile(expressions) {
    // Generate Audio Worklet processor JavaScript
    const processorCode = this.generateWorkletProcessor(expressions);
    
    // Create worklet
    const blob = new Blob([processorCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    
    await this.audioContext.audioWorklet.addModule(url);
    this.workletNode = new AudioWorkletNode(this.audioContext, 'weft-processor');
  }
  
  generateWorkletProcessor(expressions) {
    // Convert WEFT expressions to JavaScript audio processing code
    return `
      class WeftProcessor extends AudioWorkletProcessor {
        process(inputs, outputs, parameters) {
          const output = outputs[0];
          const blockSize = output[0].length;
          
          for (let i = 0; i < blockSize; i++) {
            // Generated WEFT audio expression code here
            const sample = ${this.expressionToJS(expressions[0])};
            output[0][i] = sample;
          }
          
          return true;
        }
      }
      registerProcessor('weft-processor', WeftProcessor);
    `;
  }
}
```

## 5. Data Bridges Implementation

**5.1. Create Data Bridge Class**
```javascript
// NEW FILE: src/routing/data-bridges.js
class DataBridge {
  constructor(sourceRoute, targetRoute, dataType) {
    this.source = sourceRoute;
    this.target = targetRoute;
    this.dataType = dataType;      // 'scalar', 'array', 'texture'
    this.buffer = new Float32Array(1024);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.lastValue = 0;
    this.interpolation = 'hold';   // 'hold', 'linear'
  }
  
  write(value, timestamp) {
    this.buffer[this.writeIndex % this.buffer.length] = value;
    this.writeIndex++;
    this.lastValue = value;
  }
  
  read(numSamples, targetFrequency) {
    if (this.interpolation === 'hold') {
      return new Array(numSamples).fill(this.lastValue);
    }
    
    // Linear interpolation for frequency conversion
    const output = new Float32Array(numSamples);
    const ratio = this.getFrequencyRatio(targetFrequency);
    
    for (let i = 0; i < numSamples; i++) {
      const sourceIndex = this.readIndex + (i * ratio);
      const lowerIndex = Math.floor(sourceIndex);
      const upperIndex = Math.ceil(sourceIndex);
      const fraction = sourceIndex - lowerIndex;
      
      const lowerSample = this.buffer[lowerIndex % this.buffer.length];
      const upperSample = this.buffer[upperIndex % this.buffer.length];
      
      output[i] = lowerSample * (1 - fraction) + upperSample * fraction;
    }
    
    this.readIndex += numSamples * ratio;
    return output;
  }
}
```

**5.2. Integrate Bridges into Coordinator**
```javascript
// Add to coordinator.js
createDataBridges(ast) {
  const crossContextExprs = findCrossContextExpressions(ast);
  
  crossContextExprs.forEach(expr => {
    const primaryRoute = expr.primaryRoute;
    
    expr.routes.forEach(targetRoute => {
      if (targetRoute !== primaryRoute) {
        const bridgeKey = `${expr.id}_${primaryRoute}_${targetRoute}`;
        const bridge = new DataBridge(primaryRoute, targetRoute, 'scalar');
        this.dataBridges.set(bridgeKey, bridge);
      }
    });
  });
}

updateDataBridges(sourceRoute, outputs, currentTime) {
  outputs.forEach((value, expressionId) => {
    // Find bridges where this expression is the source
    this.dataBridges.forEach((bridge, bridgeKey) => {
      if (bridgeKey.startsWith(`${expressionId}_${sourceRoute}`)) {
        bridge.write(value, currentTime);
      }
    });
  });
}
```

## 6. Integration with Main System

**6.1. Modify main.js**
```javascript
// In main.js, replace existing renderer calls:
const coordinator = new ExecutionCoordinator();

// Add route executors
coordinator.addRoute('gpu', new GPURouteExecutor(gl));
coordinator.addRoute('cpu', new CPURouteExecutor());
coordinator.addRoute('audio', new AudioRouteExecutor(audioContext));

// On code change:
function onCodeChange(weftCode) {
  try {
    const ast = parser.parse(weftCode);
    coordinator.compile(ast);
    
    // Start execution loop
    function tick() {
      coordinator.execute();
      requestAnimationFrame(tick);
    }
    tick();
  } catch (error) {
    handleError(error);
  }
}
```

**6.2. Update Parser Integration**  
```javascript
// Modify parser.js to preserve dependency information
// Add dependency tracking to semantic actions
// Ensure AST nodes have proper structure for route tagging
```

## 7. Testing Implementation

**7.1. Create Route Tagging Tests**
```javascript
// NEW FILE: tests/route-tagging.test.js
test('GPU route detection', () => {
  const ast = parser.parse(`
    pattern = sin(me.x * 10)
    display(rgb: pattern, width: 800, height: 600)
  `);
  
  tagExpressionRoutes(ast);
  
  const patternNode = findNode(ast, 'pattern');
  expect(patternNode.routes).toContain('gpu');
  expect(patternNode.primaryRoute).toBe('gpu');
});
```

**7.2. Create Cross-Context Tests**
```javascript
// NEW FILE: tests/cross-context.test.js  
test('Mouse controls visual and audio', () => {
  const ast = parser.parse(`
    freq = mouse@x * 440
    visual = sin(me.x * freq)
    audio_tone = sin(me.time * freq * 2 * pi)
    display(rgb: visual, fps: 60)
    display(audio: audio_tone, rate: 44100)
  `);
  
  const coordinator = setupCoordinator();
  coordinator.compile(ast);
  
  // Test that freq expression is cross-context
  const freqNode = findNode(ast, 'freq');
  expect(freqNode.crossContext).toBe(true);
  expect(freqNode.routes).toContain('gpu');
  expect(freqNode.routes).toContain('audio');
});
```

This implementation order ensures each component builds on the previous ones, with clear dependencies and testable milestones.