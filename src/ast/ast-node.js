// AST Node Classes for WEFT
// Base class and specific node types for the WEFT AST

class ASTNode {
  constructor(type) {
    this.type = type;
    this.routes = new Set();        // execution routes that need this node
    this.primaryRoute = null;       // primary execution route
    this.dependencies = new Set();  // nodes this depends on
    this.crossContext = false;      // crosses multiple execution contexts
    this.id = ASTNode.generateId(); // unique identifier
  }

  static generateId() {
    return `node_${ASTNode._counter++}`;
  }

  addRoute(route) {
    this.routes.add(route);
  }

  setPrimaryRoute(route) {
    this.primaryRoute = route;
  }

  addDependency(node) {
    this.dependencies.add(node);
  }

  markCrossContext() {
    this.crossContext = true;
  }

  // Abstract method - should be overridden by subclasses
  getChildren() {
    return [];
  }

  // Traverse all child nodes
  traverse(callback) {
    callback(this);
    this.getChildren().forEach(child => {
      if (child instanceof ASTNode) {
        child.traverse(callback);
      }
    });
  }
}

ASTNode._counter = 1;

// Expression nodes
class BinaryExpr extends ASTNode {
  constructor(op, left, right) {
    super('Bin');
    this.op = op;
    this.left = left;
    this.right = right;
  }

  getChildren() {
    return [this.left, this.right];
  }
}

class UnaryExpr extends ASTNode {
  constructor(op, expr) {
    super('Unary');
    this.op = op;
    this.expr = expr;
  }

  getChildren() {
    return [this.expr];
  }
}

class CallExpr extends ASTNode {
  constructor(name, args) {
    super('Call');
    this.name = name;
    this.args = args;
  }

  getChildren() {
    return [this.name, ...this.args];
  }
}

class VarExpr extends ASTNode {
  constructor(name) {
    super('Var');
    this.name = name;
  }

  getChildren() {
    return [];
  }
}

class NumExpr extends ASTNode {
  constructor(value) {
    super('Num');
    this.v = value;
  }

  getChildren() {
    return [];
  }
}

class StrExpr extends ASTNode {
  constructor(value) {
    super('Str');
    this.v = value;
  }

  getChildren() {
    return [];
  }
}

class MeExpr extends ASTNode {
  constructor(field) {
    super('Me');
    this.field = field;
  }

  getChildren() {
    return [];
  }
}

class MouseExpr extends ASTNode {
  constructor(field) {
    super('Mouse');
    this.field = field;
  }

  getChildren() {
    return [];
  }
}

class TupleExpr extends ASTNode {
  constructor(items) {
    super('Tuple');
    this.items = items;
  }

  getChildren() {
    return this.items;
  }
}

class IndexExpr extends ASTNode {
  constructor(base, index) {
    super('Index');
    this.base = base;
    this.index = index;
  }

  getChildren() {
    return [this.base, this.index];
  }
}

class StrandAccessExpr extends ASTNode {
  constructor(base, out) {
    super('StrandAccess');
    this.base = base;
    this.out = out;
  }

  getChildren() {
    return [this.base, this.out];
  }
}

class IfExpr extends ASTNode {
  constructor(condition, thenExpr, elseExpr) {
    super('If');
    this.condition = condition;
    this.thenExpr = thenExpr;
    this.elseExpr = elseExpr;
  }

  getChildren() {
    return [this.condition, this.thenExpr, this.elseExpr];
  }
}

// Statement nodes
class LetBinding extends ASTNode {
  constructor(name, expr) {
    super('LetBinding');
    this.name = name;
    this.expr = expr;
  }

  getChildren() {
    return [this.expr];
  }
}

class Assignment extends ASTNode {
  constructor(name, op, expr) {
    super('Assignment');
    this.name = name;
    this.op = op;
    this.expr = expr;
  }

  getChildren() {
    return [this.expr];
  }
}

class DisplayStmt extends ASTNode {
  constructor(args) {
    super('DisplayStmt');
    this.args = args;
    this.parameters = this.parseDisplayParams(args);
  }

  getChildren() {
    return this.args;
  }

  parseDisplayParams(args) {
    // Parse named arguments in display statements
    // e.g. display(r: red, g: green, b: blue, width: 800, height: 600)
    const params = {};
    args.forEach(arg => {
      // This is a simplified version - actual implementation would need
      // to handle the named argument parsing from the display syntax
      if (arg.type === 'NamedArg') {
        params[arg.name] = arg.value;
      }
    });
    return params;
  }
}

class SpindleDef extends ASTNode {
  constructor(name, inputs, outputs, body) {
    super('SpindleDef');
    this.name = name;
    this.inputs = inputs;
    this.outputs = outputs;
    this.body = body;
  }

  getChildren() {
    return [this.body];
  }
}

class InstanceBinding extends ASTNode {
  constructor(name, outputs, expr) {
    super('InstanceBinding');
    this.name = name;
    this.outputs = outputs;
    this.expr = expr;
  }

  getChildren() {
    return [this.expr];
  }
}

class Program extends ASTNode {
  constructor(statements) {
    super('Program');
    this.statements = statements;
  }

  getChildren() {
    return this.statements;
  }
}

// Export all classes
if (typeof module !== 'undefined' && module.exports) {
  // Node.js environment
  module.exports = {
    ASTNode,
    BinaryExpr,
    UnaryExpr,
    CallExpr,
    VarExpr,
    NumExpr,
    StrExpr,
    MeExpr,
    MouseExpr,
    TupleExpr,
    IndexExpr,
    StrandAccessExpr,
    IfExpr,
    LetBinding,
    Assignment,
    DisplayStmt,
    SpindleDef,
    InstanceBinding,
    Program
  };
} else {
  // Browser environment
  window.ASTNodes = {
    ASTNode,
    BinaryExpr,
    UnaryExpr,
    CallExpr,
    VarExpr,
    NumExpr,
    StrExpr,
    MeExpr,
    MouseExpr,
    TupleExpr,
    IndexExpr,
    StrandAccessExpr,
    IfExpr,
    LetBinding,
    Assignment,
    DisplayStmt,
    SpindleDef,
    InstanceBinding,
    Program
  };
}