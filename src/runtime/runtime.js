// runtime.js — utilities, runtime, evaluator, spindles, executor (v2)

// ===== Logger =====
class Logger {
  constructor() {
    this.logs = [];
    this.maxLogs = 1000;
    this.filters = { debug: true, info: true, warn: true, error: true };
    this.autoScroll = true;
  }

  log(level, component, message, data = null) {
    const timestamp = new Date().toLocaleTimeString();
    const entry = { level, component, message, data, timestamp, id: Date.now() + Math.random() };
    
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    
    this.updateUI();
  }

  debug(component, message, data = null) { this.log('debug', component, message, data); }
  info(component, message, data = null) { this.log('info', component, message, data); }
  warn(component, message, data = null) { this.log('warn', component, message, data); }
  error(component, message, data = null) { this.log('error', component, message, data); }

  clear() {
    this.logs = [];
    this.updateUI();
  }

  setFilters(filters) {
    this.filters = { ...this.filters, ...filters };
    this.updateUI();
  }

  updateUI() {
    const logOutput = document.getElementById('logOutput');
    if (!logOutput) return;

    const filteredLogs = this.logs.filter(log => this.filters[log.level]);
    
    logOutput.innerHTML = filteredLogs.map(log => {
      let dataStr = '';
      if (log.data) {
        if (typeof log.data === 'object') {
          dataStr = `<div class="log-data">${JSON.stringify(log.data, null, 2)}</div>`;
        } else {
          dataStr = ` <span class="log-data-inline">${log.data}</span>`;
        }
      }
      
      return `<div class="log-entry ${log.level}">
        <div class="log-header">
          <span class="log-timestamp">${log.timestamp}</span>
          <span class="log-component">${log.component}</span>
        </div>
        <div class="log-message">${this.escapeHtml(log.message)}</div>
        ${dataStr}
      </div>`;
    }).join('');

    if (this.autoScroll) {
      logOutput.scrollTop = logOutput.scrollHeight;
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  updateScopeViewer(scopeStack) {
    const scopeViewer = document.getElementById('scopeViewer');
    if (!scopeViewer) return;

    if (!scopeStack || scopeStack.length === 0) {
      scopeViewer.innerHTML = '<div class="empty-state">No active scopes</div>';
      return;
    }

    const scopeInfo = scopeStack.map((scope, index) => {
      const vars = Object.keys(scope).filter(k => k !== '__scopeStack').map(key => {
        let value = scope[key];
        let valueClass = 'scope-value';
        
        if (typeof value === 'function') {
          value = '[Function]';
          valueClass += ' scope-function';
        } else if (value && value.__kind === 'strand') {
          value = '[Strand]';
          valueClass += ' scope-strand';
        } else if (typeof value === 'object' && value !== null) {
          value = '[Object]';
          valueClass += ' scope-object';
        } else if (typeof value === 'number') {
          value = value.toFixed(3);
          valueClass += ' scope-number';
        } else if (typeof value === 'string') {
          value = `"${value}"`;
          valueClass += ' scope-string';
        }
        
        return `<div class="scope-var">
          <span class="scope-key">${key}:</span>
          <span class="${valueClass}">${value}</span>
        </div>`;
      }).join('');
      
      return `<div class="scope-level">
        <div class="scope-header">Scope ${index}</div>
        <div class="scope-vars">${vars || '<div class="scope-empty">No variables</div>'}</div>
      </div>`;
    }).join('');

    scopeViewer.innerHTML = scopeInfo;
  }

  updateInstanceViewer(instances) {
    const instanceViewer = document.getElementById('instanceViewer');
    if (!instanceViewer) return;

    if (!instances || instances.size === 0) {
      instanceViewer.innerHTML = '<div class="empty-state">No instances</div>';
      return;
    }

    const instanceInfo = Array.from(instances.entries()).map(([name, inst]) => {
      const outputs = Object.keys(inst.outs || {});
      const outputList = outputs.map(out => 
        `<span class="instance-output">${out}</span>`
      ).join(' ');
      
      return `<div class="instance-item">
        <div class="instance-header">
          <span class="instance-name">${name}</span>
          <span class="instance-count">${outputs.length} outputs</span>
        </div>
        <div class="instance-outputs">${outputList || 'No outputs'}</div>
      </div>`;
    }).join('');

    instanceViewer.innerHTML = instanceInfo;
  }
}

const logger = new Logger();

// ===== Utils =====
const clamp = (x, lo=0, hi=1) => Math.min(hi, Math.max(lo, x));
const lerp = (a,b,t)=>a+(b-a)*t;
const nowSec = ()=>performance.now()/1000;
const isNum = v => typeof v === 'number' && isFinite(v);

// Optimized hash using integer math and lookup table
const HASH_MULTIPLIER = 0x9E3779B97F4A7C15n;
const hashCache = new Map();

function hash3(x, y, z) {
  // Use integer coordinates for cache key
  const key = `${x|0},${y|0},${z|0}`;
  let cached = hashCache.get(key);
  if (cached !== undefined) return cached;

  // Fast integer hash
  let h = BigInt(x * 73856093 ^ y * 19349663 ^ z * 83492791) * HASH_MULTIPLIER;
  h = Number((h >> 32n) & 0xFFFFFFFFn) / 0xFFFFFFFF;

  // Cache with size limit
  if (hashCache.size > 10000) hashCache.clear();
  hashCache.set(key, h);
  return h;
}

// Faster smoothstep using optimized formula
function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Optimized noise with reduced operations
function noise3(x, y, t) {
  // Use faster floor
  const xi = ~~x, yi = ~~y, ti = ~~t;
  const xf = x - xi, yf = y - yi, tf = t - ti;

  // Compute smoothstep once
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = tf * tf * (3 - 2 * tf);

  // Inline mix operations for speed
  const n000 = hash3(xi, yi, ti);
  const n100 = hash3(xi + 1, yi, ti);
  const n010 = hash3(xi, yi + 1, ti);
  const n110 = hash3(xi + 1, yi + 1, ti);
  const n001 = hash3(xi, yi, ti + 1);
  const n101 = hash3(xi + 1, yi, ti + 1);
  const n011 = hash3(xi, yi + 1, ti + 1);
  const n111 = hash3(xi + 1, yi + 1, ti + 1);

  // Optimized trilinear interpolation
  const x00 = n000 + u * (n100 - n000);
  const x10 = n010 + u * (n110 - n010);
  const x01 = n001 + u * (n101 - n001);
  const x11 = n011 + u * (n111 - n011);
  const y0 = x00 + v * (x10 - x00);
  const y1 = x01 + v * (x11 - x01);
  return y0 + w * (y1 - y0);
}

// Super fast low-quality noise for preview
function fastNoise3(x, y, t) {
  const n = Math.sin(x * 12.9898 + y * 78.233 + t * 37.719) * 437538.5453;
  return n - ~~n;
}


// ===== Runtime scaffolding =====
class RuntimeError extends Error { constructor(msg){ super(msg); this.name = "RuntimeError"; } }

class Env {
  constructor(){
    this.instances = new Map();
    this.spindles = new Map();
    this.parameters = new Map(); // Parameter strands registry
    this.pragmas = []; // Store pragmas from parsing
    this.displayFns = null;
    this.defaultSampler = null;
    this.audio = { element:null, ctx:null, analyser:null, intensity:0 };
    this.mouse = { x:0.5, y:0.5 };
    this.frame = 0;
    this.boot = performance.now();
    this.targetFps = 30;
    this.resW = 300; this.resH = 300;
    this.mediaCanvas = document.createElement('canvas');
    this.mediaCtx = this.mediaCanvas.getContext('2d', { willReadFrequently: true });
    this.mediaImageData = null;
  }
  
  // Parameter strand management
  createParameterStrand(name, config) {
    const param = new ParameterStrand(name, config.defaultValue || 0, config);
    this.parameters.set(name, param);
    return param;
  }
  
  getParameterStrand(name) {
    return this.parameters.get(name);
  }
  
  processParameters(pragmas) {
    this.pragmas = pragmas || [];
    
    // console.log('🔧 Processing pragmas:', pragmas);
    
    // Create parameter instances from pragmas
    for (const pragma of this.pragmas) {
      if (pragma.type === 'slider' && pragma.config) {
        const { name, strands, range = [0, 1], label } = pragma.config;
        const defaultValue = (range[0] + range[1]) / 2;
        
        // console.log(`📊 Creating slider parameter instance '${name}' with strands:`, strands);
        
        // Create parameter strands for each output
        const outputs = {};
        if (strands && strands.length > 0) {
          for (const strandName of strands) {
            if (strandName.trim()) {
              const paramStrand = new ParameterStrand(strandName.trim(), defaultValue, {
                type: 'slider',
                range,
                label: `${label} - ${strandName}`,
                defaultValue
              });
              outputs[strandName.trim()] = paramStrand;
              
              // Also register the strand as a parameter for hover detection
              this.parameters.set(strandName.trim(), paramStrand);
              // console.log(`✅ Created parameter strand '${strandName.trim()}'`);
            }
          }
        }
        
        // Create the parameter instance with output strands
        if (Object.keys(outputs).length > 0) {
          this.instances.set(name, {
            kind: 'instance',
            name,
            outs: outputs
          });
          // console.log(`✅ Created parameter instance '${name}' with outputs:`, Object.keys(outputs));
        }
      } else if (pragma.type === 'color' && pragma.config) {
        const { name, strands, label, defaultValue } = pragma.config;
        
        // Create parameter strands for each output (r, g, b components)
        const outputs = {};
        if (strands && strands.length > 0) {
          // For color, create separate strands for each component
          strands.forEach((strandName, index) => {
            if (strandName.trim()) {
              // Default color components (red, green, blue)
              const defaultComponent = index === 0 ? 1.0 : index === 1 ? 0.0 : 0.0;
              
              const paramStrand = new ParameterStrand(strandName.trim(), defaultComponent, {
                type: 'color_component',
                component: ['r', 'g', 'b'][index] || 'r',
                label: `${label} - ${strandName}`,
                defaultValue: defaultComponent,
                parentColor: name
              });
              outputs[strandName.trim()] = paramStrand;
              
              // Also register the strand as a parameter for hover detection
              this.parameters.set(strandName.trim(), paramStrand);
            }
          });
        }
        
        // Create the parameter instance with output strands
        if (Object.keys(outputs).length > 0) {
          this.instances.set(name, {
            kind: 'instance',
            name,
            outs: outputs,
            parameterType: 'color'
          });
        }
      } else if (pragma.type === 'xy' && pragma.config) {
        const { name, strands, xRange, yRange, label, defaultValue } = pragma.config;
        
        // Create parameter strands for x and y components
        const outputs = {};
        if (strands && strands.length >= 2) {
          // X component
          const xStrand = new ParameterStrand(strands[0].trim(), defaultValue.x, {
            type: 'xy_component',
            component: 'x',
            range: xRange,
            label: `${label} - X`,
            defaultValue: defaultValue.x,
            parentXY: name
          });
          outputs[strands[0].trim()] = xStrand;
          this.parameters.set(strands[0].trim(), xStrand);
          
          // Y component
          const yStrand = new ParameterStrand(strands[1].trim(), defaultValue.y, {
            type: 'xy_component',
            component: 'y',
            range: yRange,
            label: `${label} - Y`,
            defaultValue: defaultValue.y,
            parentXY: name
          });
          outputs[strands[1].trim()] = yStrand;
          this.parameters.set(strands[1].trim(), yStrand);
        }
        
        // Create the parameter instance
        if (Object.keys(outputs).length > 0) {
          this.instances.set(name, {
            kind: 'instance',
            name,
            outs: outputs,
            parameterType: 'xy',
            xRange,
            yRange
          });
        }
      } else if (pragma.type === 'toggle' && pragma.config) {
        const { name, strands, label, defaultValue } = pragma.config;
        
        // Create parameter strands for toggle
        const outputs = {};
        if (strands && strands.length > 0) {
          for (const strandName of strands) {
            if (strandName.trim()) {
              const paramStrand = new ParameterStrand(strandName.trim(), defaultValue ? 1.0 : 0.0, {
                type: 'toggle',
                label: `${label} - ${strandName}`,
                defaultValue: defaultValue ? 1.0 : 0.0,
                booleanValue: defaultValue
              });
              outputs[strandName.trim()] = paramStrand;
              
              // Also register the strand as a parameter for hover detection
              this.parameters.set(strandName.trim(), paramStrand);
            }
          }
        }
        
        // Create the parameter instance
        if (Object.keys(outputs).length > 0) {
          this.instances.set(name, {
            kind: 'instance',
            name,
            outs: outputs,
            parameterType: 'toggle'
          });
        }
      }
    }
    
    // Keep only the essential check
    const lvlInstance = this.instances.get('lvl');
    if (lvlInstance) {
      console.log('✅ Parameter instance "lvl" created successfully');
    } else {
      console.log('❌ Parameter instance "lvl" NOT found');
    }
  }
  time(){ return (performance.now() - this.boot) / 1000; }
}
Env.prototype.__noise3 = noise3;

const Builtins = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, atan2: Math.atan2,
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, log: Math.log,
  min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  clamp: (x, lo, hi)=>clamp(x, lo, hi),
  length: (...args)=> (args.length===1 && Array.isArray(args[0])) ? Math.hypot(...args[0]) : Math.hypot(...args),
  distance: (...args)=>{
    if(args.length===2 && Array.isArray(args[0]) && Array.isArray(args[1])){
      const a=args[0], b=args[1]; return Math.hypot(a[0]-b[0], a[1]-b[1]);
    }
    if(args.length===4) return Math.hypot(args[0]-args[2], args[1]-args[3]);
    throw new RuntimeError("distance expects 4 scalars or two 2-tuples");
  },
  normalize: (x, a=0, b=1)=> (x-a)/((b-a)||1e-9),
  noise: (x,y,t)=> noise3(x*3.1,y*3.1,t*0.5),
};

function evalExprToStrand(node, env) {
  if (Array.isArray(node)) {
    if (node.length === 1) {
      return evalExprToStrand(node[0], env);
    } else if (node.length === 0) {
      throw new RuntimeError("Empty expression array");
    } else {
      throw new RuntimeError("Multiple expressions in array - expected single expression");
    }
  }

  switch(node.type){
    case "Num":
      return ConstantStrand(node.v);

    case "Str":
      return ConstantStrand(node.v);

    case "Tuple": {
      const items = node.items.map(n=>evalExprToStrand(n, env));
      return { kind:'strand', evalAt(me, scope) { return items.map(s=>s.evalAt(me, scope)); } };
    }

    case "Unary": {
      const arg = evalExprToStrand(node.expr, env);
      if(node.op==="NOT") return map1(arg, x => x ? 0 : 1);
      if(node.op==="-") return map1(arg, x => -x);
      if(unaryOps[node.op]) return map1(arg, unaryOps[node.op]);
      throw new RuntimeError(`Unknown unary ${node.op}`);
    }

    case "Bin": {
      const left = evalExprToStrand(node.left, env);
      const right = evalExprToStrand(node.right, env);
      const op = node.op;
      if(op==="+") return map2(left, right, binaryOps.add);
      if(op==="-") return map2(left, right, binaryOps.sub);
      if(op==="*") return map2(left, right, binaryOps.mul);
      if(op==="/") return map2(left, right, binaryOps.div);
      if(op==="%") return map2(left, right, binaryOps.mod);
      if(op==="^") return map2(left, right, binaryOps.pow);
      if(op==="==") return map2(left, right, (a,b) => (a === b) ? 1 : 0);
      if(op==="!=") return map2(left, right, (a,b) => (a !== b) ? 1 : 0);
      if(op==="<") return map2(left, right, (a,b) => (a < b) ? 1 : 0);
      if(op===">") return map2(left, right, (a,b) => (a > b) ? 1 : 0);
      if(op==="<=") return map2(left, right, (a,b) => (a <= b) ? 1 : 0);
      if(op===">=") return map2(left, right, (a,b) => (a >= b) ? 1 : 0);
      if(op==="AND") return map2(left, right, (a,b) => (a && b) ? 1 : 0);
      if(op==="OR") return map2(left, right, (a,b) => (a || b) ? 1 : 0);
      throw new RuntimeError(`Unknown binary ${op}`);
    }

    case "If": {
      const cond = evalExprToStrand(node.cond, env);
      const thenExpr = evalExprToStrand(node.t, env);
      const elseExpr = evalExprToStrand(node.e, env);
      return { kind:'strand', evalAt(me, scope) {
        return cond.evalAt(me, scope) ? thenExpr.evalAt(me, scope) : elseExpr.evalAt(me, scope);
      }};
    }

    case "Me": {
      const field=node.field;
      return { kind:'strand', evalAt(me, _scope) {
        if(field==="x") return me.x;
        if(field==="y") return me.y;
        if(field==="t") return me.t;
        if(field==="frames") return me.frames;
        if(field==="width") return me.width;
        if(field==="height") return me.height;
        throw new RuntimeError(`Invalid me.${field}`);
      }};
    }

    case "Mouse": {
      const field=node.field;
      return { kind:'strand', evalAt(_me, scope) {
        if(field==="x") return scope.mouse.x;
        if(field==="y") return scope.mouse.y;
        throw new RuntimeError(`Invalid mouse@${field}`);
      }};
    }

    case "StrandAccess": {
      const base=node.base, out=node.out;
      return { kind:'strand', evalAt(me, scope) {
        // Check scope.instances first, then env.instances (for parameter instances)
        let inst = scope.instances ? scope.instances.get(base) : null;
        if (!inst && env.instances) {
          inst = env.instances.get(base);
        }
        
        if(!inst) throw new RuntimeError(`Unknown instance '${base}'`);
        const strand = inst.outs[out];
        if(!strand) throw new RuntimeError(`'${base}' has no output '${out}'`);
        if(strand.kind === 'strand') {
          const value = strand.evalAt(me, scope);
          // Only log for parameter strands
          if (base === 'lvl' && out === 'l') {
            console.log(`🎛️ Parameter lvl@l = ${value}`);
          }
          return value;
        }
        if(typeof strand === 'function') return strand(me, scope); // backward compatibility
        return strand;
      }};
    }

    case "Call": {
      const name = node.name;
      const argStrands = node.args.map(a=>evalExprToStrand(a, env));
      if(Builtins[name]){
        return { kind:'strand', evalAt(me, scope) {
          const av = argStrands.map(s=>s.evalAt(me, scope));
          return Builtins[name](...av);
        }};
      }
      throw new RuntimeError(`Spindle calls in expressions not yet supported: '${name}'`);
    }

    case "Var": {
      const n=node.name;
      return { kind:'strand', evalAt(me, scope) {
        logger.debug('VarLookup', `Looking up variable '${n}'`);
        
        // First check for parameter strands
        const paramStrand = env.getParameterStrand(n);
        if (paramStrand) {
          logger.debug('VarLookup', `Found parameter strand '${n}'`, { value: paramStrand.value });
          return paramStrand.value;
        }
        
        if (scope.__scopeStack) {
          for (let i = scope.__scopeStack.length - 1; i >= 0; i--) {
            const s = scope.__scopeStack[i];
            if (s && n in s) {
              const v = s[n];
              logger.debug('VarLookup', `Found '${n}' in scope ${i}`, { value: v });
              if(v && v.__kind==="strand") return v.eval(me, scope);
              return v;
            }
          }
        }
        
        const error = `Unknown variable '${n}'`;
        logger.error('VarLookup', error, { scopeDepth: scope.__scopeStack?.length || 0 });
        throw new RuntimeError(error);
      }};
    }

    default: throw new RuntimeError(`Unhandled expr node ${node.type}`);
  }
}

// Legacy wrapper for backward compatibility
// Unified compilation function with multiple optimization levels
function compile(node, env, options = {}) {
  const { level = 'optimized', cache = true } = options;
  
  switch (level) {
    case 'basic':
      return compileBasic(node, env);
    case 'fast':
      return compileFast(node, env);
    case 'optimized':
    default:
      return cache ? compileWithCache(node, env) : compileFast(node, env);
  }
}

// Basic compilation using strand evaluation (most compatible)
function compileBasic(node, env) {
  const strand = evalExprToStrand(node, env);
  return (me, envCtx) => strand.evalAt(me, envCtx);
}

// Legacy aliases for compatibility
function compileExpr(node, envRef) {
  return compile(node, envRef, { level: 'basic' });
}

function compileExprOptimized(node, envRef) {
  return compile(node, envRef, { level: 'optimized' });
}

function toScalar(v){
  if(Array.isArray(v)) throw new RuntimeError("Expected scalar but got tuple");
  if(typeof v === "boolean") return v ? 1 : 0;
  if(typeof v === "number") return v;
  if(typeof v === "string") throw new RuntimeError("String used in numeric context");
  return v;
}
function unwrap(v){ return v; }

// Frame-based scoping system
function makeChildEnv(parent) {
  return { parent, bindings: {} };
}

function lookupStrand(env, name) {
  for (let e = env; e; e = e.parent) {
    if (e.bindings && name in e.bindings) return e.bindings[name];
  }
  throw new RuntimeError(`Unknown variable '${name}'`);
}

function makeSlot(v) {
  return { kind:'slot', v, set(x){this.v=x;}, get(){return this.v;} };
}

function readSlot(slot) {
  return slot.v;
}

function ConstantStrand(value) {
  return { kind: 'strand', evalAt(_me, _env) { return value; } };
}

// Parameter strand for UI-controlled values
class ParameterStrand {
  constructor(name, initialValue = 0, config = {}) {
    this.kind = 'strand';
    this.name = name;
    this.value = initialValue;
    this.config = config;
    this.isDirty = true;
    this.lastValue = undefined;
    this.subscribers = new Set();
    this.widgetType = config.type || 'slider';
    
    // Create unique ID for this parameter
    this.id = `param_${name}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  evalAt(_me, _env) {
    return this.value;
  }
  
  setValue(newValue) {
    if (this.value !== newValue) {
      console.log(`🎛️ Parameter '${this.name}' value changed: ${this.value} → ${newValue}`);
      this.value = newValue;
      this.isDirty = true;
      this.notifySubscribers();
      
      // Trigger a re-render by dispatching a custom event
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('parameterChanged', {
          detail: { paramName: this.name, newValue, strand: this }
        }));
      }
    }
  }
  
  subscribe(callback) {
    this.subscribers.add(callback);
  }
  
  unsubscribe(callback) {
    this.subscribers.delete(callback);
  }
  
  notifySubscribers() {
    this.subscribers.forEach(callback => callback(this.value, this));
  }
}

function coerceToStrand(valueOrStrand) {
  if (valueOrStrand && valueOrStrand.kind === 'strand') return valueOrStrand;
  if (typeof valueOrStrand === 'number') return ConstantStrand(valueOrStrand);
  if (valueOrStrand && valueOrStrand.kind === 'slot') return coerceToStrand(valueOrStrand.get());
  throw new RuntimeError('Expected strand/number/slot');
}

// ===== HIGH-PERFORMANCE WEFT COMPILER =====

// Ultra-fast cache using WeakMap for object identity + Map for primitives
const nodeIdCache = new WeakMap();
let nodeIdCounter = 0;
const compiledFunctionCache = new Map();

// Generate fast cache key without JSON.stringify
function getNodeId(node) {
  if (typeof node === 'object' && node !== null) {
    if (!nodeIdCache.has(node)) {
      nodeIdCache.set(node, `obj_${nodeIdCounter++}`);
    }
    return nodeIdCache.get(node);
  }
  return String(node);
}

// Pre-resolved builtin function mappings with inlined operations
const BUILTIN_JS_MAP = {
  sin: 'Math.sin', cos: 'Math.cos', tan: 'Math.tan',
  sqrt: 'Math.sqrt', abs: 'Math.abs', exp: 'Math.exp', log: 'Math.log',
  min: 'Math.min', max: 'Math.max', floor: 'Math.floor', ceil: 'Math.ceil',
  round: 'Math.round', atan2: 'Math.atan2'
};

// Pre-compiled function strings for common operations
const INLINE_OPS = {
  clamp3: '((a,b,c)=>a<b?b:a>c?c:a)',
  clamp01: '((a)=>a<0?0:a>1?1:a)',
  mix: '((a,b,t)=>a+(b-a)*t)',
  fract: '((a)=>a-~~a)',
  sign: '((a)=>a>0?1:a<0?-1:0)'
};

// Ultra-optimized compiler - no string building, direct code generation
// Compile AST node to JavaScript code
function compileToJS(node, env, resolvedVars = new Map()) {
  if (Array.isArray(node)) {
    return node.length === 1 ? compileToJS(node[0], env, resolvedVars) : '0';
  }

  switch(node.type) {
    case "Num": return String(node.v);
    case "Str": return `"${node.v.replace(/"/g, '\\"')}"`;

    case "Me": {
      const field = node.field;
      return field === "x" ? "x" : field === "y" ? "y" : field === "t" ? "t" :
             field === "frames" ? "f" : field === "width" ? "w" : field === "height" ? "h" : "0";
    }

    case "Mouse": {
      return node.field === "x" ? "mx" : node.field === "y" ? "my" : "0";
    }

    case "Unary": {
      const arg = compileToJS(node.expr, env, resolvedVars);
      return node.op === "NOT" ? `(${arg}?0:1)` : node.op === "-" ? `(-${arg})` :
             BUILTIN_JS_MAP[node.op] ? `${BUILTIN_JS_MAP[node.op]}(${arg})` : `(-${arg})`;
    }

    case "Bin": {
      const left = compileToJS(node.left, env, resolvedVars);
      const right = compileToJS(node.right, env, resolvedVars);
      const op = node.op;

      if (op === "+") return `(${left}+${right})`;
      if (op === "-") return `(${left}-${right})`;
      if (op === "*") return `(${left}*${right})`;
      if (op === "/") return `(${left}/(${right}||1e-9))`;
      if (op === "^") return `Math.pow(${left},${right})`;
      if (op === "%") return `((${left}%${right}+${right})%${right})`;
      if (op === "==") return `(${left}===${right}?1:0)`;
      if (op === "!=") return `(${left}!==${right}?1:0)`;
      if (op === "<") return `(${left}<${right}?1:0)`;
      if (op === ">") return `(${left}>${right}?1:0)`;
      if (op === "<=") return `(${left}<=${right}?1:0)`;
      if (op === ">=") return `(${left}>=${right}?1:0)`;
      if (op === "AND") return `(${left}&&${right}?1:0)`;
      if (op === "OR") return `(${left}||${right}?1:0)`;
      return "0";
    }

    case "If": {
      const cond = compileToJS(node.cond, env, resolvedVars);
      const thenExpr = compileToJS(node.t, env, resolvedVars);
      const elseExpr = compileToJS(node.e, env, resolvedVars);
      return `(${cond}?${thenExpr}:${elseExpr})`;
    }

    case "Call": {
      const name = node.name;
      const args = node.args.map(arg => compileToJS(arg, env, resolvedVars));

      if (BUILTIN_JS_MAP[name]) {
        return `${BUILTIN_JS_MAP[name]}(${args.join(',')})`;
      }

      // Optimized built-in functions
      if (name === "clamp") {
        if (args.length === 3) {
          return `(${args[0]}<${args[1]}?${args[1]}:${args[0]}>${args[2]}?${args[2]}:${args[0]})`;
        }
        return `(${args[0]}<0?0:${args[0]}>1?1:${args[0]})`;
      }
      if (name === "distance" && args.length === 4) {
        // Avoid hypot for 2D - direct calculation is faster
        const dx = `(${args[0]}-${args[2]})`;
        const dy = `(${args[1]}-${args[3]})`;
        return `Math.sqrt(${dx}*${dx}+${dy}*${dy})`;
      }
      if (name === "noise" && args.length >= 3) {
        // Use fast noise for low quality mode
        return `env.__noise3(${args[0]}*3.1,${args[1]}*3.1,${args[2]}*0.5)`;
      }
      if (name === "length") {
        if (args.length === 2) {
          return `Math.sqrt(${args[0]}*${args[0]}+${args[1]}*${args[1]})`;
        }
        return `Math.hypot(${args.join(',')})`;
      }
      if (name === "normalize" && args.length === 3) {
        const range = `(${args[2]}-${args[1]})`;
        return `((${args[0]}-${args[1]})/${range}||0)`;
      }

      return `${BUILTIN_JS_MAP[name] || 'Math.sin'}(${args.join(',')})`;
    }

    case "Var": {
      // Try to resolve variable at compile time
      const varName = node.name;
      if (resolvedVars.has(varName)) {
        return resolvedVars.get(varName);
      }
      // Fall back to runtime lookup (slower)
      return `getVar("${varName}")`;
    }

    case "StrandAccess": {
      // Pre-compile instance access where possible
      const base = node.base;
      const out = node.out;
      return `getInstance("${base}","${out}")`;
    }

    default: return "0";
  }
}

// Pre-compile function with ultra-optimized parameter list
function createOptimizedFunction(jsCode, hasVars = false, hasInstances = false) {
  let paramList = 'x,y,t,f,w,h,mx,my';
  let fnBody = `return ${jsCode};`;

  if (hasVars) {
    paramList += ',getVar';
    fnBody = `function getVar(name){
      if(env.__scopeStack){
        for(let i=env.__scopeStack.length-1;i>=0;i--){
          const s=env.__scopeStack[i];
          if(s && name in s) {
            const val = s[name];
            // Handle strand values
            if(val && val.__kind === "strand" && val.eval) return val.eval();
            if(typeof val === 'function') return val(me, env);
            return val;
          }
        }
      }
      return 0;
    }
    ${fnBody}`;
  }

  if (hasInstances) {
    paramList += ',getInstance';
    fnBody = `function getInstance(base,out){
      const inst=env.instances.get(base);
      if(!inst) return 0;
      const strand=inst.outs[out];
      if(!strand) return 0;
      // Properly evaluate the strand
      if(typeof strand==='function') return strand(me,env);
      if(strand && strand.kind === 'strand' && strand.evalAt) return strand.evalAt(me,env);
      return strand;
    }
    ${fnBody}`;
  }

  try {
    return new Function(`me,env,${paramList}`, fnBody);
  } catch(e) {
    console.warn('Function compilation failed:', e);
    return null;
  }
}

// Fast compilation with caching
function compileWithCache(node, env) {
  const nodeId = getNodeId(node);

  if (compiledFunctionCache.has(nodeId)) {
    return compiledFunctionCache.get(nodeId);
  }

  // Try fast compilation first
  try {
    const jsCode = compileToJS(node, env);
    const hasVars = jsCode.includes('getVar');
    const hasInstances = jsCode.includes('getInstance');

    const compiledFn = createOptimizedFunction(jsCode, hasVars, hasInstances);

    if (compiledFn) {
      const optimizedWrapper = (me, envCtx) => {
        return compiledFn(me, envCtx, me.x, me.y, me.t, me.frames, me.width, me.height,
                         envCtx.mouse.x, envCtx.mouse.y);
      };
      compiledFunctionCache.set(nodeId, optimizedWrapper);
      return optimizedWrapper;
    }
  } catch (e) {
    console.warn('Fast compilation failed, falling back to basic:', e.message);
  }

  // Fallback to basic compilation
  const fallbackFn = compileBasic(node, env);
  compiledFunctionCache.set(nodeId, fallbackFn);
  return fallbackFn;
}

// Fast compilation without caching
function compileFast(node, env) {
  try {
    const jsCode = compileToJS(node, env);
    const compiledFn = createOptimizedFunction(jsCode);
    if (compiledFn) {
      return (me, envCtx) => compiledFn(me, envCtx, me.x, me.y, me.t, me.frames, me.width, me.height, envCtx.mouse.x, envCtx.mouse.y);
    }
  } catch (e) {
    console.warn('Fast compilation failed:', e.message);
  }
  return compileBasic(node, env);
}

// Clear only when absolutely necessary
function clearCompilationCaches() {
  compiledFunctionCache.clear();
  nodeIdCounter = 0;
}
// Pointwise operations over strands
function map1(a, f) {
  return { kind:'strand', evalAt(me, env){ return f(a.evalAt(me, env)); } };
}

function map2(a, b, f) {
  return { kind:'strand', evalAt(me, env){ return f(a.evalAt(me, env), b.evalAt(me, env)); } };
}

const unaryOps  = { neg: x => -x, abs: Math.abs, sin: Math.sin, cos: Math.cos, sqrt: Math.sqrt };
const binaryOps = {
  add:(a,b)=>a+b, sub:(a,b)=>a-b, mul:(a,b)=>a*b, div:(a,b)=>a/(b||1e-9),
  pow:(a,b)=>Math.pow(a,b), mod:(a,b)=>((a % b)+b)%b, atan2:(y,x)=>Math.atan2(y,x)
};

// ===== Instances & Spindles =====
function makeSimpleInstance(name, outs){ return { name, outs }; }

// Global image cache for performance
const imageCache = new Map();
const preloadedImages = new Set();

class Sampler {
  constructor(){
    this.kind="none"; this.ready=false; this.width=1; this.height=1; this.video=null; this.image=null;
    this.off = document.createElement('canvas');
    this.offCtx = this.off.getContext('2d', { willReadFrequently: true, alpha: false });
    this.pixels=null; this.path = null; this.lastUpdate = 0;
  }

  static preloadImage(path) {
    if (preloadedImages.has(path)) return Promise.resolve();
    
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        imageCache.set(path, {
          image: img,
          width: img.width,
          height: img.height,
          timestamp: performance.now()
        });
        preloadedImages.add(path);
        logger.info('Sampler', `Preloaded image: ${path} (${img.width}x${img.height})`);
        resolve();
      };
      img.onerror = (e) => {
        logger.warn('Sampler', `Failed to preload image: ${path}`, e);
        reject(e);
      };
      img.src = path;
    });
  }

  static clearCache() {
    imageCache.clear();
    preloadedImages.clear();
    logger.info('Sampler', 'Image cache cleared');
  }

  load(path){
    this.path = path;
    const lower = (path||"").toLowerCase();
    
    logger.info('Sampler', `Loading media: ${path}`);
    
    // Handle video files
    if(lower.endsWith(".mp4") || lower.endsWith(".webm")){
      this.kind="video"; 
      this.video=document.createElement('video');
      this.video.src=path; 
      this.video.muted=true; 
      this.video.loop=true; 
      this.video.playsInline=true; 
      this.video.crossOrigin="anonymous";
      this.video.preload = "auto";
      
      this.video.addEventListener('loadeddata', ()=>{
        this.width=this.video.videoWidth||320; 
        this.height=this.video.videoHeight||180;
        this.off.width=this.width; 
        this.off.height=this.height; 
        this.ready=true;
        logger.info('Sampler', `Video loaded: ${path} (${this.width}x${this.height})`);
      });
      
      this.video.addEventListener('error', (e)=>{
        logger.error('Sampler', `Video failed to load: ${path}`, e);
        this.fallbackPattern();
      });
      return;
    }
    
    // Handle image files with caching
    if(lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".gif") || lower.endsWith(".webp")){
      this.kind="image";
      
      // Check cache first
      const cached = imageCache.get(path);
      if (cached) {
        logger.info('Sampler', `Using cached image: ${path}`);
        this.image = cached.image;
        this.width = cached.width;
        this.height = cached.height;
        this.off.width = this.width;
        this.off.height = this.height;
        this.processImage();
        return;
      }
      
      // Load new image
      this.image = new Image(); 
      this.image.crossOrigin = "anonymous";
      this.image.decoding = "async"; // Enable async decoding for better performance
      
      this.image.onload = ()=>{
        logger.info('Sampler', `Image loaded: ${path} (${this.image.width}x${this.image.height})`);
        this.width = this.image.width; 
        this.height = this.image.height; 
        this.off.width = this.width; 
        this.off.height = this.height;
        
        // Cache the image
        imageCache.set(path, {
          image: this.image,
          width: this.width,
          height: this.height,
          timestamp: performance.now()
        });
        
        this.processImage();
      };
      
      this.image.onerror = (e)=>{
        logger.error('Sampler', `Image failed to load: ${path}`, e);
        this.fallbackPattern();
      };
      
      this.image.src = path;
      return;
    }
    
    logger.warn('Sampler', `Unknown file type for: ${path}`);
    this.fallbackPattern();
  }

  processImage() {
    // Use requestIdleCallback for non-blocking image processing
    const processNow = () => {
      this.offCtx.drawImage(this.image, 0, 0); 
      this.pixels = this.offCtx.getImageData(0, 0, this.width, this.height).data; 
      this.ready = true;
      this.lastUpdate = performance.now();
    };

    if (window.requestIdleCallback) {
      requestIdleCallback(processNow, { timeout: 100 });
    } else {
      setTimeout(processNow, 0);
    }
  }
  fallbackPattern(){
    this.kind="fallback"; this.ready=true; this.width=256; this.height=256; this.off.width=this.width; this.off.height=this.height;
    const g = this.offCtx.createLinearGradient(0,0,this.width,0);
    g.addColorStop(0,"#000"); g.addColorStop(1,"#0ff");
    this.offCtx.fillStyle=g; this.offCtx.fillRect(0,0,this.width,this.height);
    this.pixels=this.offCtx.getImageData(0,0,this.width,this.height).data;
  }
  play(){ if(this.video){ try{ this.video.play(); }catch{} } }
  updateFrame(){
    if(this.kind==="video" && this.ready){
      // Throttle video updates for performance
      const now = performance.now();
      if (now - this.lastUpdate > 16.67) { // ~60fps max
        this.offCtx.drawImage(this.video,0,0,this.width,this.height);
        this.pixels=this.offCtx.getImageData(0,0,this.width,this.height).data;
        this.lastUpdate = now;
      }
    }
  }

  // Optimized sampling with bounds checking and bilinear interpolation option
  sample(nx, ny, interpolate = false){
    if(!this.ready || !this.pixels){ 
      return [nx, ny, 0.5, 1]; 
    }
    
    if (interpolate) {
      return this.sampleBilinear(nx, ny);
    } else {
      return this.sampleNearest(nx, ny);
    }
  }

  sampleNearest(nx, ny) {
    const x = clamp(Math.floor(nx * this.width), 0, this.width-1);
    const y = clamp(Math.floor(ny * this.height), 0, this.height-1);
    const idx = (y * this.width + x) * 4;
    const d = this.pixels;
    return [d[idx]/255, d[idx+1]/255, d[idx+2]/255, d[idx+3]/255];
  }

  sampleBilinear(nx, ny) {
    const fx = nx * this.width - 0.5;
    const fy = ny * this.height - 0.5;
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    const dx = fx - x;
    const dy = fy - y;

    const x0 = clamp(x, 0, this.width-1);
    const x1 = clamp(x + 1, 0, this.width-1);
    const y0 = clamp(y, 0, this.height-1);
    const y1 = clamp(y + 1, 0, this.height-1);

    const d = this.pixels;
    const w = this.width;

    const getPixel = (px, py) => {
      const idx = (py * w + px) * 4;
      return [d[idx], d[idx+1], d[idx+2], d[idx+3]];
    };

    const p00 = getPixel(x0, y0);
    const p10 = getPixel(x1, y0);
    const p01 = getPixel(x0, y1);
    const p11 = getPixel(x1, y1);

    const result = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const top = p00[i] * (1 - dx) + p10[i] * dx;
      const bottom = p01[i] * (1 - dx) + p11[i] * dx;
      result[i] = (top * (1 - dy) + bottom * dy) / 255;
    }

    return result;
  }
}

const BuiltinSpindles = {
  load: (env, args, instName, outs) => {
    const path = (args[0] && args[0].type==="Str") ? args[0].v : "";
    const xExpr = args[1] ? compileExprOptimized(args[1], env) : null;
    const yExpr = args[2] ? compileExprOptimized(args[2], env) : null;

    logger.info('Builtin', `Loading media: '${path}' for instance '${instName}'`, { outs });

    const sampler = new Sampler(); sampler.load(path);
    if(sampler.kind!=="none") env.defaultSampler = sampler;

    // Create flexible output mapping
    const instanceOuts = {};
    
    // Get component values function
    const getComponent = (index, me, env) => {
      const x = xExpr ? toScalar(xExpr(me, env)) : me.x;
      const y = yExpr ? toScalar(yExpr(me, env)) : me.y;
      return (env.defaultSampler||sampler).sample(x, y)[index] || 0;
    };

    // Map outputs based on their names or positions
    for (let i = 0; i < outs.length; i++) {
      const outName = typeof outs[i] === 'string' ? outs[i] : (outs[i].name || outs[i].alias);
      
      // Try to map based on common color channel names
      let componentIndex = 0; // default to red
      if (outName === 'r' || outName === 'red') componentIndex = 0;
      else if (outName === 'g' || outName === 'green') componentIndex = 1;
      else if (outName === 'b' || outName === 'blue') componentIndex = 2;
      else if (outName === 'a' || outName === 'alpha') componentIndex = 3;
      else if (outName === 'left' || outName === 'right') {
        // Audio outputs
        instanceOuts[outName] = {
          kind: 'strand',
          evalAt: (_me, _env) => env.audio.intensity || 0
        };
        continue;
      } else {
        // For any other name, use position-based mapping (r,g,b,a in order)
        componentIndex = Math.min(i, 3);
      }

      instanceOuts[outName] = {
        kind: 'strand',
        evalAt: (me, env) => getComponent(componentIndex, me, env)
      };
      
      logger.debug('Builtin', `Mapped output '${outName}' to component ${componentIndex}`);
    }

    const inst = makeSimpleInstance(instName, instanceOuts);
    inst.sampler = sampler; // Store sampler reference
    
    // Handle audio files
    const lower = (path||"").toLowerCase();
    if(lower.endsWith(".wav") || lower.endsWith(".mp3") || lower.endsWith(".ogg")){
      logger.info('Builtin', `Setting up audio for: ${path}`);
      const el = new Audio(path); el.loop=true; el.crossOrigin="anonymous";
      env.audio.element = el;
      try {
        const ctx = new (window.AudioContext||window['webkitAudioContext'])();
        const src = ctx.createMediaElementSource(el);
        const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
        src.connect(analyser); analyser.connect(ctx.destination);
        env.audio.ctx=ctx; env.audio.analyser=analyser;
        logger.info('Builtin', 'Audio context created successfully');
      } catch(e) {
        logger.warn('Builtin', `Failed to create audio context: ${e.message}`);
      }
    }
    
    env.instances.set(instName, inst);
    logger.updateInstanceViewer(env.instances);
    return inst;
  },

  sample: (env, args, instName, outs) => {
    // sample(imageInstance, x, y) - sample a specific loaded image at custom coordinates
    const imageInstanceName = (args[0] && args[0].type === "Var") ? args[0].name : null;
    const xExpr = compileExprOptimized(args[1], env);
    const yExpr = compileExprOptimized(args[2], env);

    logger.info('Builtin', `Creating sample instance '${instName}' from '${imageInstanceName}'`, { outs });

    const instanceOuts = {};
    
    // Get component values function with safety checks
    const getComponent = (index, me, env) => {
      const x = toScalar(xExpr(me, env));
      const y = toScalar(yExpr(me, env));
      const imageInst = env.instances.get(imageInstanceName);
      const sampler = (imageInst && imageInst.sampler) || env.defaultSampler || fallbackSampler;
      return sampler.sample(x, y)[index] || 0;
    };

    // Map outputs flexibly
    for (let i = 0; i < outs.length; i++) {
      const outName = typeof outs[i] === 'string' ? outs[i] : (outs[i].name || outs[i].alias);
      
      let componentIndex = 0; // default to red
      if (outName === 'r' || outName === 'red') componentIndex = 0;
      else if (outName === 'g' || outName === 'green') componentIndex = 1;
      else if (outName === 'b' || outName === 'blue') componentIndex = 2;
      else if (outName === 'a' || outName === 'alpha') componentIndex = 3;
      else componentIndex = Math.min(i, 3); // position-based fallback

      instanceOuts[outName] = {
        kind: 'strand',
        evalAt: (me, env) => getComponent(componentIndex, me, env)
      };
      
      logger.debug('Builtin', `Sample output '${outName}' → component ${componentIndex}`);
    }

    const inst = makeSimpleInstance(instName, instanceOuts);
    env.instances.set(instName, inst);
    logger.updateInstanceViewer(env.instances);
    return inst;
  },

  video: (env, args, instName, outs) => {
    const xf = compileExprOptimized(args[0], env);
    const yf = compileExprOptimized(args[1], env);
    
    logger.info('Builtin', `Creating video instance '${instName}'`, { outs });

    const instanceOuts = {};
    
    // Get component values function
    const getComponent = (index, me, env) => {
      return (env.defaultSampler||fallbackSampler).sample(toScalar(xf(me,env)), toScalar(yf(me,env)))[index] || 0;
    };

    // Map outputs flexibly
    for (let i = 0; i < outs.length; i++) {
      const outName = typeof outs[i] === 'string' ? outs[i] : (outs[i].name || outs[i].alias);
      
      let componentIndex = 0; // default to red
      if (outName === 'r' || outName === 'red') componentIndex = 0;
      else if (outName === 'g' || outName === 'green') componentIndex = 1;
      else if (outName === 'b' || outName === 'blue') componentIndex = 2;
      else if (outName === 'a' || outName === 'alpha') componentIndex = 3;
      else componentIndex = Math.min(i, 3); // position-based fallback

      instanceOuts[outName] = {
        kind: 'strand',
        evalAt: (me, env) => getComponent(componentIndex, me, env)
      };
      
      logger.debug('Builtin', `Video output '${outName}' → component ${componentIndex}`);
    }

    const inst = makeSimpleInstance(instName, instanceOuts);
    env.instances.set(instName, inst);
    logger.updateInstanceViewer(env.instances);
    return inst;
  },
  compose: (env, args, instName, outs) => {
    logger.info('Builtin', `Creating compose instance '${instName}'`, { outs, argCount: args.length });
    
    const argExprs = args.map(arg => compileExprOptimized(arg, env));
    const instanceOuts = {};

    // Map outputs flexibly - either by name or position
    for (let i = 0; i < outs.length; i++) {
      const outName = typeof outs[i] === 'string' ? outs[i] : (outs[i].name || outs[i].alias);
      const argIndex = Math.min(i, argExprs.length - 1);
      
      instanceOuts[outName] = {
        kind: 'strand',
        evalAt: (me, env) => {
          if (argIndex < argExprs.length) {
            return toScalar(argExprs[argIndex](me, env));
          }
          return 0;
        }
      };
      
      logger.debug('Builtin', `Compose output '${outName}' → arg[${argIndex}]`);
    }

    const inst = makeSimpleInstance(instName, instanceOuts);
    env.instances.set(instName, inst);
    logger.updateInstanceViewer(env.instances);
    return inst;
  },

  map: (env, args, instName, outs) => {
    const spindleName = (args[0] && args[0].type === "Str") ? args[0].v : "";
    const spindleDef = env.spindles.get(spindleName);

    if (!spindleDef) {
      const error = `Unknown spindle '${spindleName}' in map`;
      logger.error('Builtin', error);
      throw new RuntimeError(error);
    }

    logger.info('Builtin', `Creating map instance '${instName}' using spindle '${spindleName}'`, { 
      outs, 
      spindleOuts: spindleDef.outs,
      argCount: args.length - 1 
    });

    // Get array arguments - compile as expressions
    const arrayExprs = args.slice(1).map(arg => compileExprOptimized(arg, env));
    const instanceOuts = {};

    // Create outputs - one for each requested output
    for (let i = 0; i < outs.length; i++) {
      const outName = typeof outs[i] === 'string' ? outs[i] : (outs[i].name || outs[i].alias);

      instanceOuts[outName] = {
        kind: 'strand',
        evalAt: (me, globalEnv) => {
          try {
            // Evaluate all array arguments
            const arrays = arrayExprs.map(expr => {
              const result = expr(me, globalEnv);
              return Array.isArray(result) ? result : [result];
            });

            // Get the i-th element from each array (or first element if array is shorter)
            const elementArgs = arrays.map(arr => arr[i] || arr[0] || 0);

            // Create a proper call with the element arguments
            const callWithArgs = {
              callee: spindleName,
              args: elementArgs.map(val => ({ type: 'Num', v: toScalar(val) }))
            };
            
            const evalFn = evalSpindleCall(callWithArgs, env);
            const result = evalFn(me, globalEnv);

            // Try to return a corresponding output from the mapped spindle
            // First try exact name match, then positional, then first output
            if (result[outName] !== undefined) {
              return result[outName];
            } else if (spindleDef.outs[i]) {
              return result[spindleDef.outs[i]] || 0;
            } else if (spindleDef.outs[0]) {
              return result[spindleDef.outs[0]] || 0;
            }
            return 0;
          } catch (error) {
            logger.warn('Builtin', `Map evaluation failed for '${outName}': ${error.message}`);
            return 0;
          }
        }
      };
      
      logger.debug('Builtin', `Map output '${outName}' mapped to element ${i}`);
    }

    const inst = makeSimpleInstance(instName, instanceOuts);
    env.instances.set(instName, inst);
    logger.updateInstanceViewer(env.instances);
    return inst;
  },

  noise: (env, args, instName, outs) => {
    logger.info('Builtin', `Creating noise instance '${instName}'`, { outs, argCount: args.length });
    
    // Use compiled expressions for performance
    const xExpr = args[0] ? compileExprOptimized(args[0], env) : (me) => me.x;
    const yExpr = args[1] ? compileExprOptimized(args[1], env) : (me) => me.y;
    const tExpr = args[2] ? compileExprOptimized(args[2], env) : (me) => me.t;
    const ampExpr = args[3] ? compileExprOptimized(args[3], env) : () => 1;
    const periodExpr = args[4] ? compileExprOptimized(args[4], env) : () => 1;
    const harmonicsExpr = args[5] ? compileExprOptimized(args[5], env) : () => 3;

    const instanceOuts = {};
    
    // Generate noise value
    const generateNoise = (me, env) => {
      const x = xExpr(me, env);
      const y = yExpr(me, env);
      const t = tExpr(me, env);
      const amp = ampExpr(me, env);
      const period = Math.max(0.001, periodExpr(me, env));
      const harmonics = Math.max(1, Math.floor(harmonicsExpr(me, env)));
      const freq = 1.0 / period;

      if (harmonics === 1) {
        return noise3(x * freq, y * freq, t * freq) * amp;
      }

      let result = 0, maxValue = 0, f = freq, a = amp;
      for (let i = 0; i < harmonics; i++) {
        result += noise3(x * f, y * f, t * f) * a;
        maxValue += a;
        f *= 2.0;
        a *= 0.5;
      }
      return maxValue > 0 ? result / maxValue : 0;
    };

    // Map outputs - all outputs get the same noise value (unless specified otherwise)
    for (let i = 0; i < outs.length; i++) {
      const outName = typeof outs[i] === 'string' ? outs[i] : (outs[i].name || outs[i].alias);
      
      instanceOuts[outName] = {
        kind: 'strand',
        evalAt: generateNoise
      };
      
      logger.debug('Builtin', `Noise output '${outName}' created`);
    }

    const inst = makeSimpleInstance(instName, instanceOuts);
    env.instances.set(instName, inst);
    logger.updateInstanceViewer(env.instances);
    return inst;
  },
};
const fallbackSampler = new Sampler(); fallbackSampler.fallbackPattern();

// Fixed spindle call evaluator that properly binds parameters
function evalSpindleCall(call, outerEnv) {
  const def = outerEnv.spindles.get(call.callee);
  if (!def) {
    const error = `Unknown spindle '${call.callee}'`;
    logger.error('SpindleCall', error);
    throw new RuntimeError(error);
  }

  logger.info('SpindleCall', `Evaluating spindle '${call.callee}'`, {
    params: def.params,
    outputs: def.outs,
    argCount: call.args.length
  });

  // Compile arguments as strands
  const argStrands = call.args.map(arg => evalExprToStrand(arg, outerEnv));

  return function(me, globalEnv) {
    logger.debug('SpindleCall', `Executing ${call.callee} at (${me.x}, ${me.y})`);
    
    // Create local scope with parameter bindings
    const paramBindings = {};

    // Handle both nested and flat parameter lists properly
    let params = def.params;
    if (Array.isArray(params) && params.length > 0 && Array.isArray(params[0])) {
      params = params[0]; // Flatten nested parameters
    }
    if (!Array.isArray(params)) {
      params = []; // Ensure params is always an array
    }

    logger.debug('SpindleCall', `Binding ${params.length} parameters`, { params });

    // Bind parameters to evaluated argument values
    for (let i = 0; i < params.length; i++) {
      const paramName = params[i];
      if (!paramName || typeof paramName !== 'string') {
        logger.warn('SpindleCall', `Skipping invalid parameter at index ${i}`, { paramName });
        continue;
      }
      
      const argStrand = argStrands[i] || ConstantStrand(0);
      const value = argStrand.evalAt(me, globalEnv);
      
      // Store as constant strand for consistent lookup
      paramBindings[paramName] = { __kind: "strand", eval: () => value };
      
      logger.debug('SpindleCall', `Bound parameter '${paramName}' = ${value}`);
    }

    // Initialize output variables
    const outputs = {};
    for (const out of def.outs) {
      outputs[out] = 0;
      logger.debug('SpindleCall', `Initialized output '${out}' = 0`);
    }

    // Create combined scope (parameters + outputs)
    const localScope = { ...paramBindings };
    for (const out of def.outs) {
      localScope[out] = 0;
    }

    // Execute body with scope stack
    const oldStack = globalEnv.__scopeStack || [];
    globalEnv.__scopeStack = [...oldStack, localScope];
    
    logger.debug('SpindleCall', `Created scope stack depth: ${globalEnv.__scopeStack.length}`);
    logger.updateScopeViewer(globalEnv.__scopeStack);

    try {
      // Execute each statement in the body
      for (const stmt of def.body.body) {
        logger.debug('SpindleCall', `Executing statement: ${stmt.type}`);
        execStmtWithScope(stmt, me, globalEnv, localScope);
      }

      // Collect output values
      const result = {};
      for (const out of def.outs) {
        result[out] = localScope[out];
        logger.debug('SpindleCall', `Output '${out}' = ${result[out]}`);
      }
      
      logger.debug('SpindleCall', `${call.callee} completed`, result);
      return result;

    } catch (error) {
      logger.error('SpindleCall', `Error in ${call.callee}: ${error.message}`, { 
        localScope: Object.keys(localScope),
        error: error.stack 
      });
      throw error;
    } finally {
      globalEnv.__scopeStack = oldStack;
      logger.updateScopeViewer(globalEnv.__scopeStack);
    }
  };
}

function execStmtWithScope(stmt, me, env, localScope) {
  logger.debug('StmtExec', `Executing ${stmt.type} statement`);
  
  if (stmt.type === "Let") {
    const value = compileExprOptimized(stmt.expr, env)(me, env);
    localScope[stmt.name] = value;
    logger.debug('StmtExec', `Let: ${stmt.name} = ${value}`);
    return;
  }

  if (stmt.type === "Assign") {
    const rhs = compileExprOptimized(stmt.expr, env)(me, env);
    const cur = localScope[stmt.name] ?? 0;

    let newValue;
    if (stmt.op === "=") newValue = rhs;
    else if (stmt.op === "+=") newValue = cur + rhs;
    else if (stmt.op === "-=") newValue = cur - rhs;
    else if (stmt.op === "*=") newValue = cur * rhs;
    else if (stmt.op === "/=") newValue = cur / (rhs || 1e-9);
    else {
      const error = `Unknown assignment op ${stmt.op}`;
      logger.error('StmtExec', error);
      throw new RuntimeError(error);
    }
    
    localScope[stmt.name] = newValue;
    logger.debug('StmtExec', `Assign: ${stmt.name} ${stmt.op} ${rhs} → ${newValue}`);
    return;
  }

  if (stmt.type === "For") {
    const start = Math.floor(compileExprOptimized(stmt.start, env)(me, env));
    const end = Math.floor(compileExprOptimized(stmt.end, env)(me, env));
    const inc = start <= end ? 1 : -1;

    logger.debug('StmtExec', `For loop: ${stmt.v} from ${start} to ${end} (inc: ${inc})`);

    for (let v = start; inc > 0 ? v <= end : v >= end; v += inc) {
      localScope[stmt.v] = v;
      logger.debug('StmtExec', `For iteration: ${stmt.v} = ${v}`);
      
      for (const s of stmt.body.body) {
        execStmtWithScope(s, me, env, localScope);
      }
    }
    return;
  }

  const error = `Unknown body stmt ${stmt.type}`;
  logger.error('StmtExec', error);
  throw new RuntimeError(error);
}

// Legacy spindle body interpreter (for compatibility)
function compileSpindleBody(astBody, paramNames, outNames, argExprs, outerEnv){
  const call = { callee: 'temp', args: argExprs, outs: outNames };
  const tempDef = { params: paramNames, outs: outNames, body: astBody };
  outerEnv.spindles.set('temp', tempDef);

  const evalFn = evalSpindleCall(call, outerEnv);

  return function(me, env) {
    const result = evalFn(me, env);
    return result;
  };
}

// Program executor
class Executor {
  constructor(env, parser = null, standardLibraryCode = null){ 
    this.env = env; 
    this.ast = null;
    this.parser = parser;
    this.standardLibraryCode = standardLibraryCode;
  }

  loadStandardLibrary() {
    logger.info('Executor', 'Loading standard library');
    
    // Load standard library spindles if available
    if (this.standardLibraryCode && this.parser) {
      try {
        const stdlibAst = this.parser.parse(this.standardLibraryCode);
        let loadedCount = 0;
        
        for (const s of stdlibAst.body) {
          if (s.type === "SpindleDef") {
            this.env.spindles.set(s.name, s);
            loadedCount++;
            logger.debug('Executor', `Loaded stdlib spindle: ${s.name}`, { 
              params: s.params, 
              outputs: s.outs 
            });
          }
        }
        
        logger.info('Executor', `Standard library loaded: ${loadedCount} spindles`);
      } catch (e) {
        logger.error('Executor', `Failed to load standard library: ${e.message}`);
      }
    } else {
      logger.warn('Executor', 'Standard library code or parser not available');
    }
  }
  run(ast){
    logger.info('Executor', 'Starting program execution');
    
    this.ast = ast;
    this.env.instances.clear();
    this.env.displayFns = null;

    // Process pragmas for parameter strands
    if (ast.pragmas) {
      this.env.processParameters(ast.pragmas);
      logger.info('Executor', `Processed ${ast.pragmas.length} pragmas`);
    }

    // Clear compilation caches on new program run
    clearCompilationCaches();

    // Load standard library spindles first
    this.loadStandardLibrary();

    // Register user-defined spindles
    let userSpindleCount = 0;
    for(const s of ast.statements){
      if(s.type==="SpindleDef") {
        this.env.spindles.set(s.name, s);
        userSpindleCount++;
        logger.debug('Executor', `Registered user spindle: ${s.name}`, { 
          params: s.params, 
          outputs: s.outs 
        });
      }
    }
    
    logger.info('Executor', `Registered ${userSpindleCount} user spindles`);
    for(const s of ast.statements){
      if(s.type==="SpindleDef") continue;
      if(s.type==="Direct"){
        const fx = compileExprOptimized(s.expr, this.env);
        let existingInst = this.env.instances.get(s.name);
        const outs = existingInst ? {...existingInst.outs} : {};
        if(s.outs.length===1){
          const nameOut = s.outs[0];
          outs[nameOut] = (me,env)=> fx(me,env);
        } else {
          outs[s.outs[0]] = (me,env)=> {
            const v = fx(me,env); if(!Array.isArray(v)) throw new RuntimeError("Tuple expected");
            return v[0] ?? 0;
          };
          for(let i=1;i<s.outs.length;i++){
            const k = s.outs[i];
            outs[k] = (me,env)=> {
              const v = fx(me,env);
              return Array.isArray(v) ? (v[i] ?? 0) : 0;
            };
          }
        }
        this.env.instances.set(s.name, makeSimpleInstance(s.name, outs));
        continue;
      }
      if(s.type==="CallInstance"){
        if(BuiltinSpindles[s.callee]){
          BuiltinSpindles[s.callee](this.env, s.args, s.inst, s.outs);
        } else {
          const def = this.env.spindles.get(s.callee);
          if(!def) throw new RuntimeError(`Unknown spindle '${s.callee}'`);

          // Use new spindle call evaluator
          const compute = evalSpindleCall(s, this.env);
          const outs = {};
          for(const o of s.outs){
            if(o.type === 'AliasedIdent'){
              // New format: alias:actual
              const idx = def.outs.indexOf(o.actual);
              if(idx<0) throw new RuntimeError(`Spindle '${def.name}' has no output '${o.actual}'`);
              outs[o.alias] = { kind:'strand', evalAt(me, env) { return compute(me, env)[o.actual]; } };
            } else if(o.type === 'NormalIdent'){
              // Check if this is positional mapping (aliases) or exact name mapping
              const outputIndex = s.outs.indexOf(o);
              if (outputIndex >= 0 && outputIndex < def.outs.length) {
                // Positional mapping: map to corresponding spindle output by position
                const actualOutput = def.outs[outputIndex];
                outs[o.name] = { kind:'strand', evalAt(me, env) { return compute(me, env)[actualOutput]; } };
              } else if (def.outs.indexOf(o.name) >= 0) {
                // Exact name mapping: output name matches spindle output name
                outs[o.name] = { kind:'strand', evalAt(me, env) { return compute(me, env)[o.name]; } };
              } else {
                throw new RuntimeError(`Cannot map output '${o.name}' - no matching spindle output`);
              }
            } else if(typeof o === 'string'){
              // Legacy format: direct output name - allow any name, map to first output
              const actualOutput = def.outs[0]; // Use first (and likely only) output
              if(!actualOutput) throw new RuntimeError(`Spindle '${def.name}' has no outputs`);
              outs[o] = { kind:'strand', evalAt(me, env) { return compute(me, env)[actualOutput]; } };
            } else {
              throw new RuntimeError(`Unknown output format: ${JSON.stringify(o)}`);
            }
          }
          // Merge outputs into existing instance if it exists
          const existingInst = this.env.instances.get(s.inst);
          const mergedOuts = existingInst ? {...existingInst.outs, ...outs} : outs;
          this.env.instances.set(s.inst, makeSimpleInstance(s.inst, mergedOuts));
        }
        continue;
      }
      if(s.type==="Display"){
        logger.info('Display', `Processing display statement with ${s.args.length} arguments`);
        let fr, fg, fb;

        if(s.args.length === 1) {
          // Check if single argument is an instance with outputs
          const arg = s.args[0];
          if(arg.type === "Var") {
            const inst = this.env.instances.get(arg.name);
            if(inst && inst.outs) {
              const outputs = Object.keys(inst.outs);
              logger.info('Display', `Instance '${arg.name}' has outputs: [${outputs.join(', ')}]`);
              
              if(outputs.length >= 3) {
                // Use the first 3 outputs for r,g,b
                const [rOut, gOut, bOut] = outputs;
                logger.info('Display', `Mapping: r=${rOut}, g=${gOut}, b=${bOut}`);
                
                fr = (me, env) => {
                  const strand = inst.outs[rOut];
                  return strand && strand.evalAt ? strand.evalAt(me, env) : (typeof strand === 'function' ? strand(me, env) : strand);
                };
                fg = (me, env) => {
                  const strand = inst.outs[gOut];
                  return strand && strand.evalAt ? strand.evalAt(me, env) : (typeof strand === 'function' ? strand(me, env) : strand);
                };
                fb = (me, env) => {
                  const strand = inst.outs[bOut];
                  return strand && strand.evalAt ? strand.evalAt(me, env) : (typeof strand === 'function' ? strand(me, env) : strand);
                };
              } else if(outputs.length === 1) {
                // Single output - use for all three channels (grayscale)
                const singleOut = outputs[0];
                logger.info('Display', `Single output '${singleOut}' - using as grayscale`);
                
                const getSingleValue = (me, env) => {
                  const strand = inst.outs[singleOut];
                  return strand && strand.evalAt ? strand.evalAt(me, env) : (typeof strand === 'function' ? strand(me, env) : strand);
                };
                fr = fg = fb = getSingleValue;
              } else {
                const error = `Instance '${arg.name}' has ${outputs.length} outputs - need at least 1 or exactly 3 for display`;
                logger.error('Display', error);
                throw new RuntimeError(error);
              }
            } else {
              const error = `Unknown instance '${arg.name}' for display`;
              logger.error('Display', error);
              throw new RuntimeError(error);
            }
          } else {
            const error = "Single argument display requires an instance name";
            logger.error('Display', error);
            throw new RuntimeError(error);
          }
        } else if(s.args.length === 3) {
          // Original 3-argument behavior
          logger.info('Display', 'Using 3 separate expressions for r,g,b');
          fr = compileExprOptimized(s.args[0], this.env);
          fg = compileExprOptimized(s.args[1], this.env);
          fb = compileExprOptimized(s.args[2], this.env);
        } else {
          const error = `display needs either 1 instance or 3 expressions, got ${s.args.length} arguments`;
          logger.error('Display', error);
          throw new RuntimeError(error);
        }

        this.env.displayFns = [fr, fg, fb];
        logger.info('Display', 'Display functions configured successfully');
        continue;
      }
      if(s.type==="RenderStmt"){
        logger.info('RenderStmt', `Processing render statement with ${s.args.length} arguments`);
        // Handle RenderStmt the same way as Display for now
        let fr, fg, fb;

        if(s.args.length === 1) {
          // Check if single argument is an instance with outputs
          const arg = s.args[0];
          if(arg.type === "Var") {
            const inst = this.env.instances.get(arg.name);
            if(inst && inst.outs) {
              const outputs = Object.keys(inst.outs);
              logger.info('RenderStmt', `Instance '${arg.name}' has outputs: [${outputs.join(', ')}]`);
              
              if(outputs.length >= 3) {
                // Use the first 3 outputs for r,g,b
                const [rOut, gOut, bOut] = outputs;
                logger.info('RenderStmt', `Mapping: r=${rOut}, g=${gOut}, b=${bOut}`);
                fr = compileExprOptimized({type: "StrandAccess", base: arg, out: rOut}, this.env);
                fg = compileExprOptimized({type: "StrandAccess", base: arg, out: gOut}, this.env);
                fb = compileExprOptimized({type: "StrandAccess", base: arg, out: bOut}, this.env);
              } else {
                logger.warn('RenderStmt', `Instance '${arg.name}' has insufficient outputs for r,g,b`);
                fr = fg = fb = () => 0;
              }
            } else {
              // Single expression
              const compiledExpr = compileExprOptimized(arg, this.env);
              fr = fg = fb = compiledExpr;
            }
          } else {
            // Single expression
            const compiledExpr = compileExprOptimized(arg, this.env);
            fr = fg = fb = compiledExpr;
          }
        } else if(s.args.length >= 3) {
          fr = compileExprOptimized(s.args[0], this.env);
          fg = compileExprOptimized(s.args[1], this.env);
          fb = compileExprOptimized(s.args[2], this.env);
        }

        this.env.displayFns = [fr, fg, fb];
        logger.info('RenderStmt', 'Render functions configured successfully');
        continue;
      }
      if(s.type==="PlayStmt"){
        logger.info('PlayStmt', `Processing play statement with ${s.args.length} arguments - not implemented yet`);
        continue;
      }
      if(s.type==="ComputeStmt"){
        logger.info('ComputeStmt', `Processing compute statement with ${s.args.length} arguments - not implemented yet`);
        continue;
      }
      if(s.type==="EnvStmt"){
        console.log('Processing EnvStmt:', s.field, s.expr);
        if(s.field === "frames") {
          const valueExpr = compileExprOptimized(s.expr, this.env);
          // Evaluate the expression to get the target fps
          const fps = toScalar(valueExpr({}, this.env));
          this.env.targetFps = Math.max(1, Math.min(120, fps)); // Clamp between 1-120 fps
          console.log('Set target FPS to:', this.env.targetFps);
        }
        if(s.field === "width") {
          const valueExpr = compileExprOptimized(s.expr, this.env);
          // Evaluate the expression to get the target width
          const width = toScalar(valueExpr({}, this.env));
          // Use reasonable limits - WebGL usually supports up to 16384 but let's be conservative
          this.env.resW = Math.max(1, Math.min(8192, Math.floor(width)));
          console.log('Set width to:', this.env.resW);
        }
        if(s.field === "height") {
          const valueExpr = compileExprOptimized(s.expr, this.env);
          // Evaluate the expression to get the target height
          const height = toScalar(valueExpr({}, this.env));
          // Use reasonable limits - WebGL usually supports up to 16384 but let's be conservative
          this.env.resH = Math.max(1, Math.min(8192, Math.floor(height)));
          console.log('Set height to:', this.env.resH);
        }
        continue;
      }
      throw new RuntimeError(`Unhandled statement type ${s.type}`);
    }
    if(!this.env.displayFns) throw new RuntimeError("No render(...) or display(...) statement found.");
  }
}

// Export using ES6 modules
export {
  Env,
  Executor,
  clamp,
  isNum,
  logger,
  RuntimeError,
  evalExprToStrand,
  compile,
  compileExpr, // Legacy alias
  compileExprOptimized, // Legacy alias
  evalSpindleCall,
  BuiltinSpindles,
  Sampler
};

// Temporary bridge for debugging - also expose to global scope
if (typeof window !== 'undefined') {
  window.Env = Env;
  window.Executor = Executor;
  window.clamp = clamp;
  window.isNum = isNum;
  window.logger = logger;
  window.Sampler = Sampler;
}