// renderer.js — CPU renderer extending AbstractRenderer
import { clamp, isNum } from '../../utils/math.js';
import { AbstractRenderer } from './abstract-renderer.js';
import { CrossContextManager, MediaManager, ValueUtils } from '../shared-utils.js';
import { logger } from '../../utils/logger.js';
import { compile, compileExpr } from '../../compilers/js-compiler.js';

class Renderer extends AbstractRenderer {
  constructor(canvas, env) {
    super(env, 'CPU');

    // Canvas-specific properties
    this.canvas = canvas;
    this.ctx = null; // Delay context creation to avoid conflicts with WebGL
    this.offscreenCanvas = document.createElement('canvas');
    this.offscreenCanvas.width = env.resW;
    this.offscreenCanvas.height = env.resH;
    this.offCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true });
    this.imageData = this.offCtx.createImageData(env.resW, env.resH);

    // Resolution tracking
    this.lastResW = env.resW;
    this.lastResH = env.resH;

    // Set supported routes
    this.supportedRoutes.add('cpu');
    this.supportedRoutes.add('gpu'); // CPU can also handle GPU routes as fallback

    // Initialize shared utilities
    this.crossContextManager = new CrossContextManager(env, 'CPU');
    this.mediaManager = new MediaManager(env, 'CPU');

    // Error handling for offscreen canvas only (main context created later)
    if (!this.offCtx) {
      throw new Error('Failed to get offscreen 2D rendering context');
    }

    logger.info('CPU', 'CPU Renderer initialized');
  }
  // ===== Implementation of abstract methods =====

  /**
   * Initialize CPU renderer resources
   */
  async initialize() {
    // Get the main canvas 2D context now that we're sure WebGL isn't using it
    if (!this.ctx) {
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      if (!this.ctx) {
        throw new Error('Failed to get main 2D rendering context');
      }
    }

    this.setupCanvas();
    return true;
  }

  /**
   * Compile AST for CPU rendering
   */
  async compile(ast) {
    try {
      this.filterStatements(ast);
      await this.mediaManager.processLoadStatements(this.filteredStatements);

      // Collect cross-context parameters
      const usedVars = this.findUsedVariables(this.filteredStatements);
      this.crossContextManager.collectCrossContextParams(ast, usedVars);

      // Compile display statements into display functions
      this.compileDisplayStatements(ast);

      logger.info('CPU', 'Compilation completed successfully');
      return true;
    } catch (error) {
      logger.error('CPU', 'Compilation failed:', error);
      return false;
    }
  }

  /**
   * Render a single frame using CPU
   */
  render() {
    this.checkResolution();
    this.updateAudioIntensity();

    if (!this.displayFunctions) {
      this.clearCanvas();
      return;
    }

    this.renderPixels();
    this.displayFrame();
  }

  /**
   * Clean up CPU renderer resources
   */
  cleanup() {
    // Canvas cleanup is automatic
    logger.debug('CPU', 'CPU renderer cleanup complete');
  }

  // ===== CPU-specific implementation methods =====

  /**
   * Setup canvas and image data
   */
  setupCanvas() {
    const W = this.env.resW;
    const H = this.env.resH;

    this.offscreenCanvas.width = W;
    this.offscreenCanvas.height = H;
    this.imageData = this.offCtx.createImageData(W, H);
    this.lastResW = W;
    this.lastResH = H;

    this.updateResolutionDisplay();
    logger.debug('CPU', `Canvas initialized: ${W}×${H}`);
  }

  /**
   * Check if resolution has changed and update canvas
   */
  checkResolution() {
    if (this.env.resW !== this.lastResW || this.env.resH !== this.lastResH) {
      this.setupCanvas();
    }
  }

  /**
   * Update audio intensity for visualization
   */
  updateAudioIntensity() {
    if (this.env.defaultSampler) {
      this.env.defaultSampler.updateFrame();
    }

    if (this.env.audio.analyser) {
      const buf = new Uint8Array(this.env.audio.analyser.frequencyBinCount);
      this.env.audio.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      this.env.audio.intensity = Math.sqrt(sum / buf.length);
    } else {
      // Fallback audio intensity simulation
      this.env.audio.intensity = (Math.sin(this.time() * 0.8) * 0.5 + 0.5) * 0.5;
    }
  }

  /**
   * Clear the canvas to black
   */
  clearCanvas() {
    const data = this.imageData.data;
    data.fill(0);
    for (let i = 3; i < data.length; i += 4) {
      data[i] = 255; // Alpha channel
    }
  }

  /**
   * Render all pixels using precompiled functions
   */
  renderPixels() {
    const W = this.env.resW;
    const H = this.env.resH;
    const data = this.imageData.data;
    const [rFn, gFn, bFn] = this.displayFunctions;

    // Get the 'me' instance
    const meInstance = this.env.instances.get('me');
    if (!meInstance) {
      logger.error('CPU', 'No "me" instance found');
      this.clearCanvas();
      return;
    }

    try {
      for (let y = 0; y < H; y++) {
        const ny = (y + 0.5) / H;
        for (let x = 0; x < W; x++) {
          const nx = (x + 0.5) / W;

          // Update the 'me' instance with current pixel coordinates
          meInstance.x = nx;
          meInstance.y = ny;

          let r = 0, g = 0, b = 0;

          try {
            // Call precompiled functions with me instance and environment
            r = rFn ? rFn(meInstance, this.env) : 0;
            g = gFn ? gFn(meInstance, this.env) : 0;
            b = bFn ? bFn(meInstance, this.env) : 0;
          } catch (pixelError) {
            // Safe fallback for individual pixel errors
            r = g = b = 0;
          }

          const rgb = ValueUtils.validateRGB(r, g, b);
          const idx = (y * W + x) * 4;
          data[idx] = Math.round(rgb.r * 255);
          data[idx + 1] = Math.round(rgb.g * 255);
          data[idx + 2] = Math.round(rgb.b * 255);
          data[idx + 3] = 255;
        }
      }
    } catch (error) {
      logger.error('CPU', 'Pixel rendering error:', error);
      this.clearCanvas();
    }
  }

  /**
   * Display the rendered frame to canvas
   */
  displayFrame() {
    if (!this.ctx) {
      logger.warn('CPU', 'No 2D context available for display');
      return;
    }

    this.offCtx.putImageData(this.imageData, 0, 0);
    this.ctx.imageSmoothingEnabled = this.env.interpolate;
    if (this.env.interpolate) {
      this.ctx.imageSmoothingQuality = 'high';
    }
    this.ctx.drawImage(this.offscreenCanvas, 0, 0, this.canvas.width, this.canvas.height);
    this.env.frame++;
  }

  /**
   * Find variables used in filtered statements
   */
  findUsedVariables(statements) {
    const usedVars = new Set();

    const traverse = (node) => {
      if (!node) return;

      if (node.type === 'Var') {
        usedVars.add(node.name);
      } else if (node.type === 'StrandAccess') {
        const baseName = node.base?.name || node.base;
        if (baseName && baseName !== 'me') {
          usedVars.add(baseName);
        }
      }

      // Traverse children
      if (node.args) node.args.forEach(traverse);
      if (node.expr) traverse(node.expr);
      if (node.left) traverse(node.left);
      if (node.right) traverse(node.right);
    };

    statements.forEach(traverse);
    return usedVars;
  }


  /**
   * Handle parameter updates
   */
  onParameterUpdate(paramName, value) {
    logger.debug('CPU', `Parameter updated: ${paramName} = ${value}`);
  }

  /**
   * Compile display statements into functions once
   */
  compileDisplayStatements(ast) {
    // Find display statements
    const displayStmts = [];
    const traverse = (node) => {
      if (!node) return;
      if (node.type === 'DisplayStmt' || node.type === 'RenderStmt') {
        displayStmts.push(node);
      }
      if (node.statements) node.statements.forEach(traverse);
      if (node.args) node.args.forEach(traverse);
    };

    traverse(ast);

    if (displayStmts.length === 0) {
      logger.debug('CPU', 'No display statements found');
      this.displayFunctions = null;
      return;
    }

    // Compile the display statement expressions ONCE
    const displayStmt = displayStmts[0];
    if (!displayStmt.args || displayStmt.args.length < 3) {
      logger.warn('CPU', 'Display statement needs at least 3 arguments (R, G, B)');
      this.displayFunctions = null;
      return;
    }

    try {
      // Compile each color channel expression once
      const rExpr = displayStmt.args[0];
      const gExpr = displayStmt.args[1];
      const bExpr = displayStmt.args[2];

      const rFn = compileExpr(rExpr, this.env);
      const gFn = compileExpr(gExpr, this.env);
      const bFn = compileExpr(bExpr, this.env);

      this.displayFunctions = [rFn, gFn, bFn];
      logger.info('CPU', 'Compiled display functions successfully');
    } catch (error) {
      logger.error('CPU', 'Failed to compile display functions:', error);
      this.displayFunctions = null;
    }
  }

  /**
   * Get performance label
   */
  getPerformanceLabel() {
    return `CPU: ${this.avgMs} ms`;
  }

  /**
   * Sample pixel value at normalized coordinates [0,1]
   * @param {number} x - Normalized X coordinate (0-1)
   * @param {number} y - Normalized Y coordinate (0-1)
   * @param {number} channel - Channel index (0=r, 1=g, 2=b, 3=a)
   * @returns {number} Normalized pixel value (0-1)
   */
  samplePixel(x, y, channel = 0) {
    if (!this.imageData) return 0;

    // Clamp and normalize coordinates
    x = Math.max(0, Math.min(1, x));
    y = Math.max(0, Math.min(1, y));

    // Convert to pixel coordinates
    const px = Math.floor(x * this.env.resW);
    const py = Math.floor(y * this.env.resH);

    // Get pixel value from image data
    const idx = (py * this.env.resW + px) * 4 + channel;
    const value = this.imageData.data[idx] || 0;

    // Return normalized value [0,1]
    return value / 255.0;
  }

  // ===== Legacy support for existing interface =====

  /**
   * Legacy start method - delegates to base class
   */
  startLegacy() {
    this.running = true;
    this.legacyLoop();
  }

  /**
   * Legacy loop method for backward compatibility
   */
  legacyLoop() {
    if (!this.running) return;

    const now = performance.now();
    const targetFrameTime = 1000 / this.env.targetFps;
    const deltaTime = now - this.lastFrameTime;

    this.frameTimeAccumulator += deltaTime;

    if (this.frameTimeAccumulator >= targetFrameTime) {
      const t0 = performance.now();
      this.render(); // Use the new render method
      const t1 = performance.now();
      const dt = t1 - t0;

      this.updateFrameIndicator();
      this.updatePerformanceStats(dt);

      this.frameTimeAccumulator -= targetFrameTime;
    }

    this.lastFrameTime = now;
    requestAnimationFrame(() => this.legacyLoop());
  }
}
export { Renderer };