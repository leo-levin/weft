const editor = document.getElementById('editor');
// Ensure editor text is visible with white color, default background
if (editor) {
  editor.style.color = 'white';                  // text color
  editor.style.backgroundColor = '';             // reset background to default
  editor.style.fontFamily = "'SF Mono', monospace";
  editor.style.fontSize = '13px';
  editor.style.padding = '10px';
}
const errorsEl = document.getElementById('errors');
const canvas = document.getElementById('out');

const env = new Env();
const executor = new Executor(env);

// Initialize renderer - will be set up after all scripts load
let renderer;

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
}

const interpToggle = document.getElementById('interpToggle');
env.interpolate = false;
interpToggle.addEventListener('click', () => {
  env.interpolate = !env.interpolate;
  interpToggle.classList.toggle('active', env.interpolate);
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

canvas.addEventListener('click', (e)=>{
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width));
  const y = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height));

  if (x >= 0 && x < canvas.width && y >= 0 && y < canvas.height) {
    try {
      let r = 0, g = 0, b = 0;

      // Check if we're using WebGL renderer
      if (renderer && typeof WebGLRenderer !== 'undefined' && renderer instanceof WebGLRenderer) {
        // For WebGL, we need to read from the WebGL context
        const gl = renderer.gl;
        if (gl) {
          const pixels = new Uint8Array(4);
          gl.readPixels(x, canvas.height - y - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          r = pixels[0];
          g = pixels[1];
          b = pixels[2];
        }
      } else {
        // For CPU renderer, use 2D context
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const imageData = ctx.getImageData(x, y, 1, 1);
          r = imageData.data[0];
          g = imageData.data[1];
          b = imageData.data[2];
        }
      }

      const rgbDisplay = document.getElementById('rgbDisplay');
      if (rgbDisplay) {
        rgbDisplay.textContent = `RGB: ${(r/255).toFixed(3)}, ${(g/255).toFixed(3)}, ${(b/255).toFixed(3)}`;
      }

    } catch (e) {
      console.warn('Could not get pixel data:', e);
      const rgbDisplay = document.getElementById('rgbDisplay');
      if (rgbDisplay) {
        rgbDisplay.textContent = 'RGB: —, —, —';
      }
    }
  }
});

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
document.getElementById('mediaBtn').addEventListener('click', ()=>{
  try { env.audio.ctx && env.audio.ctx.resume && env.audio.ctx.resume(); } catch {}
  try { env.audio.element && env.audio.element.play(); } catch {}
  try { env.defaultSampler && env.defaultSampler.play(); } catch {}
});

function persistAndRun(){
  localStorage.setItem('weft_code', editor.value);
  runCode();
}


function runCode(){
  errorsEl.textContent = "";

  // Clear previous logs
  if (window.logger) {
    window.logger.clear();
  }

  // Initialize renderer if not already done
  if (!renderer) {
    initializeRenderer();
  }

  try {
    const src = editor.value;
    window.logger && window.logger.info('Main', 'Parsing program', { length: src.length });

    const ast = Parser.parse(src);
    window.logger && window.logger.info('Main', 'AST parsed successfully', {
      statements: ast.body.length,
      types: ast.body.map(s => s.type)
    });

    // Store ASTs for WebGL compiler
    env.currentProgram = ast;
    for (const stmt of ast.body) {
      if (stmt.type === 'Display') {
        env.displayAst = stmt;
        break;
      }
    }

    executor.run(ast);
    renderer.stop();

    // Recreate WebGL renderer if needed to recompile shaders
    if (typeof WebGLRenderer !== 'undefined' && renderer instanceof WebGLRenderer) {
      window.logger && window.logger.info('Main', 'Recreating WebGL renderer');
      renderer = new WebGLRenderer(canvas, env);
    }

    renderer.start();
    window.logger && window.logger.info('Main', 'Program execution completed successfully');

  } catch (e){
    const errorMsg = (e && e.message) ? e.message : String(e);
    errorsEl.textContent = errorMsg;
    window.logger && window.logger.error('Main', 'Program execution failed', {
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

circle(me.x, me.y, 0.5, 0.5, 0.3) :: myCircle<:result:val>

// Test threshold spindle with different output names
threshold(myCircle@val, 0.5) :: myThresh<:output:filtered>

// Create a compose instance with arbitrary output names
compose(myThresh@filtered, sin(me.t), cos(me.x * 10)) :: colors<:red:green:blue>

// Display using the instance with 3 outputs
display(colors)`;
}


// Debug panel controls
function initDebugPanel() {
  const debugToggle = document.getElementById('debugToggle');
  const debugClear = document.getElementById('debugClear');
  const debugPanel = document.getElementById('debugPanel');
  const debugResizeHandle = document.getElementById('debugResizeHandle');
  const debugTabs = document.querySelectorAll('.debug-tab');
  const debugTabPanes = document.querySelectorAll('.debug-tab-pane');
  const logFilters = document.querySelectorAll('#logFilters input[type="checkbox"]');

  // Toggle debug panel
  debugToggle.addEventListener('click', () => {
    const isCollapsed = debugPanel.classList.contains('collapsed');
    if (isCollapsed) {
      debugPanel.classList.remove('collapsed');
      debugToggle.textContent = 'Hide';
    } else {
      debugPanel.classList.add('collapsed');
      debugToggle.textContent = 'Show';
    }
  });

  // Clear debug logs
  debugClear.addEventListener('click', () => {
    if (window.logger) {
      window.logger.clear();
      // Also clear image cache
      if (typeof Sampler !== 'undefined' && Sampler.clearCache) {
        Sampler.clearCache();
        window.logger.info('Main', 'Image cache cleared');
      }
    }
  });

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

  // Log filters
  logFilters.forEach(filter => {
    filter.addEventListener('change', () => {
      if (window.logger) {
        const filters = {};
        logFilters.forEach(f => {
          const level = f.id.replace('filter', '').toLowerCase();
          filters[level] = f.checked;
        });
        window.logger.setFilters(filters);
      }
    });
  });

  // Debug panel resize functionality
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
  }, 100);
});