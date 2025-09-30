// Math utilities extracted from runtime.js

/**
 * Clamps a value between minimum and maximum bounds
 * @param {number} x - Value to clamp
 * @param {number} lo - Lower bound (default: 0)
 * @param {number} hi - Upper bound (default: 1)
 * @returns {number} Clamped value
 */
export const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

/**
 * Linear interpolation between two values
 * @param {number} a - Start value
 * @param {number} b - End value
 * @param {number} t - Interpolation factor (0-1)
 * @returns {number} Interpolated value
 */
export const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Get current time in seconds
 * @returns {number} Current time in seconds since page load
 */
export const nowSec = () => performance.now() / 1000;

/**
 * Check if value is a finite number
 * @param {*} v - Value to check
 * @returns {boolean} True if value is a finite number
 */
export const isNum = v => typeof v === 'number' && isFinite(v);