import { logger } from '../utils/logger.js';
import { clamp, isNum } from '../utils/math.js';

/**
 * Shared expression compilation utilities
 */
export class ExpressionCompiler {
  constructor(rendererType) {
    this.rendererType = rendererType;
    this.instanceOutputs = {};
    this.localScope = {};
  }

  /**
   * Get variable value from instance outputs
   * @param {string} varName - Variable name
   * @returns {string|null} Variable reference
   */
  getVariable(varName) {
    return this.instanceOutputs[varName] || this.localScope[varName] || null;
  }

  /**
   * Set variable in local scope
   * @param {string} varName - Variable name
   * @param {string} value - Variable value/reference
   */
  setVariable(varName, value) {
    this.localScope[varName] = value;
    this.instanceOutputs[varName] = value;
  }

  /**
   * Get strand access variable
   * @param {string} baseName - Base instance name
   * @param {string} outputName - Output name
   * @returns {string|null} Variable reference
   */
  getStrandVariable(baseName, outputName) {
    const key = `${baseName}@${outputName}`;
    return this.instanceOutputs[key] || null;
  }

  /**
   * Set strand access variable
   * @param {string} baseName - Base instance name
   * @param {string} outputName - Output name
   * @param {string} value - Variable value/reference
   */
  setStrandVariable(baseName, outputName, value) {
    const key = `${baseName}@${outputName}`;
    this.instanceOutputs[key] = value;
  }

  /**
   * Clear all variables
   */
  clear() {
    this.instanceOutputs = {};
    this.localScope = {};
  }
}

/**
 * Cross-context parameter management
 */
export class CrossContextManager {
  constructor(env, rendererType) {
    this.env = env;
    this.rendererType = rendererType;
    this.crossContextParams = [];
    this.parameterValues = {};
  }

  /**
   * Collect cross-context parameters from tagged AST
   * @param {Object} ast - Tagged AST
   * @param {Set} usedInThisRenderer - Variables used in this renderer
   */
  collectCrossContextParams(ast, usedInThisRenderer) {
    this.crossContextParams = [];

    // Find variables defined elsewhere but used here
    const variableBindings = this.buildVariableBindings(ast);

    for (const [varName, binding] of variableBindings) {
      if (usedInThisRenderer.has(varName) && !this.isDefinedInRenderer(binding)) {
        this.crossContextParams.push({
          name: varName,
          statement: binding,
          outputs: this.getStatementOutputs(binding),
          type: 'statement'
        });
      }
    }

    if (ast.pragmas) {
      ast.pragmas.forEach(pragma => {
        if (['slider', 'color', 'xy', 'toggle'].includes(pragma.type) && pragma.config) {
          const instanceName = pragma.config.name;
          if (usedInThisRenderer.has(instanceName)) {
            pragma.config.strands.forEach(strand => {
              this.crossContextParams.push({
                name: instanceName,
                strand: strand,
                pragma: pragma,
                type: 'pragma'
              });
            });
          }
        }
      });
    }

    logger.debug(this.rendererType, `Found ${this.crossContextParams.length} cross-context parameters`);
  }

  /**
   * Build map of variable name to defining statement
   * @param {Object} ast - AST
   * @returns {Map} Variable bindings map
   */
  buildVariableBindings(ast) {
    const bindings = new Map();

    const traverse = (node) => {
      if (!node) return;

      if (['LetBinding', 'Assignment', 'Direct'].includes(node.type) && node.name) {
        bindings.set(node.name, node);
      }

      // Traverse children
      if (node.statements) {
        node.statements.forEach(stmt => traverse(stmt));
      }
      if (node.args) {
        node.args.forEach(arg => traverse(arg));
      }
      if (node.expr) {
        traverse(node.expr);
      }
    };

    traverse(ast);
    return bindings;
  }

  /**
   * Check if a statement is defined in this renderer's route
   * @param {Object} stmt - AST statement
   * @returns {boolean}
   */
  isDefinedInRenderer(stmt) {
    // This would check if the statement has the renderer's route
    // Implementation depends on specific renderer routes
    return false; // Default to treating as cross-context
  }

  /**
   * Get outputs from a statement
   * @param {Object} stmt - AST statement
   * @returns {Array} Output names
   */
  getStatementOutputs(stmt) {
    if (stmt.type === 'Direct') {
      return stmt.outs || [];
    }
    return [];
  }

  /**
   * Update cross-context parameter values
   */
  updateParameterValues() {
    const newValues = {};

    this.crossContextParams.forEach(param => {
      try {
        if (param.type === 'pragma') {
          const paramStrand = this.env.getParameterStrand(param.strand);
          if (paramStrand && paramStrand.value !== undefined) {
            newValues[`${param.name}_${param.strand}`] = paramStrand.value;
          }
        } else {
          const value = this.evaluateSimpleExpression(param.statement.expr);
          if (param.outputs && param.outputs.length > 0) {
            param.outputs.forEach(output => {
              newValues[`${param.name}_${output}`] = value;
            });
          } else {
            newValues[param.name] = value;
          }
        }
      } catch (error) {
        logger.warn(this.rendererType, `Failed to update parameter ${param.name}:`, error);
      }
    });

    this.parameterValues = newValues;
    return newValues;
  }

  /**
   * Simple expression evaluation for parameter updates
   * @param {Object} expr - Expression AST
   * @returns {number}
   */
  evaluateSimpleExpression(expr) {
    if (!expr) return 0;

    switch (expr.type) {
      case 'Num':
        return expr.v || 0;
      case 'Bin':
        const left = this.evaluateSimpleExpression(expr.left);
        const right = this.evaluateSimpleExpression(expr.right);
        switch (expr.op) {
          case '+': return left + right;
          case '-': return left - right;
          case '*': return left * right;
          case '/': return right !== 0 ? left / right : 0;
          case '^': return Math.pow(left, right);
          default: return 0;
        }
      case 'Unary':
        const operand = this.evaluateSimpleExpression(expr.expr);
        switch (expr.op) {
          case '-': return -operand;
          case 'NOT': return operand > 0 ? 0 : 1;
          default: return operand;
        }
      case 'Call':
        // Simple math functions only
        const args = expr.args.map(arg => this.evaluateSimpleExpression(arg));
        return this.evaluateFunction(expr.name, args);
      default:
        return 0;
    }
  }

  /**
   * Evaluate simple functions for cross-context parameters
   * @param {string} name - Function name
   * @param {Array} args - Arguments
   * @returns {number}
   */
  evaluateFunction(name, args) {
    switch (name) {
      case 'sin': return Math.sin(args[0] || 0);
      case 'cos': return Math.cos(args[0] || 0);
      case 'abs': return Math.abs(args[0] || 0);
      case 'sqrt': return Math.sqrt(Math.max(0, args[0] || 0));
      case 'floor': return Math.floor(args[0] || 0);
      case 'ceil': return Math.ceil(args[0] || 0);
      case 'round': return Math.round(args[0] || 0);
      case 'min': return args.length > 0 ? Math.min(...args) : 0;
      case 'max': return args.length > 0 ? Math.max(...args) : 0;
      case 'clamp':
        if (args.length >= 3) {
          return Math.max(args[1], Math.min(args[2], args[0]));
        } else {
          return Math.max(0, Math.min(1, args[0] || 0));
        }
      default:
        return 0;
    }
  }
}

/**
 * Visual dependency analyzer for audio expressions
 * Detects when audio expressions reference visual data that needs sampling
 */
export class VisualDependencyAnalyzer {
  constructor(env) {
    this.env = env;
    this.dependencies = [];
  }

  /**
   * Analyze an audio expression for visual dependencies
   * @param {Object} expr - Expression AST
   * @returns {Array} List of visual sampling dependencies
   */
  analyze(expr) {
    this.dependencies = [];
    this.traverse(expr);
    return this.dependencies;
  }

  /**
   * Traverse expression tree looking for StrandRemap of visual instances
   * @param {Object} node - AST node
   */
  traverse(node) {
    if (!node) return;

    // Check if this is a StrandRemap expression
    if (node.type === 'StrandRemap') {
      const baseName = node.base?.name || node.base;
      const strandName = node.strand?.name || node.strand;

      // Check if this references a visual instance (not audio, not me)
      if (baseName !== 'me' && this.isVisualInstance(baseName)) {
        // Extract coordinate expressions
        const coordinates = node.coordinates || [];

        this.dependencies.push({
          type: 'visual_sample',
          instance: baseName,
          strand: strandName,
          coordinateExprs: coordinates,
          node: node
        });
      }
    }

    // Recursively traverse all properties
    if (node.args) {
      node.args.forEach(arg => this.traverse(arg));
    }
    if (node.expr) {
      this.traverse(node.expr);
    }
    if (node.left) {
      this.traverse(node.left);
    }
    if (node.right) {
      this.traverse(node.right);
    }
    if (node.condition) {
      this.traverse(node.condition);
    }
    if (node.thenExpr) {
      this.traverse(node.thenExpr);
    }
    if (node.elseExpr) {
      this.traverse(node.elseExpr);
    }
    if (node.coordinates) {
      node.coordinates.forEach(coord => this.traverse(coord));
    }
  }

  /**
   * Check if an instance is a visual instance (loaded media or computed visual data)
   * @param {string} instanceName - Instance name
   * @returns {boolean}
   */
  isVisualInstance(instanceName) {
    const instance = this.env.instances.get(instanceName);
    if (!instance) return false;

    // Check if it's a loaded media instance
    if (instance.sampler) {
      const kind = instance.sampler.kind;
      return kind === 'image' || kind === 'video';
    }

    // Check if it has visual routes
    // (This would require route tagging to be complete)
    return true; // For now, assume non-me instances are visual
  }
}

/**
 * Media loading and sampling utilities
 */
export class MediaManager {
  constructor(env, rendererType) {
    this.env = env;
    this.rendererType = rendererType;
    this.loadedMedia = new Map();
  }

  /**
   * Process load statements and set up media access
   * @param {Array} statements - AST statements
   * @returns {Promise}
   */
  async processLoadStatements(statements) {
    for (const stmt of statements) {
      if (stmt.type === 'CallInstance' && stmt.callee === 'load') {
        const mediaPath = stmt.args[0]?.v;
        if (mediaPath) {
          await this.loadMedia(mediaPath, stmt.inst, stmt.outs);
        }
      }
    }

    // Also check for Direct statements that might be load calls
    for (const stmt of statements) {
      if (stmt.type === 'Direct' && stmt.expr?.type === 'Call' && stmt.expr.name === 'load') {
        const mediaPath = stmt.expr.args[0]?.v;
        if (mediaPath) {
          await this.loadMedia(mediaPath, stmt.inst, stmt.outs);
        }
      }
    }
  }

  /**
   * Load media file and create accessors
   * @param {string} path - Media file path
   * @param {string} instName - Instance name
   * @param {Array} outputs - Output specifications
   */
  async loadMedia(path, instName, outputs) {
    try {
      // Get or create sampler
      const instance = this.env.instances.get(instName);
      let sampler = instance?.sampler;

      if (!sampler) {
        const { Sampler } = await import('../runtime/media/sampler.js');
        sampler = new Sampler();
        await sampler.load(path);

        // Store in environment
        if (instance) {
          instance.sampler = sampler;
        }
      }

      this.loadedMedia.set(instName, sampler);

      // Create accessors for outputs
      this.createMediaAccessors(sampler, instName, outputs);

      logger.debug(this.rendererType, `Loaded media: ${path} as ${instName}`);
    } catch (error) {
      logger.error(this.rendererType, `Failed to load media ${path}:`, error);
    }
  }

  /**
   * Create media accessors based on media type and outputs
   * @param {Object} sampler - Media sampler
   * @param {string} instName - Instance name
   * @param {Array} outputs - Output specifications
   */
  createMediaAccessors(sampler, instName, outputs) {
    // Override in subclasses for renderer-specific media access
  }

  /**
   * Get loaded media sampler
   * @param {string} instName - Instance name
   * @returns {Object|null} Media sampler
   */
  getMediaSampler(instName) {
    return this.loadedMedia.get(instName) || null;
  }
}

/**
 * Performance monitoring utilities
 */
export class PerformanceMonitor {
  constructor(rendererType) {
    this.rendererType = rendererType;
    this.frameCount = 0;
    this.fpsAccumulator = 0;
    this.lastUpdate = performance.now();
    this.avgFrameTime = 0;
    this.maxFrameTime = 0;
    this.minFrameTime = Infinity;
  }

  /**
   * Record a frame render
   * @param {number} frameTime - Time to render frame in ms
   */
  recordFrame(frameTime) {
    this.frameCount++;
    this.avgFrameTime = (this.avgFrameTime * (this.frameCount - 1) + frameTime) / this.frameCount;
    this.maxFrameTime = Math.max(this.maxFrameTime, frameTime);
    this.minFrameTime = Math.min(this.minFrameTime, frameTime);
  }

  /**
   * Get performance statistics
   * @returns {Object} Performance stats
   */
  getStats() {
    return {
      frameCount: this.frameCount,
      avgFrameTime: this.avgFrameTime,
      maxFrameTime: this.maxFrameTime,
      minFrameTime: this.minFrameTime,
      fps: this.frameCount / ((performance.now() - this.lastUpdate) / 1000)
    };
  }

  /**
   * Reset statistics
   */
  reset() {
    this.frameCount = 0;
    this.avgFrameTime = 0;
    this.maxFrameTime = 0;
    this.minFrameTime = Infinity;
    this.lastUpdate = performance.now();
  }
}

/**
 * Utility functions for value clamping and validation
 */
export const ValueUtils = {
  /**
   * Clamp and validate a numeric value
   * @param {*} value - Input value
   * @param {number} min - Minimum value
   * @param {number} max - Maximum value
   * @returns {number} Clamped value
   */
  clampValue(value, min = 0, max = 1) {
    return clamp(isNum(value) ? value : 0, min, max);
  },

  /**
   * Validate RGB color values
   * @param {number} r - Red component
   * @param {number} g - Green component
   * @param {number} b - Blue component
   * @returns {Object} Validated RGB object
   */
  validateRGB(r, g, b) {
    return {
      r: this.clampValue(r),
      g: this.clampValue(g),
      b: this.clampValue(b)
    };
  },

  /**
   * Safe array access with bounds checking
   * @param {Array} array - Input array
   * @param {number} index - Index to access
   * @param {*} fallback - Fallback value
   * @returns {*} Array value or fallback
   */
  safeArrayAccess(array, index, fallback = 0) {
    if (!Array.isArray(array) || index < 0 || index >= array.length) {
      return fallback;
    }
    return array[index];
  }
};