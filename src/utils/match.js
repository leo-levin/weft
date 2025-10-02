'use strict';

class MatchFailure extends Error {
  constructor() {
    super(':( match failed');
  }
}

const _ = {};

function match(value, ...args) {
  if (args.length %2 !== 0) {
    throw new Error('patterns and functions must come in pairs!')
  };
  for (let i = 0; i < args.length; i+=2) {
    const bindings = matchPattern(args[i], value)
    if (bindings !== null) {
      const func = args[i+1];
      if (func.length !== bindings.length) {
        throw new Error(`Arr! Arity Error! expected ${func.length} args, got ${bindings.length}`)
      }
      return func(...bindings)
    }
  }
  throw new MatchFailure(`No pattern matched: ${JSON.stringify(value)}`);
}

function matchPattern(pattern, value) {
  if (pattern === _) {
    return [value];
  }

  if (typeof pattern === 'function') {
    return pattern(value) ? [value] : null;
  }

  if (Array.isArray(pattern)) {
    if (!Array.isArray(value)) {
      return null;
    }

    const allBinds = [];
    let patternIndex = 0;
    let valueIndex = 0;

    while (patternIndex < pattern.length) {
      const curPattern = pattern[patternIndex];
      if (curPattern && curPattern.type === 'many') {
        const manyBinds = [];
        const innerPattern = curPattern.pattern;

        while (valueIndex < value.length) {
          const subBinds = matchPattern(innerPattern, value[valueIndex]);
          if (subBinds === null) {
            break;
          }
          manyBinds.push(subBinds);
          valueIndex++;
        }

        if (manyBinds.length === 0) {
          allBinds.push([]);
        } else {
          for (let col = 0; col < manyBinds[0].length; col++) {
            const column = manyBinds.map(row => row[col]);
            allBinds.push(column);
          }
        }
        patternIndex++;
      } else if (curPattern && curPattern.type === 'rest') {
        const remaining = value.slice(valueIndex);
        allBinds.push(remaining);
        valueIndex = value.length;
        patternIndex++;
      } else {
        if (valueIndex >= value.length) {
          return null;
        }
        const subBinds = matchPattern(curPattern, value[valueIndex]);
        if (subBinds === null) {
          return null;
        }
        allBinds.push(...subBinds);
        patternIndex++;
        valueIndex++;
      }
    }

    if (valueIndex !== value.length && !pattern.some(p => p && p.type === 'rest')) {
      return null;
    }

    return allBinds;
  }

  if (pattern && pattern.type === "instance") {
    if (!(value instanceof pattern.cls)) {
      return null
    }
    const deconstructed = value.deconstruct();

    if (pattern.patterns.length !== deconstructed.length) {
      return null;
    }

    const allBindings = [];
    for (let i = 0; i < pattern.patterns.length; i++) {
      const subBindings = matchPattern(pattern.patterns[i], deconstructed[i]);
      if (subBindings === null) {
        return null;
      }
      allBindings.push(...subBindings);
    }

    return allBindings;
  }

  if (pattern && pattern.type === "range") {
    if (typeof value === 'number' && value >= pattern.min && value <= pattern.max) {
      return [];
    }
    return null;
  }

  if (pattern && pattern.type === "check") {
    const bindings = matchPattern(pattern.pattern, value);
    if (bindings === null) {
      return null;
    }

    if (pattern.predicate(value)) {
      return bindings;
    }
    return null;
  }

  return value === pattern ? [] : null
}

function inst (cls, ...patterns) {
  return {type: "instance", cls: cls, patterns: patterns};
}

function many(pattern) {
  return {type: "many", pattern: pattern};
}

function range(min, max) {
  return {
    type: "range",
    min: min,
    max: max
  };
}

function when(pattern, predicate) {
  return {
    type: "check",
    pattern: pattern,
    predicate: predicate
  };
}

function rest(name) {
  return {type: "rest", name: name};
}

// ES6 exports
export { match, _, inst, many, range, when, rest, MatchFailure };