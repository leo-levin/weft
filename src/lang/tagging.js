import { OutputStatement } from '../ast/ast-node.js';

function tagExpressionRoutes(ast) {
  const outputStatements = findOutputStatements(ast);

  outputStatements.forEach(stmt => {
    if (!stmt || !stmt.route) return; // Skip invalid statements

    // Ensure the output statement itself has route methods
    ensureNodeHasRouteMethods(stmt);
    stmt.addRoute(stmt.route);
    stmt.setPrimaryRoute(stmt.route);

    const dependencies = traceDependencies(stmt, ast);
    const route = stmt.route;

    dependencies.forEach(expr => {
      if (!expr) return; // Skip null expressions
      ensureNodeHasRouteMethods(expr);
      expr.addRoute(route);
      if (!expr.primaryRoute) {
        expr.setPrimaryRoute(route);
      }
    });
  });
  const crossContextExprs = findCrossContextExpressions(ast);
  crossContextExprs.forEach(expr => {
    if (!expr || !expr.routes) return; // Skip invalid expressions
    expr.markCrossContext();
    expr.setPrimaryRoute(selectPrimaryRoute(expr));
  });

  return ast;
}
function findOutputStatements(ast) {
  const outputStatements = [];

  function traverse(node) {
    if (!node) return;

    if (node instanceof OutputStatement ||
        ['RenderStmt', 'PlayStmt', 'ComputeStmt', 'DisplayStmt'].includes(node.type)) {

      // Assign appropriate routes to output statements
      if (node.type === 'PlayStmt') {
        node.route = 'audio';
      } else if (node.type === 'DisplayStmt' || node.type === 'RenderStmt') {
        node.route = 'gpu'; // Default to GPU for visual output
      } else if (node.type === 'ComputeStmt') {
        node.route = 'cpu'; // Default to CPU for compute
      } else if (node instanceof OutputStatement) {
        // For generic OutputStatement, determine route based on context or default to cpu
        node.route = node.route || 'cpu';
      }

      outputStatements.push(node);
    }
    const children = node.getChildren ? node.getChildren() : [];
    children.forEach(child => traverse(child));
    if (node.statements) {
      node.statements.forEach(stmt => traverse(stmt));
    }
  }

  traverse(ast);
  return outputStatements;
}

function traceDependencies(outputStmt, ast) {
  const dependencies = new Set();
  const variableBindings = buildVariableBindings(ast);

  function traceExpr(expr) {
    if (!expr || dependencies.has(expr)) return;
    dependencies.add(expr);

    if (expr.type === 'Var') {
      const binding = variableBindings.get(expr.name);
      if (binding) {
        dependencies.add(binding); // Add the binding statement itself
        traceExpr(binding.expr);
      }
    }

    if (expr.type === 'StrandAccess') {
      const baseName = expr.base?.name || expr.base;
      const binding = variableBindings.get(baseName);
      if (binding) {
        dependencies.add(binding); // Add the binding statement itself
        traceExpr(binding.expr);
      }
    }

    const children = expr.getChildren ? expr.getChildren() : [];
    children.forEach(child => traceExpr(child));
  }

  if (outputStmt.args) {
    outputStmt.args.forEach(arg => traceExpr(arg));
  }
  return Array.from(dependencies);
}

// Build variable bindings map
function buildVariableBindings(ast) {
  const bindings = new Map();

  function traverse(node) {
    if (!node) return;

    if (['LetBinding', 'Assignment', 'Direct'].includes(node.type) && node.name) {
      bindings.set(node.name, node);
    }

    const children = node.getChildren ? node.getChildren() : [];
    children.forEach(child => traverse(child));

    if (node.statements) {
      node.statements.forEach(stmt => traverse(stmt));
    }
  }

  traverse(ast);
  return bindings;
}

// Find expressions used by multiple routes
function findCrossContextExpressions(ast) {
  const crossContextExprs = [];

  function traverse(node) {
    if (!node || !node.routes) return;

    if (node.routes.size > 1) {
      crossContextExprs.push(node);
    }

    const children = node.getChildren ? node.getChildren() : [];
    children.forEach(child => traverse(child));

    if (node.statements) {
      node.statements.forEach(stmt => traverse(stmt));
    }
  }

  traverse(ast);
  return crossContextExprs;
}

// Select primary route for cross-context expressions
function selectPrimaryRoute(expression) {
  if (!expression || !expression.routes || expression.routes.size === 0) {
    return 'cpu'; // Default fallback
  }

  const routes = Array.from(expression.routes);

  if (routes.length === 1) return routes[0];
  if (routes.length > 2) return 'cpu'; // CPU handles complex shared computations

  // For dual routes, prefer CPU for flexibility
  if (routes.includes('cpu')) return 'cpu';
  if (routes.includes('gpu')) return 'gpu';
  return 'audio';
}

// Add route methods to nodes that don't have them
function ensureNodeHasRouteMethods(node) {
  if (!node || typeof node !== 'object') return;

  if (!node.routes) {
    node.routes = new Set();
  }
  if (!node.primaryRoute) {
    node.primaryRoute = null;
  }
  if (!node.dependencies) {
    node.dependencies = new Set();
  }
  if (!node.crossContext) {
    node.crossContext = false;
  }

  if (!node.addRoute) {
    node.addRoute = function(route) { this.routes.add(route); };
  }
  if (!node.setPrimaryRoute) {
    node.setPrimaryRoute = function(route) { this.primaryRoute = route; };
  }
  if (!node.addDependency) {
    node.addDependency = function(dep) { this.dependencies.add(dep); };
  }
  if (!node.markCrossContext) {
    node.markCrossContext = function() { this.crossContext = true; };
  }
}

// Export functions using ES6 modules
export {
  tagExpressionRoutes,
  findOutputStatements,
  traceDependencies,
  buildVariableBindings,
  findCrossContextExpressions,
  selectPrimaryRoute,
  ensureNodeHasRouteMethods
};