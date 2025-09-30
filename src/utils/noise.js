// Noise generation utilities extracted from runtime.js

// Hash cache for performance optimization
const hashCache = new Map();
const MAX_CACHE_SIZE = 1000;

/**
 * Fast 3D hash function with LRU caching
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {number} z - Z coordinate
 * @returns {number} Hash value normalized to [0, 1]
 */
export function hash3(x, y, z) {
  // Use integer coordinates for cache key
  const xi = x | 0, yi = y | 0, zi = z | 0;
  const key = `${xi},${yi},${zi}`;
  let cached = hashCache.get(key);
  if (cached !== undefined) return cached;

  // Fast integer hash using 32-bit arithmetic instead of BigInt
  let h = ((xi * 73856093) ^ (yi * 19349663) ^ (zi * 83492791)) >>> 0;
  h = ((h ^ (h >>> 16)) * 0x85ebca6b) >>> 0;
  h = ((h ^ (h >>> 13)) * 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;

  // Normalize to [0, 1]
  const result = h / 0xFFFFFFFF;

  // LRU cache management - remove oldest entry when full
  if (hashCache.size >= MAX_CACHE_SIZE) {
    const firstKey = hashCache.keys().next().value;
    hashCache.delete(firstKey);
  }
  hashCache.set(key, result);
  return result;
}

/**
 * Smooth interpolation function (smoothstep)
 * @param {number} a - Lower bound
 * @param {number} b - Upper bound
 * @param {number} x - Input value
 * @returns {number} Smoothly interpolated value
 */
export function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * High-quality 3D Perlin-style noise
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {number} t - Time/Z coordinate
 * @returns {number} Noise value [0, 1]
 */
export function noise3(x, y, t) {
  // Use faster floor
  const xi = ~~x, yi = ~~y, ti = ~~t;
  const xf = x - xi, yf = y - yi, tf = t - ti;

  // Compute smoothstep once
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = tf * tf * (3 - 2 * tf);

  // Inline mix operations for speed
  const n000 = hash3(xi, yi, ti);
  const n100 = hash3(xi + 1, yi, ti);
  const n010 = hash3(xi, yi + 1, ti);
  const n110 = hash3(xi + 1, yi + 1, ti);
  const n001 = hash3(xi, yi, ti + 1);
  const n101 = hash3(xi + 1, yi, ti + 1);
  const n011 = hash3(xi, yi + 1, ti + 1);
  const n111 = hash3(xi + 1, yi + 1, ti + 1);

  // Optimized trilinear interpolation
  const x00 = n000 + u * (n100 - n000);
  const x10 = n010 + u * (n110 - n010);
  const x01 = n001 + u * (n101 - n001);
  const x11 = n011 + u * (n111 - n011);
  const y0 = x00 + v * (x10 - x00);
  const y1 = x01 + v * (x11 - x01);
  return y0 + w * (y1 - y0);
}

/**
 * Super fast low-quality noise for preview/real-time use
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {number} t - Time/Z coordinate
 * @returns {number} Noise value [0, 1]
 */
export function fastNoise3(x, y, t) {
  const n = Math.sin(x * 12.9898 + y * 78.233 + t * 37.719) * 437538.5453;
  return n - ~~n;
}