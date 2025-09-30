// parameter-system.js — Unified parameter management for all renderers
import { logger } from '../utils/logger.js';
import { findCrossContextExpressions, traceDependencies } from '../lang/tagging.js';

/**
 * Unified parameter system that coordinates parameter sharing between renderers
 * based on route tagging information
 */
export class UnifiedParameterSystem {
  constructor(env) {
    this.env = env;
    this.renderers = new Map(); // renderer type -> renderer instance
    this.parameterRoutes = new Map(); // parameter name -> Set of routes
    this.crossContextParams = new Map(); // parameter name -> parameter info
    this.parameterValues = new Map(); // parameter name -> current value
    this.updateCallbacks = new Map(); // renderer type -> callback function

    this.updateInterval = 100; // Update every 100ms
    this.updateTimer = null;
    this.running = false;
  }

  /**
   * Register a renderer with the parameter system
   * @param {string} rendererType - Type of renderer (cpu, gpu, audio)
   * @param {Object} renderer - Renderer instance
   * @param {Function} updateCallback - Callback to call when parameters update
   */
  registerRenderer(rendererType, renderer, updateCallback) {
    this.renderers.set(rendererType, renderer);
    this.updateCallbacks.set(rendererType, updateCallback);
    logger.debug('ParameterSystem', `Registered ${rendererType} renderer`);
  }

  /**
   * Unregister a renderer
   * @param {string} rendererType - Type of renderer
   */
  unregisterRenderer(rendererType) {
    this.renderers.delete(rendererType);
    this.updateCallbacks.delete(rendererType);
    logger.debug('ParameterSystem', `Unregistered ${rendererType} renderer`);
  }

  /**
   * Analyze tagged AST and set up parameter routing
   * @param {Object} ast - Tagged AST with route information
   */
  analyzeParameterRoutes(ast) {
    this.parameterRoutes.clear();
    this.crossContextParams.clear();

    // Find all parameter definitions and their routes
    this.analyzeParameterDefinitions(ast);

    // Find cross-context parameter usage
    this.analyzeCrossContextUsage(ast);

    // Set up pragma parameters
    this.analyzePragmaParameters(ast);

    logger.info('ParameterSystem', `Analyzed ${this.crossContextParams.size} cross-context parameters`);
  }

  /**
   * Find where parameters are defined and which routes use them
   * @param {Object} ast - Tagged AST
   */
  analyzeParameterDefinitions(ast) {
    const traverse = (node) => {
      if (!node) return;

      // Check for parameter-defining statements
      if (this.isParameterDefinition(node)) {
        const paramName = this.getParameterName(node);
        if (paramName) {
          // Determine which routes this parameter is used by
          const routes = new Set();

          if (node.routes) {
            node.routes.forEach(route => routes.add(route));
          }
          if (node.primaryRoute) {
            routes.add(node.primaryRoute);
          }

          // If no routes specified, assume it's used by all renderers
          if (routes.size === 0) {
            routes.add('cpu');
            routes.add('gpu');
            routes.add('audio');
          }

          this.parameterRoutes.set(paramName, routes);
          logger.debug('ParameterSystem', `Parameter ${paramName} used by routes: ${Array.from(routes)}`);
        }
      }

      // Recursively traverse children
      this.traverseChildren(node, traverse);
    };

    traverse(ast);
  }

  /**
   * Find cross-context parameter usage
   * @param {Object} ast - Tagged AST
   */
  analyzeCrossContextUsage(ast) {
    // Use the tagging system to find cross-context expressions
    const crossContextExprs = findCrossContextExpressions(ast);

    crossContextExprs.forEach(expr => {
      if (this.isParameterReference(expr)) {
        const paramName = this.getParameterName(expr);
        if (paramName && !this.crossContextParams.has(paramName)) {
          this.crossContextParams.set(paramName, {
            name: paramName,
            expression: expr,
            routes: new Set(expr.routes || []),
            primaryRoute: expr.primaryRoute || 'cpu',
            type: 'cross-context'
          });
        }
      }
    });
  }

  /**
   * Analyze pragma parameters (sliders, toggles, etc.)
   * @param {Object} ast - Tagged AST
   */
  analyzePragmaParameters(ast) {
    if (!ast.pragmas) return;

    ast.pragmas.forEach(pragma => {
      if (['slider', 'color', 'xy', 'toggle'].includes(pragma.type) && pragma.config) {
        const instanceName = pragma.config.name;

        // Find which routes use this pragma
        const routes = new Set();
        this.findPragmaUsage(ast, instanceName, routes);

        if (routes.size > 1) {
          // This is a cross-context pragma parameter
          pragma.config.strands.forEach(strand => {
            const paramKey = `${instanceName}@${strand}`;
            this.crossContextParams.set(paramKey, {
              name: instanceName,
              strand: strand,
              pragma: pragma,
              routes: routes,
              primaryRoute: this.selectPrimaryRoute(routes),
              type: 'pragma'
            });
          });
        }
      }
    });
  }

  /**
   * Find which routes use a pragma parameter
   * @param {Object} ast - Tagged AST
   * @param {string} instanceName - Pragma instance name
   * @param {Set} routes - Set to collect routes
   */
  findPragmaUsage(ast, instanceName, routes) {
    const traverse = (node) => {
      if (!node) return;

      // Check for strand access to this instance
      if (node.type === 'StrandAccess' && node.base?.name === instanceName) {
        if (node.routes) {
          node.routes.forEach(route => routes.add(route));
        }
        if (node.primaryRoute) {
          routes.add(node.primaryRoute);
        }
      }

      // Check for variable references
      if (node.type === 'Var' && node.name === instanceName) {
        if (node.routes) {
          node.routes.forEach(route => routes.add(route));
        }
        if (node.primaryRoute) {
          routes.add(node.primaryRoute);
        }
      }

      this.traverseChildren(node, traverse);
    };

    traverse(ast);
  }

  /**
   * Start the parameter update system
   */
  start() {
    if (this.running) return;

    this.running = true;
    this.startUpdateLoop();
    logger.info('ParameterSystem', 'Started parameter update system');
  }

  /**
   * Stop the parameter update system
   */
  stop() {
    if (!this.running) return;

    this.running = false;
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    logger.info('ParameterSystem', 'Stopped parameter update system');
  }

  /**
   * Start the parameter update loop
   */
  startUpdateLoop() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }

    this.updateTimer = setInterval(() => {
      if (this.running) {
        this.updateAllParameters();
      }
    }, this.updateInterval);
  }

  /**
   * Update all cross-context parameters
   */
  updateAllParameters() {
    const updatedParams = {};

    // Update environment parameters (pragmas)
    if (this.env.parameters) {
      for (const [paramName, paramStrand] of this.env.parameters) {
        const oldValue = this.parameterValues.get(paramName);
        const newValue = paramStrand.value;

        if (oldValue !== newValue) {
          this.parameterValues.set(paramName, newValue);
          updatedParams[paramName] = newValue;
        }
      }
    }

    // Update cross-context expression parameters
    this.crossContextParams.forEach((param, paramKey) => {
      try {
        const oldValue = this.parameterValues.get(paramKey);
        let newValue;

        if (param.type === 'pragma') {
          // Get value from parameter strand
          const paramStrand = this.env.getParameterStrand(param.strand);
          newValue = paramStrand ? paramStrand.value : 0;
        } else {
          // Evaluate expression for current value
          newValue = this.evaluateParameterExpression(param.expression);
        }

        if (oldValue !== newValue) {
          this.parameterValues.set(paramKey, newValue);
          updatedParams[paramKey] = newValue;
        }
      } catch (error) {
        logger.warn('ParameterSystem', `Failed to update parameter ${paramKey}:`, error);
      }
    });

    // Notify renderers of parameter updates
    if (Object.keys(updatedParams).length > 0) {
      this.notifyRenderers(updatedParams);
    }
  }

  /**
   * Notify renderers about parameter updates
   * @param {Object} updatedParams - Map of parameter names to new values
   */
  notifyRenderers(updatedParams) {
    for (const [rendererType, callback] of this.updateCallbacks) {
      try {
        // Filter parameters relevant to this renderer
        const relevantParams = {};

        for (const [paramKey, value] of Object.entries(updatedParams)) {
          const param = this.crossContextParams.get(paramKey);
          if (param && (param.routes.has(rendererType) || param.primaryRoute === rendererType)) {
            relevantParams[paramKey] = value;
          }
        }

        if (Object.keys(relevantParams).length > 0) {
          callback(relevantParams);
        }
      } catch (error) {
        logger.error('ParameterSystem', `Failed to notify ${rendererType} renderer:`, error);
      }
    }
  }

  /**
   * Helper methods
   */

  isParameterDefinition(node) {
    return ['LetBinding', 'Assignment', 'Direct'].includes(node.type) && node.name;
  }

  isParameterReference(node) {
    return ['Var', 'StrandAccess'].includes(node.type);
  }

  getParameterName(node) {
    if (node.name) return node.name;
    if (node.type === 'StrandAccess') {
      const baseName = node.base?.name || node.base;
      const outputName = node.out;
      return `${baseName}@${outputName}`;
    }
    return null;
  }

  selectPrimaryRoute(routes) {
    if (routes.has('cpu')) return 'cpu';
    if (routes.has('gpu')) return 'gpu';
    if (routes.has('audio')) return 'audio';
    return Array.from(routes)[0] || 'cpu';
  }

  traverseChildren(node, callback) {
    if (node.statements) {
      node.statements.forEach(callback);
    }
    if (node.args) {
      node.args.forEach(callback);
    }
    if (node.expr) {
      callback(node.expr);
    }
    if (node.left) {
      callback(node.left);
    }
    if (node.right) {
      callback(node.right);
    }
    if (node.condition) {
      callback(node.condition);
    }
    if (node.thenExpr) {
      callback(node.thenExpr);
    }
    if (node.elseExpr) {
      callback(node.elseExpr);
    }
  }

  /**
   * Simple expression evaluation for parameter updates
   * @param {Object} expr - Expression to evaluate
   * @returns {number} Evaluated value
   */
  evaluateParameterExpression(expr) {
    if (!expr) return 0;

    switch (expr.type) {
      case 'Num':
        return expr.v || 0;

      case 'StrandAccess':
        if (expr.base === 'me' || (expr.base?.name === 'me')) {
          return this.evaluateMeAccess(expr.out);
        }
        // For other strand access, return cached value or 0
        const paramKey = `${expr.base?.name || expr.base}@${expr.out}`;
        return this.parameterValues.get(paramKey) || 0;

      case 'Var':
        return this.parameterValues.get(expr.name) || 0;

      default:
        return 0;
    }
  }

  /**
   * Evaluate me@ access expressions
   * @param {string} field - Field name
   * @returns {number} Field value
   */
  evaluateMeAccess(field) {
    const currentTime = (Date.now() - this.env.startTime) / 1000;
    const visualFrame = Math.floor(currentTime * this.env.targetFps);

    switch (field) {
      case 'time':
        return (visualFrame % this.env.loop) / this.env.targetFps;
      case 'abstime':
        return currentTime;
      case 'frame':
        return visualFrame % this.env.loop;
      case 'absframe':
        return visualFrame;
      case 'width':
        return this.env.resW;
      case 'height':
        return this.env.resH;
      case 'fps':
        return this.env.targetFps;
      case 'loop':
        return this.env.loop;
      case 'bpm':
        return this.env.bpm;
      case 'timesig_num':
        return this.env.timesig_num;
      case 'timesig_den':
        return this.env.timesig_den;
      case 'x':
        return this.env.mouse?.x || 0.5;
      case 'y':
        return this.env.mouse?.y || 0.5;
      default:
        return 0;
    }
  }

  /**
   * Get current parameter values for a specific renderer
   * @param {string} rendererType - Renderer type
   * @returns {Object} Parameter values
   */
  getParametersForRenderer(rendererType) {
    const params = {};

    this.crossContextParams.forEach((param, paramKey) => {
      if (param.routes.has(rendererType) || param.primaryRoute === rendererType) {
        params[paramKey] = this.parameterValues.get(paramKey) || 0;
      }
    });

    return params;
  }

  /**
   * Get debugging information about the parameter system
   * @returns {Object} Debug info
   */
  getDebugInfo() {
    return {
      renderers: Array.from(this.renderers.keys()),
      crossContextParams: Array.from(this.crossContextParams.keys()),
      parameterValues: Object.fromEntries(this.parameterValues),
      running: this.running
    };
  }
}