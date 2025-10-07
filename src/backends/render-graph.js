import {
  BinaryExpr,
  UnaryExpr,
  CallExpr,
  MeExpr,
  TupleExpr,
  IndexExpr,
  StrandAccessExpr,
  StrandRemapExpr,
  IfExpr,
} from "../lang/ast-node.js";

import { match, _, inst } from "../utils/match.js";

export class RenderGraph {
  constructor(ast, env) {
    (this.ast = ast), (this.env = env), (this.nodes = new Map());
    this.execOrder = [];
  }
  build() {
    this.collectInstances();
    this.resolveNumericStrandIndices();
    this.markRequiredOutputs();
    this.extractDeps();
    this.topoSort();
    return {
      nodes: this.nodes,
      execOrder: this.execOrder,
    };
  }
  collectInstances() {
    for (const stmt of this.ast.statements) {
      if (stmt.type !== "InstanceBinding") continue;

      const name = stmt.name;

      if (!this.nodes.has(name)) {
        this.nodes.set(name, {
          instanceName: name,
          type: this.determineType(stmt),
          outputs: new Map(),
          deps: new Set(),
          requiredOutputs: new Set(),
          contexts: new Set()
        });
      }
      const node = this.nodes.get(name);
      for (const outputName of stmt.outputs) {
        node.outputs.set(outputName, stmt.expr);
      }
    }
  }

  resolveNumericStrandIndices() {
    // Walk the entire AST and resolve numeric strand indices to actual names
    for (const stmt of this.ast.statements) {
      this.resolveInNode(stmt);
    }
  }

  resolveInNode(node) {
    if (!node) return;

    // Handle StrandAccessExpr with numeric indices
    if (node.type === 'StrandAccess' && typeof node.out === 'number') {
      const instance = this.env.instances.get(node.base.name);
      if (instance) {
        const strandNames = Object.keys(instance.outs);
        const actualName = strandNames[node.out];
        if (actualName) {
          node.out = actualName; // Mutate AST to replace number with string
        } else {
          throw new Error(
            `Strand index ${node.out} out of bounds for instance '${node.base.name}' (has ${strandNames.length} strands)`
          );
        }
      } else {
        throw new Error(
          `Instance '${node.base.name}' not found when resolving numeric strand index`
        );
      }
    }

    // Recursively resolve in all children
    if (node.getChildren) {
      const children = node.getChildren();
      for (const child of children) {
        this.resolveInNode(child);
      }
    }
  }

  determineType(stmt) {
    if (stmt.expr.type === "Call") {
      const callName = stmt.expr.name;
      if (callName === "load") return "builtin";
      if (this.env.spindles.has(callName)) return "spindle";
      return "call";
    }
    return "expr";
  }

  markRequiredOutputs() {
    const outputStmts = this.ast.statements.filter(
      (s) =>
        s.type === "DisplayStmt" ||
        s.type === "PlayStmt" ||
        s.type === "RenderStmt" ||
        s.type === "ComputeStmt"
    );

    for (const stmt of outputStmts) {
      for (const arg of stmt.args) {
        this.markRequiredInExpr(arg);
      }
    }
  }

  markRequiredInExpr(expr) {
    match(
      expr,
      inst(StrandAccessExpr, _, _),
      (base, strand) => {
        const instName = base.name;
        if (this.nodes.has(instName)) {
          this.nodes.get(instName).requiredOutputs.add(strand);
        }
      },
      inst(StrandRemapExpr, _, _, _),
      (base, strand, mappings) => {
        const instName = base.name;
        if (this.nodes.has(instName)) {
          this.nodes.get(instName).requiredOutputs.add(strand);
        }
        for (const mapping of mappings) {
          this.markRequiredInExpr(mapping.expr);
        }
      },
      inst(BinaryExpr, _, _, _),
      (op, left, right) => {
        this.markRequiredInExpr(left);
        this.markRequiredInExpr(right);
      },
      inst(UnaryExpr, _, _),
      (op, expr) => {
        this.markRequiredInExpr(expr);
      },
      inst(CallExpr, _, _),
      (name, args) => {
        for (const arg of args) {
          this.markRequiredInExpr(arg);
        }
      },
      inst(IfExpr, _, _, _),
      (c, t, e) => {
        this.markRequiredInExpr(c);
        this.markRequiredInExpr(t);
        this.markRequiredInExpr(e);
      },
      inst(TupleExpr, _),
      (items) => {
        for (const item of items) {
          this.markRequiredInExpr(item);
        }
      },
      inst(IndexExpr, _, _),
      (base, index) => {
        this.markRequiredInExpr(base);
        this.markRequiredInExpr(index);
      },
      _,
      (n) => {}
    );
  }

  extractDeps() {
    for (const [name, node] of this.nodes) {
      for (const [outputName, expr] of node.outputs) {
        const deps = this.findDepsInExpr(expr);
        for (const dep of deps) {
          node.deps.add(dep);
        }
      }
    }
  }

  findDepsInExpr(expr) {
    const deps = new Set();
    match(
      expr,
      inst(StrandAccessExpr, _, _),
      (b, s) => {
        deps.add(b.name);
      },
      inst(StrandRemapExpr, _, _, _),
      (b, s, m) => {
        deps.add(b.name);
        for (const mapping of m) {
          const subDeps = this.findDepsInExpr(mapping.expr);
          for (const d of subDeps) deps.add(d);
        }
      },
      inst(MeExpr, _),
      (f) => {
        deps.add("me");
      },
      inst(BinaryExpr, _, _, _),
      (o, l, r) => {
        const lDeps = this.findDepsInExpr(l);
        const rDeps = this.findDepsInExpr(r);
        for (const d of lDeps) deps.add(d);
        for (const d of rDeps) deps.add(d);
      },
      inst(UnaryExpr, _, _),
      (op, innerExpr) => {
        const innerDeps = this.findDepsInExpr(innerExpr);
        for (const d of innerDeps) deps.add(d);
      },
      inst(CallExpr, _, _),
      (name, args) => {
        for (const arg of args) {
          const argDeps = this.findDepsInExpr(arg);
          for (const d of argDeps) deps.add(d);
        }
      },
      inst(IfExpr, _, _, _),
      (cond, thenExpr, elseExpr) => {
        const condDeps = this.findDepsInExpr(cond);
        const thenDeps = this.findDepsInExpr(thenExpr);
        const elseDeps = this.findDepsInExpr(elseExpr);
        for (const d of condDeps) deps.add(d);
        for (const d of thenDeps) deps.add(d);
        for (const d of elseDeps) deps.add(d);
      },
      inst(TupleExpr, _),
      (items) => {
        for (const item of items) {
          const itemDeps = this.findDepsInExpr(item);
          for (const d of itemDeps) deps.add(d);
        }
      },
      inst(IndexExpr, _, _),
      (base, index) => {
        const baseDeps = this.findDepsInExpr(base);
        const indexDeps = this.findDepsInExpr(index);
        for (const d of baseDeps) deps.add(d);
        for (const d of indexDeps) deps.add(d);
      },
      _,
      (n) => {}
    );

    return deps;
  }

  topoSort() {
    const inDeg = new Map();
    for (const [name, node] of this.nodes) {
      inDeg.set(name, 0);
    }

    for (const [name, node] of this.nodes) {
      for (const dep of node.deps) {
        if (this.nodes.has(dep)) {
          inDeg.set(name, (inDeg.get(name) || 0) + 1);
        }
      }
    }

    const queue = [];

    for (const [name, deg] of inDeg) {
      if (deg === 0) {
        queue.push(name);
      }
    }

    while (queue.length > 0) {
      const current = queue.shift();
      this.execOrder.push(current);

      for (const [name, node] of this.nodes) {
        if (node.deps.has(current)) {
          const newDeg = inDeg.get(name) - 1;
          inDeg.set(name, newDeg);

          if (newDeg === 0) {
            queue.push(name);
          }
        }
      }
    }

    if (this.execOrder.length !== this.nodes.size) { 
      throw new Error("Circular dependency in render graph!");
    }
  }
  
  tagContexts(outputStmts) {
    // Tag instances with contexts based on output statements
    for (const stmt of outputStmts) {
      const context = this.getStmtContext(stmt);
      if (!context) continue;

      for (const expr of stmt.args) {
        this.tagDepsInExpr(expr, context, this.nodes);
      }
    }

    // Log tagging results
    console.log('[RenderGraph] Context tagging complete:');
    for (const [name, node] of this.nodes) {
      if (node.contexts.size > 0) {
        console.log(`  ${name}: ${Array.from(node.contexts).join(', ')}`);
      }
    }
  }

  getStmtContext(stmt) {
    switch(stmt.type) {
      case 'DisplayStmt':
      case 'RenderStmt':
        return 'visual';
      case 'PlayStmt':
        return 'audio';
      case 'ComputeStmt':
        return 'compute';
      default:
        return null;
    }
  }

  tagDepsInExpr(expr, context, nodes) {
    if (!expr) return;

    match(expr,
      inst(StrandAccessExpr, _, _), (base, strand) => {
        if (base.type === 'Var') {
          const instName = base.name;
          if(nodes.has(instName)) {
            nodes.get(instName).contexts.add(context);
            this.tagInstDeps(instName, context, nodes);
          }
        }
      },

      inst(StrandRemapExpr, _, _, _), (base, strand, mappings) => {
        if (base.type === 'Var') {
          const instName = base.name;
          if (nodes.has(instName)) {
            nodes.get(instName).contexts.add(context);
            this.tagInstDeps(instName, context, nodes);
          }
        }
        for (const mapping of mappings) {
          this.tagDepsInExpr(mapping.expr, context, nodes);
        }
      },

      inst(BinaryExpr, _, _, _), (_op, left, right) => {
        this.tagDepsInExpr(left, context, nodes);
        this.tagDepsInExpr(right, context, nodes);
      },

      inst(UnaryExpr, _, _), (_op, innerExpr) => {
        this.tagDepsInExpr(innerExpr, context, nodes);
      },

      inst(CallExpr, _, _), (_name, args) => {
        for (const arg of args) {
          this.tagDepsInExpr(arg, context, nodes);
        }
      },

      inst(IfExpr, _, _, _), (cond, thenExpr, elseExpr) => {
        this.tagDepsInExpr(cond, context, nodes);
        this.tagDepsInExpr(thenExpr, context, nodes);
        this.tagDepsInExpr(elseExpr, context, nodes);
      },

      inst(TupleExpr, _), (items) => {
        for (const item of items) {
          this.tagDepsInExpr(item, context, nodes);
        }
      },

      inst(IndexExpr, _, _), (base, index) => {
        this.tagDepsInExpr(base, context, nodes);
        this.tagDepsInExpr(index, context, nodes);
      },
      _, (n) => {}
    );
  }

  tagInstDeps(instName, context, nodes) {
    const node = nodes.get(instName);
    if(!node) return;

    for (const depName of node.deps) {
      if (nodes.has(depName)) {
        const depNode = nodes.get(depName);

        if(!depNode.contexts.has(context)) {
          depNode.contexts.add(context);
          this.tagInstDeps(depName, context, nodes);
        }
      }
    }
  };

  getContextsNeeded() {
    const contexts = new Set();
    for (const [name, node] of this.nodes) {
      for (const ctx of node.contexts) {
        contexts.add(ctx);
      }
    }
    return contexts;
  }
}
