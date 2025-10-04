// New architecture main file - wires up the Coordinator and new backend system
import { parse } from '../lang/parser-new.js';
import { Env } from '../runtime/runtime-new.js';
import { Coordinator } from '../backends/coordinator.js';
import { WebGLBackend } from '../backends/webgl-backend-full.js';
import { clamp } from '../utils/math.js';
import { logger } from '../utils/logger.js';
import { match, _ } from '../utils/match.js';
import { highlightWEFT } from './codemirror-weft-mode.js';

console.log('✅ Starting WEFT application (NEW ARCHITECTURE)...');

// Enable debug logging
logger.setFilters({ debug: false, info: false, warn: false, error: true });

// DOM elements
const errorsEl = document.getElementById('errors');
const canvas = document.getElementById('out');
const runBtn = document.getElementById('runBtn');
const autorunBtn = document.getElementById('autorunBtn');
const interpToggle = document.getElementById('interpToggle');
const playPauseBtn = document.getElementById('playPauseBtn');

// Initialize CodeMirror
let editor = null;
function initEditor() {
  const editorContainer = document.getElementById('editorContainer');
  editor = CodeMirror(editorContainer, {
    mode: 'weft',
    lineNumbers: true,
    lineWrapping: true,
    tabSize: 2,
    indentUnit: 2,
    autofocus: true,
    styleActiveLine: true,
    matchBrackets: true,
    autoCloseBrackets: true,
  });
}

// Create environment and coordinator
const env = new Env();
env.canvas = canvas;
let coordinator = null;

// Initialize backends
function initializeBackends() {
  console.log('🔧 Initializing backends...');

  // Create WebGL backend for visual context
  const webglBackend = new WebGLBackend(env, 'webgl', 'visual');

  // Create coordinator and register backends
  coordinator = new Coordinator(null, env);
  coordinator.setBackends({
    webgl: webglBackend
  });

  console.log('✅ Backends initialized');
  return coordinator;
}

// Update AST viewer with clean display
function updateASTViewer(ast) {
  const astViewer = document.getElementById('astViewer');
  if (!astViewer) return;

  try {
    // Simplify AST for display
    const simplified = {
      statements: ast.statements.map(stmt => simplifyNode(stmt))
    };

    astViewer.innerHTML = `<pre style="font-family: monospace; font-size: 11px; line-height: 1.5; padding: 15px; margin: 0; color: #d4d4d4;">${JSON.stringify(simplified, null, 2)}</pre>`;
  } catch (error) {
    astViewer.textContent = `Error displaying AST: ${error.message}`;
  }
}

function simplifyNode(node) {
  if (!node || typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    return node.map(n => simplifyNode(n));
  }

  const simplified = { type: node.type };

  // Add relevant fields based on node type
  if (node.name) simplified.name = node.name;
  if (node.field) simplified.field = node.field;
  if (node.params) simplified.params = node.params;
  if (node.outputs) simplified.outputs = node.outputs;
  if (node.args) simplified.args = node.args.map(a => simplifyNode(a));
  if (node.expr) simplified.expr = simplifyNode(node.expr);
  if (node.value) simplified.value = simplifyNode(node.value);
  if (node.v !== undefined) simplified.v = node.v;
  if (node.op) simplified.op = node.op;
  if (node.left) simplified.left = simplifyNode(node.left);
  if (node.right) simplified.right = simplifyNode(node.right);
  if (node.arg) simplified.arg = simplifyNode(node.arg);
  if (node.func) simplified.func = node.func;
  if (node.base) simplified.base = simplifyNode(node.base);
  if (node.strand) simplified.strand = node.strand;
  if (node.output) simplified.output = node.output;
  if (node.cond) simplified.cond = simplifyNode(node.cond);
  if (node.then) simplified.then = simplifyNode(node.then);
  if (node.else) simplified.else = simplifyNode(node.else);
  if (node.mappings) simplified.mappings = node.mappings.map(m => simplifyNode(m));
  if (node.source) simplified.source = simplifyNode(node.source);
  if (node.target) simplified.target = simplifyNode(node.target);
  if (node.body) simplified.body = simplifyNode(node.body);

  return simplified;
}

function extractDependencies(expr) {
  const deps = [];
  if (!expr) return deps;

  match(expr.type,
    'Var', () => deps.push(expr.name),
    'StrandAccess', () => {
      if (expr.base && expr.base.type === 'Var') {
        deps.push(expr.base.name);
      }
    },
    'Call', () => {
      if (expr.args) {
        expr.args.forEach(arg => deps.push(...extractDependencies(arg)));
      }
    },
    'Binary', () => {
      deps.push(...extractDependencies(expr.left));
      deps.push(...extractDependencies(expr.right));
    },
    'Unary', () => {
      deps.push(...extractDependencies(expr.arg));
    },
    'StrandRemap', () => {
      if (expr.base && expr.base.type === 'Var') {
        deps.push(expr.base.name);
      }
    },
    _, (n) => {}
  );

  return [...new Set(deps)];
}


function renderNodeGraph(nodes, edges, title) {
  if (nodes.length === 0) {
    return `<div style="padding: 20px; color: #666;">No nodes to display</div>`;
  }

  const nodeWidth = 160;
  const nodeHeight = 70;
  const layerSpacingX = 220;
  const nodeSpacingY = 90;
  const leftMargin = 40;
  const topMargin = 70;

  const outgoing = new Map();
  const incoming = new Map();

  nodes.forEach(n => {
    outgoing.set(n.id, []);
    incoming.set(n.id, []);
  });

  edges.forEach(edge => {
    if (outgoing.has(edge.from) && incoming.has(edge.to)) {
      outgoing.get(edge.from).push(edge.to);
      incoming.get(edge.to).push(edge.from);
    }
  });

  const layers = [];
  const nodeLayer = new Map();

  const roots = nodes.filter(n => incoming.get(n.id).length === 0);

  if (roots.length > 0) {
    layers.push(roots.map(n => n.id));
    roots.forEach(n => nodeLayer.set(n.id, 0));
  }

  let currentLayer = 0;
  while (layers[currentLayer]) {
    const nextLayer = new Set();

    layers[currentLayer].forEach(nodeId => {
      outgoing.get(nodeId).forEach(childId => {
        const deps = incoming.get(childId);
        if (deps.every(dep => nodeLayer.has(dep))) {
          const maxDepLayer = Math.max(...deps.map(dep => nodeLayer.get(dep)));
          if (!nodeLayer.has(childId) || nodeLayer.get(childId) < maxDepLayer + 1) {
            nodeLayer.set(childId, maxDepLayer + 1);
            nextLayer.add(childId);
          }
        }
      });
    });

    if (nextLayer.size > 0) {
      layers.push([...nextLayer]);
      currentLayer++;
    } else {
      break;
    }
  }

  nodes.forEach(n => {
    if (!nodeLayer.has(n.id)) {
      nodeLayer.set(n.id, layers.length);
      if (!layers[layers.length]) {
        layers[layers.length] = [];
      }
      layers[layers.length - 1].push(n.id);
    }
  });

  const nodePositions = new Map();
  const maxNodesInLayer = Math.max(...layers.map(l => l.length));

  layers.forEach((layer, layerIdx) => {
    const layerHeight = layer.length * nodeSpacingY;
    const startY = topMargin + (maxNodesInLayer * nodeSpacingY - layerHeight) / 2;

    layer.forEach((nodeId, nodeIdx) => {
      nodePositions.set(nodeId, {
        x: leftMargin + layerIdx * layerSpacingX,
        y: startY + nodeIdx * nodeSpacingY
      });
    });
  });

  const svgWidth = Math.max(600, leftMargin + layers.length * layerSpacingX + nodeWidth + 40);
  const svgHeight = topMargin + maxNodesInLayer * nodeSpacingY + 40;

  let svg = `<svg width="100%" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}" style="font-family: monospace; font-size: 12px; background: rgba(0,0,0,0.2); border-radius: 8px;">`;

  svg += `<defs>
    <linearGradient id="edgeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#4ec9b0;stop-opacity:0.3" />
      <stop offset="100%" style="stop-color:#4ec9b0;stop-opacity:0.6" />
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="2" result="coloredBlur"/>
      <feMerge>
        <feMergeNode in="coloredBlur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>`;

  // Title
  svg += `<text x="20" y="35" fill="#9cdcfe" font-size="16" font-weight="bold">${title}</text>`;
  svg += `<line x1="20" y1="42" x2="${20 + title.length * 9}" y2="42" stroke="#9cdcfe" stroke-width="2" opacity="0.3"/>`;

  // Draw edges
  edges.forEach(edge => {
    const fromPos = nodePositions.get(edge.from);
    const toPos = nodePositions.get(edge.to);

    if (fromPos && toPos) {
      const fromX = fromPos.x + nodeWidth;
      const fromY = fromPos.y + nodeHeight / 2;
      const toX = toPos.x;
      const toY = toPos.y + nodeHeight / 2;

      const dx = toX - fromX;
      const controlX1 = fromX + dx * 0.6;
      const controlX2 = toX - dx * 0.4;

      svg += `<path d="M ${fromX} ${fromY} C ${controlX1} ${fromY}, ${controlX2} ${toY}, ${toX - 5} ${toY}"
              stroke="url(#edgeGradient)" stroke-width="2.5" fill="none"/>`;

      svg += `<path d="M ${toX} ${toY} l -10 -5 l 0 10 z" fill="#4ec9b0" opacity="0.7"/>`;
    }
  });

  // Draw nodes
  nodes.forEach(node => {
    const pos = nodePositions.get(node.id);
    if (!pos) return;

    const color = match(node.type,
      'InstanceBinding', () => '#4ec9b0',
      'Instance', () => '#4ec9b0',
      'DisplayStmt', () => '#c586c0',
      'RenderStmt', () => '#c586c0',
      'EnvAssignment', () => '#569cd6',
      'SpindleDef', () => '#dcdcaa',
      _, () => '#888'
    );

    // Shadow
    svg += `<rect x="${pos.x + 2}" y="${pos.y + 2}" width="${nodeWidth}" height="${nodeHeight}"
            fill="rgba(0,0,0,0.3)" rx="8"/>`;

    // Node box with gradient
    svg += `<rect x="${pos.x}" y="${pos.y}" width="${nodeWidth}" height="${nodeHeight}"
            fill="rgba(20,20,20,0.95)" stroke="${color}" stroke-width="2.5" rx="8"
            filter="url(#glow)"/>`;

    // Accent bar
    svg += `<rect x="${pos.x}" y="${pos.y}" width="4" height="${nodeHeight}"
            fill="${color}" rx="8 0 0 8" opacity="0.8"/>`;

    // Node label
    const labelText = node.label.length > 18 ? node.label.substring(0, 15) + '...' : node.label;
    svg += `<text x="${pos.x + 12}" y="${pos.y + 24}" fill="${color}" font-weight="bold" font-size="13">${labelText}</text>`;

    // Outputs
    if (node.outputs && node.outputs.length > 0) {
      const outputText = node.outputs.join(', ');
      const displayText = outputText.length > 18 ? outputText.substring(0, 15) + '...' : outputText;
      svg += `<text x="${pos.x + 12}" y="${pos.y + 43}" fill="#9cdcfe" font-size="10">▸ ${displayText}</text>`;
    }

    // Expression or contexts
    if (node.expr) {
      const exprText = node.expr.length > 20 ? node.expr.substring(0, 17) + '...' : node.expr;
      svg += `<text x="${pos.x + 12}" y="${pos.y + 60}" fill="#ce9178" font-size="9" opacity="0.8">${exprText}</text>`;
    } else if (node.contexts && node.contexts.length > 0) {
      const ctxText = node.contexts.join(', ');
      const displayCtx = ctxText.length > 18 ? ctxText.substring(0, 15) + '...' : ctxText;
      svg += `<text x="${pos.x + 12}" y="${pos.y + 60}" fill="#dcdcaa" font-size="9" opacity="0.8">ctx: ${displayCtx}</text>`;
    }
  });

  svg += `</svg>`;
  return svg;
}

// Format expression for AST display
function formatExpr(expr) {
  if (!expr) return 'null';
  return match(expr.type,
    'Num', () => expr.v.toString(),
    'Str', () => `"${expr.v}"`,
    'Var', () => expr.name,
    'Me', () => `me@${expr.field}`,
    'Mouse', () => `mouse@${expr.field}`,
    'StrandAccess', () => `${formatExpr(expr.base)}@${expr.output}`,
    'Call', () => `${expr.name}(${expr.args.map(formatExpr).join(', ')})`,
    'Binary', () => `(${formatExpr(expr.left)} ${expr.op} ${formatExpr(expr.right)})`,
    'Unary', () => `${expr.op}${formatExpr(expr.arg)}`,
    'StrandRemap', () => {
      const mappings = expr.mappings.map(m => `${formatExpr(m.source)}~${formatExpr(m.target)}`).join(', ');
      return `${formatExpr(expr.base)}@${expr.strand}(${mappings})`;
    },
    _, (m) => expr.type || 'unknown'
  );
}

// Update graph viewer - show raw graph structure
function updateGraphViewer() {
  const graphViewer = document.getElementById('graphViewer');
  if (!graphViewer || !coordinator || !coordinator.graph) return;

  try {
    const graphData = {
      execOrder: coordinator.graph.execOrder,
      nodes: {}
    };

    for (const [name, node] of coordinator.graph.nodes) {
      graphData.nodes[name] = {
        outputs: Array.from(node.outputs.keys()),
        deps: Array.from(node.deps),
        contexts: Array.from(node.contexts)
      };
    }

    graphViewer.innerHTML = `<pre style="font-family: monospace; font-size: 11px; line-height: 1.4; padding: 15px; margin: 0; color: #d4d4d4;">${JSON.stringify(graphData, null, 2)}</pre>`;
  } catch (error) {
    graphViewer.textContent = `Error displaying graph: ${error.message}`;
  }
}

// Update instance viewer - consistent with AST style
function updateInstanceViewer() {
  const instanceViewer = document.getElementById('instanceViewer');
  if (!instanceViewer || !coordinator || !coordinator.graph) return;

  try {
    let html = '<div style="font-family: monospace; line-height: 1.6;">';

    for (const [name, node] of coordinator.graph.nodes) {
      html += '<div style="margin: 10px 0; padding: 8px; background: rgba(255,255,255,0.03); border-left: 3px solid #4ec9b0; border-radius: 2px;">';
      html += `<div style="color: #4ec9b0; font-weight: bold;">${name}</div>`;
      html += `<div style="margin-left: 15px; color: #9cdcfe;">outputs: ${Array.from(node.outputs.keys()).join(', ')}</div>`;

      if (node.deps.size > 0) {
        html += `<div style="margin-left: 15px; color: #ce9178;">depends: ${Array.from(node.deps).join(', ')}</div>`;
      }

      if (node.contexts.size > 0) {
        html += `<div style="margin-left: 15px; color: #dcdcaa;">contexts: ${Array.from(node.contexts).join(', ')}</div>`;
      }

      html += '</div>';
    }

    html += '</div>';
    instanceViewer.innerHTML = html;
  } catch (error) {
    if (instanceViewer) {
      instanceViewer.textContent = `Error: ${error.message}`;
    }
  }
}

// Canvas sizing - maintain aspect ratio
function fitCanvas() {
  // Skip auto-sizing if user has manually set dimensions via me<width> or me<height>
  if (env.manualResize) {
    canvas.style.width = env.resW + 'px';
    canvas.style.height = env.resH + 'px';
    document.getElementById('resPill').textContent = `${env.resW}×${env.resH}`;
    return;
  }

  const container = canvas.parentElement;
  const containerRect = container.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;

  // Account for container padding (16px on each side = 32px total)
  const padding = 32;
  const aspectRatio = 16 / 9;
  const maxWidth = containerRect.width - padding;
  const maxHeight = containerRect.height - padding;

  let canvasWidth = maxWidth;
  let canvasHeight = maxWidth / aspectRatio;

  // If calculated height exceeds available space, fit to height instead
  if (canvasHeight > maxHeight) {
    canvasHeight = maxHeight;
    canvasWidth = canvasHeight * aspectRatio;
  }

  const width = Math.floor(canvasWidth * scale);
  const height = Math.floor(canvasHeight * scale);

  canvas.width = width;
  canvas.height = height;
  canvas.style.width = Math.floor(canvasWidth) + 'px';
  canvas.style.height = Math.floor(canvasHeight) + 'px';

  env.resW = width;
  env.resH = height;

  document.getElementById('resPill').textContent = `${width}×${height}`;

  console.log(`📐 Canvas resized to: ${width}×${height}`);
}

new ResizeObserver(fitCanvas).observe(canvas);
fitCanvas();

// Mouse tracking
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  env.mouse.x = clamp((e.clientX - rect.left) / rect.width);
  env.mouse.y = clamp((e.clientY - rect.top) / rect.height);
});

// Autorun toggle
env.autorun = false;
autorunBtn.addEventListener('click', () => {
  env.autorun = !env.autorun;
  autorunBtn.classList.toggle('active', env.autorun);
});

// Interpolation toggle
env.interpolate = false;
interpToggle.addEventListener('click', () => {
  env.interpolate = !env.interpolate;
  interpToggle.classList.toggle('active', env.interpolate);
});

// Auto-run on input
let debounceTimer = null;
function setupEditorListeners() {
  editor.on('change', () => {
    localStorage.setItem('weft_code', editor.getValue());

    // Apply syntax highlighting
    highlightWEFT(editor);

    if (!env.autorun) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (window.requestIdleCallback) {
        requestIdleCallback(() => runCode(), { timeout: 1000 });
      } else {
        runCode();
      }
    }, 400);
  });
}

// Play/pause button
let isPlaying = false;
playPauseBtn.addEventListener('click', () => {
  if (!coordinator) return;

  if (isPlaying) {
    coordinator.stop();
    playPauseBtn.textContent = '▶';
    isPlaying = false;
    console.log('⏸ Stopped');
  } else {
    coordinator.start();
    playPauseBtn.textContent = '⏸';
    isPlaying = true;
    console.log('▶ Started');
  }
});

// Run button
runBtn.addEventListener('click', runCode);

// Main execution function
async function runCode() {
  errorsEl.textContent = '';

  // Clear previous logs
  logger.clear();

  // Initialize coordinator if needed
  if (!coordinator) {
    initializeBackends();
  }

  try {
    const src = editor.getValue();
    console.log('📝 Parsing program...', { length: src.length });

    // Parse WEFT code
    const ast = parse(src);
    console.log('✅ AST parsed successfully', {
      statements: ast.statements.length,
      types: ast.statements.map(s => s.type)
    });

    // Reset manual resize flag before processing
    env.manualResize = false;

    // Process environment assignments before compilation
    for (const stmt of ast.statements) {
      if (stmt.type === 'EnvAssignment') {
        const field = stmt.field;
        // Evaluate the expression to get the value
        const value = match(stmt.value.type,
          'Num', () => stmt.value.v,
          _, (n) => {
            console.warn(`EnvAssignment: cannot evaluate ${stmt.value.type} at parse time`);
            return null;
          }
        );
        if (value !== null) {
          console.log(`Setting env.${field} = ${value}`);
          match(field,
            'resW', () => { env.resW = value; canvas.width = value; env.manualResize = true; },
            'resH', () => { env.resH = value; canvas.height = value; env.manualResize = true; },
            'width', () => { env.resW = value; canvas.width = value; env.manualResize = true; },
            'height', () => { env.resH = value; canvas.height = value; env.manualResize = true; },
            'loop', () => { env.loop = value; },
            'fps', () => { env.targetFps = value; },
            'targetFps', () => { env.targetFps = value; },
            'bpm', () => { env.bpm = value; },
            'timesig_num', () => { env.timesig_num = value; },
            'timesig_denom', () => { env.timesig_denom = value; },
            _, (n) => console.warn(`Unknown env field: ${field}`)
          );
        }
      }
    }

    // Trigger fitCanvas to apply manual or auto sizing
    fitCanvas();

    // Update AST viewer
    updateASTViewer(ast);

    // Stop existing rendering
    if (coordinator.running) {
      coordinator.stop();
      isPlaying = false;
      playPauseBtn.textContent = '▶';
    }

    // Update coordinator with new AST
    coordinator.ast = ast;

    // Compile all backends
    console.log('🔨 Compiling backends...');
    const compileSuccess = await coordinator.compile();

    if (!compileSuccess) {
      throw new Error('Backend compilation failed');
    }

    console.log('✅ Compilation successful');

    // Update graph viewer
    updateGraphViewer();

    // Update instance viewer
    updateInstanceViewer();

    // Start rendering
    console.log('▶ Starting coordinator...');
    coordinator.start();
    isPlaying = true;
    playPauseBtn.textContent = '⏸';

    console.log('✅ Program running successfully');

  } catch (e) {
    const errorMsg = (e && e.message) ? e.message : String(e);
    errorsEl.textContent = errorMsg;

    // Clear AST viewer on error
    const astViewer = document.getElementById('astViewer');
    if (astViewer) {
      astViewer.textContent = `Parse Error: ${errorMsg}`;
    }

    console.error('❌ Program execution failed:', errorMsg);
    console.error(e.stack);

    logger.error('Main', 'Program execution failed', {
      error: errorMsg,
      stack: e.stack
    });
  }
}

// Default code
function defaultCode() {
  return `// Simple WEFT test

base<r> = me@x
base<g> = me@y
base<b> = sin(me@time)

display(base@r, base@g, base@b)`;
}

// Debug panel controls
function initDebugPanel() {
  const debugTabs = document.querySelectorAll('.debug-tab');
  const debugTabPanes = document.querySelectorAll('.debug-tab-pane');
  const canvasTabs = document.querySelectorAll('.canvas-tab');
  const canvasTabPanes = document.querySelectorAll('.canvas-tab-pane');

  // Debug sub-tabs
  debugTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      debugTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      debugTabPanes.forEach(pane => {
        pane.classList.remove('active');
        if (pane.id === targetTab + 'Tab') {
          pane.classList.add('active');
        }
      });
    });
  });

  // Canvas tabs
  canvasTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      canvasTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      canvasTabPanes.forEach(pane => {
        pane.classList.remove('active');
        if (pane.id === targetTab + 'Pane') {
          pane.classList.add('active');
        }
      });
    });
  });

  // Log filters
  const logFilters = document.querySelectorAll('#logFilters input[type="checkbox"]');
  logFilters.forEach(filter => {
    filter.addEventListener('change', () => {
      const filters = {};
      logFilters.forEach(f => {
        const level = f.id.replace('filter', '').toLowerCase();
        filters[level] = f.checked;
      });
      logger.setFilters(filters);
    });
  });
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    // Initialize CodeMirror
    initEditor();

    const saved = localStorage.getItem('weft_code');
    if (saved) {
      editor.setValue(saved);
    } else {
      editor.setValue(defaultCode().trim());
    }

    // Apply initial syntax highlighting
    highlightWEFT(editor);

    // Setup editor event listeners
    setupEditorListeners();

    // Initialize debug panel
    initDebugPanel();

    // Run initial code
    runCode();
  }, 100);
});

// Update clock display
function updateClock() {
  const clockDisplay = document.getElementById('clockDisplay');
  if (clockDisplay && env) {
    const time = ((env.frame % env.loop) / env.targetFps).toFixed(2);
    const frame = env.frame % env.loop;
    const absTime = ((Date.now() - env.startTime) / 1000).toFixed(1);
    clockDisplay.textContent = `${time}s | ${frame}/${env.loop} | ${absTime} | ${env.bpm}`;
  }
  requestAnimationFrame(updateClock);
}
updateClock();
