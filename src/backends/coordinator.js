import { RenderGraph } from './render-graph.js'
import { CPUEvaluator } from './cpu-evaluator.js'


/*
Future renderers could include:
- Metal
- NativeAudio
- 3d point cloud shit?
- NURBS?
- DataExport (to CSV / JSON)
- VideoExport (encode to video file)
- OSC/NDI
- MIDI
- Web Socket
- uhhhhhhh

- CONTEXTS vs IMPLEMENTATIONS
*/


export class Coordinator {
  constructor(ast, env) {
    this.ast = ast;
    this.env = env;

    this.backends = new Map();
    this.backendsByContext = new Map();

    this.graph = null;
    this.cpuEvaluator = null;
    this.activeBackends = new Set();

    this.outputStatements = [];

    // Timing control
    this.running = false;
    this.frameId = null;
    this.lastFrameTime = 0;
  }

  setBackends(backendMap) {
    for (const [name, backend] of Object.entries(backendMap)) {
      if (backend) {
        this.backends.set(name, backend);
        const ctx = backend.context;
        if (!this.backendsByContext.has(ctx)) {
          this.backendsByContext.set(ctx, []);
        }
        this.backendsByContext.get(ctx).push(name);
      }
    }
  }

  getBackendForContext(context) {
    const names = this.backendsByContext.get(context) || [];
    for (const name of names) {
      const backend = this.backends.get(name);
      if (backend) return backend;
    }
    return null;
  }

  async compile() {
    this.graph = new RenderGraph(this.ast, this.env);
    const graphResult = this.graph.build();

    console.log('[Coordinator] Render graph built:', {
        nodes: graphResult.nodes.size,
        execOrder: graphResult.execOrder
    });

    this.cpuEvaluator = new CPUEvaluator(this.env, this.graph);

    this.outputStatements =
      this.ast.statements.filter(stmt =>
            stmt.type === 'DisplayStmt' ||
            stmt.type === 'RenderStmt' ||
            stmt.type === 'PlayStmt' ||
            stmt.type === 'ComputeStmt'
      );

    this.graph.tagContexts(this.outputStatements);

    const contextsNeeded = this.graph.getContextsNeeded();
    console.log('[Coordinator] Contexts needed:',Array.from(contextsNeeded));

    const compilePromises = [];

    for (const context of contextsNeeded) {
      const backend = this.getBackendForContext(context);
      if (backend) {
        backend.coordinator = this;
        compilePromises.push( backend.compile(this.ast, this.env) .then(() =>
          console.log(`[Coordinator] ${backend.name} compiled`))
        );
      }
    }

    await Promise.all(compilePromises);
    console.log('[Coordinator] Compilation complete');
  }

  render() {
    for (const backend of this.backends.values()) {
      if (backend) {
        backend.render();
      }
    }
  }

  start(){
    if(this.running) return;

    this.running = true;
    this.lastFrameTime = performance.now();
    this.mainLoop();
    console.log('[Coord] render loop started')

  }

  mainLoop() {
    if (!this.running) return;

    const cur_time = performance.now();
    const delta = cur_time - this.lastFrameTime;
    const targetDelta = 1000 / this.env.targetFps;

    if (delta >= targetDelta) {
      this.env.frame++;
      this.render();
      this.lastFrameTime = cur_time;
    }
    this.frameId = requestAnimationFrame(() => this.mainLoop());
  }

  stop() {
    this.running = false;
    if (this.frameId) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
    console.log('[Coord] render loop stopped');
  }

  getValue(instName, outName, me) {
    const node = this.graph.nodes.get(instName);
    if (!node) {
      console.warn(`[Coordinator] Instance "${instName}" not found`);
      return 0;
    }
    const routes = node.contexts;

    for (const context of routes) {
      const backend = this.getBackendForContext(context);
      if (backend && backend.canGetValue()) {
        return backend.getValue(instName, outName, me);
      }
    }

    if (this.cpuEvaluator) {
      return this.cpuEvaluator.getValue(instName, outName, me);
    }

    console.warn(`[Coordinator] No way to evaluate ${instName}@${outName}`);
    return 0;
  }

  cleanup(){
    this.stop();

    for (const backend of this.backends.values()) {
      if (backend && backend.cleanup) {
        backend.cleanup();
      }
    }

    this.backends.clear();
    this.backendsByContext.clear();
    this.activeBackends.clear();
    this.outputStatements = [];
    this.graph = null;
  }

  getGraphData() {
    if (!this.graph) return null;
    return {
      nodes: Array.from(this.graph.nodes.entries()).map(([name,node]) => ({
      name,
      type: node.type,
      outputs: Array.from(node.outputs.keys()),
      deps: Array.from(node.deps),
      requiredOutputs:
      Array.from(node.requiredOutputs),
      contexts: Array.from(node.contexts)
      })),
      execOrder: this.graph.execOrder
    };
  }
}
