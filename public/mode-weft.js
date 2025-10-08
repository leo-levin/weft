// CodeMirror mode for WEFT language
(function(mod) {
  if (typeof exports == "object" && typeof module == "object") // CommonJS
    mod(require("codemirror"));
  else if (typeof define == "function" && define.amd) // AMD
    define(["codemirror"], mod);
  else // Plain browser env
    mod(CodeMirror);
})(function(CodeMirror) {
  "use strict";

  CodeMirror.defineMode("weft", function(config, parserConfig) {
    // Keywords in WEFT
    const keywords = {
      "spindle": true,
      "if": true,
      "then": true,
      "else": true,
      "display": true,
      "render": true,
      "play": true,
      "compute": true,
      "let": true,
      "for": true,
      "to": true,
      "not": true,
      "and": true,
      "or": true
    };

    // Special keyword atoms
    const atoms = {
      "out": true,
      "in": true
    };

    // Special identifiers (built-ins)
    const specialIdents = {
      "me": true,
      "mouse": true
    };

    // Math functions
    const mathFunctions = {
      "sin": true,
      "cos": true,
      "tan": true,
      "asin": true,
      "acos": true,
      "atan": true,
      "atan2": true,
      "sqrt": true,
      "abs": true,
      "floor": true,
      "ceil": true,
      "round": true,
      "min": true,
      "max": true,
      "pow": true,
      "exp": true,
      "log": true,
      "log2": true,
      "log10": true,
      "sign": true,
      "trunc": true,
      "fract": true,
      "mod": true,
      "clamp": true,
      "mix": true,
      "step": true,
      "smoothstep": true,
      "length": true,
      "distance": true,
      "dot": true,
      "cross": true,
      "normalize": true
    };

    // Pragma types
    const pragmaTypes = {
      "slider": true,
      "color": true,
      "xy": true,
      "toggle": true,
      "curve": true,
      "badge": true
    };

    function tokenBase(stream, state) {
      // TOKEN TYPE REFERENCE:
      // Return these strings to get CSS classes (.cm-* prefix):
      // "keyword"    → spindle, if, then, else, display
      // "atom"       → out, in
      // "builtin"    → me, mouse
      // "spin-name"  → spindle names (my_circle in definition)
      // "params"     → parameters in spindle signature
      // "callee"     → function calls (my_circle when called)
      // "outs"       → output names in <result> spec
      // "strands"    → strand names in <r,g,b> or @r
      // "bundles"    → instance names (circs in ::circs)
      // "tag"        → variable name after 'out' keyword
      // "variable"   → variable references
      // "variable-2" → local variable definitions (dx = ...)
      // "operator"   → + - * / == << >> :: etc.
      // "operator-2" → ~
      // "operator-3" → @
      // "math"       → sin, cos, sqrt, etc.
      // "count"      → <3> in multi-call syntax
      // "outs-bracket"    → <> around ::<result>
      // "strands-bracket" → <> around ::inst<r,g,b>
      // "tuple-bracket"   → <> around foo(<0.1,0.2,0.3>)
      // "number", "string", "comment" → literals and comments
      //
      // Add CSS rules in editor-highlighting.css to style them!

      // Handle whitespace
      if (stream.eatSpace()) return null;

      const ch = stream.peek();

      // Comments
      if (ch === "/") {
        if (stream.match("//")) {
          stream.skipToEnd();
          return "comment";
        }
        if (stream.match("/*")) {
          state.tokenize = tokenComment;
          return tokenComment(stream, state);
        }
      }

      // Strings
      if (ch === '"') {
        stream.next();
        state.tokenize = tokenString;
        return state.tokenize(stream, state);
      }

      // Pragmas
      if (ch === "#" && stream.sol()) {
        stream.next();
        stream.eatWhile(/\w/);
        const pragma = stream.current().substring(1);
        if (pragmaTypes[pragma]) {
          return "meta";
        }
        return "meta";
      }

      // Numbers
      if (/\d/.test(ch) || (ch === "." && /\d/.test(stream.peek()))) {
        stream.match(/^[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?/);
        return "number";
      }

      // Strand access operator (@)
      if (ch === "@") {
        stream.next();
        state.afterAtOperator = true;
        return "operator-3";
      }

      // Instance binding operator (::)
      if (ch === ":" && stream.match("::")) {
        state.expectingInstanceName = true;
        return "operator";
      }

      // Remap operator (~)
      if (ch === "~") {
        stream.next();
        return "operator-2";
      }

      // Handle < for multi-call count, output specs, and strand maps
      if (ch === "<") {
        stream.next();

        // Check for << and <<= operators FIRST
        if (stream.peek() === "<") {
          stream.next(); // consume second <
          stream.eat("="); // optional =
          return "operator";
        }

        // Check for multi-call count expression <3>
        const start = stream.pos - 1; // pos is already after <
        if (/\d/.test(stream.peek())) {
          stream.match(/^[0-9]+/);
          if (stream.peek() === ">") {
            stream.next(); // consume >
            return "count";
          }
          // Not a valid count, backtrack
          stream.pos = start + 1;
        }

        // Check if we're accessing builtin property (me<width>, mouse<x>)
        if (state.lastToken === "builtin") {
          state.insideBuiltinAccess = true;
          return "strands-bracket";
        }

        // Check if we're starting a strand map (after :: and instance name)
        if (state.lastToken === "bundles") {
          state.insideStrandMap = true;
          return "strands-bracket";
        }
        // Check if we're starting an output spec (directly after ::)
        else if (state.expectingInstanceName) {
          state.insideOutputSpec = true;
          state.expectingInstanceName = false; // Clear the flag
          return "outs-bracket";
        }
        // Check if we're inside function arguments (tuple literal)
        else if (state.insideFunctionArgs) {
          state.insideTupleLiteral = true;
          return "tuple-bracket";
        }
        // Check for <= operator
        if (stream.eat("=")) {
          return "operator";
        }
        return "bracket";
      }

      if (ch === ">") {
        stream.next();
        // Check for >> and >>= operators first
        if (stream.peek() === ">") {
          stream.next(); // consume second >
          stream.eat("="); // optional =
          return "operator";
        }

        // Check for >= operator
        if (stream.eat("=")) {
          return "operator";
        }

        // Exit builtin access
        if (state.insideBuiltinAccess) {
          state.insideBuiltinAccess = false;
          return "strands-bracket";
        }
        // Exit output spec
        if (state.insideOutputSpec) {
          state.insideOutputSpec = false;
          return "outs-bracket";
        }
        // Exit strand map
        if (state.insideStrandMap) {
          state.insideStrandMap = false;
          return "strands-bracket";
        }
        // Exit tuple literal
        if (state.insideTupleLiteral) {
          state.insideTupleLiteral = false;
          return "tuple-bracket";
        }
        return "bracket";
      }

      // Other operators
      if ("+-*/%^=!".indexOf(ch) !== -1) {
        stream.next();
        // Check for compound operators
        if (ch === "=" && stream.eat("=")) {
          stream.eat("="); // === or ==
        } else if (ch === "!" && stream.eat("=")) {
          // !=
        } else if ("+-*/".indexOf(ch) !== -1 && stream.eat("=")) {
          // +=, -=, *=, /=
        }
        return "operator";
      }

      if ("()[]{}".indexOf(ch) !== -1) {
        stream.next();
        // Track entering/exiting spindle parameter list
        if (ch === "(") {
          if (state.lastToken === "spin-name") {
            state.insideSpindleParams = true;
          } else if (state.lastToken === "callee" || state.lastToken === "count") {
            // Handle both foo() and foo<3>() cases
            state.insideFunctionArgs = true;
          }
        } else if (ch === ")") {
          // Don't exit param mode here - wait for the body to start
          // This allows :: <output> to be processed correctly
          if (state.insideFunctionArgs) {
            state.insideFunctionArgs = false;
          }
        } else if (ch === "{") {
          // Entering spindle body, exit param mode
          if (state.insideSpindleParams) {
            state.insideSpindleParams = false;
          }
        }
        return "bracket";
      }

      if (ch === ",") {
        stream.next();
        return "punctuation";
      }

      if (ch === ";") {
        stream.next();
        return "punctuation";
      }

      // Identifiers and keywords
      if (/[a-zA-Z_]/.test(ch)) {
        stream.eatWhile(/[\w]/);
        const word = stream.current();

        // Check if it's a keyword
        if (keywords[word]) {
          if (word === "spindle") {
            state.afterSpindleKeyword = true;
          }
          return "keyword";
        }

        // Check if it's an atom (out, in)
        if (atoms[word]) {
          if (word === "out") {
            state.afterOutKeyword = true;
          }
          return "atom";
        }

        // Check if identifier comes after @ operator (strand access)
        if (state.afterAtOperator) {
          state.afterAtOperator = false;
          return "strands";
        }

        // Check if we're inside output spec (between < >) - check this BEFORE params
        if (state.insideOutputSpec) {
          state.outNames[word] = true; // Track output name
          return "outs";
        }

        // Check if we're inside strand map (between < > after instance name)
        if (state.insideStrandMap) {
          return "strands";
        }

        // Check if we're inside spindle parameter list
        if (state.insideSpindleParams) {
          state.paramNames[word] = true; // Track parameter name
          return "params";
        }

        // Check if this is a spindle name (after 'spindle' keyword)
        if (state.afterSpindleKeyword) {
          state.afterSpindleKeyword = false;
          return "spin-name";
        }

        // Check if this is an instance name (after ::)
        if (state.expectingInstanceName) {
          state.expectingInstanceName = false;
          state.bundleNames[word] = true; // Track bundle name
          return "bundles";
        }

        // Check if this identifier is a tracked parameter name
        if (state.paramNames[word]) {
          return "params";
        }

        // Check if this identifier is a tracked bundle name
        if (state.bundleNames[word]) {
          return "bundles";
        }

        // Check if it's a special identifier (me, mouse)
        if (specialIdents[word]) {
          return "builtin";
        }

        // Check if it's a math function
        if (mathFunctions[word]) {
          return "math";
        }

        // Check if this is after 'out' keyword
        if (state.afterOutKeyword) {
          state.afterOutKeyword = false;
          state.outNames[word] = true; // Track output name
          return "outs"; // Use same color as in signature
        }

        // Check if this identifier is a tracked output name
        if (state.outNames[word]) {
          return "outs";
        }

        // Check if this is a function call (followed by () or <...>()
        // Save position to peek ahead
        const savedPos = stream.pos;
        stream.eatSpace();
        const currentPos = stream.pos;
        const peekChar = stream.peek();

        if (peekChar === "(" || peekChar === "<") {
          stream.pos = savedPos; // Restore position
          return "callee"; // Function/spindle call
        }

        // Check if this is a variable definition (followed by =)
        if (peekChar === "=") {
          // Check if it's not == or === (peek at next character)
          const nextChar = stream.string.charAt(currentPos + 1);
          if (nextChar !== "=") {
            stream.pos = savedPos; // Restore position
            state.localVarNames[word] = true; // Track local variable name
            return "variable-2"; // Local variable definition
          }
        }
        stream.pos = savedPos; // Restore position

        // Check if this identifier is a tracked local variable
        if (state.localVarNames[word]) {
          return "variable-2";
        }

        // Regular identifier (variable reference)
        return "variable";
      }

      // Default: consume the character
      stream.next();
      return null;
    }

    function tokenString(stream, state) {
      let escaped = false;
      let next;

      while ((next = stream.next()) != null) {
        if (next === '"' && !escaped) {
          state.tokenize = tokenBase;
          return "string";
        }
        escaped = !escaped && next === "\\";
      }

      return "string";
    }

    function tokenComment(stream, state) {
      let maybeEnd = false;
      let ch;

      while ((ch = stream.next()) != null) {
        if (ch === "/" && maybeEnd) {
          state.tokenize = tokenBase;
          break;
        }
        maybeEnd = (ch === "*");
      }

      return "comment";
    }

    return {
      startState: function() {
        return {
          tokenize: tokenBase,
          lastToken: null,          // Track the last token type
          lastIdentifier: null,     // Track the last identifier text
          insideOutputSpec: false,  // Are we inside < > for output spec?
          insideStrandMap: false,   // Are we inside < > for strand remapping?
          insideTupleLiteral: false, // Are we inside < > for tuple literal?
          insideBuiltinAccess: false, // Are we inside < > for builtin access (me<width>)?
          insideFunctionArgs: false, // Are we inside function call arguments?
          expectingInstanceName: false, // Expecting instance name after ::
          afterOutKeyword: false,   // Track if we just saw 'out' keyword
          insideSpindleParams: false, // Track if we're inside spindle parameter list
          afterSpindleKeyword: false, // Track if we just saw 'spindle' keyword
          afterAtOperator: false,   // Track if we just saw @ operator
          bundleNames: {},          // Track bundle instance names
          paramNames: {},           // Track parameter names
          localVarNames: {},        // Track local variable names
          outNames: {}              // Track output names
        };
      },

      token: function(stream, state) {
        const style = state.tokenize(stream, state);

        // Update state based on token type
        if (style) {
          state.lastToken = style;
        }

        return style;
      },

      lineComment: "//",
      blockCommentStart: "/*",
      blockCommentEnd: "*/",
      fold: "brace"
    };
  });

  CodeMirror.defineMIME("text/x-weft", "weft");
});
