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

  deconstruct() {
    return [this.op, this.left, this.right];
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

  deconstruct() {
    return [this.op, this.expr];
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

  deconstruct() {
    return [this.name, this.args];
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

  deconstruct() {
    return [this.name];
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

  deconstruct() {
    return [this.v];
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

  deconstruct() {
    return [this.v];
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

  deconstruct() {
    return [this.field];
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

  deconstruct() {
    return [this.field];
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

  deconstruct() {
    return [this.items];
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

  deconstruct() {
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

  deconstruct() {
    return [this.base, this.out];
  }
}

class StrandRemapExpr extends ASTNode {
  constructor(base, strand, mappings) {
    super('StrandRemap');
    this.base = base;           // VarExpr for instance (e.g., VarExpr('img'))
    this.strand = strand;       // Strand name string (e.g., 'r')
    this.mappings = mappings;   // Array of {axis: 'x', expr: ...} objects
  }

  getChildren() {
    // Extract all expression children from mappings
    return [this.base, this.strand, ...this.mappings.map(m => m.expr)];
  }

  deconstruct() {
    return [this.base, this.strand, this.mappings];
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

  deconstruct() {
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

  deconstruct() {
    return [this.name, this.expr];
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

  deconstruct() {
    return [this.name, this.op, this.expr];
  }
}

class NamedArg extends ASTNode {
  constructor(name, value) {
    super('NamedArg');
    this.name = name;
    this.value = value;
  }

  getChildren() {
    return [this.value];
  }

  deconstruct() {
    return [this.name, this.value];
  }
}

// Base class for all output statements (render, play, compute, display)
class OutputStatement extends ASTNode {
  constructor(statementType, args) {
    super(statementType);
    this.args = args;
    this.namedArgs = new Map();
    this.positionalArgs = [];
    this.parameters = {};
    this.parseArgs(args);

    // Determine execution route based on statement type
    this.route = this.determineRoute();
  }

  getChildren() {
    return this.args;
  }

  deconstruct() {
    return [this.args];
  }

  parseArgs(args) {
    args.forEach(arg => {
      if (arg.type === 'NamedArg') {
        this.namedArgs.set(arg.name, arg.value);
        this.parameters[arg.name] = arg.value;
      } else {
        this.positionalArgs.push(arg);
      }
    });
  }

  determineRoute() {
    switch (this.type) {
      case 'RenderStmt': return 'gpu';
      case 'PlayStmt': return 'audio';
      case 'ComputeStmt': return 'cpu';
      case 'DisplayStmt': return this.determineLegacyRoute();
      default: return 'cpu';
    }
  }

  determineLegacyRoute() {
    const params = this.parameters;

    // GPU route indicators - visual rendering parameters
    if (params.r || params.g || params.b || params.rgb ||
        params.width || params.height || params.fps) {
      return 'gpu';
    }

    // Audio route indicators - audio synthesis parameters
    if (params.audio || params.left || params.right ||
        params.rate || params.channels) {
      return 'audio';
    }

    // Default based on positional args (legacy support)
    if (this.positionalArgs.length >= 3) {
      return 'gpu';  // Assume r,g,b positional arguments
    }

    if (this.positionalArgs.length === 1) {
      return 'audio';  // Assume single audio expression
    }

    return 'cpu';  // Default fallback
  }
}

// Convenience constructors for specific statement types
class DisplayStmt extends OutputStatement {
  constructor(args) { super('DisplayStmt', args); }
}

class RenderStmt extends OutputStatement {
  constructor(args) { super('RenderStmt', args); }
}

class PlayStmt extends OutputStatement {
  constructor(args) { super('PlayStmt', args); }
}

class ComputeStmt extends OutputStatement {
  constructor(args) { super('ComputeStmt', args); }
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

  deconstruct() {
    return [this.name, this.inputs, this.outputs, this.body];
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

  deconstruct() {
    return [this.name, this.outputs, this.expr];
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

  deconstruct() {
    return [this.statements];
  }
}

// Export all classes using ES6 modules
export {
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
  StrandRemapExpr,
  IfExpr,
  LetBinding,
  Assignment,
  NamedArg,
  OutputStatement,
  DisplayStmt,
  RenderStmt,
  PlayStmt,
  ComputeStmt,
  SpindleDef,
  InstanceBinding,
  Program
};