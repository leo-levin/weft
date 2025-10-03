import { logger } from '../utils/logger.js';
import { clamp, isNum } from '../utils/math.js';

/**
 * Media loading and management utilities
 * Used by backends to handle image/video/audio loading
 */
export class MediaManager {
  constructor(env, backendType) {
    this.env = env;
    this.backendType = backendType;
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
   * Load media file and create sampler
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

      logger.debug(this.backendType, `Loaded media: ${path} as ${instName}`);
      return sampler;
    } catch (error) {
      logger.error(this.backendType, `Failed to load media ${path}:`, error);
      return null;
    }
  }

  /**
   * Get loaded media sampler
   * @param {string} instName - Instance name
   * @returns {Object|null} Media sampler
   */
  getMediaSampler(instName) {
    return this.loadedMedia.get(instName) || null;
  }

  /**
   * Check if instance has loaded media
   * @param {string} instName - Instance name
   * @returns {boolean}
   */
  hasMedia(instName) {
    return this.loadedMedia.has(instName);
  }

  /**
   * Clear all loaded media
   */
  clear() {
    this.loadedMedia.clear();
  }
}

/**
 * Performance monitoring utilities
 */
export class PerformanceMonitor {
  constructor(backendType) {
    this.backendType = backendType;
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
