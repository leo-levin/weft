// renderer-manager.js — Coordinates multiple WEFT renderers
import { logger } from '../../utils/logger.js';
import { UnifiedParameterSystem } from './parameter-system.js';
import { tagExpressionRoutes } from '../../lang/tagging.js';
import { VisualDependencyAnalyzer } from '../shared-utils.js';
import { compileExpr } from '../../compilers/js-compiler.js';

/**
 * Manages and coordinates multiple WEFT renderers (CPU, WebGL, Audio)
 * Handles route-based rendering, parameter sharing, and lifecycle management
 */
export class RendererManager {
  constructor(env) {
    this.env = env;
    this.renderers = new Map(); // renderer type -> renderer instance
    this.activeRenderers = new Set(); // currently active renderer types

    // Unified parameter system for cross-renderer communication
    this.parameterSystem = new UnifiedParameterSystem(env);

    // Compilation and routing state
    this.currentAST = null;
    this.availableRoutes = new Set(); // routes available in current AST

    // Cross-context sampling system
    this.visualDependencyAnalyzer = new VisualDependencyAnalyzer(env);
    this.visualSamplers = []; // Array of {coordFns, samplerFn, paramName}
    this.samplingUpdateInterval = null;

    // Performance monitoring
    this.performanceStats = {
      totalFrames: 0,
      startTime: performance.now(),
      lastStatsUpdate: performance.now()
    };

    logger.info('RendererManager', 'Renderer Manager initialized');
  }

  /**
   * Register a renderer with the manager
   * @param {string} rendererType - Type of renderer (cpu, webgl, audio)
   * @param {AbstractRenderer} renderer - Renderer instance
   */
  registerRenderer(rendererType, renderer) {
    if (this.renderers.has(rendererType)) {
      logger.warn('RendererManager', `Renderer ${rendererType} already registered, replacing`);
      this.unregisterRenderer(rendererType);
    }

    this.renderers.set(rendererType, renderer);

    // Register with parameter system
    this.parameterSystem.registerRenderer(
      rendererType,
      renderer,
      (params) => this.onParameterUpdate(rendererType, params)
    );

    logger.info('RendererManager', `Registered ${rendererType} renderer`);
  }

  /**
   * Unregister a renderer
   * @param {string} rendererType - Type of renderer
   */
  unregisterRenderer(rendererType) {
    const renderer = this.renderers.get(rendererType);
    if (renderer) {
      if (this.activeRenderers.has(rendererType)) {
        renderer.stop();
        this.activeRenderers.delete(rendererType);
      }
      this.renderers.delete(rendererType);
      this.parameterSystem.unregisterRenderer(rendererType);
      logger.info('RendererManager', `Unregistered ${rendererType} renderer`);
    }
  }

  /**
   * Compile and prepare renderers for the given AST
   * @param {Object} ast - WEFT AST to compile
   * @returns {Promise<boolean>} Compilation success
   */
  async compile(ast) {
    try {
      logger.info('RendererManager', 'Starting compilation for all renderers');

      // Tag the AST with route information
      const taggedAST = tagExpressionRoutes(ast);
      this.currentAST = taggedAST;

      // Analyze available routes
      this.analyzeAvailableRoutes(taggedAST);

      // Setup parameter system for this AST
      try {
        this.parameterSystem.analyzeParameterRoutes(taggedAST);
        logger.debug('RendererManager', 'Parameter system analysis completed');
      } catch (error) {
        logger.error('RendererManager', 'Parameter system analysis failed:', error);
        // Continue with compilation even if parameter analysis fails
      }

      // Pre-process shared resources (media loading, etc.)
      await this.loadSharedResources(taggedAST);

      // Compile each registered renderer that has relevant routes
      const compilationPromises = [];

      for (const [rendererType, renderer] of this.renderers) {
        logger.debug('RendererManager', `Checking renderer ${rendererType}, shouldCompile: ${this.shouldCompileRenderer(rendererType)}`);

        if (this.shouldCompileRenderer(rendererType)) {
          logger.info('RendererManager', `Compiling ${rendererType} renderer`);

          // Ensure compile result is a promise
          const compileResultPromise = Promise.resolve(renderer.compile(taggedAST));
          logger.debug('RendererManager', `${rendererType} compile initiated`);

          compilationPromises.push(
            compileResultPromise.then(success => {
              logger.debug('RendererManager', `${rendererType} compilation result: ${success}`);
              return {
                rendererType,
                success
              };
            }).catch(error => {
              logger.error('RendererManager', `${rendererType} compilation threw error:`, error);
              return {
                rendererType,
                success: false,
                error
              };
            })
          );
        } else {
          logger.debug('RendererManager', `Skipping ${rendererType} renderer - no relevant routes`);
        }
      }

      logger.debug('RendererManager', `Created ${compilationPromises.length} compilation promises`);

      if (compilationPromises.length === 0) {
        logger.warn('RendererManager', 'No renderers to compile - this may indicate no routes were found or no renderers support the available routes');
        return false;
      }

      // Wait for all compilations to complete
      logger.debug('RendererManager', 'Waiting for compilation promises to resolve...');
      const results = await Promise.all(compilationPromises);
      logger.debug('RendererManager', 'All compilation promises resolved');

      // Check compilation results
      let allSuccessful = true;
      const successfulRenderers = [];

      for (const result of results) {
        const { rendererType, success, error } = result;
        if (success) {
          successfulRenderers.push(rendererType);
          logger.info('RendererManager', `${rendererType} compilation successful`);
        } else {
          allSuccessful = false;
          if (error) {
            logger.error('RendererManager', `${rendererType} compilation failed:`, error);
          } else {
            logger.error('RendererManager', `${rendererType} compilation failed`);
          }
        }
      }

      // Update active renderers based on successful compilation
      this.updateActiveRenderers(successfulRenderers);

      logger.info('RendererManager',
        `Compilation complete. Active renderers: ${Array.from(this.activeRenderers).join(', ')}`
      );

      return allSuccessful;
    } catch (error) {
      logger.error('RendererManager', 'Compilation failed with exception:', {
        message: error?.message || 'Unknown error',
        stack: error?.stack,
        error: error
      });
      return false;
    }
  }

  /**
   * Start all active renderers
   * @returns {Promise<boolean>} Start success
   */
  async start() {
    try {
      logger.info('RendererManager', 'Starting all active renderers');

      const startPromises = [];

      // Determine which renderer should be the primary frame counter
      // Priority: WebGL > CPU > Audio
      let primaryRenderer = null;
      for (const type of ['webgl', 'cpu', 'audio']) {
        if (this.activeRenderers.has(type)) {
          primaryRenderer = type;
          break;
        }
      }

      for (const rendererType of this.activeRenderers) {
        const renderer = this.renderers.get(rendererType);
        if (renderer) {
          // Set frame counter responsibility
          renderer.isPrimaryFrameCounter = (rendererType === primaryRenderer);

          logger.info('RendererManager', `Starting ${rendererType} renderer${renderer.isPrimaryFrameCounter ? ' (primary frame counter)' : ''}`);
          startPromises.push(
            renderer.start().then(() => ({
              rendererType,
              success: true
            })).catch(error => ({
              rendererType,
              success: false,
              error
            }))
          );
        }
      }

      const results = await Promise.all(startPromises);

      // Check start results
      let allSuccessful = true;

      for (const result of results) {
        if (result.success) {
          logger.info('RendererManager', `${result.rendererType} started successfully`);
        } else {
          allSuccessful = false;
          const errorDetails = {
            renderer: result.rendererType,
            message: result.error?.message || 'Unknown error',
            stack: result.error?.stack || 'No stack trace',
            name: result.error?.name || 'Error',
            errorObject: result.error
          };
          logger.error('RendererManager', `${result.rendererType} start failed:`, errorDetails);
          this.activeRenderers.delete(result.rendererType);
        }
      }

      // Start parameter system if any renderers are active
      if (this.activeRenderers.size > 0) {
        this.parameterSystem.start();
        this.startPerformanceMonitoring();
      }

      logger.info('RendererManager',
        `Start complete. Running renderers: ${Array.from(this.activeRenderers).join(', ')}`
      );

      return allSuccessful;
    } catch (error) {
      logger.error('RendererManager', 'Start failed:', error);
      return false;
    }
  }

  /**
   * Stop all active renderers
   */
  stop() {
    logger.info('RendererManager', 'Stopping all renderers');

    // Stop visual sampling
    this.stopVisualSampling();

    // Stop parameter system
    this.parameterSystem.stop();
    this.stopPerformanceMonitoring();

    // Stop all renderers
    for (const rendererType of this.activeRenderers) {
      const renderer = this.renderers.get(rendererType);
      if (renderer) {
        try {
          renderer.stop();
          logger.info('RendererManager', `${rendererType} renderer stopped`);
        } catch (error) {
          logger.error('RendererManager', `Error stopping ${rendererType} renderer:`, error);
        }
      }
    }

    this.activeRenderers.clear();
    logger.info('RendererManager', 'All renderers stopped');
  }

  /**
   * Update parameters in all active renderers
   */
  updateParameters() {
    // The parameter system handles this automatically
    this.parameterSystem.updateAllParameters();
  }

  /**
   * Get status of all renderers
   * @returns {Object} Renderer status information
   */
  getStatus() {
    const status = {
      registered: Array.from(this.renderers.keys()),
      active: Array.from(this.activeRenderers),
      availableRoutes: Array.from(this.availableRoutes),
      parameterSystem: this.parameterSystem.getDebugInfo(),
      performance: this.getPerformanceStats(),
      visualSamplers: this.visualSamplers.length
    };

    // Add individual renderer status
    status.renderers = {};
    for (const [type, renderer] of this.renderers) {
      status.renderers[type] = {
        running: renderer.running,
        fps: renderer.fps || 0,
        frames: renderer.frames || 0
      };
    }

    return status;
  }

  /**
   * Setup visual sampling for audio expressions
   * Analyzes audio expressions and creates samplers for visual data dependencies
   * @param {Object} audioExpr - Audio expression AST
   * @returns {Object} {paramNames: Array, dependencyMap: Map}
   */
  setupVisualSamplingForAudio(audioExpr) {
    if (!audioExpr) return { paramNames: [], dependencyMap: new Map() };

    // Analyze audio expression for visual dependencies
    const dependencies = this.visualDependencyAnalyzer.analyze(audioExpr);

    if (dependencies.length === 0) {
      logger.debug('RendererManager', 'No visual dependencies found in audio expression');
      return { paramNames: [], dependencyMap: new Map() };
    }

    logger.info('RendererManager', `Found ${dependencies.length} visual dependencies in audio`);

    // Clear existing samplers
    this.visualSamplers = [];
    const samplerParamNames = [];
    const dependencyMap = new Map();

    // Create a sampler for each dependency
    for (let i = 0; i < dependencies.length; i++) {
      const dep = dependencies[i];
      const paramName = `__sampled_${dep.instance}_${dep.strand}_${i}`;

      try {
        // Compile coordinate expression functions
        const meInstance = this.env.instances.get('me');
        const coordFns = dep.coordinateExprs.map(coordExpr => {
          try {
            return compileExpr(coordExpr, this.env);
          } catch (error) {
            logger.error('RendererManager', `Failed to compile coordinate expression:`, error);
            return () => 0;
          }
        });

        // Create sampler function
        const samplerFn = () => {
          // Evaluate coordinates
          const x = coordFns[0] ? coordFns[0](meInstance, this.env) : 0;
          const y = coordFns[1] ? coordFns[1](meInstance, this.env) : 0;

          // Determine channel from strand name
          const channelMap = { r: 0, red: 0, g: 1, green: 1, b: 2, blue: 2, a: 3, alpha: 3 };
          const channel = channelMap[dep.strand.toLowerCase()] || 0;

          // Sample from visual renderer
          return this.sampleFromVisualRenderer(x, y, channel);
        };

        this.visualSamplers.push({
          coordFns,
          samplerFn,
          paramName,
          dependency: dep
        });

        samplerParamNames.push(paramName);

        // Create key for dependency lookup (instance@strand)
        const depKey = `${dep.instance}@${dep.strand}`;
        dependencyMap.set(depKey, paramName);

        logger.info('RendererManager',
          `Created sampler: ${paramName} for ${depKey}`
        );
      } catch (error) {
        logger.error('RendererManager', `Failed to create sampler for ${dep.instance}@${dep.strand}:`, error);
      }
    }

    return { paramNames: samplerParamNames, dependencyMap };
  }

  /**
   * Sample pixel value from active visual renderer
   * @param {number} x - Normalized X coordinate
   * @param {number} y - Normalized Y coordinate
   * @param {number} channel - Channel index (0=r, 1=g, 2=b)
   * @returns {number} Sampled value [0,1]
   */
  sampleFromVisualRenderer(x, y, channel) {
    // Try WebGL renderer first (preferred)
    const webglRenderer = this.renderers.get('webgl');
    if (webglRenderer && this.activeRenderers.has('webgl') && webglRenderer.samplePixel) {
      return webglRenderer.samplePixel(x, y, channel);
    }

    // Fall back to CPU renderer
    const cpuRenderer = this.renderers.get('cpu');
    if (cpuRenderer && this.activeRenderers.has('cpu') && cpuRenderer.samplePixel) {
      return cpuRenderer.samplePixel(x, y, channel);
    }

    // No visual renderer available
    return 0;
  }

  /**
   * Update sampled values and send to audio renderer
   * Called on each frame to keep audio in sync with visual data
   */
  updateVisualSampling() {
    if (this.visualSamplers.length === 0) return;

    const audioRenderer = this.renderers.get('audio');
    if (!audioRenderer || !this.activeRenderers.has('audio')) return;

    // Sample all values
    const sampledParams = {};
    for (const sampler of this.visualSamplers) {
      try {
        const value = sampler.samplerFn();
        sampledParams[sampler.paramName] = value;
      } catch (error) {
        logger.warn('RendererManager', `Sampling error for ${sampler.paramName}:`, error);
        sampledParams[sampler.paramName] = 0;
      }
    }

    // Send to audio worklet via cross-context update
    if (audioRenderer.workletNode && audioRenderer.workletNode.port) {
      audioRenderer.workletNode.port.postMessage({
        type: 'updateCrossContext',
        params: sampledParams
      });
    }
  }

  /**
   * Start periodic visual sampling updates
   */
  startVisualSampling() {
    if (this.visualSamplers.length === 0) return;

    if (this.samplingUpdateInterval) {
      clearInterval(this.samplingUpdateInterval);
    }

    // Update at 60fps for smooth audio-visual coupling
    this.samplingUpdateInterval = setInterval(() => {
      this.updateVisualSampling();
    }, 16); // ~60fps

    logger.info('RendererManager', 'Started visual sampling updates');
  }

  /**
   * Stop periodic visual sampling updates
   */
  stopVisualSampling() {
    if (this.samplingUpdateInterval) {
      clearInterval(this.samplingUpdateInterval);
      this.samplingUpdateInterval = null;
      logger.info('RendererManager', 'Stopped visual sampling updates');
    }
  }

  // ===== Private methods =====

  /**
   * Load shared resources that all renderers can use
   * @param {Object} ast - Tagged AST
   */
  async loadSharedResources(ast) {
    try {
      // Find load statements in the AST
      const loadStatements = [];
      const traverse = (node) => {
        if (!node) return;

        if (node.type === 'Direct' && node.expr?.type === 'Call' && node.expr.name === 'load') {
          loadStatements.push({
            type: 'CallInstance',
            callee: 'load',
            inst: node.inst,
            outs: node.outs,
            args: node.expr.args
          });
        }

        if (node.statements) node.statements.forEach(traverse);
        if (node.args) node.args.forEach(traverse);
        if (node.expr) traverse(node.expr);
      };

      traverse(ast);

      if (loadStatements.length > 0) {
        logger.info('RendererManager', `Loading ${loadStatements.length} shared media resources`);

        // Use the first registered renderer's media manager to load resources
        // All renderers can then access the loaded media from the environment
        for (const renderer of this.renderers.values()) {
          if (renderer.mediaManager) {
            await renderer.mediaManager.processLoadStatements(loadStatements);
            break;
          }
        }
      }
    } catch (error) {
      logger.error('RendererManager', 'Failed to load shared resources:', error);
      // Continue even if media loading fails
    }
  }

  /**
   * Analyze which routes are available in the AST
   * @param {Object} ast - Tagged AST
   */
  analyzeAvailableRoutes(ast) {
    this.availableRoutes.clear();

    const traverse = (node) => {
      if (!node) return;

      // Check for route information
      if (node.routes) {
        node.routes.forEach(route => this.availableRoutes.add(route));
      }
      if (node.primaryRoute) {
        this.availableRoutes.add(node.primaryRoute);
      }

      // Check statement types for implicit routes
      if (node.type === 'RenderStmt' || node.type === 'DisplayStmt') {
        this.availableRoutes.add('gpu'); // Prefer GPU for visual output
      } else if (node.type === 'PlayStmt') {
        this.availableRoutes.add('audio');
      } else if (node.type === 'ComputeStmt') {
        this.availableRoutes.add('cpu');
      }

      // Traverse children
      if (node.statements) {
        node.statements.forEach(traverse);
      }
      if (node.args) {
        node.args.forEach(traverse);
      }
      if (node.expr) {
        traverse(node.expr);
      }
    };

    traverse(ast);

    logger.info('RendererManager', `Available routes: ${Array.from(this.availableRoutes).join(', ')}`);

    // Log renderer capabilities for debugging
    for (const [rendererType, renderer] of this.renderers) {
      const supportedRoutes = renderer.supportedRoutes ? Array.from(renderer.supportedRoutes) : ['none'];
      logger.info('RendererManager', `${rendererType} renderer supports routes: ${supportedRoutes.join(', ')}`);
    }
  }

  /**
   * Determine if a renderer should be compiled for the current AST
   * @param {string} rendererType - Renderer type
   * @returns {boolean}
   */
  shouldCompileRenderer(rendererType) {
    const renderer = this.renderers.get(rendererType);
    if (!renderer) {
      logger.debug('RendererManager', `No renderer found for type: ${rendererType}`);
      return false;
    }

    if (!renderer.supportedRoutes) {
      logger.debug('RendererManager', `${rendererType} renderer has no supportedRoutes property`);
      return false;
    }

    // Check if renderer supports any of the available routes
    for (const route of this.availableRoutes) {
      if (renderer.supportedRoutes.has(route)) {
        logger.debug('RendererManager', `${rendererType} supports route '${route}'`);
        return true;
      }
    }

    logger.debug('RendererManager', `${rendererType} doesn't support any available routes`);
    return false;
  }

  /**
   * Update the set of active renderers based on compilation results
   * @param {Array} successfulRenderers - List of successfully compiled renderers
   */
  updateActiveRenderers(successfulRenderers) {
    // Stop renderers that are no longer needed
    for (const rendererType of this.activeRenderers) {
      if (!successfulRenderers.includes(rendererType)) {
        const renderer = this.renderers.get(rendererType);
        if (renderer && renderer.running) {
          renderer.stop();
        }
      }
    }

    // Update active set with conflict resolution
    this.activeRenderers.clear();

    // Handle visual renderer conflict - only one can be active (WebGL or CPU)
    const hasWebGL = successfulRenderers.includes('webgl');
    const hasCPU = successfulRenderers.includes('cpu');

    if (hasWebGL && hasCPU) {
      // Prefer WebGL over CPU for performance
      logger.info('RendererManager', 'Both WebGL and CPU compiled - using WebGL for visual rendering');
      this.activeRenderers.add('webgl');
      // Don't add CPU when WebGL is available
    } else if (hasWebGL) {
      this.activeRenderers.add('webgl');
    } else if (hasCPU) {
      this.activeRenderers.add('cpu');
    }

    // Audio renderer can always be active alongside visual renderers
    if (successfulRenderers.includes('audio')) {
      this.activeRenderers.add('audio');
    }
  }

  /**
   * Handle parameter updates for a specific renderer
   * @param {string} rendererType - Renderer type
   * @param {Object} params - Updated parameters
   */
  onParameterUpdate(rendererType, params) {
    const renderer = this.renderers.get(rendererType);
    if (renderer && renderer.running) {
      // Forward parameters to renderer
      for (const [paramName, value] of Object.entries(params)) {
        renderer.onParameterUpdate(paramName, value);
      }
    }
  }

  /**
   * Start performance monitoring
   */
  startPerformanceMonitoring() {
    this.performanceStats.startTime = performance.now();
    this.performanceStats.totalFrames = 0;
    this.performanceStats.lastStatsUpdate = performance.now();

    // Update stats periodically
    this.performanceTimer = setInterval(() => {
      this.updatePerformanceStats();
    }, 1000); // Update every second
  }

  /**
   * Stop performance monitoring
   */
  stopPerformanceMonitoring() {
    if (this.performanceTimer) {
      clearInterval(this.performanceTimer);
      this.performanceTimer = null;
    }
  }

  /**
   * Update performance statistics
   */
  updatePerformanceStats() {
    const now = performance.now();
    const elapsed = now - this.performanceStats.lastStatsUpdate;

    // Collect frame counts from active renderers
    let totalFrames = 0;
    for (const rendererType of this.activeRenderers) {
      const renderer = this.renderers.get(rendererType);
      if (renderer && renderer.frames) {
        totalFrames += renderer.frames;
      }
    }

    this.performanceStats.totalFrames = totalFrames;
    this.performanceStats.lastStatsUpdate = now;
  }

  /**
   * Get performance statistics
   * @returns {Object} Performance data
   */
  getPerformanceStats() {
    const now = performance.now();
    const totalTime = now - this.performanceStats.startTime;

    return {
      totalFrames: this.performanceStats.totalFrames,
      totalTimeMs: totalTime,
      averageFps: this.performanceStats.totalFrames / (totalTime / 1000),
      activeRenderers: this.activeRenderers.size
    };
  }

  /**
   * Get a specific renderer by type
   * @param {string} rendererType - Renderer type
   * @returns {AbstractRenderer|null}
   */
  getRenderer(rendererType) {
    return this.renderers.get(rendererType) || null;
  }

  /**
   * Check if a renderer is currently active
   * @param {string} rendererType - Renderer type
   * @returns {boolean}
   */
  isRendererActive(rendererType) {
    return this.activeRenderers.has(rendererType);
  }

  /**
   * Get debug information
   * @returns {Object} Debug info
   */
  getDebugInfo() {
    return {
      renderers: Object.fromEntries(
        Array.from(this.renderers.entries()).map(([type, renderer]) => [
          type, {
            registered: true,
            active: this.activeRenderers.has(type),
            running: renderer.running,
            supportedRoutes: Array.from(renderer.supportedRoutes || [])
          }
        ])
      ),
      availableRoutes: Array.from(this.availableRoutes),
      parameterSystem: this.parameterSystem.getDebugInfo(),
      performance: this.getPerformanceStats()
    };
  }
}