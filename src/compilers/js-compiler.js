// js-compiler.js — High-performance WEFT-to-JavaScript compiler

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
      // Handle me@field access directly to optimized variables
      switch (node.field) {
        case "x": return "x";
        case "y": return "y";
        case "time": return "t";
        case "frame": return "f";
        case "width": return "w";
        case "height": return "h";
        case "abstime": return "(Date.now() - env.startTime) / 1000";
        case "absframe": return "env.frame";
        case "fps": return "env.targetFps";
        case "loop": return "env.loop";
        case "bpm": return "env.bpm";
        case "beat": return "Math.floor(((Date.now() - env.startTime) / 1000) * (env.bpm / 60)) % env.timesig_num";
        case "measure": return "Math.floor(((Date.now() - env.startTime) / 1000) * (env.bpm / 60) / env.timesig_num)";
        default: return "0";
      }
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
      if (op === "<<") return `(${left}<${right}?1:0)`;
      if (op === ">>") return `(${left}>${right}?1:0)`;
      if (op === "<<=") return `(${left}<=${right}?1:0)`;
      if (op === ">>=") return `(${left}>=${right}?1:0)`;
      if (op === "AND") return `(${left}&&${right}?1:0)`;
      if (op === "OR") return `(${left}||${right}?1:0)`;
      return "0";
    }

    case "If": {
      const cond = compileToJS(node.condition, env, resolvedVars);
      const thenExpr = compileToJS(node.thenExpr, env, resolvedVars);
      const elseExpr = compileToJS(node.elseExpr, env, resolvedVars);
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

    case "StrandRemap": {
      // StrandRemap is complex and cannot be easily pre-compiled
      // Fall back to runtime evaluation
      return `evalStrandRemap(${JSON.stringify(node)})`;
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
export function compileWithCache(node, env) {
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
        // Calculate time variables
        const currentTime = (envCtx.frame % envCtx.loop) / envCtx.targetFps;
        return compiledFn(me, envCtx, me.x, me.y, currentTime, envCtx.frame,
                         envCtx.resW, envCtx.resH, envCtx.mouse.x, envCtx.mouse.y);
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
export function compileFast(node, env) {
  try {
    const jsCode = compileToJS(node, env);
    const compiledFn = createOptimizedFunction(jsCode);
    if (compiledFn) {
      return (me, envCtx) => {
        const currentTime = (envCtx.frame % envCtx.loop) / envCtx.targetFps;
        return compiledFn(me, envCtx, me.x, me.y, currentTime, envCtx.frame,
                         envCtx.resW, envCtx.resH, envCtx.mouse.x, envCtx.mouse.y);
      };
    }
  } catch (e) {
    console.warn('Fast compilation failed:', e.message);
  }
  return compileBasic(node, env);
}

// Clear only when absolutely necessary
export function clearCompilationCaches() {
  compiledFunctionCache.clear();
  nodeIdCounter = 0;
}

// Pointwise operations over strands
export function map1(a, f) {
  return { kind:'strand', evalAt(me, env){ return f(a.evalAt(me, env)); } };
}

export function map2(a, b, f) {
  return { kind:'strand', evalAt(me, env){ return f(a.evalAt(me, env), b.evalAt(me, env)); } };
}

export const unaryOps  = { neg: x => -x, abs: Math.abs, sin: Math.sin, cos: Math.cos, sqrt: Math.sqrt };
export const binaryOps = {
  add:(a,b)=>a+b, sub:(a,b)=>a-b, mul:(a,b)=>a*b, div:(a,b)=>a/(b||1e-9),
  pow:(a,b)=>Math.pow(a,b), mod:(a,b)=>((a % b)+b)%b, atan2:(y,x)=>Math.atan2(y,x)
};

// Basic compilation using strand evaluation (most compatible)
function compileBasic(node, env) {
  // This needs evalExprToStrand which should be imported from the evaluation module
  // For now, we'll import it when this module is used
  const strand = evalExprToStrand(node, env);
  return (me, envCtx) => strand.evalAt(me, envCtx);
}

// Unified compilation function with multiple optimization levels
export function compile(node, env, options = {}) {
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

// Legacy aliases for compatibility
export function compileExpr(node, envRef) {
  return compile(node, envRef, { level: 'basic' });
}

export function compileExprOptimized(node, envRef) {
  return compile(node, envRef, { level: 'optimized' });
}

// Placeholder for evalExprToStrand - this will be injected by the runtime
let evalExprToStrand = null;

export function setEvalExprToStrand(fn) {
  evalExprToStrand = fn;
}