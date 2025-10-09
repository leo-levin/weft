// builtins-math.js — Mathematical built-in functions

import { clamp } from '../utils/math.js';
import { noise3 } from '../utils/noise.js';
import { RuntimeError } from '../core/errors.js';

export const Builtins = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, atan2: Math.atan2,
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, log: Math.log,
  min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  clamp: (x, lo, hi) => clamp(x, lo, hi),
  length: (...args) => (args.length === 1 && Array.isArray(args[0])) ? Math.hypot(...args[0]) : Math.hypot(...args),
  distance: (...args) => {
    if (args.length === 2 && Array.isArray(args[0]) && Array.isArray(args[1])) {
      const a = args[0], b = args[1];
      return Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
    if (args.length === 4) return Math.hypot(args[0] - args[2], args[1] - args[3]);
    throw new RuntimeError("distance expects 4 scalars or two 2-tuples");
  },
  normalize: (x, a = 0, b = 1) => (x - a) / ((b - a) || 1e-9),
  noise: (x, y, t) => noise3(x * 3.1, y * 3.1, t * 0.5),
};