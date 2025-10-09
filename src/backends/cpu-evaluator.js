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
      return `env.coordinator.getValue("${baseName}","${out}",me)`;
    },
    inst(StrandRemapExpr, _, _, _), (base, strand, mappings) => {
      const baseName = base.name;
      const coordPairs = mappings.map(m => {
        const axisCode = compileToJS(m.expr, env);
        return `${m.axis}:${axisCode}`;
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
    const x = me.x;
    const y = me.y;
    const t = me.time;
    const f = me.frame;
    const w = me.width;
    const h = me.height;
    const fps = me.fps;
    const loop = me.loop;
    const bpm = me.bpm;
    const beat = me.beat;
    const measure = me.measure;
    const abstime = me.abstime;
    const absframe = me.absframe;
    const mx = env.mouse.x;
    const my = env.mouse.y;
    return (${jsCode});
  `;

  try {
    return new Function('me', 'env', funcBody);
  } catch (e) {
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
    }

    try {
      return fn(me, this.env);
    } catch (e) {
      console.error(`[CPUEvaluator] Error evaluating ${key}:`, e);
      return 0;
    }
  }

  clear() {
    this.compiledFunctions.clear()
  }
}