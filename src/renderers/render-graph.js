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
} from "../ast/ast-node.js";

import { match, _, inst } from "../utils/match.js";

export class RenderGraph {
  constructor(ast, env) {
    (this.ast = ast), (this.env = env), (this.nodes = new Map());
    this.execOrder = [];
  }
  build() {
    this.collectInstances();
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
        });
      }
      const node = this.nodes.get(name);
      for (const outputName of stmt.outputs) {
        node.outputs.set(outputName, stmt.expr);
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
}
