/**
 * Comprehensive test suite for new WEFT architecture
 * Tests: CPUEvaluator, RenderGraph, Coordinator, Compiler, Runtime
 */

// import { Env } from './src/runtime/runtime-new.js'; // Can't use in Node - needs DOM
import { parse } from './src/lang/parser-new.js';

// Minimal test environment (no DOM dependencies)
class TestEnv {
  constructor() {
    this.spindles = new Map();
    this.instances = new Map();
    this.vars = new Map();
    this.resW = 1080;
    this.resH = 1080;
    this.frame = 0;
    this.startTime = Date.now();
    this.targetFps = 30;
    this.mouse = { x: 0.5, y: 0.5 };
    this.loop = 600;
    this.bpm = 120;
    this.coordinator = null;
  }

  getVar(name) {
    return this.vars.get(name) ?? 0;
  }
}
import { Coordinator } from './src/backends/coordinator.js';
import { CPUEvaluator } from './src/backends/cpu-evaluator.js';
import { RenderGraph } from './src/backends/render-graph.js';
import { compile } from './src/compilers/compiler-new.js';
import { BaseBackend } from './src/backends/base-backend.js';

// Test utilities
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`✅ ${message}`);
    testsPassed++;
  } else {
    console.error(`❌ ${message}`);
    testsFailed++;
  }
}

function assertEquals(actual, expected, message) {
  if (actual === expected) {
    console.log(`✅ ${message}`);
    testsPassed++;
  } else {
    console.error(`❌ ${message}`);
    console.error(`   Expected: ${expected}`);
    console.error(`   Actual: ${actual}`);
    testsFailed++;
  }
}

function assertClose(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) < tolerance) {
    console.log(`✅ ${message}`);
    testsPassed++;
  } else {
    console.error(`❌ ${message}`);
    console.error(`   Expected: ${expected} ± ${tolerance}`);
    console.error(`   Actual: ${actual}`);
    testsFailed++;
  }
}

function section(name) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${name}`);
  console.log('='.repeat(60));
}

function subsection(name) {
  console.log(`\n--- ${name} ---`);
}

// Mock backend for testing
class MockBackend extends BaseBackend {
  constructor(env, name, context) {
    super(env, name, context);
    this.compiled = false;
    this.rendered = false;
    this.cleanedUp = false;
  }

  async compile(ast, env) {
    this.compiled = true;
  }

  render() {
    this.rendered = true;
  }

  cleanup() {
    this.cleanedUp = true;
  }

  canGetValue() {
    return false; // Default: can't get values
  }
}

class EfficientMockBackend extends MockBackend {
  constructor(env, name, context) {
    super(env, name, context);
    this.getValueCalls = 0;
  }

  canGetValue() {
    return true; // This backend CAN get values
  }

  getValue(instName, outName, me) {
    this.getValueCalls++;
    return 42; // Mock value
  }
}

// ============================================================================
// TEST SUITE
// ============================================================================

async function runTests() {
  section('TEST 1: Compiler - Expression Compilation');

  const env = new TestEnv();

  subsection('1.1: Numeric Literals');
  const numExpr = { type: 'Num', v: 3.14 };
  const numFn = compile(numExpr, env);
  const me = { x: 0, y: 0, time: 0, frame: 0, width: 100, height: 100 };
  assertClose(numFn(me, env), 3.14, 0.001, 'Numeric literal compiles');

  subsection('1.2: Me Expressions');
  const meXExpr = { type: 'Me', field: 'x' };
  const meXFn = compile(meXExpr, env);
  me.x = 0.75;
  assertClose(meXFn(me, env), 0.75, 0.001, 'me@x compiles');

  subsection('1.3: Binary Expressions');
  const addExpr = {
    type: 'BinaryExpr',
    left: { type: 'Num', v: 10 },
    right: { type: 'Num', v: 5 },
    op: '+'
  };
  const addFn = compile(addExpr, env);
  assertClose(addFn(me, env), 15, 0.001, 'Addition compiles');

  const mulExpr = {
    type: 'BinaryExpr',
    left: { type: 'Num', v: 3 },
    right: { type: 'Num', v: 4 },
    op: '*'
  };
  const mulFn = compile(mulExpr, env);
  assertClose(mulFn(me, env), 12, 0.001, 'Multiplication compiles');

  subsection('1.4: Unary Expressions');
  const sinExpr = {
    type: 'UnaryExpr',
    op: 'sin',
    expr: { type: 'Num', v: 0 }
  };
  const sinFn = compile(sinExpr, env);
  assertClose(sinFn(me, env), 0, 0.001, 'sin(0) compiles');

  subsection('1.5: Call Expressions');
  const maxExpr = {
    type: 'CallExpr',
    name: 'max',
    args: [
      { type: 'Num', v: 10 },
      { type: 'Num', v: 20 }
    ]
  };
  const maxFn = compile(maxExpr, env);
  assertClose(maxFn(me, env), 20, 0.001, 'max(10, 20) compiles');

  // ============================================================================
  section('TEST 2: RenderGraph - Graph Building');

  const weftCode = `
    noise<r> = me@x + me@y
    color<r, g, b> = noise@r, noise@r * 0.5, 0.2

    display(color@r, color@g, color@b)
  `;

  subsection('2.1: Parse and Build Graph');
  const ast = parse(weftCode);
  assert(ast, 'AST parsed successfully');

  const graph = new RenderGraph(ast, env);
  const graphResult = graph.build();

  assert(graphResult.nodes.size > 0, 'Graph has nodes');
  assert(graphResult.execOrder.length > 0, 'Execution order computed');

  subsection('2.2: Instance Collection');
  assert(graphResult.nodes.has('noise'), 'noise instance collected');
  assert(graphResult.nodes.has('color'), 'color instance collected');

  const noiseNode = graphResult.nodes.get('noise');
  assert(noiseNode.outputs.has('r'), 'noise has @r output');

  const colorNode = graphResult.nodes.get('color');
  assert(colorNode.outputs.has('r'), 'color has @r output');
  assert(colorNode.outputs.has('g'), 'color has @g output');
  assert(colorNode.outputs.has('b'), 'color has @b output');

  subsection('2.3: Dependency Extraction');
  assert(colorNode.deps.has('noise'), 'color depends on noise');

  subsection('2.4: Topological Sort');
  const noiseIndex = graphResult.execOrder.indexOf('noise');
  const colorIndex = graphResult.execOrder.indexOf('color');
  assert(noiseIndex < colorIndex, 'noise comes before color in exec order');

  subsection('2.5: Context Tagging');
  const outputStmts = ast.statements.filter(s =>
    s.type === 'DisplayStmt' || s.type === 'PlayStmt' || s.type === 'RenderStmt'
  );
  graph.tagContexts(outputStmts);

  assert(noiseNode.contexts.has('visual'), 'noise tagged with visual context');
  assert(colorNode.contexts.has('visual'), 'color tagged with visual context');

  const contextsNeeded = graph.getContextsNeeded();
  assert(contextsNeeded.has('visual'), 'visual context needed');

  // ============================================================================
  section('TEST 3: CPUEvaluator - Expression Evaluation');

  subsection('3.1: Create CPUEvaluator');
  const evaluator = new CPUEvaluator(env, graph);
  assert(evaluator, 'CPUEvaluator created');

  subsection('3.2: Evaluate Simple Expression');
  const testMe = {
    x: 0.5,
    y: 0.3,
    time: 1.0,
    frame: 30,
    width: 100,
    height: 100,
    fps: 30,
    loop: 600,
    bpm: 120,
    beat: 0,
    measure: 0,
    abstime: 1.0,
    absframe: 30
  };

  const noiseValue = evaluator.getValue('noise', 'r', testMe);
  assertClose(noiseValue, 0.8, 0.001, 'noise@r = me@x + me@y = 0.5 + 0.3');

  subsection('3.3: Function Caching');
  const cachedValue = evaluator.getValue('noise', 'r', testMe);
  assertClose(cachedValue, 0.8, 0.001, 'Cached function returns same result');

  subsection('3.4: Different Coordinates');
  const testMe2 = { ...testMe, x: 1.0, y: 0.0 };
  const noiseValue2 = evaluator.getValue('noise', 'r', testMe2);
  assertClose(noiseValue2, 1.0, 0.001, 'Different coordinates work');

  subsection('3.5: Dependent Expression');
  const colorR = evaluator.getValue('color', 'r', testMe);
  assertClose(colorR, 0.8, 0.001, 'color@r = noise@r');

  const colorG = evaluator.getValue('color', 'g', testMe);
  assertClose(colorG, 0.4, 0.001, 'color@g = noise@r * 0.5');

  subsection('3.6: Error Handling - Missing Instance');
  const missingInst = evaluator.getValue('nonexistent', 'r', testMe);
  assertEquals(missingInst, 0, 'Missing instance returns 0');

  subsection('3.7: Error Handling - Missing Output');
  const missingOut = evaluator.getValue('noise', 'nonexistent', testMe);
  assertEquals(missingOut, 0, 'Missing output returns 0');

  subsection('3.8: Clear Cache');
  evaluator.clear();
  assert(evaluator.compiledFunctions.size === 0, 'Cache cleared');

  // ============================================================================
  section('TEST 4: Coordinator - Backend Management');

  subsection('4.1: Create Coordinator');
  const coordinator = new Coordinator(ast, env);
  assert(coordinator, 'Coordinator created');

  subsection('4.2: Register Backends');
  const visualBackend = new MockBackend(env, 'webgl', 'visual');
  const audioBackend = new MockBackend(env, 'audio', 'audio');
  const computeBackend = new MockBackend(env, 'cpu', 'compute');

  coordinator.setBackends({
    webgl: visualBackend,
    audio: audioBackend,
    cpu: computeBackend
  });

  assert(coordinator.backends.size === 3, 'Three backends registered');
  assert(coordinator.backends.has('webgl'), 'webgl backend registered');

  subsection('4.3: Context Mapping');
  assert(coordinator.backendsByContext.has('visual'), 'visual context mapped');
  assert(coordinator.backendsByContext.has('audio'), 'audio context mapped');
  assert(coordinator.backendsByContext.has('compute'), 'compute context mapped');

  subsection('4.4: Get Backend for Context');
  const visual = coordinator.getBackendForContext('visual');
  assert(visual === visualBackend, 'visual context returns webgl backend');

  const audio = coordinator.getBackendForContext('audio');
  assert(audio === audioBackend, 'audio context returns audio backend');

  subsection('4.5: Compilation');
  await coordinator.compile();
  assert(visualBackend.compiled, 'Visual backend compiled');
  assert(coordinator.cpuEvaluator, 'CPUEvaluator created during compile');

  subsection('4.6: Rendering');
  coordinator.render();
  assert(visualBackend.rendered, 'Visual backend rendered');

  subsection('4.7: getValue - Backend with canGetValue');
  const efficientBackend = new EfficientMockBackend(env, 'metal', 'visual');

  const coordinator2 = new Coordinator(ast, env);
  coordinator2.setBackends({ metal: efficientBackend });
  await coordinator2.compile();

  const value = coordinator2.getValue('noise', 'r', testMe);
  assertEquals(value, 42, 'Efficient backend getValue called');
  assert(efficientBackend.getValueCalls > 0, 'Backend getValue was called');

  subsection('4.8: getValue - Fallback to CPUEvaluator');
  const regularBackend = new MockBackend(env, 'webgl', 'visual');
  const coordinator3 = new Coordinator(ast, env);
  coordinator3.setBackends({ webgl: regularBackend });
  await coordinator3.compile();

  const value2 = coordinator3.getValue('noise', 'r', testMe);
  assertClose(value2, 0.8, 0.001, 'Falls back to CPUEvaluator when backend cannot getValue');

  subsection('4.9: Cleanup');
  coordinator.cleanup();
  assert(visualBackend.cleanedUp, 'Visual backend cleaned up');
  assert(coordinator.backends.size === 0, 'Backends cleared');
  assert(coordinator.backendsByContext.size === 0, 'Context map cleared');

  // ============================================================================
  section('TEST 5: Integration - Cross-Context Access');

  const crossContextCode = `
    audio<left> = me@x * 440
    visual<r> = audio@left / 1000

    display(visual@r, 0, 0)
  `;

  subsection('5.1: Parse Cross-Context Code');
  const crossAst = parse(crossContextCode);
  assert(crossAst, 'Cross-context AST parsed');

  subsection('5.2: Build Graph');
  const crossGraph = new RenderGraph(crossAst, env);
  crossGraph.build();

  const audioNode = crossGraph.nodes.get('audio');
  const visualNode = crossGraph.nodes.get('visual');

  assert(audioNode, 'audio instance in graph');
  assert(visualNode, 'visual instance in graph');
  assert(visualNode.deps.has('audio'), 'visual depends on audio');

  subsection('5.3: Tag Contexts');
  const crossOutputStmts = crossAst.statements.filter(s => s.type === 'DisplayStmt');
  crossGraph.tagContexts(crossOutputStmts);

  assert(visualNode.contexts.has('visual'), 'visual tagged with visual context');
  // audio should also get visual context because visual depends on it
  assert(audioNode.contexts.has('visual'), 'audio tagged with visual context (dependency)');

  subsection('5.4: Evaluate Cross-Context Expression');
  const crossEvaluator = new CPUEvaluator(env, crossGraph);
  const crossMe = { ...testMe, x: 1.0 };

  const audioLeft = crossEvaluator.getValue('audio', 'left', crossMe);
  assertClose(audioLeft, 440, 0.001, 'audio@left = me@x * 440 = 1.0 * 440');

  const visualR = crossEvaluator.getValue('visual', 'r', crossMe);
  assertClose(visualR, 0.44, 0.001, 'visual@r = audio@left / 1000 = 440 / 1000');

  // ============================================================================
  section('TEST 6: Coordinator Timing Control');

  subsection('6.1: Start/Stop');
  const timingCoord = new Coordinator(ast, env);
  timingCoord.setBackends({ webgl: new MockBackend(env, 'webgl', 'visual') });
  await timingCoord.compile();

  assert(!timingCoord.running, 'Initially not running');

  timingCoord.start();
  assert(timingCoord.running, 'Started successfully');
  assert(timingCoord.frameId !== null, 'Frame ID set');

  timingCoord.stop();
  assert(!timingCoord.running, 'Stopped successfully');
  assert(timingCoord.frameId === null, 'Frame ID cleared');

  // ============================================================================
  section('TEST SUMMARY');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Total Tests: ${testsPassed + testsFailed}`);
  console.log(`✅ Passed: ${testsPassed}`);
  console.log(`❌ Failed: ${testsFailed}`);
  console.log(`Success Rate: ${((testsPassed / (testsPassed + testsFailed)) * 100).toFixed(1)}%`);
  console.log('='.repeat(60));

  if (testsFailed === 0) {
    console.log('\n🎉 ALL TESTS PASSED! 🎉\n');
  } else {
    console.log(`\n⚠️  ${testsFailed} test(s) failed\n`);
    process.exit(1);
  }
}

// Run tests
runTests().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
