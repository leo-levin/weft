// Route Tagging System for WEFT AST
// Streamlined version - routing is now handled directly in AST nodes during construction

import { OutputStatement } from '../ast/ast-node.js';

// Main function to tag expression routes based on output statement dependencies
function tagExpressionRoutes(ast) {
  // Step 1: Find all output statements - they already have their routes determined
  const outputStatements = findOutputStatements(ast);
  
  // Step 2: Trace dependencies and propagate routes
  outputStatements.forEach(stmt => {
    const dependencies = traceDependencies(stmt, ast);
    const route = stmt.route; // Route already determined during construction
    
    dependencies.forEach(expr => {
      ensureNodeHasRouteMethods(expr);
      expr.addRoute(route);
      
      // Set primary route if not already set
      if (!expr.primaryRoute) {
        expr.setPrimaryRoute(route);
      }
    });
  });

  // Step 3: Handle cross-context expressions
  const crossContextExprs = findCrossContextExpressions(ast);
  crossContextExprs.forEach(expr => {
    expr.markCrossContext();
    expr.setPrimaryRoute(selectPrimaryRoute(expr));
  });

  return ast;
}

// Find all output statements in the AST
function findOutputStatements(ast) {
  const outputStatements = [];
  
  function traverse(node) {
    if (!node) return;
    
    if (node instanceof OutputStatement || 
        ['RenderStmt', 'PlayStmt', 'ComputeStmt', 'DisplayStmt'].includes(node.type)) {
      outputStatements.push(node);
    }
    
    // Traverse children
    const children = node.getChildren ? node.getChildren() : [];
    children.forEach(child => traverse(child));
    
    // Also traverse statements for Program nodes
    if (node.statements) {
      node.statements.forEach(stmt => traverse(stmt));
    }
  }
  
  traverse(ast);
  return outputStatements;
}

// Trace all expressions that an output statement depends on
function traceDependencies(outputStmt, ast) {
  const dependencies = new Set();
  const variableBindings = buildVariableBindings(ast);

  function traceExpr(expr) {
    if (!expr || dependencies.has(expr)) return;
    dependencies.add(expr);

    // Trace variable bindings
    if (expr.type === 'Var') {
      const binding = variableBindings.get(expr.name);
      if (binding) traceExpr(binding.expr);
    }

    // Trace strand access bindings
    if (expr.type === 'StrandAccess') {
      const binding = variableBindings.get(expr.base);
      if (binding) traceExpr(binding.expr);
    }

    // Recursively trace children
    const children = expr.getChildren ? expr.getChildren() : [];
    children.forEach(child => traceExpr(child));
  }

  outputStmt.args.forEach(arg => traceExpr(arg));
  return Array.from(dependencies);
}

// Build variable bindings map
function buildVariableBindings(ast) {
  const bindings = new Map();
  
  function traverse(node) {
    if (!node) return;
    
    if (['LetBinding', 'Assignment', 'Direct'].includes(node.type)) {
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