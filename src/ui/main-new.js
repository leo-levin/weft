// New architecture maiw
// file - wires up the Coordinator and new backend system
import { parse } from '../lang/parser-new.js';
import { Env } from '../runtime/runtime-new.js';
import { Coordinator } from '../backends/coordinator.js';
import { WebGLBackend } from '../backends/webgl-backend-full.js';
import { clamp } from '../utils/math.js';
import { logger } from '../utils/logger.js';
import { match, _ } from '../utils/match.js';

console.log('✅ Starting WEFT application (NEW ARCHITECTURE)...');

// Enable debug logging
logger.setFilters({ debug: true, info: true, warn: true, error: true });
console.log('🔧 Debug logging enabled');

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
  if (astViewer) {
    try {
      let html = '<div style="font-family: monospace; line-height: 1.6;">';

      for (const stmt of ast.statements) {
        html += '<div style="margin: 10px 0; padding: 8px; background: rgba(255,255,255,0.03); border-left: 3px solid #4ec9b0; border-radius: 2px;">';

        if (stmt.type === 'EnvAssignment') {
          html += `<div style="color: #569cd6; font-weight: bold;">me&lt;${stmt.field}&gt; = ${formatExpr(stmt.value)}</div>`;
        } else if (stmt.type === 'InstanceBinding') {
          html += `<div style="color: #4ec9b0; font-weight: bold;">${stmt.name}</div>`;
          html += `<div style="margin-left: 15px; color: #9cdcfe;">outputs: ${stmt.outputs.join(', ')}</div>`;
          html += `<div style="margin-left: 15px; color: #ce9178;">expr: ${formatExpr(stmt.expr)}</div>`;
        } else if (stmt.type === 'DisplayStmt' || stmt.type === 'RenderStmt') {
          html += `<div style="color: #c586c0; font-weight: bold;">${stmt.type}</div>`;
          html += `<div style="margin-left: 15px;">args: ${stmt.args.map(a => formatExpr(a)).join(', ')}</div>`;
        } else if (stmt.type === 'SpindleDef') {
          html += `<div style="color: #dcdcaa; font-weight: bold;">spindle ${stmt.name}</div>`;
          html += `<div style="margin-left: 15px;">params: ${stmt.params.join(', ')}</div>`;
          html += `<div style="margin-left: 15px;">outputs: ${stmt.outputs.join(', ')}</div>`;
        }

        html += '</div>';
      }

      html += '</div>';
      astViewer.innerHTML = html;
    } catch (error) {
      astViewer.textContent = `Error displaying AST: ${error.message}`;
    }
  }
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

// Update graph viewer - consistent with AST style
function updateGraphViewer() {
  const graphViewer = document.getElementById('graphViewer');
  if (!graphViewer || !coordinator || !coordinator.graph) return;

  try {
    let html = '<div style="font-family: monospace; line-height: 1.6;">';

    // Execution order
    html += '<div style="margin: 10px 0; padding: 8px; background: rgba(255,255,255,0.03); border-left: 3px solid #569cd6; border-radius: 2px;">';
    html += '<div style="color: #569cd6; font-weight: bold;">Execution Order</div>';
    html += `<div style="margin-left: 15px; margin-top: 4px;">${coordinator.graph.execOrder.join(' → ')}</div>`;
    html += '</div>';

    // Nodes
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
    graphViewer.innerHTML = html;
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
          _, () => {
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
            _, () => console.warn(`Unknown env field: ${field}`)
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
