const editor = document.getElementById('editor');
const errorsEl = document.getElementById('errors');
const canvas = document.getElementById('out');

const env = new Env();
const executor = new Executor(env);
const renderer = new Renderer(canvas, env);

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
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(x, y, 1, 1);
    const [r, g, b] = imageData.data;
    
    const rgbDisplay = document.getElementById('rgbDisplay');
    if (rgbDisplay) {
      rgbDisplay.textContent = `RGB: ${(r/255).toFixed(3)}, ${(g/255).toFixed(3)}, ${(b/255).toFixed(3)}`;
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
  try {
    const src = editor.value;
    const ast = Parser.parse(src);
    executor.run(ast);
    renderer.stop();
    renderer.start();
  } catch (e){
    errorsEl.textContent = (e && e.message) ? e.message : String(e);
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
  return `// Simple test case for the compiler
display(sin(me.x * 10 + me.t), cos(me.y * 10 + me.t), 0.5)`;
}

const saved = localStorage.getItem('weft_code');
if(saved){ editor.value = saved; } else { editor.value = defaultCode().trim(); }
runCode();