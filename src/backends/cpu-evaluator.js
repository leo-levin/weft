import {compile} from '../compilers/compiler-new.js'

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