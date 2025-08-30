// Route Tagging System for WEFT AST
// DISPLAY-DRIVEN ROUTING: Routes are determined by display statements, NOT expression content
//
// Key Principles:
// 1. Display statements determine execution routes based on their parameters
// 2. ALL expressions are route-agnostic - they can compile to any target
// 3. Abstract placeholders (me.x, me.y, me.time) resolve differently per context
// 4. Cross-context is about data flow optimization, not capability limitations
// 5. if/then works on GPU! sin() works on CPU! Routes are WHERE, not WHAT

// Route determination based on statement type (simplified with explicit statement types)
function determineRoute(stmt) {
  // Direct mapping from statement type to execution route
  switch (stmt.type) {
    case 'RenderStmt':
      return 'gpu';
    case 'PlayStmt':
      return 'audio';
    case 'ComputeStmt':
      return 'cpu';
    case 'DisplayStmt':
      // Legacy support - fall back to parameter analysis for old DisplayStmt nodes
      return determineRouteLegacy(stmt);
    default:
      return 'cpu';  // Default fallback
  }
}

// Legacy route determination for backward compatibility with DisplayStmt
function determineRouteLegacy(displayStmt) {
  const params = displayStmt.parameters;

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

  // CPU route indicators - explicit CPU targets
  if (params.target === 'console' || params.target === 'storage' ||
      params.target === 'websocket' || params.target === 'worker') {
    return 'cpu';
  }

  // Default based on positional args (legacy support)
  if (displayStmt.positionalArgs.length >= 3) {
    return 'gpu';  // Assume r,g,b positional arguments
  }

  if (displayStmt.positionalArgs.length === 1) {
    return 'audio';  // Assume single audio expression
  }

  return 'cpu';  // Default fallback
}

// Add route methods to a single node (non-recursive)
function ensureNodeHasRouteMethods(node) {
  if (!node || typeof node !== 'object') return;

  // Add route properties if missing
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

  // Add route methods if missing
  if (!node.addRoute) {
    node.addRoute = function(route) {
      this.routes.add(route);
    };
  }
  if (!node.setPrimaryRoute) {
    node.setPrimaryRoute = function(route) {
      this.primaryRoute = route;
    };
  }
  if (!node.addDependency) {
    node.addDependency = function(dep) {
      this.dependencies.add(dep);
    };
  }
  if (!node.markCrossContext) {
    node.markCrossContext = function() {
      this.crossContext = true;
    };
  }
}

function tagExpressionRoutes(ast) {
  // Step 1: Find all output statements and determine their routes
  const outputStatements = findDisplayStatements(ast);
  const routeMap = new Map();

  outputStatements.forEach(stmt => {
    const route = determineRoute(stmt);  // Based on statement type (render/play/compute)
    routeMap.set(stmt, route);
    
    // Add methods if missing
    ensureNodeHasRouteMethods(stmt);
    stmt.addRoute(route);
    stmt.setPrimaryRoute(route);
  });

  // Step 3: Trace dependencies backward from each output statement
  outputStatements.forEach(stmt => {
    const route = routeMap.get(stmt);
    const dependencies = traceDependencies(stmt, ast);

    dependencies.forEach(expr => {
      // Add methods if missing  
      ensureNodeHasRouteMethods(expr);
      expr.addRoute(route);
      // Set primary route if not already set
      if (!expr.primaryRoute) {
        expr.setPrimaryRoute(route);
      }
    });
  });

  // Step 4: Identify and handle cross-context expressions
  const crossContextExprs = findCrossContextExpressions(ast);

  crossContextExprs.forEach(expr => {
    ensureNodeHasRouteMethods(expr);
    expr.markCrossContext();
    // Select primary route based on usage patterns, not content
    expr.setPrimaryRoute(selectPrimaryRouteByUsage(expr));
  });

  return ast;
}

// Trace all expressions that an output statement depends on
function traceDependencies(outputStmt, ast) {
  const dependencies = new Set();
  const variableBindings = buildVariableBindings(ast);

  function traceExpr(expr) {
    if (!expr || dependencies.has(expr)) return;

    dependencies.add(expr);

    // If this is a variable reference, trace its binding
    if (expr.type === 'Var') {
      const binding = variableBindings.get(expr.name);
      if (binding) {
        traceExpr(binding.expr);
      }
    }

    // If this is a strand access (instance@output), trace the instance binding
    if (expr.type === 'StrandAccess') {
      const binding = variableBindings.get(expr.base);
      if (binding) {
        traceExpr(binding.expr);
      }
    }

    // Recursively trace all child expressions
    const children = expr.getChildren ? expr.getChildren() : [];
    children.forEach(child => traceExpr(child));
  }

  // Trace all arguments of the output statement (render, play, compute, or legacy display)
  outputStmt.args.forEach(arg => traceExpr(arg));

  return Array.from(dependencies);
}

// Build a map of variable names to their binding expressions
function buildVariableBindings(ast) {
  const bindings = new Map();

  function traverse(node) {
    if (!node) return;

    if (node.type === 'LetBinding' || node.type === 'Assignment' || node.type === 'Direct') {
      bindings.set(node.name, node);
    }

    // Traverse children
    const children = node.getChildren ? node.getChildren() : [];
    children.forEach(child => traverse(child));

    // Also traverse statements if this is a Program node
    if (node.statements) {
      node.statements.forEach(stmt => traverse(stmt));
    }
  }

  traverse(ast);
  return bindings;
}

// Find all output statements in the AST (render, play, compute, and legacy display)
function findDisplayStatements(ast) {
  const outputStatements = [];

  function traverse(node) {
    if (!node) return;

    // Find all types of output statements
    if (node.type === 'RenderStmt' ||
        node.type === 'PlayStmt' ||
        node.type === 'ComputeStmt' ||
        node.type === 'DisplayStmt') {
      outputStatements.push(node);
    }

    // Traverse children
    const children = node.getChildren ? node.getChildren() : [];
    children.forEach(child => traverse(child));

    // Also traverse statements if this is a Program node
    if (node.statements) {
      node.statements.forEach(stmt => traverse(stmt));
    }
  }

  traverse(ast);
  return outputStatements;
}

// Find expressions that are used by multiple routes (cross-context)
function findCrossContextExpressions(ast) {
  const crossContextExprs = [];

  function traverse(node) {
    if (!node || !node.routes) return;

    // If this expression is needed by multiple routes, it's cross-context
    if (node.routes.size > 1) {
      crossContextExprs.push(node);
    }

    // Traverse children
    const children = node.getChildren ? node.getChildren() : [];
    children.forEach(child => traverse(child));

    // Also traverse statements if this is a Program node
    if (node.statements) {
      node.statements.forEach(stmt => traverse(stmt));
    }
  }

  traverse(ast);
  return crossContextExprs;
}

// Select primary route based on usage patterns and performance, NOT content
function selectPrimaryRouteByUsage(expression) {
  const routes = Array.from(expression.routes);

  // Rule 1: If only one route needs it, that's primary
  if (routes.length === 1) {
    return routes[0];
  }

  // Rule 2: Shared computations should prefer CPU for single computation + data bridges
  // This avoids recomputing the same expression in multiple contexts
  if (routes.length > 2) {
    return 'cpu';
  }

  // Rule 3: For two routes, choose based on computational efficiency
  // GPU is most parallel, Audio has strict timing constraints, CPU is most flexible
  if (routes.includes('cpu') && routes.includes('gpu')) {
    // CPU↔GPU: Prefer CPU for complex shared calculations, GPU for simple parallel ones
    return 'cpu';  // CPU can handle any computation, GPU has limitations
  }

  if (routes.includes('cpu') && routes.includes('audio')) {
    // CPU↔Audio: Prefer CPU for flexibility, unless it's simple math
    return 'cpu';
  }

  if (routes.includes('gpu') && routes.includes('audio')) {
    // GPU↔Audio: Both are specialized, prefer GPU as it has more parallelism
    return 'gpu';
  }

  // Rule 4: Default fallback hierarchy
  if (routes.includes('cpu')) return 'cpu';
  if (routes.includes('gpu')) return 'gpu';
  return 'audio';
}

// Export functions for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    tagExpressionRoutes,
    ensureNodeHasRouteMethods,
    determineRoute,
    determineRouteLegacy,
    traceDependencies,
    buildVariableBindings,
    findDisplayStatements,
    findCrossContextExpressions,
    selectPrimaryRouteByUsage
  };
} else if (typeof window !== 'undefined') {
  window.RouteTagging = {
    tagExpressionRoutes,
    ensureNodeHasRouteMethods,
    determineRoute,
    determineRouteLegacy,
    traceDependencies,
    buildVariableBindings,
    findDisplayStatements,
    findCrossContextExpressions,
    selectPrimaryRouteByUsage
  };
}