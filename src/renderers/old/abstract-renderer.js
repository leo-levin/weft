// abstract-renderer.js — Base class for all WEFT renderers
import { logger } from '../../utils/logger.js';

/**
 * Abstract base class that defines the common interface and shared functionality
 * for all WEFT renderers (CPU, WebGL, Audio)
 */
class AbstractRenderer {
  constructor(env, rendererType) {
    this.env = env;
    this.rendererType = rendererType;
    this.running = false;
    this.frames = 0;
    this.fps = 0;
    this.avgMs = 0;

    // Timing state
    this.lastTime = performance.now();
    this.lastFrameTime = performance.now();
    this.frameTimeAccumulator = 0;
    this.frameAdvancementId = null;
    this.timingUpdateId = null;

    // Performance monitoring
    this.fpsAccumulator = 0;
    this.frameCount = 0;
    this.lastFpsUpdate = performance.now();

    // Route filtering
    this.supportedRoutes = new Set();
    this.filteredStatements = [];
    this.crossContextParams = [];

    // Parameters and instances
    this.instanceOutputs = {};

    // DOM elements for performance display
    this.domElements = {
      frameIndicator: document.getElementById('frameIndicator'),
      fpsPill: document.getElementById('fpsPill'),
      perfPill: document.getElementById('perfPill'),
      resPill: document.getElementById('resPill')
    };
  }

  // ===== Abstract methods that must be implemented by subclasses =====

  /**
   * Initialize renderer-specific resources
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    throw new Error('initialize() must be implemented by subclass');
  }

  /**
   * Compile AST for this renderer's route
   * @param {Object} ast - The tagged AST
   * @returns {Promise<boolean>} Compilation success
   */
  async compile(ast) {
    throw new Error('compile() must be implemented by subclass');
  }

  /**
   * Render a single frame
   */
  render() {
    throw new Error('render() must be implemented by subclass');
  }

  /**
   * Clean up renderer-specific resources
   */
  cleanup() {
    throw new Error('cleanup() must be implemented by subclass');
  }

  // ===== Shared interface methods =====

  /**
   * Start the renderer
   */
  async start() {
    if (this.running) return;

    try {
      logger.debug(this.rendererType, 'Starting renderer initialization');
      await this.initialize();
      logger.debug(this.rendererType, 'Initialization complete, starting main loop');
      this.running = true;
      this.startMainLoop();
      this.startPerformanceMonitoring();
      logger.info(this.rendererType, 'Renderer started successfully');
    } catch (error) {
      const errorDetails = {
        phase: 'initialization',
        message: error?.message || 'Unknown error',
        stack: error?.stack || 'No stack trace',
        name: error?.name || 'Error'
      };
      logger.error(this.rendererType, 'Failed to start renderer:', errorDetails);
      throw error;
    }
  }

  /**
   * Stop the renderer
   */
  stop() {
    if (!this.running) return;

    this.running = false;
    this.stopMainLoop();
    this.stopPerformanceMonitoring();
    this.cleanup();
    logger.info(this.rendererType, 'Renderer stopped');
  }

  /**
   * Update parameters from environment
   */
  updateParameters() {
    if (this.env.parameters) {
      for (const [paramName, paramStrand] of this.env.parameters) {
        this.onParameterUpdate(paramName, paramStrand.value);
      }
    }
  }

  /**
   * Update timing parameters
   */
  updateTiming() {
    // Update any timing-dependent state
    this.onTimingUpdate();
  }

  // ===== Shared implementation methods =====

  /**
   * Filter AST statements by supported routes
   * @param {Object} ast - Tagged AST
   */
  filterStatements(ast) {
    this.filteredStatements = [];

    if (!ast || !ast.statements) {
      return;
    }

    for (const stmt of ast.statements) {
      if (this.shouldProcessStatement(stmt)) {
        this.filteredStatements.push(stmt);
      }
    }

    logger.debug(this.rendererType, `Filtered ${this.filteredStatements.length} statements for processing`);
  }

  /**
   * Check if a statement should be processed by this renderer
   * @param {Object} stmt - AST statement
   * @returns {boolean}
   */
  shouldProcessStatement(stmt) {
    // Check if statement has any of our supported routes
    if (stmt.routes) {
      for (const route of this.supportedRoutes) {
        if (stmt.routes.has(route)) {
          return true;
        }
      }
    }

    // Check primary route
    if (stmt.primaryRoute && this.supportedRoutes.has(stmt.primaryRoute)) {
      return true;
    }

    // Check statement type for route-specific outputs
    if (stmt.type === 'RenderStmt' || stmt.type === 'DisplayStmt') {
      return this.supportedRoutes.has('gpu') || this.supportedRoutes.has('cpu');
    }

    if (stmt.type === 'PlayStmt') {
      return this.supportedRoutes.has('audio');
    }

    return false;
  }

  /**
   * Main rendering loop with frame rate control
   * Note: Only visual renderers (CPU, WebGL) should run animation loops
   * Audio renderer runs on audio callback timing
   */
  startMainLoop() {
    // Audio renderers don't need visual frame loops
    if (this.rendererType === 'Audio') {
      return;
    }

    if (this.frameAdvancementId) {
      cancelAnimationFrame(this.frameAdvancementId);
    }

    const loop = () => {
      if (!this.running) return;

      const now = performance.now();
      const targetFrameTime = 1000 / this.env.targetFps;
      const deltaTime = now - this.lastFrameTime;

      this.frameTimeAccumulator += deltaTime;

      // Only render if enough time has accumulated for the target frame rate
      if (this.frameTimeAccumulator >= targetFrameTime) {
        const startTime = performance.now();

        try {
          this.render();
          this.updateFrameIndicator();
          this.frames++;

          // Only primary renderer advances the global frame counter
          if (this.isPrimaryFrameCounter) {
            this.env.frame++;
          }
        } catch (error) {
          logger.error(this.rendererType, 'Render error:', error);
        }

        const endTime = performance.now();
        this.updatePerformanceStats(endTime - startTime);

        // Subtract one frame time but keep remainder to prevent drift
        this.frameTimeAccumulator -= targetFrameTime;
      }

      this.lastFrameTime = now;
      this.frameAdvancementId = requestAnimationFrame(loop);
    };

    this.frameAdvancementId = requestAnimationFrame(loop);
  }

  /**
   * Stop the main rendering loop
   */
  stopMainLoop() {
    if (this.frameAdvancementId) {
      cancelAnimationFrame(this.frameAdvancementId);
      this.frameAdvancementId = null;
    }
  }

  /**
   * Start performance monitoring updates
   */
  startPerformanceMonitoring() {
    if (this.timingUpdateId) {
      clearInterval(this.timingUpdateId);
    }

    this.timingUpdateId = setInterval(() => {
      if (this.running) {
        this.updateTiming();
        this.updateParameters();
      }
    }, 100); // Update 10 times per second
  }

  /**
   * Stop performance monitoring
   */
  stopPerformanceMonitoring() {
    if (this.timingUpdateId) {
      clearInterval(this.timingUpdateId);
      this.timingUpdateId = null;
    }
  }

  /**
   * Update frame indicator animation
   */
  updateFrameIndicator() {
    if (this.domElements.frameIndicator) {
      this.domElements.frameIndicator.classList.add('active');
      setTimeout(() => this.domElements.frameIndicator.classList.remove('active'), 50);
    }
  }

  /**
   * Update performance statistics
   * @param {number} frameTime - Time to render this frame in ms
   */
  updatePerformanceStats(frameTime) {
    const now = performance.now();
    this.fpsAccumulator += (now - this.lastTime);
    this.lastTime = now;
    this.frameCount++;

    if (this.fpsAccumulator > 500) { // Update every 500ms
      this.fps = Math.round(1000 * this.frameCount / this.fpsAccumulator);
      this.avgMs = Math.round(frameTime);

      // Update DOM elements
      if (this.domElements.fpsPill) {
        this.domElements.fpsPill.textContent = `FPS: ${this.fps}`;
      }
      if (this.domElements.perfPill) {
        this.domElements.perfPill.textContent = this.getPerformanceLabel();
      }

      this.fpsAccumulator = 0;
      this.frameCount = 0;
    }
  }

  /**
   * Get performance label for this renderer
   * @returns {string}
   */
  getPerformanceLabel() {
    return `${this.rendererType}: ${this.avgMs} ms`;
  }

  /**
   * Update resolution display
   */
  updateResolutionDisplay() {
    if (this.domElements.resPill) {
      this.domElements.resPill.textContent = `Res: ${this.env.resW}×${this.env.resH}`;
    }
  }

  // ===== Hooks for subclass customization =====

  /**
   * Called when a parameter is updated
   * @param {string} paramName - Parameter name
   * @param {*} value - Parameter value
   */
  onParameterUpdate(paramName, value) {
    // Override in subclasses
  }

  /**
   * Called when timing parameters are updated
   */
  onTimingUpdate() {
    // Override in subclasses
  }

  /**
   * Get the current time for animations
   * @returns {number} Current time in seconds
   */
  time() {
    return (this.env.frame % this.env.loop) / this.env.targetFps;
  }

  /**
   * Get absolute time since program start
   * @returns {number} Absolute time in seconds
   */
  absTime() {
    return (Date.now() - this.env.startTime) / 1000;
  }
}

export { AbstractRenderer };