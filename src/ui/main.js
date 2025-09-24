import { Parser } from '../lang/parser.js';
import { tagExpressionRoutes } from '../lang/tagging.js';
import { Env, Executor, clamp, isNum, logger, Sampler } from '../runtime/runtime.js';
import { Renderer } from '../renderers/renderer.js';
import { WebGLRenderer } from '../renderers/webgl-renderer.js';
import { AudioWorkletRenderer } from '../renderers/audio-worklet-renderer.js';
import { WidgetManager } from './widget-manager.js';
import { HoverDetector } from './hover-detector.js';
import { CoordinateProbe } from './coordinate-probe.js';
import { ClockDisplay } from './clock-display.js';

console.log('✅ Starting WEFT application...');

// Enable debug logging for audio debugging
logger.setFilters({ debug: true, info: true, warn: true, error: true });
console.log('🔧 Debug logging enabled');

const editor = document.getElementById('editor');
// Ensure editor text is visible with white color, default background
if (editor) {
  editor.style.color = 'var(--ink)';
  editor.style.backgroundColor = '';
  editor.style.fontFamily = "'SF Mono', ui-monospace, monospace";
  editor.style.fontSize = 'var(--font-size-sm)';
  editor.style.padding = 'var(--spacing-xxl)';
}
const errorsEl = document.getElementById('errors');
const canvas = document.getElementById('out');

const env = new Env();
const executor = new Executor(env, Parser);

// Initialize renderer - will be set up after all scripts load
let renderer;
let audioRenderer;

// Initialize widget manager for parameter controls
let widgetManager;
let hoverDetector;
let coordinateProbe;
let clockDisplay;

// Function to update AST viewer with clean, formatted JSON
function updateASTViewer(ast) {
  const astViewer = document.getElementById('astViewer');
  if (astViewer) {
    try {
      // Clean AST by removing noise properties
      const cleanAST = cleanASTForDisplay(ast);
      const astString = JSON.stringify(cleanAST, null, 2);
      astViewer.textContent = astString;
    } catch (error) {
      astViewer.textContent = `Error displaying AST: ${error.message}`;
    }
  }
}

// Remove routing metadata and other noise for cleaner display
function cleanASTForDisplay(node) {
  if (!node || typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    return node.map(item => cleanASTForDisplay(item));
  }

  const cleaned = {};

  // Always include type
  if (node.type) cleaned.type = node.type;

  // Include key properties based on node type
  if (node.type === 'Program') {
    cleaned.statements = cleanASTForDisplay(node.statements);
  } else if (node.type === 'RenderStmt' || node.type === 'PlayStmt' || node.type === 'ComputeStmt') {
    cleaned.args = cleanASTForDisplay(node.args);
    if (node.namedArgs && Object.keys(node.namedArgs).length > 0) {
      cleaned.namedArgs = cleanASTForDisplay(node.namedArgs);
    }
  } else if (node.type === 'Me') {
    cleaned.field = node.field;
  } else if (node.type === 'Mouse') {
    cleaned.field = node.field;
  } else if (node.type === 'Num') {
    cleaned.value = node.v;
  } else if (node.type === 'Str') {
    cleaned.value = node.v;
  } else if (node.type === 'Var') {
    cleaned.name = node.name;
  } else if (node.type === 'Bin') {
    cleaned.op = node.op;
    cleaned.left = cleanASTForDisplay(node.left);
    cleaned.right = cleanASTForDisplay(node.right);
  } else if (node.type === 'Unary') {
    cleaned.op = node.op;
    cleaned.expr = cleanASTForDisplay(node.expr);
  } else if (node.type === 'Call') {
    cleaned.name = node.name;
    cleaned.args = cleanASTForDisplay(node.args);
  } else if (node.type === 'Let') {
    cleaned.name = node.name;
    cleaned.expr = cleanASTForDisplay(node.expr);
  } else {
    // For other node types, include common properties
    Object.keys(node).forEach(key => {
      if (key !== 'id' && key !== 'positionalArgs' && key !== 'parameters') {
        cleaned[key] = cleanASTForDisplay(node[key]);
      }
    });
  }

  // Add route information if present (after tagging)
  if (node.routes && node.routes.size > 0) {
    cleaned.routes = Array.from(node.routes);
  }
  if (node.primaryRoute) {
    cleaned.primaryRoute = node.primaryRoute;
  }
  if (node.crossContext) {
    cleaned.crossContext = node.crossContext;
  }

  return cleaned;
}

function initializeRenderer() {
  const useWebGL = true; // Re-enabling - it's working better than expected!

  if (useWebGL && typeof WebGLRenderer !== 'undefined') {
    try {
      renderer = new WebGLRenderer(canvas, env);
      if (renderer.gl && renderer.initWebGL() !== false) {
        console.log('Using WebGL renderer for GPU acceleration');
      } else {
        throw new Error('WebGL context initialization failed');
      }
    } catch (e) {
      console.warn('WebGL failed, falling back to CPU renderer:', e);
      renderer = new Renderer(canvas, env);
    }
  } else {
    console.log('Using CPU renderer');
    renderer = new Renderer(canvas, env);
  }

  // Initialize audio renderer
  if (!audioRenderer) {
    audioRenderer = new AudioWorkletRenderer(env);
    console.log('🎵 Audio renderer initialized');

    // Add click handler to resume AudioContext on user interaction
    const resumeAudioContext = async () => {
      if (audioRenderer && audioRenderer.audioContext && audioRenderer.audioContext.state === 'suspended') {
        try {
          await audioRenderer.audioContext.resume();

          // Update parameters again now that context is running
          if (audioRenderer.updateCrossContextParams) {
            audioRenderer.updateCrossContextParams();
          }
        } catch (error) {
          console.error('Failed to resume AudioContext:', error);
        }
      }
    };

    // Add event listeners for user interaction
    document.addEventListener('click', resumeAudioContext, { once: true });
    document.addEventListener('keydown', resumeAudioContext, { once: true });
  }
  
  // Initialize widget manager after renderer is ready
  if (!widgetManager) {
    widgetManager = new WidgetManager(env, document.body);
    console.log('✅ Widget manager initialized');
  }
  
  // Initialize hover detector for parameter interactions
  if (!hoverDetector) {
    hoverDetector = new HoverDetector(editor, env, widgetManager);
    window.hoverDetector = hoverDetector; // Global reference for event handlers
    console.log('✅ Hover detector initialized');
  }
  
  // Initialize coordinate probe for spatial exploration
  if (!coordinateProbe) {
    coordinateProbe = new CoordinateProbe(canvas, env, renderer, executor);
    console.log('✅ Coordinate probe initialized');
  }

  // Initialize clock display for time control
  if (!clockDisplay) {
    clockDisplay = new ClockDisplay(env);
    clockDisplay.setRenderer(renderer);
    console.log('✅ Clock display initialized');
  }
}

const interpToggle = document.getElementById('interpToggle');
env.interpolate = false;
interpToggle.addEventListener('click', () => {
  env.interpolate = !env.interpolate;
  interpToggle.classList.toggle('active', env.interpolate);
});

const probeToggle = document.getElementById('probeToggle');
probeToggle.addEventListener('click', () => {
  if (coordinateProbe) {
    const isEnabled = coordinateProbe.toggle();
    probeToggle.classList.toggle('active', isEnabled);
  }
});

function fitCanvas(){
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * scale);
  canvas.height = Math.floor(rect.height * scale);
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
}

new ResizeObserver(fitCanvas).observe(canvas);
fitCanvas();

document.getElementById('resPill').textContent = `Res: ${env.resW}×${env.resH}`;

canvas.addEventListener('mousemove', (e)=>{
  const rect = canvas.getBoundingClientRect();
  env.mouse.x = clamp((e.clientX - rect.left)/rect.width);
  env.mouse.y = clamp((e.clientY - rect.top)/rect.height);
});

// Canvas click handler is now handled by coordinate probe when enabled

let debounceTimer = null;
const autorunBtn = document.getElementById('autorunBtn');
env.autorun = false;
autorunBtn.addEventListener('click', () => {
  env.autorun = !env.autorun;
  autorunBtn.classList.toggle('active', env.autorun);
});
editor.addEventListener('input', ()=>{
  localStorage.setItem('weft_code', editor.value);
  if (!env.autorun) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(()=> {
    // Use requestIdleCallback to avoid blocking typing
    if (window.requestIdleCallback) {
      requestIdleCallback(() => runCode(), { timeout: 1000 });
    } else {
      runCode();
    }
  }, 400);
});

document.getElementById('runBtn').addEventListener('click', runCode);
document.getElementById('mediaBtn').addEventListener('click', async ()=>{
  try { env.audio.ctx && env.audio.ctx.resume && env.audio.ctx.resume(); } catch {}
  try { env.audio.element && env.audio.element.play(); } catch {}
  try { env.defaultSampler && env.defaultSampler.play(); } catch {}

  // Resume audio worklet context
  if (audioRenderer && audioRenderer.audioContext) {
    try {
      await audioRenderer.audioContext.resume();
      console.log('🎵 AudioContext resumed');
    } catch (error) {
      console.warn('🎵 Failed to resume AudioContext:', error);
    }
  }
});

function persistAndRun(){
  localStorage.setItem('weft_code', editor.value);
  runCode();
}


async function runCode(){
  errorsEl.textContent = "";

  // Clear previous logs
  logger.clear();

  // Initialize renderer if not already done
  if (!renderer) {
    initializeRenderer();
  }

  try {
    const src = editor.value;
    logger.info('Main', 'Parsing program', { length: src.length });

    const ast = Parser.parse(src);
    logger.info('Main', 'AST parsed successfully', {
      statements: ast.statements.length,
      types: ast.statements.map(s => s.type)
    });

    // Tag AST with execution routes (render→gpu, play→audio, compute→cpu)
    tagExpressionRoutes(ast);
    logger.info('Main', 'Route tagging completed');

    // Update AST viewer (after tagging so route info is included)
    updateASTViewer(ast);

    // Store ASTs for WebGL compiler
    env.currentProgram = ast;
    for (const stmt of ast.statements) {
      if (stmt.type === 'RenderStmt' || stmt.type === 'DisplayStmt') {
        env.displayAst = stmt;
        break;
      }
    }

    executor.run(ast);
    renderer.stop();

    // Stop audio renderer
    if (audioRenderer) {
      audioRenderer.stop();
    }

    // Recreate WebGL renderer if needed to recompile shaders
    if (typeof WebGLRenderer !== 'undefined' && renderer instanceof WebGLRenderer) {
      logger.info('Main', 'Recreating WebGL renderer');
      renderer = new WebGLRenderer(canvas, env);
    }

    // Compile audio if there are play statements
    if (audioRenderer && env.playStatements && env.playStatements.length > 0) {
      try {
        await audioRenderer.compile(env.playStatements);
        await audioRenderer.start();
        logger.info('Main', 'Audio compilation and start completed');
      } catch (error) {
        logger.error('Main', 'Audio compilation failed', error);
      }
    }

    // Update clock display with new renderer
    if (clockDisplay) {
      clockDisplay.setRenderer(renderer);
      clockDisplay.setAudioRenderer(audioRenderer);
    }

    renderer.start();
    logger.info('Main', 'Program execution completed successfully');
    
    // Refresh coordinate probe after rendering
    if (coordinateProbe) {
      coordinateProbe.refresh();
    }
    
    // Update hover zones after program execution (parameters may have been created)
    if (hoverDetector) {
      console.log('🔄 Triggering hover zone update after program execution');
      hoverDetector.updateHoverZones();
    }

  } catch (e){
    const errorMsg = (e && e.message) ? e.message : String(e);
    errorsEl.textContent = errorMsg;

    // Clear AST viewer on error
    const astViewer = document.getElementById('astViewer');
    if (astViewer) {
      astViewer.textContent = `Parse Error: ${errorMsg}`;
    }

    logger.error('Main', 'Program execution failed', {
      error: errorMsg,
      stack: e.stack
    });
  }
}

// Load standard library
fetch('./standard.weft')
  .then(response => response.text())
  .then(code => {
    window.StandardLibraryCode = code;
    console.log('Standard library code loaded');
  })
  .catch(e => console.warn('No standard library found:', e.message));

function defaultCode() {
  return `// Test the fixed general structure and logging
// This uses the standard library circle spindle with custom output names

circle(me@x, me@y, 0.5, 0.5, 0.3) :: myCircle<:result:val>

// Test threshold spindle with different output names
threshold(myCircle@val, 0.5) :: myThresh<:output:filtered>

// Create a compose instance with arbitrary output names
compose(myThresh@filtered, sin(me@time), cos(me@x * 10)) :: colors<:red:green:blue>

// Display using the instance with 3 outputs
display(colors)`;
}


// Debug panel controls
function initDebugPanel() {
  // Debug sub-tabs (Logs, Scope, Instances) - now inside the main Debug tab
  const debugTabs = document.querySelectorAll('.debug-tab');
  const debugTabPanes = document.querySelectorAll('.debug-tab-pane');
  const logFilters = document.querySelectorAll('#logFilters input[type="checkbox"]');

  // Tab switching
  debugTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;

      // Update active tab
      debugTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // Update active pane
      debugTabPanes.forEach(pane => {
        pane.classList.remove('active');
        if (pane.id === targetTab + 'Tab') {
          pane.classList.add('active');
        }
      });
    });
  });

  // Canvas tabs
  const canvasTabs = document.querySelectorAll('.canvas-tab');
  const canvasTabPanes = document.querySelectorAll('.canvas-tab-pane');

  console.log('Canvas tabs found:', canvasTabs.length);
  console.log('Canvas panes found:', canvasTabPanes.length);

  canvasTabs.forEach((tab, index) => {
    console.log(`Setting up tab ${index}:`, tab.textContent, tab.dataset.tab);
    tab.addEventListener('click', (e) => {
      console.log('Canvas tab clicked:', tab.textContent, 'Target:', tab.dataset.tab);
      const targetTab = tab.dataset.tab;

      // Update active tab
      canvasTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // Update active pane
      canvasTabPanes.forEach(pane => {
        console.log('Checking pane:', pane.id, 'Looking for:', targetTab + 'Pane');
        pane.classList.remove('active');
        if (pane.id === targetTab + 'Pane') {
          pane.classList.add('active');
          console.log('Activated pane:', pane.id);
        }
      });

      // Handle canvas tab switching specifically
      if (targetTab === 'canvas' && renderer) {
        console.log('Switching to canvas tab, renderer status:', {
          hasRenderer: !!renderer,
          rendererType: renderer.constructor.name,
          isRunning: renderer.isRunning || 'unknown'
        });

        setTimeout(() => {
          console.log('Attempting to restart renderer after tab switch');
          try {
            // Force renderer restart
            if (renderer.stop) renderer.stop();
            if (renderer.start) renderer.start();
            console.log('Renderer restart completed');
          } catch (error) {
            console.error('Error restarting renderer:', error);
          }
        }, 50);
      }
    });
  });

  // Log filters
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

  // Debug panel resize functionality
  const debugPanel = document.getElementById('debugPane');
  const debugResizeHandle = document.querySelector('.debug-resize-handle');
  
  // Only setup resize if elements exist
  if (!debugResizeHandle || !debugPanel) return;
  
  let isResizing = false;
  let startY = 0;
  let startHeight = 0;

  debugResizeHandle.addEventListener('mousedown', (e) => {
    if (debugPanel.classList.contains('collapsed')) return;

    isResizing = true;
    startY = e.clientY;
    startHeight = parseInt(window.getComputedStyle(debugPanel).height, 10);

    document.addEventListener('mousemove', handleResize);
    document.addEventListener('mouseup', stopResize);

    e.preventDefault();
  });

  function handleResize(e) {
    if (!isResizing) return;

    const deltaY = startY - e.clientY; // Inverted because we're resizing from the top
    const newHeight = Math.max(44, Math.min(window.innerHeight * 0.8, startHeight + deltaY));

    debugPanel.style.height = newHeight + 'px';
    debugPanel.style.transition = 'none';
  }

  function stopResize() {
    isResizing = false;
    debugPanel.style.transition = 'height 0.3s cubic-bezier(0.4, 0, 0.2, 1)';

    document.removeEventListener('mousemove', handleResize);
    document.removeEventListener('mouseup', stopResize);
  }
}

// Wait for all scripts to load before initializing
document.addEventListener('DOMContentLoaded', () => {
  // Give scripts a moment to finish loading
  setTimeout(() => {
    const saved = localStorage.getItem('weft_code');
    if(saved){ editor.value = saved; } else { editor.value = defaultCode().trim(); }

    // Initialize debug panel
    initDebugPanel();

    runCode();
    
    // Listen for parameter changes to trigger re-rendering
    window.addEventListener('parameterChanged', (event) => {
      console.log('🔄 Parameter changed, triggering re-render:', event.detail);
      if (env.autorun) {
        // Use a short debounce to avoid excessive re-renders
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          runCode();
        }, 50);
      }
    });
    
  }, 100);
});