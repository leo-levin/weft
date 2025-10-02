import { clamp, isNum } from '../utils/math.js';
import { Sampler } from './media/sampler.js';
import { match, _ } from '../utils/match.js';
export class Env {
  constructor(){
    this.spindles = new Map();
    this.instances = new Map();
    this.vars = new Map();

    this.resW = 1080;
    this.resH = 1080;
    this.frame = 0;
    this.startTime = Date.now();
    this.targetFPS = 30;

    this.mouse = {x: 0.5, y:0.5};

    this.audio = {element: null, intensity: 0};

    this.loop = 600;
    this.bpm = 120;
    this.timesig_num = 4;
    this.timesig_denom = 4;

    this.media = new Map();

    this.createBuiltins();
  }

  createBuiltins(){
    const me = {
      x: () => this.currentX ?? 0.5,
      y: () => this.currentY ?? 0.5,

      time: () => ((this.frame % this.loop) / this.targetFPS),
      frame: () => (this.frame % this.loop),
      abstime: () => ((Date.now() - this.startTime) / 1000),
      absframe: () => this.frame,

      width: () => this.resW,
      height: () => this.resH,
      fps: () => this.targetFps,
      loop: () => this.loop,
      bpm: () => this.bpm,
      beat: () => {
        const absTime = (Date.now() - this.startTime) / 1000;
        return Math.floor(absTime * (this.bpm / 60)) % this.timesig_num;
      },
      measure: () => {
        const absTime = (Date.now() - this.startTime) / 1000;
        return Math.floor(absTime * (this.bpm / 60) / this.timesig_num);
      }
    };

    this.instances.set('me', me);
    }

    setParam(name, value) {
      if (!this.instances.has(name)) {
        this.instances.set(name, {});
      }
      const inst = this.instances.get(name);
      inst.value = () => value;
    }

    getParam(name) {
      const inst = this.instances.get(name);
      return inst?.value ? inst.value() : 0;
    }

    async loadMedia(path, instanceName) {
      const sampler = new Sampler();
      await sampler.load(path);
      this.media.set(instanceName, sampler);
      return sampler;
    }

    getMedia(instanceName) {
      return this.media.get(instanceName);
    }
  }

  export class Executor {
    constructor(env) {
      this.env = env;
    }

    execute(ast) {
      for (const stmt of ast.statements) {
        this.executeStmt(stmt);
      }
    }

    executeStmt(stmt) {
      match(stmt.type,
        'SpindleDef', () => {
          this.env.spindles.set(stmt.name, stmt);
        },

        'LetBinding', () => {
          this.env.vars.set(stmt.name, stmt.expr);
        },

        'InstanceBinding', () => {
          this.createInstance(stmt);
        },

        'Assignment', () => {
          this.env.vars.set(stmt.name, stmt.expr);
        },

        'DisplayStmt', () => {},
        'PlayStmt', () => {},
        'RenderStmt', () => {},
        'ComputeStmt', () => {},

        _, (type) => {
          console.warn(`Unknown statement type: ${type}`);
        }
      );
    }

    createInstance(stmt) {
      const instanceData = match(stmt.expr?.type,
        'Call', () => ({
          type: 'call',
          callName: stmt.expr.name,
          args: stmt.expr.args,
          outputs: stmt.outputs
        }),

        _, (n) => ({
          type: 'expr',
          expr: stmt.expr,
          outputs: stmt.outputs
        })
      );

      this.env.instances.set(stmt.name, instanceData);
    }
  }

  export const Builtins = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    sqrt: Math.sqrt,
    abs: Math.abs,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    min: Math.min,
    max: Math.max,

    clamp: (x, a, b) => Math.max(a, Math.min(b, x)),
    mix: (a, b, t) => a + (b - a) * t,
    fract: (x) => x - Math.floor(x),
    sign: (x) => x > 0 ? 1 : x < 0 ? -1 : 0,
  };

export function evalStrandRemap(node, env, me) {
  const baseInst = env.instances.get(node.base);
  if (!baseInst) {
    console.warn(`StrandRemap: unknown instance '${node.base}'`);
    return 0;
  }

  const strand = baseInst[node.strand];
  if (!strand || typeof strand !== 'function') {
    console.warn(`StrandRemap: '${node.base}' has no strand '${node.strand}'`);
    return 0;
  }

  const remappedMe = { ...me };

  for (const mapping of node.mappings) {
    const axisName = mapping.axis;
    const axisValue = evalExpr(mapping.expr, env, me);

    const clamped = Math.max(0, Math.min(1, isFinite(axisValue) ? axisValue : 0));
    remappedMe[axisName] = clamped;
  }

  const oldX = env.currentX;
  const oldY = env.currentY;
  env.currentX = remappedMe.x;
  env.currentY = remappedMe.y;

  const result = strand();

  env.currentX = oldX;
  env.currentY = oldY;

  return result;
}


function evalExpr(node, env, me) {
  return match(node.type,
    'Num', () => node.v,
    'Me', () => {
      const meInst = env.instances.get('me');
      if (meInst && meInst[node.field]) {
        return meInst[node.field]();
      }
      return 0;
    },
    'Var', () => {
      const value = env.vars.get(node.name);
      if (value !== undefined) return value;
      console.warn(`evalExpr: unknown variable '${node.name}'`);
      return 0;
    },
    'Bin', () => {
      const left = evalExpr(node.left, env, me);
      const right = evalExpr(node.right, env, me);
      return match(node.op,
        '+', () => left + right,
        '-', () => left - right,
        '*', () => left * right,
        '/', () => right !== 0 ? left / right : 0,
        '%', () => right !== 0 ? left % right : 0,
        '^', () => Math.pow(left, right),
        _, (n) => {
          console.warn(`evalExpr: unknown binary op '${node.op}'`);
          return 0;
        }
      );
    },
    'Unary', () => {
      const arg = evalExpr(node.expr, env, me);
      return match(node.op,
        '-', () => -arg,
        'NOT', () => arg ? 0 : 1,
        _, (n) => {
          console.warn(`evalExpr: unknown unary op '${node.op}'`);
          return 0;
        }
      );
    },
    'Call', () => {
      const fn = Builtins[node.name];
      if (fn) {
        const args = node.args.map(a => evalExpr(a, env, me));
        return fn(...args);
      }
      console.warn(`evalExpr: unknown function '${node.name}'`);
      return 0;
    },
    _, (n) => {
      console.warn(`evalExpr: unhandled node type '${node.type}'`);
      return 0;
    }
  );
}
