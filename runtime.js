// runtime.js — utilities, runtime, evaluator, spindles, executor (v2)

// ===== Utils =====
const clamp = (x, lo=0, hi=1) => Math.min(hi, Math.max(lo, x));
const lerp = (a,b,t)=>a+(b-a)*t;
const nowSec = ()=>performance.now()/1000;
const isNum = v => typeof v === 'number' && isFinite(v);

function hash3(x,y,z){
  const s = Math.sin(x*127.1 + y*311.7 + z*74.7) * 43758.5453;
  return s - Math.floor(s);
}
function smoothstep(a,b,x){ const t = clamp((x-a)/(b-a)); return t*t*(3-2*t); }
function noise3(x,y,t){
  const xi = Math.floor(x), yi = Math.floor(y), ti = Math.floor(t);
  let xf = x - xi, yf = y - yi, tf = t - ti;
  let n000 = hash3(xi, yi, ti);
  let n100 = hash3(xi+1, yi, ti);
  let n010 = hash3(xi, yi+1, ti);
  let n110 = hash3(xi+1, yi+1, ti);
  let n001 = hash3(xi, yi, ti+1);
  let n101 = hash3(xi+1, yi, ti+1);
  let n011 = hash3(xi, yi+1, ti+1);
  let n111 = hash3(xi+1, yi+1, ti+1);
  let u = smoothstep(0,1,xf), v = smoothstep(0,1,yf), w = smoothstep(0,1,tf);
  function mix(a,b,t){return a*(1-t)+b*t;}
  let x00 = mix(n000, n100, u);
  let x10 = mix(n010, n110, u);
  let x01 = mix(n001, n101, u);
  let x11 = mix(n011, n111, u);
  let y0 = mix(x00, x10, v);
  let y1 = mix(x01, x11, v);
  return mix(y0,y1,w);
}

// ===== Runtime scaffolding =====
class RuntimeError extends Error { constructor(msg){ super(msg); this.name = "RuntimeError"; } }

class Env {
  constructor(){
    this.instances = new Map();
    this.spindles = new Map();
    this.displayFns = null;
    this.defaultSampler = null;
    this.audio = { element:null, ctx:null, analyser:null, intensity:0 };
    this.mouse = { x:0.5, y:0.5 };
    this.frame = 0;
    this.boot = performance.now();
    this.targetFps = 30;
    this.resW = 80; this.resH = 80;
    this.mediaCanvas = document.createElement('canvas');
    this.mediaCtx = this.mediaCanvas.getContext('2d', { willReadFrequently: true });
    this.mediaImageData = null;
  }
  time(){ return (performance.now() - this.boot) / 1000; }
}

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
      return { kind:'strand', evalAt(me, scope) {
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
      return { kind:'strand', evalAt(me, scope) {
        if(field==="x") return scope.mouse.x;
        if(field==="y") return scope.mouse.y;
        throw new RuntimeError(`Invalid mouse@${field}`);
      }};
    }

    case "StrandAccess": {
      const base=node.base, out=node.out;
      return { kind:'strand', evalAt(me, scope) {
        const inst = scope.instances.get(base);
        if(!inst) throw new RuntimeError(`Unknown instance '${base}'`);
        const strand = inst.outs[out];
        if(!strand) throw new RuntimeError(`'${base}' has no output '${out}'`);
        if(strand.kind === 'strand') return strand.evalAt(me, scope);
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
        if (scope.__scopeStack) {
          for (let i = scope.__scopeStack.length - 1; i >= 0; i--) {
            const s = scope.__scopeStack[i];
            if (s && n in s) {
              const v = s[n];
              if(v && v.__kind==="strand") return v.eval(me, scope);
              return v;
            }
          }
        }
        throw new RuntimeError(`Unknown variable '${n}'`);
      }};
    }

    default: throw new RuntimeError(`Unhandled expr node ${node.type}`);
  }
}

// Legacy wrapper for backward compatibility
function compileExpr(node, envRef){
  const strand = evalExprToStrand(node, envRef);
  return (me, env) => strand.evalAt(me, env);
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
  return { kind: 'strand', evalAt(me, env) { return value; } };
}

function coerceToStrand(valueOrStrand) {
  if (valueOrStrand && valueOrStrand.kind === 'strand') return valueOrStrand;
  if (typeof valueOrStrand === 'number') return ConstantStrand(valueOrStrand);
  if (valueOrStrand && valueOrStrand.kind === 'slot') return coerceToStrand(valueOrStrand.get());
  throw new RuntimeError('Expected strand/number/slot');
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

class Sampler {
  constructor(){
    this.kind="none"; this.ready=false; this.width=1; this.height=1; this.video=null; this.image=null;
    this.off = document.createElement('canvas');
    this.offCtx = this.off.getContext('2d', { willReadFrequently: true });
    this.pixels=null;
  }
  load(path){
    const lower = (path||"").toLowerCase();
    if(lower.endsWith(".mp4") || lower.endsWith(".webm")){
      this.kind="video"; this.video=document.createElement('video');
      this.video.src=path; this.video.muted=true; this.video.loop=true; this.video.playsInline=true; this.video.crossOrigin="anonymous";
      this.video.addEventListener('loadeddata', ()=>{
        this.width=this.video.videoWidth||320; this.height=this.video.videoHeight||180;
        this.off.width=this.width; this.off.height=this.height; this.ready=true;
      });
      return;
    }
    if(lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".gif")){
      this.kind="image"; this.image = new Image(); this.image.crossOrigin="anonymous"; this.image.src=path;
      console.log('Attempting to load image:', path);
      this.image.onload = ()=>{
        console.log('Image loaded successfully:', path, this.image.width, 'x', this.image.height);
        this.width=this.image.width; this.height=this.image.height; this.off.width=this.width; this.off.height=this.height;
        this.offCtx.drawImage(this.image,0,0); this.pixels=this.offCtx.getImageData(0,0,this.width,this.height).data; this.ready=true;
      };
      this.image.onerror = (e)=>{
        console.error('Image failed to load:', path, e);
        this.fallbackPattern();
      };
      return;
    }
    this.fallbackPattern();
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
      this.offCtx.drawImage(this.video,0,0,this.width,this.height);
      this.pixels=this.offCtx.getImageData(0,0,this.width,this.height).data;
    }
  }
  sample(nx, ny){
    if(!this.ready || !this.pixels){ return [nx, ny, 0.5, 1]; }
    const x = clamp(Math.floor(nx * (this.width-1)), 0, this.width-1);
    const y = clamp(Math.floor(ny * (this.height-1)), 0, this.height-1);
    const idx = (y * this.width + x) * 4;
    const d = this.pixels;
    return [d[idx]/255, d[idx+1]/255, d[idx+2]/255, d[idx+3]/255];
  }
}

const BuiltinSpindles = {
  load: (env, args, instName, outs) => {
    const path = (args[0] && args[0].type==="Str") ? args[0].v : "";
    const xExpr = args[1] ? compileExpr(args[1], env) : null;
    const yExpr = args[2] ? compileExpr(args[2], env) : null;

    const sampler = new Sampler(); sampler.load(path);
    if(sampler.kind!=="none") env.defaultSampler = sampler;

    const inst = makeSimpleInstance(instName, {
      r:(me, env)=>{
        const x = xExpr ? toScalar(xExpr(me, env)) : me.x;
        const y = yExpr ? toScalar(yExpr(me, env)) : me.y;
        return (env.defaultSampler||sampler).sample(x, y)[0];
      },
      g:(me, env)=>{
        const x = xExpr ? toScalar(xExpr(me, env)) : me.x;
        const y = yExpr ? toScalar(yExpr(me, env)) : me.y;
        return (env.defaultSampler||sampler).sample(x, y)[1];
      },
      b:(me, env)=>{
        const x = xExpr ? toScalar(xExpr(me, env)) : me.x;
        const y = yExpr ? toScalar(yExpr(me, env)) : me.y;
        return (env.defaultSampler||sampler).sample(x, y)[2];
      },
      a:(me, env)=>{
        const x = xExpr ? toScalar(xExpr(me, env)) : me.x;
        const y = yExpr ? toScalar(yExpr(me, env)) : me.y;
        return (env.defaultSampler||sampler).sample(x, y)[3];
      },
      left:(me)=> env.audio.intensity,
      right:(me)=> env.audio.intensity,
    });
    // Store the sampler in the instance so sample() can access it
    inst.sampler = sampler;
    const lower = (path||"").toLowerCase();
    if(lower.endsWith(".wav") || lower.endsWith(".mp3") || lower.endsWith(".ogg")){
      const el = new Audio(path); el.loop=true; el.crossOrigin="anonymous";
      env.audio.element = el;
      try {
        const ctx = new (window.AudioContext||window.webkitAudioContext)();
        const src = ctx.createMediaElementSource(el);
        const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
        src.connect(analyser); analyser.connect(ctx.destination);
        env.audio.ctx=ctx; env.audio.analyser=analyser;
      } catch {}
    }
    env.instances.set(instName, inst);
    return inst;
  },

  sample: (env, args, instName, outs) => {
    // sample(imageInstance, x, y) - sample a specific loaded image at custom coordinates
    const imageInstanceName = (args[0] && args[0].type === "Var") ? args[0].name : null;
    const xExpr = compileExpr(args[1], env);
    const yExpr = compileExpr(args[2], env);

    const inst = makeSimpleInstance(instName, {
      r: (me, env) => {
        const x = toScalar(xExpr(me, env));
        const y = toScalar(yExpr(me, env));
        const imageInst = env.instances.get(imageInstanceName);
        const sampler = (imageInst && imageInst.sampler) || env.defaultSampler || fallbackSampler;
        return sampler.sample(x, y)[0];
      },
      g: (me, env) => {
        const x = toScalar(xExpr(me, env));
        const y = toScalar(yExpr(me, env));
        const imageInst = env.instances.get(imageInstanceName);
        const sampler = (imageInst && imageInst.sampler) || env.defaultSampler || fallbackSampler;
        return sampler.sample(x, y)[1];
      },
      b: (me, env) => {
        const x = toScalar(xExpr(me, env));
        const y = toScalar(yExpr(me, env));
        const imageInst = env.instances.get(imageInstanceName);
        const sampler = (imageInst && imageInst.sampler) || env.defaultSampler || fallbackSampler;
        return sampler.sample(x, y)[2];
      },
      a: (me, env) => {
        const x = toScalar(xExpr(me, env));
        const y = toScalar(yExpr(me, env));
        const imageInst = env.instances.get(imageInstanceName);
        const sampler = (imageInst && imageInst.sampler) || env.defaultSampler || fallbackSampler;
        return sampler.sample(x, y)[3];
      }
    });
    env.instances.set(instName, inst);
    return inst;
  },

  video: (env, args, instName, outs)=>{
    const xf = compileExpr(args[0], env), yf = compileExpr(args[1], env);
    const inst = makeSimpleInstance(instName, {
      r:(me,env)=> (env.defaultSampler||fallbackSampler).sample(toScalar(xf(me,env)), toScalar(yf(me,env)))[0],
      g:(me,env)=> (env.defaultSampler||fallbackSampler).sample(toScalar(xf(me,env)), toScalar(yf(me,env)))[1],
      b:(me,env)=> (env.defaultSampler||fallbackSampler).sample(toScalar(xf(me,env)), toScalar(yf(me,env)))[2],
      a:(me,env)=> (env.defaultSampler||fallbackSampler).sample(toScalar(xf(me,env)), toScalar(yf(me,env)))[3],
    });
    env.instances.set(instName, inst);
    return inst;
  },
  compose: (env,args,instName,outs)=>{
    const r=compileExpr(args[0],env), g=compileExpr(args[1],env), b=compileExpr(args[2],env);
    const inst = makeSimpleInstance(instName, { rgb:(me,env)=>[toScalar(r(me,env)),toScalar(g(me,env)),toScalar(b(me,env))] });
    env.instances.set(instName,inst); return inst;
  },
};
const fallbackSampler = new Sampler(); fallbackSampler.fallbackPattern();

// Fixed spindle call evaluator that properly binds parameters
function evalSpindleCall(call, outerEnv) {
  const def = outerEnv.spindles.get(call.callee);
  if (!def) throw new RuntimeError(`Unknown spindle '${call.callee}'`);


  // Compile arguments as strands
  const argStrands = call.args.map(arg => evalExprToStrand(arg, outerEnv));

  return function(me, globalEnv) {
    // Create local scope with parameter bindings
    const paramBindings = {};

    // Flatten parameter list if it's nested
    const params = Array.isArray(def.params[0]) ? def.params[0] : def.params;

    // Bind parameters to evaluated argument values
    for (let i = 0; i < params.length; i++) {
      const paramName = params[i];
      if (!paramName) continue; // Skip empty parameter names
      const argStrand = argStrands[i] || ConstantStrand(0);
      const value = argStrand.evalAt(me, globalEnv);
      // Store as constant strand for consistent lookup
      paramBindings[paramName] = { __kind: "strand", eval: () => value };
    }

    // Initialize output variables
    const outputs = {};
    for (const out of def.outs) {
      outputs[out] = 0;
    }

    // Create combined scope (parameters + outputs) - ensure outputs are separate objects
    const localScope = { ...paramBindings };
    for (const out of def.outs) {
      localScope[out] = 0;
    }

    // Execute body with scope stack
    const oldStack = globalEnv.__scopeStack || [];
    globalEnv.__scopeStack = [...oldStack, localScope];

    try {
      // Execute each statement in the body
      for (const stmt of def.body.body) {
        execStmtWithScope(stmt, me, globalEnv, localScope);
      }

      // Collect output values
      const result = {};
      for (const out of def.outs) {
        result[out] = localScope[out];
      }
      return result;

    } finally {
      globalEnv.__scopeStack = oldStack;
    }
  };
}

function execStmtWithScope(stmt, me, env, localScope) {
  if (stmt.type === "Let") {
    const value = compileExpr(stmt.expr, env)(me, env);
    localScope[stmt.name] = value;
    return;
  }

  if (stmt.type === "Assign") {
    const rhs = compileExpr(stmt.expr, env)(me, env);
    const cur = localScope[stmt.name] ?? 0;


    if (stmt.op === "=") localScope[stmt.name] = rhs;
    else if (stmt.op === "+=") localScope[stmt.name] = cur + rhs;
    else if (stmt.op === "-=") localScope[stmt.name] = cur - rhs;
    else if (stmt.op === "*=") localScope[stmt.name] = cur * rhs;
    else if (stmt.op === "/=") localScope[stmt.name] = cur / (rhs || 1e-9);
    else throw new RuntimeError(`Unknown assignment op ${stmt.op}`);
    return;
  }

  if (stmt.type === "For") {
    const start = Math.floor(compileExpr(stmt.start, env)(me, env));
    const end = Math.floor(compileExpr(stmt.end, env)(me, env));
    const inc = start <= end ? 1 : -1;

    for (let v = start; inc > 0 ? v <= end : v >= end; v += inc) {
      localScope[stmt.v] = v;
      for (const s of stmt.body.body) {
        execStmtWithScope(s, me, env, localScope);
      }
    }
    return;
  }

  throw new RuntimeError(`Unknown body stmt ${stmt.type}`);
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
  constructor(env){ this.env = env; this.ast = null; }
  
  loadStandardLibrary() {
    // Load standard library spindles if available
    if (window.StandardLibraryCode && window.Parser) {
      try {
        const stdlibAst = Parser.parse(window.StandardLibraryCode);
        for (const s of stdlibAst.body) {
          if (s.type === "SpindleDef") {
            this.env.spindles.set(s.name, s);
          }
        }
        console.log('Standard library loaded:', Object.keys(this.env.spindles).length, 'spindles');
      } catch (e) {
        console.warn('Failed to load standard library:', e.message);
      }
    }
  }
  run(ast){
    this.ast = ast;
    this.env.instances.clear();
    this.env.displayFns = null;

    // Load standard library spindles first
    this.loadStandardLibrary();

    for(const s of ast.body){
      if(s.type==="SpindleDef") this.env.spindles.set(s.name, s);
    }
    for(const s of ast.body){
      if(s.type==="SpindleDef") continue;
      if(s.type==="Direct"){
        const fx = compileExpr(s.expr, this.env);
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
        let fr, fg, fb;

        if(s.args.length === 1) {
          // Check if single argument is an instance with exactly 3 outputs
          const arg = s.args[0];
          if(arg.type === "Var") {
            const inst = this.env.instances.get(arg.name);
            if(inst && inst.outs) {
              const outputs = Object.keys(inst.outs);
              if(outputs.length === 3) {
                // Use the 3 outputs in order for r,g,b
                fr = (me, env) => inst.outs[outputs[0]].evalAt(me, env);
                fg = (me, env) => inst.outs[outputs[1]].evalAt(me, env);
                fb = (me, env) => inst.outs[outputs[2]].evalAt(me, env);
              } else {
                throw new RuntimeError(`Instance '${arg.name}' must have exactly 3 outputs for single-argument display, found ${outputs.length}`);
              }
            } else {
              throw new RuntimeError(`Unknown instance '${arg.name}' for display`);
            }
          } else {
            throw new RuntimeError("Single argument display requires an instance name");
          }
        } else if(s.args.length === 3) {
          // Original 3-argument behavior
          fr = compileExpr(s.args[0], this.env);
          fg = compileExpr(s.args[1], this.env);
          fb = compileExpr(s.args[2], this.env);
        } else {
          throw new RuntimeError("display needs either 1 instance with 3 outputs or 3 expressions (r,g,b)");
        }

        this.env.displayFns = [fr, fg, fb];
        continue;
      }
      if(s.type==="EnvStmt"){
        if(s.field === "frames") {
          const valueExpr = compileExpr(s.expr, this.env);
          // Evaluate the expression to get the target fps
          const fps = toScalar(valueExpr({}, this.env));
          this.env.targetFps = Math.max(1, Math.min(120, fps)); // Clamp between 1-120 fps
        }
        continue;
      }
      throw new RuntimeError(`Unhandled statement type ${s.type}`);
    }
    if(!this.env.displayFns) throw new RuntimeError("No display(...) statement found.");
  }
}

window.Env = Env;
window.Executor = Executor;
window.clamp = clamp;
window.isNum = isNum;