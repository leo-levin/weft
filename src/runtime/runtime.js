// runtime.js — core runtime, evaluator, spindles, executor (v2)
// Utilities have been extracted to src/utils/

// Import extracted utilities
import { clamp, isNum, lerp, nowSec } from '../utils/math.js';
import { logger } from '../utils/logger.js';
import { hash3, noise3, fastNoise3, smoothstep } from '../utils/noise.js';
import { RuntimeError } from './core/errors.js';
import { ParameterStrand } from './core/parameter-strand.js';
import { Builtins } from './evaluation/builtins-math.js';
import {
  compile,
  compileExpr,
  compileExprOptimized,
  compileWithCache,
  compileFast,
  clearCompilationCaches,
  map1,
  map2,
  unaryOps,
  binaryOps,
  setEvalExprToStrand
} from '../compilers/js-compiler.js';
import { Sampler, fallbackSampler } from './media/sampler.js';

// ===== Runtime scaffolding =====

class Env {
  constructor(){
    this.instances = new Map();
    this.spindles = new Map();
    this.parameters = new Map(); // Parameter strands registry
    this.pragmas = []; // Store pragmas from parsing
    this.displayFns = null;
    this.playStatements = []; // Store compiled play statements for audio renderer
    this.defaultSampler = null;
    this.audio = { element:null, ctx:null, analyser:null, intensity:0 };
    this.mouse = { x:0.5, y:0.5 };
    this.frame = 0;
    this.startTime = Date.now(); // Absolute start time
    this.boot = performance.now();
    this.targetFps = 30;
    this.resW = 300; this.resH = 300;
    this.mediaCanvas = document.createElement('canvas');
    this.mediaCtx = this.mediaCanvas.getContext('2d', { willReadFrequently: true });
    this.mediaImageData = null;

    // Time configuration
    this.loop = 600; // Default loop duration in frames
    this.bpm = 120; // Default BPM
    this.timesig_num = 4; // Time signature numerator
    this.timesig_den = 4; // Time signature denominator

    // Create the built-in "me" instance
    this.createMeInstance();
  }

  // Create the built-in "me" instance with time variables
  createMeInstance() {
    const meOuts = {
      // Spatial coordinates (normalized 0-1)
      x: { kind: 'strand', evalAt: (me, _scope) => me.x },
      y: { kind: 'strand', evalAt: (me, _scope) => me.y },

      // Absolute time (since program start)
      abstime: { kind: 'strand', evalAt: (_me, _scope) => (Date.now() - this.startTime) / 1000 },
      absframe: { kind: 'strand', evalAt: (_me, _scope) => this.frame },

      // Looped time (within current loop)
      time: { kind: 'strand', evalAt: (_me, _scope) => (this.frame % this.loop) / this.targetFps },
      frame: { kind: 'strand', evalAt: (_me, _scope) => this.frame % this.loop },

      // Display properties
      width: { kind: 'strand', evalAt: (_me, _scope) => this.resW },
      height: { kind: 'strand', evalAt: (_me, _scope) => this.resH },
      fps: { kind: 'strand', evalAt: (_me, _scope) => this.targetFps },

      // Loop configuration
      loop: { kind: 'strand', evalAt: (_me, _scope) => this.loop },

      // Musical time
      bpm: { kind: 'strand', evalAt: (_me, _scope) => this.bpm },
      timesig_num: { kind: 'strand', evalAt: (_me, _scope) => this.timesig_num },
      timesig_den: { kind: 'strand', evalAt: (_me, _scope) => this.timesig_den },
      beat: { kind: 'strand', evalAt: (_me, _scope) => {
        const absTime = (Date.now() - this.startTime) / 1000;
        const beatsPerSecond = this.bpm / 60;
        return Math.floor(absTime * beatsPerSecond) % this.timesig_num;
      }},
      measure: { kind: 'strand', evalAt: (_me, _scope) => {
        const absTime = (Date.now() - this.startTime) / 1000;
        const beatsPerSecond = this.bpm / 60;
        return Math.floor(absTime * beatsPerSecond / this.timesig_num);
      }}
    };

    const meInstance = makeSimpleInstance('me', meOuts);
    this.instances.set('me', meInstance);
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
  }
  time(){ return (performance.now() - this.boot) / 1000; }
}
Env.prototype.__noise3 = noise3;


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
      if(op==="<<") return map2(left, right, (a,b) => (a < b) ? 1 : 0);
      if(op===">>") return map2(left, right, (a,b) => (a > b) ? 1 : 0);
      if(op==="<<=") return map2(left, right, (a,b) => (a <= b) ? 1 : 0);
      if(op===">>=") return map2(left, right, (a,b) => (a >= b) ? 1 : 0);
      if(op==="AND") return map2(left, right, (a,b) => (a && b) ? 1 : 0);
      if(op==="OR") return map2(left, right, (a,b) => (a || b) ? 1 : 0);
      throw new RuntimeError(`Unknown binary ${op}`);
    }

    case "If": {
      const cond = evalExprToStrand(node.condition, env);
      const thenExpr = evalExprToStrand(node.thenExpr, env);
      const elseExpr = evalExprToStrand(node.elseExpr, env);
      return { kind:'strand', evalAt(me, scope) {
        return cond.evalAt(me, scope) ? thenExpr.evalAt(me, scope) : elseExpr.evalAt(me, scope);
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
          return value;
        }
        if(typeof strand === 'function') return strand(me, scope); // backward compatibility
        return strand;
      }};
    }

    case "StrandRemap": {
      const baseName = node.base?.name || node.base;
      const strandName = node.strand?.name || node.strand;
      return { kind:'strand', evalAt(me, scope) {
        try {
          // 1. Get the source strand function
          let inst = scope.instances ? scope.instances.get(baseName) : null;
          if (!inst && env.instances) {
            inst = env.instances.get(baseName);
          }

          if(!inst) {
            logger.warn('Runtime', `Unknown instance '${baseName}' in strand remap, returning 0`);
            return 0;
          }

          const sourceStrand = inst.outs[strandName];
          if(!sourceStrand) {
            logger.warn('Runtime', `'${baseName}' has no output '${strandName}' in strand remap, returning 0`);
            return 0;
          }

          // 2. Evaluate coordinate expressions to get remapped coordinates
          const coords = node.coordinates.map(coordExpr => {
            try {
              const coordStrand = evalExprToStrand(coordExpr, env);
              return coordStrand.evalAt(me, scope);
            } catch (error) {
              logger.warn('Runtime', `Error evaluating coordinate in strand remap: ${error.message}`);
              return 0;
            }
          });

          // 3. Create new evaluation context with remapped coordinates
          const remappedMe = {
            ...me,
            x: coords[0] !== undefined ? coords[0] : me.x,
            y: coords[1] !== undefined ? coords[1] : me.y,
            z: coords[2] !== undefined ? coords[2] : (me.z !== undefined ? me.z : 0)
          };

          // Clamp coordinates to reasonable bounds to prevent issues
          remappedMe.x = Math.max(0, Math.min(1, isFinite(remappedMe.x) ? remappedMe.x : 0));
          remappedMe.y = Math.max(0, Math.min(1, isFinite(remappedMe.y) ? remappedMe.y : 0));

          // 4. Evaluate source strand with new coordinates
          if(sourceStrand.kind === 'strand') {
            return sourceStrand.evalAt(remappedMe, scope);
          }
          if(typeof sourceStrand === 'function') return sourceStrand(remappedMe, scope); // backward compatibility
          return sourceStrand;
        } catch (error) {
          logger.error('Runtime', `Error in strand remap: ${error.message}`);
          return 0; // Fallback to 0 instead of crashing
        }
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

// Set up dependency injection for the compiler
setEvalExprToStrand(evalExprToStrand);


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


function coerceToStrand(valueOrStrand) {
  if (valueOrStrand && valueOrStrand.kind === 'strand') return valueOrStrand;
  if (typeof valueOrStrand === 'number') return ConstantStrand(valueOrStrand);
  if (valueOrStrand && valueOrStrand.kind === 'slot') return coerceToStrand(valueOrStrand.get());
  throw new RuntimeError('Expected strand/number/slot');
}


// ===== Instances & Spindles =====
function makeSimpleInstance(name, outs){ return { name, outs }; }

const BuiltinSpindles = {
  load: (env, args, instName, outs) => {
    const path = (args[0] && args[0].type==="Str") ? args[0].v : "";

    logger.info('Builtin', `Loading media: '${path}' for instance '${instName}'`, { outs });

    const sampler = new Sampler(); sampler.load(path);
    if(sampler.kind!=="none") env.defaultSampler = sampler;

    // Create flexible output mapping
    const instanceOuts = {};

    // Get component values function - use me.x/me.y directly for strand remap support
    const getComponent = (index, me, env) => {
      // Use passed me coordinates directly (supports strand remap)
      const x = me.x;
      const y = me.y;
      return (env.defaultSampler||sampler).sample(x, y)[index] || 0;
    };

    // Map outputs based on their names or positions
    for (let i = 0; i < outs.length; i++) {
      const outName = typeof outs[i] === 'string' ? outs[i] : (outs[i].name || outs[i].alias);

      // Handle metadata strands
      if (outName === 'w' || outName === 'width') {
        instanceOuts[outName] = {
          kind: 'strand',
          evalAt: (_me, _env) => sampler.width || 0
        };
        logger.debug('Builtin', `Mapped output '${outName}' to width metadata`);
        continue;
      } else if (outName === 'h' || outName === 'height') {
        instanceOuts[outName] = {
          kind: 'strand',
          evalAt: (_me, _env) => sampler.height || 0
        };
        logger.debug('Builtin', `Mapped output '${outName}' to height metadata`);
        continue;
      } else if (outName === 'd' || outName === 'duration') {
        instanceOuts[outName] = {
          kind: 'strand',
          evalAt: (_me, _env) => {
            if (sampler.video && sampler.video.duration) return sampler.video.duration;
            if (sampler.kind === 'audio' && env.audio.element && env.audio.element.duration) return env.audio.element.duration;
            return 0;
          }
        };
        logger.debug('Builtin', `Mapped output '${outName}' to duration metadata`);
        continue;
      }

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

  env: (env, args, instName, outs) => {
    // Built-in function to create the me instance with environment outputs
    // Usage: me<x,y,time,frame,fps,loop,bpm,etc> = env()
    logger.info('Builtin', `Creating env instance '${instName}'`, { outs });

    // This is essentially the same as the me instance, but allows custom output mapping
    const envOuts = {};

    for (let i = 0; i < outs.length; i++) {
      const outName = typeof outs[i] === 'string' ? outs[i] : (outs[i].name || outs[i].alias);

      // Map output names to environment values
      switch(outName) {
        case 'x':
          envOuts[outName] = { kind: 'strand', evalAt: (me, _scope) => me.x };
          break;
        case 'y':
          envOuts[outName] = { kind: 'strand', evalAt: (me, _scope) => me.y };
          break;
        case 'abstime':
          envOuts[outName] = { kind: 'strand', evalAt: (_me, _scope) => (Date.now() - env.startTime) / 1000 };
          break;
        case 'absframe':
          envOuts[outName] = { kind: 'strand', evalAt: (_me, _scope) => env.frame };
          break;
        case 'time':
          envOuts[outName] = { kind: 'strand', evalAt: (_me, _scope) => (env.frame % env.loop) / env.targetFps };
          break;
        case 'frame':
          envOuts[outName] = { kind: 'strand', evalAt: (_me, _scope) => env.frame % env.loop };
          break;
        case 'width':
          envOuts[outName] = { kind: 'strand', evalAt: (_me, _scope) => env.resW };
          break;
        case 'height':
          envOuts[outName] = { kind: 'strand', evalAt: (_me, _scope) => env.resH };
          break;
        case 'fps':
          envOuts[outName] = { kind: 'strand', evalAt: (_me, _scope) => env.targetFps };
          break;
        case 'loop':
          envOuts[outName] = { kind: 'strand', evalAt: (_me, _scope) => env.loop };
          break;
        case 'bpm':
          envOuts[outName] = { kind: 'strand', evalAt: (_me, _scope) => env.bpm };
          break;
        case 'timesig_num':
          envOuts[outName] = { kind: 'strand', evalAt: (_me, _scope) => env.timesig_num };
          break;
        case 'timesig_den':
          envOuts[outName] = { kind: 'strand', evalAt: (_me, _scope) => env.timesig_den };
          break;
        case 'beat':
          envOuts[outName] = { kind: 'strand', evalAt: (_me, _scope) => {
            const absTime = (Date.now() - env.startTime) / 1000;
            const beatsPerSecond = env.bpm / 60;
            return Math.floor(absTime * beatsPerSecond) % env.timesig_num;
          }};
          break;
        case 'measure':
          envOuts[outName] = { kind: 'strand', evalAt: (_me, _scope) => {
            const absTime = (Date.now() - env.startTime) / 1000;
            const beatsPerSecond = env.bpm / 60;
            return Math.floor(absTime * beatsPerSecond / env.timesig_num);
          }};
          break;
        default:
          // For unknown outputs, default to 0
          envOuts[outName] = { kind: 'strand', evalAt: (_me, _scope) => 0 };
          logger.warn('Builtin', `Unknown env output '${outName}', defaulting to 0`);
      }

      logger.debug('Builtin', `Mapped env output '${outName}'`);
    }

    const inst = makeSimpleInstance(instName, envOuts);
    env.instances.set(instName, inst);
    logger.updateInstanceViewer(env.instances);
    return inst;
  },
};

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
    this.env.playStatements = [];

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

        // Special handling for 'me' instance parameter updates
        if (s.name === 'me') {
          for (const outName of s.outs) {
            if (outName === 'loop' || outName === 'bpm' || outName === 'fps' || outName === 'timesig_num' || outName === 'timesig_den' || outName === 'width' || outName === 'height') {
              // Evaluate the expression to get the value and update the environment
              const value = toScalar(fx({}, this.env));
              if (outName === 'loop') {
                this.env.loop = Math.max(1, Math.floor(value));
              } else if (outName === 'bpm') {
                this.env.bpm = Math.max(1, value);
              } else if (outName === 'fps') {
                this.env.targetFps = Math.max(1, Math.min(120, value));
              } else if (outName === 'timesig_num') {
                this.env.timesig_num = Math.max(1, Math.floor(value));
              } else if (outName === 'timesig_den') {
                this.env.timesig_den = Math.max(1, Math.floor(value));
              } else if (outName === 'width') {
                this.env.resW = Math.max(1, Math.min(4096, Math.floor(value)));
                logger.info('Runtime', `Updated canvas width to: ${this.env.resW}`);
              } else if (outName === 'height') {
                this.env.resH = Math.max(1, Math.min(4096, Math.floor(value)));
                logger.info('Runtime', `Updated canvas height to: ${this.env.resH}`);
              }
            }
          }
          // Recreate the me instance with updated values
          this.env.createMeInstance();
          continue; // Don't process normal instance binding for me parameters
        }

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
      if(s.type==="DisplayStmt"){
        logger.info('DisplayStmt', `Processing display statement with ${s.args.length} arguments`);
        // Handle DisplayStmt - this is the main rendering statement
        let fr, fg, fb;

        if(s.args.length === 1) {
          // Check if single argument is an instance with outputs
          const arg = s.args[0];
          if(arg.type === "Var") {
            const inst = this.env.instances.get(arg.name);
            if(inst && inst.outs) {
              const outputs = Object.keys(inst.outs);
              logger.info('DisplayStmt', `Instance '${arg.name}' has outputs: [${outputs.join(', ')}]`);

              if(outputs.length >= 3) {
                // Use the first 3 outputs for r,g,b
                const [rOut, gOut, bOut] = outputs;
                logger.info('DisplayStmt', `Mapping: r=${rOut}, g=${gOut}, b=${bOut}`);
                fr = compileExprOptimized({type: "StrandAccess", base: arg, out: rOut}, this.env);
                fg = compileExprOptimized({type: "StrandAccess", base: arg, out: gOut}, this.env);
                fb = compileExprOptimized({type: "StrandAccess", base: arg, out: bOut}, this.env);
              } else {
                logger.warn('DisplayStmt', `Instance '${arg.name}' has insufficient outputs for r,g,b`);
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
        logger.info('DisplayStmt', 'Display functions configured successfully');
        continue;
      }
      if(s.type==="RenderStmt"){
        logger.info('RenderStmt', `Processing render statement with ${s.args.length} arguments`);
        let fr, fg, fb;

        if(s.args.length === 1) {
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
        logger.info('PlayStmt', `Processing play statement with ${s.args.length} arguments`);

        // Store the PlayStmt for the audio renderer
        this.env.playStatements.push(s);

        logger.info('PlayStmt', 'Play statement stored for audio rendering');
        continue;
      }
      if(s.type==="ComputeStmt"){
        logger.info('ComputeStmt', `Processing compute statement with ${s.args.length} arguments - not implemented yet`);
        continue;
      }
      throw new RuntimeError(`Unhandled statement type ${s.type}`);
    }
    if(!this.env.displayFns && (!this.env.playStatements || this.env.playStatements.length === 0)) {
      throw new RuntimeError("No render(...), display(...), or play(...) statement found.");
    }
  }
}

// Helper function for runtime evaluation of StrandRemap nodes
function evalStrandRemap(node) {
  // This function is called from compiled code, so we need to get env from global context
  // For now, we'll create a simplified implementation that can work in compiled context
  return function(me, scope) {
    const baseName = node.base?.name || node.base;
    const strandName = node.strand?.name || node.strand;

    // Get the source instance
    let inst = scope.instances ? scope.instances.get(baseName) : null;
    if (!inst && window.weftEnv && window.weftEnv.instances) {
      inst = window.weftEnv.instances.get(baseName);
    }

    if (!inst) throw new RuntimeError(`Unknown instance '${baseName}' in strand remap`);
    const sourceStrand = inst.outs[strandName];
    if (!sourceStrand) throw new RuntimeError(`'${baseName}' has no output '${strandName}' in strand remap`);

    // Evaluate coordinate expressions - simplified for compiled context
    const coords = node.coordinates.map(coordExpr => {
      // For now, return 0 for complex coordinate expressions
      // This should be enhanced once the basic framework is working
      return 0;
    });

    // Create remapped coordinates
    const remappedMe = {
      ...me,
      x: coords[0] !== undefined ? coords[0] : me.x,
      y: coords[1] !== undefined ? coords[1] : me.y,
      z: coords[2] !== undefined ? coords[2] : (me.z !== undefined ? me.z : 0)
    };

    // Evaluate source strand with new coordinates
    if (sourceStrand.kind === 'strand') {
      return sourceStrand.evalAt(remappedMe, scope);
    }
    if (typeof sourceStrand === 'function') return sourceStrand(remappedMe, scope);
    return sourceStrand;
  };
}

export {
  Env,
  Executor,
  RuntimeError,
  evalExprToStrand,
  compile,
  compileExpr, // Legacy alias
  compileExprOptimized, // Legacy alias
  evalSpindleCall,
  evalStrandRemap,
  BuiltinSpindles,
  Sampler,
  // Re-export utilities for backward compatibility
  clamp,
  isNum,
  logger
};

if (typeof window !== 'undefined') {
  window.Env = Env;
  window.Executor = Executor;
  window.clamp = clamp;
  window.isNum = isNum;
  window.logger = logger;
  window.Sampler = Sampler;
}