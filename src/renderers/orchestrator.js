import { RenderGraph } from './render-graph.js'

export class Orchestrator {
  constructor(ast, env) {
    this.ast = ast;
    this.env = env;

    this.cpuRenderer = null;
    this.gpuRenderer = null;
    this.audioRenderer = null;

    this.graph = null;
    this.activeRenderers = new Set();

    this.outputStatemets = [];
  }

  setRenderers({cpu, gpu, audio}) {
    this.cpuRenderer = cpu;
    this.gpuRenderer = gpu;
    this.audioRenderer = audio;
  }

  async compile() {
    this.graph = new RenderGraph(this.ast, this.env);
    const graphResult = this.graph.build();

    console.log('[Orchestrator] Render graph built:', {
        nodes: graphResult.nodes.size,
        execOrder: graphResult.execOrder
    });

    this.outputStatements =
      this.ast.statements.filter(stmt =>
            stmt.type === 'DisplayStmt' ||
            stmt.type === 'RenderStmt' ||
            stmt.type === 'PlayStmt' ||
            stmt.type === 'ComputeStmt'
      );

    this.graph.tagContexts(this.outputStatements);

    const contextsNeeded = this.graph.getContextsNeeded();
    console.log('[Orchestrator] Contexts needed:',Array.from(contextsNeeded));

    if (contextsNeeded.has('visual')) {
      this.activeRenderers.add('gpu');
    }
    if(contextsNeeded.has('audio')) {
      this.activeRenderers.add('audio')
    }
    if(contextsNeeded.has('compute')) {
      this.activeRenderers.add('cpu')
    }

    const compilePromises = [];

    if (this.activeRenderers.has('gpu') && this.gpuRenderer) {
      compilePromises.push(
        this.gpuRenderer.compile(this.ast, this.env)
        .then(() => console.log('[Orchestrator] GPU renderer compiled'))
      );
    }

    if (this.activeRenderers.has('cpu') && this.cpuRenderer) {
      compilePromises.push(
        this.cpuRenderer.compile(this.ast, this.env)
        .then(() => console.log('[Orchestrator] CPU renderer compiled'))
      );
    }

    if (this.activeRenderers.has('audio') && this.audioRenderer) {
      compilePromises.push(
        this.audioRenderer.compile(this.ast, this.env)
        .then(() => console.log('[Orchestrator] Audio renderer compiled'))
      );
    }

    await Promise.all(compilePromises);

    console.log('[Orchestrator] Compilation complete');
  }

  render() {
    if (this.activeRenderers.has('gpu') && this.gpuRenderer) {
        this.gpuRenderer.render();
      } else if (this.activeRenderers.has('cpu') && this.cpuRenderer) {
        this.cpuRenderer.render();
      } else if (this.activeRenderers.has('cpu') && this.audioRenderer) {
        this.audioRenderer.render();
      }
  }

  cleanup(){
    if (this.cpuRenderer) this.cpuRenderer.cleanup?.();
    if (this.gpuRenderer) this.gpuRenderer.cleanup?.();
    if (this.audioRenderer) this.audioRenderer.cleanup?.();

    this.activeRenderers.clear();
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