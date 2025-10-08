// Token-based hover system using Ohm's tokens rule
// This demonstrates how to build interactive features using the tokens rule

import { grammar, semantics } from '../lang/parser-new.js';

/**
 * Get the token at a specific character position in the source code
 * @param {string} source - The source code
 * @param {number} charPos - Character position (0-indexed)
 * @returns {Object|null} Token info {type, text, start, end} or null
 */
export function getTokenAtPosition(source, charPos) {
  const match = grammar.match(source, 'tokens');
  if (match.failed()) return null;

  // Walk the match tree to find the token at the given position
  const result = findTokenAtPos(match, charPos);
  return result;
}

function findTokenAtPos(node, pos) {
  const interval = node.source;
  const start = interval.startIdx;
  const end = interval.endIdx;

  // Check if position is within this node's range
  if (pos < start || pos >= end) return null;

  // If this is a terminal or has the token type we care about
  if (node.ctorName === 'keyword' ||
      node.ctorName === 'ident' ||
      node.ctorName === 'specialIdent' ||
      node.ctorName === 'number' ||
      node.ctorName === 'string' ||
      node.ctorName === 'strandOp' ||
      node.ctorName === 'instanceOp' ||
      node.ctorName === 'operator') {
    return {
      type: node.ctorName,
      text: interval.contents,
      start: start,
      end: end
    };
  }

  // Recursively check children
  if (node.children) {
    for (const child of node.children) {
      const result = findTokenAtPos(child, pos);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Generate hover information for a token
 * @param {Object} token - Token from getTokenAtPosition
 * @param {Object} env - Runtime environment
 * @returns {string} Hover text (HTML)
 */
export function generateHoverInfo(token, env) {
  if (!token) return null;

  switch (token.type) {
    case 'keyword':
      return getKeywordDocs(token.text);

    case 'specialIdent':
      return getSpecialIdentDocs(token.text);

    case 'ident':
      // Look up in environment
      if (env && env.vars && env.vars[token.text]) {
        const value = env.vars[token.text];
        return `<strong>${token.text}</strong><br>Value: ${formatValue(value)}`;
      }
      return `<strong>${token.text}</strong><br>Identifier`;

    case 'strandOp':
      return `<strong>@</strong> - Strand Access<br>Access an output from an instance`;

    case 'instanceOp':
      return `<strong>::</strong> - Instance Binding<br>Bind outputs to an instance name`;

    case 'number':
      return `<strong>Number</strong><br>${token.text}`;

    case 'string':
      return `<strong>String</strong><br>${token.text}`;

    default:
      return `${token.type}: ${token.text}`;
  }
}

function getKeywordDocs(keyword) {
  const docs = {
    'display': '<strong>display</strong><br>Render expression to the canvas',
    'render': '<strong>render</strong><br>Render expression (visual context)',
    'play': '<strong>play</strong><br>Send expression to audio output',
    'compute': '<strong>compute</strong><br>Compute expression (CPU context)',
    'spindle': '<strong>spindle</strong><br>Define a reusable computation unit',
    'if': '<strong>if</strong><br>Conditional expression',
    'then': '<strong>then</strong><br>True branch of conditional',
    'else': '<strong>else</strong><br>False branch of conditional',
    'let': '<strong>let</strong><br>Bind a value to a name',
    'for': '<strong>for</strong><br>Loop construct',
    'and': '<strong>and</strong><br>Logical AND operator',
    'or': '<strong>or</strong><br>Logical OR operator',
    'not': '<strong>not</strong><br>Logical NOT operator',
  };

  return docs[keyword] || `<strong>${keyword}</strong><br>Keyword`;
}

function getSpecialIdentDocs(ident) {
  const docs = {
    'me': '<strong>me</strong><br>Access canvas/pixel properties<br>Fields: x, y, time, width, height',
    'mouse': '<strong>mouse</strong><br>Access mouse position<br>Fields: x, y',
  };

  return docs[ident] || `<strong>${ident}</strong><br>Special identifier`;
}

function formatValue(value) {
  if (typeof value === 'number') {
    return value.toFixed(3);
  } else if (typeof value === 'string') {
    return `"${value}"`;
  } else if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

/**
 * Example usage with CodeMirror:
 *
 * editor.on('cursorActivity', (cm) => {
 *   const cursor = cm.getCursor();
 *   const pos = cm.indexFromPos(cursor);
 *   const source = cm.getValue();
 *
 *   const token = getTokenAtPosition(source, pos);
 *   if (token) {
 *     const hoverInfo = generateHoverInfo(token, env);
 *     showTooltip(hoverInfo, cursor);
 *   }
 * });
 */
