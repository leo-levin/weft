// New architecture maiw
// file - wires up the Coordinator and new backend system
import { parse } from '../lang/parser-new.js';
import { Env } from '../runtime/runtime-new.js';
import { Coordinator } from '../backends/coordinator.js';
import { WebGLBackend } from '../backends/webgl-backend-full.js';
import { clamp } from '../utils/math.js';
import { logger } from '../utils/logger.js';

console.log('✅ Starting WEFT application (NEW ARCHITECTURE)...');

// Enable debug logging
logger.setFilters({ debug: true, info: true, warn: true, error: true });
console.log('🔧 Debug logging enabled');

// DOM elements
const editor = document.getElementById('editor');
const errorsEl = document.getElementById('errors');
const canvas = document.getElementById('out');
const runBtn = document.getElementById('runBtn');
const autorunBtn = document.getElementById('autorunBtn');
const interpToggle = document.getElementById('interpToggle');
const playPauseBtn = document.getElementById('playPauseBtn');

// Ensure editor text is visible
if (editor) {
  editor.style.color = 'var(--ink)';
  editor.style.backgroundColor = '';
  editor.style.fontFamily = "'SF Mono', ui-monospace, monospace";
  editor.style.fontSize = 'var(--font-size-sm)';
  editor.style.padding = 'var(--spacing-xxl)';
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

// Update AST viewer
function updateASTViewer(ast) {
  const astViewer = document.getElementById('astViewer');
  if (astViewer) {
    try {
      const astString = JSON.stringify(ast, null, 2);
      astViewer.textContent = astString;
    } catch (error) {
      astViewer.textContent = `Error displaying AST: ${error.message}`;
    }
  }
}

// Update graph viewer
function updateGraphViewer() {
  const graphViewer = document.getElementById('graphViewer');
  if (!graphViewer || !coordinator || !coordinator.graph) return;

  try {
    let html = '<div style="font-family: monospace; padding: 10px;">';

    // Execution order
    html += '<div style="margin-bottom: 20px;">';
    html += '<strong>Execution Order:</strong><br>';
    html += coordinator.graph.execOrder.join(' → ');
    html += '</div>';

    // Nodes
    html += '<div>';
    html += '<strong>Nodes:</strong><br>';
    for (const [name, node] of coordinator.graph.nodes) {
      html += `<div style="margin: 10px 0; padding: 10px; background: rgba(255,255,255,0.05); border-radius: 4px;">`;
      html += `<div style="color: #4ec9b0; font-weight: bold;">${name}</div>`;
      html += `<div style="margin-left: 20px;">`;
      html += `Type: ${node.type}<br>`;
      html += `Outputs: ${Array.from(node.outputs.keys()).join(', ')}<br>`;
      if (node.deps.size > 0) {
        html += `Dependencies: ${Array.from(node.deps).join(', ')}<br>`;
      }
      if (node.requiredOutputs.size > 0) {
        html += `Required Outputs: ${Array.from(node.requiredOutputs).join(', ')}<br>`;
      }
      if (node.contexts.size > 0) {
        html += `Contexts: ${Array.from(node.contexts).join(', ')}<br>`;
      }
      html += `</div></div>`;
    }
    html += '</div>';
    html += '</div>';

    graphViewer.innerHTML = html;
  } catch (error) {
    graphViewer.textContent = `Error displaying graph: ${error.message}`;
  }
}

// Canvas sizing
function fitCanvas() {
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;

  const width = Math.floor(rect.width * scale);
  const height = Math.floor(rect.height * scale);

  canvas.width = width;
  canvas.height = height;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';

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
editor.addEventListener('input', () => {
  localStorage.setItem('weft_code', editor.value);
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
    const src = editor.value;
    console.log('📝 Parsing program...', { length: src.length });

    // Parse WEFT code
    const ast = parse(src);
    console.log('✅ AST parsed successfully', {
      statements: ast.statements.length,
      types: ast.statements.map(s => s.type)
    });

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
    const saved = localStorage.getItem('weft_code');
    if (saved) {
      editor.value = saved;
    } else {
      editor.value = defaultCode().trim();
    }

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
