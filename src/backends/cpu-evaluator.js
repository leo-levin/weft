import {match, _, inst} from '../utils/match.js'

import {
  BinaryExpr,
  UnaryExpr,
  CallExpr,
  VarExpr,
  NumExpr,
  StrExpr,
  MeExpr,
  MouseExpr,
  StrandAccessExpr,
  StrandRemapExpr,
  IfExpr
} from '../lang/ast-node.js'

function compileToJS(node, env) {
  if (Array.isArray(node)) {
    return node.length === 1 ? compileToJS(node[0], env) : '0';
  }

  return match(node,
    inst(NumExpr, _), (v) => String(v),
    inst(StrExpr, _), (v) => `"${v.replace(/"/g, '\\"')}"`,
    inst(MeExpr, _), (field) => match(field,
      "x", () => "x",
      "y", () => "y",
      "time", () => "t",
      "frame", () => "f",
      "width", () => "w",
      "height", () => "h",
      "fps", () => "fps",
      "loop", () => "loop",
      "bpm", () => "bpm",
      "beat", () => "beat",
      "measure", () => "measure",
      "abstime", () => "abstime",
      "absframe", () => "absframe",
      _, (n) => "0"
    ),
    inst(MouseExpr, _), (field) => field == "x" ? "mx" : field === "y" ? "my" : "0",
    inst(BinaryExpr, _,_,_), (op, left, right) => {
      const leftCode = compileToJS(left, env);
      const rightCode = compileToJS(right, env);

      return match(op,
        "+", () =>`(${leftCode}+${rightCode})`,
        "-", () =>`(${leftCode}-${rightCode})`,
        "*", () =>`(${leftCode} * ${rightCode})`,
        "/", () =>`(${rightCode}===0?1e-9:${leftCode}/${rightCode})`,
        "^", () => `Math.pow(${leftCode},${rightCode})`,
        "%", () => `((${leftCode}%${rightCode}+${rightCode})%${rightCode})`,
        "==", () => `(${leftCode}===${rightCode}?1:0)`,
        "!=", () => `(${leftCode}!==${rightCode}?1:0)`,
        "<<", () => `(${leftCode}<${rightCode}?1:0)`,
        ">>", () => `(${leftCode}>${rightCode}?1:0)`,
        "<=", () => `(${leftCode}<=${rightCode}?1:0)`,
        ">=", () => `(${leftCode}>=${rightCode}?1:0)`,
        "AND", () => `(${leftCode}&&${rightCode}?1:0)`,
        "OR", () => `(${leftCode}||${rightCode}?1:0)`,
        _, (n) => "0"
      );
    },
    inst(UnaryExpr, _, _), (op, expr) => {
      const arg = compileToJS(expr, env);
      return match(op,
        "-", () => `(-${arg})`,
        "NOT", () => `(${arg}?0:1)`,
        _, (n) => {
          const mathFn = getMathFunction(op);
          return mathFn ? `${mathFn}(${arg})` : `(-${arg})`;
        }
      );
    },
    inst(IfExpr, _, _, _), (condition, thenExpr, elseExpr) => {
      const cond = compileToJS(condition, env);
      const thenCode = compileToJS(thenExpr, env);
      const elseCode = compileToJS(elseExpr, env);
      return `(${cond}?${thenCode}:${elseCode})`;
    },
    inst(CallExpr, _, _), (name, args) => {
      const argCodes = args.map(arg => compileToJS(arg, env));
      const mathFn = getMathFunction(name);
      if (mathFn) {
        return `${mathFn}(${argCodes.join(',')})`;
      }

      return match(name,
        "clamp", () => {
          if (argCodes.length === 3) {
            return `(${argCodes[0]}<${argCodes[1]}?${argCodes[1]}:${argCodes[0]}>${argCodes[2]}?${argCodes[2]}:${argCodes[0]})`;
          }
          return `(${argCodes[0]}<0?0:${argCodes[0]}>1?1:${argCodes[0]})`;
        },
        "noise", () => `env.__noise3(${argCodes[0]}*3.1,${argCodes[1]}*3.1,${argCodes[2]}*0.5)`,
        _, (n) => `Math.sin(${argCodes.join(',')})`
      );
    },
    inst(VarExpr, _), (name) => `env.getVar("${name}")`,
    inst(StrandAccessExpr, _, _), (base, out) => {
      const baseName = base.name;

      // Check if this is an image instance with a sampler (dual-storage support)
      const instance = env.instances?.get(baseName);
      if (instance && instance.sampler) {
        // Map output name to RGBA channel index
        const channelMap = { r: 0, g: 1, b: 2, a: 3, red: 0, green: 1, blue: 2, alpha: 3 };
        const channelIndex = channelMap[out];

        if (channelIndex !== undefined) {
          // Sample from image using bilinear interpolation
          // Add safety check for sampler readiness
          return `(env.instances.get("${baseName}")?.sampler?.ready ? env.instances.get("${baseName}").sampler.sample(x, y, true)[${channelIndex}] : 0)`;
        }
      }

      // Fall back to coordinator for non-image instances
      return `env.coordinator.getValue("${baseName}","${out}",me)`;
    },
    inst(StrandRemapExpr, _, _, _), (base, strand, mappings) => {
      const baseName = base.name;
      const coordPairs = mappings.map(m => {
        // Extract axis from source (e.g., me@x → 'x')
        let axis;
        if (m.source.type === 'Me') {
          axis = m.source.field;
        } else if (m.source.type === 'StrandAccess' && m.source.base.name === 'me') {
          axis = m.source.output;
        } else {
          console.warn('[CPUEvaluator] StrandRemap source must be me@field, got:', m.source);
          axis = 'x';
        }

        // Compile target expression
        const targetCode = compileToJS(m.target, env);
        return `${axis}:${targetCode}`;
      });
      const coordObj = `{...me,${coordPairs.join(',')}}`;
      return `env.coordinator.getValue("${baseName}","${strand}",${coordObj})`;
    },
    _, (n) => {
      console.warn('[js-compiler] Unhandled node:', node);
      return "0";
    }
  );
}

function getMathFunction(name) {
  const MAP = {
    sin: 'Math.sin', cos: 'Math.cos', tan: 'Math.tan',
    sqrt: 'Math.sqrt', abs: 'Math.abs', exp: 'Math.exp', log: 'Math.log',
    min: 'Math.min', max: 'Math.max', floor: 'Math.floor',
    ceil: 'Math.ceil', round: 'Math.round', atan2: 'Math.atan2'
  };
  return MAP[name];
}


export function compile(node, env) {
  const jsCode = compileToJS(node, env);
  const funcBody = `
    const x = me.x || 0.5;
    const y = me.y || 0.5;
    const t = me.time || 0;
    const f = me.frame || 0;
    const w = me.width || env.resW || 1;
    const h = me.height || env.resH || 1;
    const fps = me.fps || env.targetFps || 60;
    const loop = me.loop || env.loop || 1000;
    const bpm = me.bpm || env.bpm || 120;
    const beat = me.beat || 0;
    const measure = me.measure || 0;
    const abstime = me.abstime || 0;
    const absframe = me.absframe || 0;
    const mx = env.mouse.x;
    const my = env.mouse.y;
    return (${jsCode});
  `;

  try {
    const fn = new Function('me', 'env', funcBody);
    return fn;
  } catch (e) {
    console.error('[CPUEvaluator] Compile error:', e, 'Code:', funcBody);
    return () => 0;
  }
}

export class CPUEvaluator {
  constructor(env, graph){
    this.env = env;
    this.graph = graph;
    this.compiledFunctions = new Map(); //instName@outName -> function
  }

  getValue(instName, outName, me) {
    const key = `${instName}@${outName}`;

    let fn = this.compiledFunctions.get(key);

    if(!fn) {
      const node = this.graph.nodes.get(instName);
      if (!node) {
        console.warn(`[CPUEvaluator] Instance "${instName}" not found`);
        return 0;
      }

      const expr = node.outputs.get(outName);
      if(!expr) {
        console.warn(`[CPUEvaluator] Output "${outName}" not found on "${instName}"`);
        return 0;
      }

      fn = compile(expr, this.env);
      this.compiledFunctions.set(key, fn);

      // Debug: show compiled code for first few evaluations
      if (this.compiledFunctions.size <= 3) {
        console.log(`[CPUEvaluator] Compiled ${key}:`, fn.toString());
      }
    }

    try {
      const result = fn(me, this.env);

      // Debug: log first few calls
      if (this.env.frame < 3 && key === 'samp@x') {
        console.log(`[CPUEvaluator] Evaluated ${key} with me=`, me, 'result=', result);
      }

      return result;
    } catch (e) {
      console.error(`[CPUEvaluator] Error evaluating ${key}:`, e);
      return 0;
    }
  }

  clear() {
    this.compiledFunctions.clear()
  }
}