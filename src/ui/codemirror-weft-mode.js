// WEFT syntax mode for CodeMirror using Ohm-based highlighting
// Based on convention-over-configuration: Ohm rule names → CSS classes

const ohm = window.ohm;

const grammar = ohm.grammar(`
  Weft {
    Program = Statement*

    Statement = Definition
              | EnvAssignment
              | Binding
              | SideEffect

    EnvAssignment = kw<"me"> sym<"<"> ident sym<">"> sym<"="> Expr
    Definition = SpindleDef
    SpindleDef = kw<"spindle"> ident sym<"("> ListOf<ident, ","> sym<")"> sym<"::"> OutputSpec Block

    Binding = InstanceBinding

    LetBinding = kw<"let"> ident sym<"="> Expr
    InstanceBinding = ident space* OutputSpec space* sym<"="> space* Expr  -- direct
                    | ident sym<"@"> ident sym<"("> ListOf<Expr, ","> sym<")"> sym<"::"> ident OutputSpec -- strandRemap
                    | ident sym<"("> ListOf<Expr, ","> sym<")"> sym<"::"> ident OutputSpec -- call
                    | ident sym<"<"> digit+ sym<">"> sym<"("> ListOf<BundleOrExpr, ","> sym<")"> sym<"::"> ident OutputSpec -- multiCall

    Assignment = ident AssignOp Expr
    AssignOp = sym<"="> | sym<"+="> | sym<"-="> | sym<"*="> | sym<"/=">

    SideEffect = DisplayStmt | RenderStmt | PlayStmt | ComputeStmt

    DisplayStmt = kw<"display"> sym<"("> ListOf<StmtArg, ","> sym<")">
    RenderStmt = kw<"render"> sym<"("> ListOf<StmtArg, ","> sym<")">
    PlayStmt = kw<"play"> sym<"("> ListOf<StmtArg, ","> sym<")">
    ComputeStmt = kw<"compute"> sym<"("> ListOf<StmtArg, ","> sym<")">

    StmtArg = ident sym<":"> Expr  -- named
            | Expr                 -- positional

    Block = sym<"{"> BlockStatement* sym<"}">
    BlockStatement = LetBinding | Assignment | ForLoop
    ForLoop = kw<"for"> ident kw<"in"> sym<"("> Expr kw<"to"> Expr sym<")"> Block

    OutputSpec = sym<"<"> ListOf<ident, ","> sym<">">

    BundleOrExpr = sym<"<"> ListOf<Expr, ","> sym<">">  -- bundle
                | Expr                                 -- regular

    Expr = IfExpr | LogicalExpr
    IfExpr = kw<"if"> Expr kw<"then"> Expr kw<"else"> Expr

    LogicalExpr = LogicalExpr kw<"or"> LogicalExpr   -- or
                | LogicalExpr kw<"and"> LogicalExpr  -- and
                | ComparisonExpr

    ComparisonExpr = ArithExpr CmpOp ArithExpr -- compare
                  | ArithExpr
    CmpOp = sym<"==="> | sym<"=="> | sym<"!="> | sym<"<<="> | sym<">>="> | sym<"<<"> | sym<">>">

    ArithExpr = AddExpr
    AddExpr = AddExpr AddOp MulExpr  -- addsub
            | MulExpr
    MulExpr = MulExpr MulOp PowerExpr  -- muldiv
            | PowerExpr
    PowerExpr = UnaryExpr sym<"^"> PowerExpr  -- power
              | UnaryExpr
    AddOp = sym<"+"> | sym<"-">
    MulOp = sym<"*"> | sym<"/"> | sym<"%">

    UnaryExpr = sym<"-"> UnaryExpr    -- neg
              | kw<"not"> UnaryExpr   -- not
              | PrimaryExpr

    PrimaryExpr = sym<"("> Expr sym<")">                          -- paren
                | sym<"("> ListOf<Expr, ","> sym<")">             -- tuple
                | PrimaryExpr sym<"["> Expr sym<"]">              -- index
                | ident sym<"@"> ident sym<"("> ListOf<AxisMapping, ","> sym<")"> -- strandRemap
                | ident sym<"@"> ident                            -- strand
                | builtinFunc                                     -- builtin
                | ident sym<"("> ListOf<Expr, ","> sym<")">       -- call
                | sym<"<"> ListOf<Expr, ","> sym<">">             -- bundle
                | kw<"mouse"> sym<"@"> ident                      -- mouse
                | builtinIdent                                    -- builtinIdent
                | ident                                           -- var
                | number
                | string

    AxisMapping = Expr sym<"~"> Expr

    builtinFunc = ("sin" | "cos" | "tan" | "abs" | "floor" | "ceil" | "round" | "min" | "max"
                  | "clamp" | "mix" | "step" | "smoothstep" | "load" | "noise" | "sqrt" | "pow" | "exp" | "log")
                  sym<"("> ListOf<Expr, ","> sym<")">
    builtinIdent = ("me" | "mouse") ~identRest
    instName = ident
    strandName = ident
    ident = ~keyword letter identRest*
    identRest = letter | digit | "_"
    keyword = ("spindle" | "if" | "then" | "else" | "not" | "and" | "or"
            | "display" | "render" | "play" | "compute" | "let" | "for" | "in" | "to"
            | "mouse" | "me" | "sin" | "cos" | "tan" | "abs" | "floor" | "ceil" | "round"
            | "min" | "max" | "clamp" | "mix" | "step" | "smoothstep" | "load" | "noise"
            | "sqrt" | "pow" | "exp" | "log") ~identRest

    number = numCore
    numCore = digit+ "." digit* expPart?    -- d1
            | "." digit+ expPart?           -- d2
            | digit+ expPart?               -- d3
    expPart = ("e" | "E") ("+" | "-")? digit+

    string = "\\"" (~"\\"" any)* "\\""

    sym<tok> = tok space*
    kw<word> = word ~identRest space*

    space += lineComment | blockComment
    lineComment = "//" (~"\\n" any)*
    blockComment = "/*" (~"*/" any)* "*/"
  }
`);

const builtinFuncs = new Set(['sin', 'cos', 'tan', 'abs', 'floor', 'ceil', 'round', 'min', 'max', 'clamp', 'mix', 'step', 'smoothstep', 'load', 'noise', 'sqrt', 'pow', 'exp', 'log']);

(function(mod) {
  if (typeof exports == "object" && typeof module == "object") // CommonJS
    mod(require("../../lib/codemirror"));
  else if (typeof define == "function" && define.amd) // AMD
    define(["../../lib/codemirror"], mod);
  else // Plain browser env
    mod(CodeMirror);
})(function(CodeMirror) {
  "use strict";

  CodeMirror.defineMode("weft", function() {
    let tokenMap = null;
    let lastSource = null;

    // Regex fallback for when parse fails
    function buildRegexTokenMap(source) {
      const lines = source.split('\n');
      const lineMap = new Map();

      lines.forEach((line, lineNum) => {
        const tokens = [];
        const patterns = [
          { regex: /\/\/.*/, type: 'comment' },
          { regex: /"(?:[^"\\]|\\.)*"/, type: 'string' },
          { regex: /\b(spindle|if|then|else|not|and|or|display|render|play|compute|let|for|in|to)\b/, type: 'keyword' },
          { regex: /\b(me|mouse)\b/, type: 'builtin' },
          { regex: /\b(sin|cos|tan|abs|floor|ceil|round|min|max|clamp|mix|step|smoothstep|load|noise|sqrt|pow|exp|log)\b/, type: 'builtin' },
          { regex: /\d+\.?\d*/, type: 'number' },
          { regex: /@[a-zA-Z_]\w*/, type: 'variable-2' },
          { regex: /[+\-*/%=<>!~^]/, type: 'operator' },
          { regex: /[a-zA-Z_]\w*(?=\s*<)/, type: 'def' },
          { regex: /[a-zA-Z_]\w*/, type: 'variable' },
        ];

        let idx = 0;
        while (idx < line.length) {
          let matched = false;
          for (const pattern of patterns) {
            const match = line.slice(idx).match(new RegExp(`^${pattern.regex.source}`));
            if (match) {
              tokens.push({ start: idx, end: idx + match[0].length, type: pattern.type });
              idx += match[0].length;
              matched = true;
              break;
            }
          }
          if (!matched) idx++;
        }

        lineMap.set(lineNum, tokens);
      });

      return lineMap;
    }

    function buildTokenMap(source) {
      try {
        const match = grammar.match(source);
        const tokens = [];

        if (match.succeeded()) {
          // Walk CST and extract token positions
          function walk(node) {
            if (!node) return;

            const type = getTokenType(node, source);
            if (type) {
              tokens.push({
                start: node.source.startIdx,
                end: node.source.endIdx,
                type: type
              });
            }

            // Recurse into children
            if (node.children && node.children.length > 0) {
              node.children.forEach(child => walk(child));
            }
          }

          walk(match._cst);
        } else {
          // Parse failed - use simple regex fallback
          return buildRegexTokenMap(source);
        }

        // Convert to line-based map
        const lines = source.split('\n');
        const lineMap = new Map();

        lines.forEach((line, lineNum) => {
          const lineStart = lines.slice(0, lineNum).reduce((acc, l) => acc + l.length + 1, 0);
          const lineEnd = lineStart + line.length;

          const lineTokens = tokens
            .filter(t => t.start < lineEnd && t.end > lineStart)
            .map(t => ({
              start: Math.max(0, t.start - lineStart),
              end: Math.min(line.length, t.end - lineStart),
              type: t.type
            }))
            .filter(t => t.start < t.end);

          lineMap.set(lineNum, lineTokens);
        });

        return lineMap;
      } catch (e) {
        console.warn('WEFT highlighting error:', e);
        return buildRegexTokenMap(source);
      }
    }

    return {
      startState: function() {
        return { line: 0 };
      },

      token: function(stream, state) {
        const lineNum = state.line;
        const col = stream.pos;

        // Rebuild token map when needed
        if (!tokenMap) {
          const allLines = [];
          let line = 0;
          while (true) {
            const lineText = stream.lookAhead(line);
            if (lineText === null || lineText === undefined) break;
            allLines.push(lineText);
            line++;
          }
          const source = allLines.join('\n');
          if (source && source !== lastSource) {
            lastSource = source;
            tokenMap = buildTokenMap(source);
          }
        }

        if (!tokenMap) {
          stream.next();
          return null;
        }

        const tokens = tokenMap.get(lineNum) || [];

        // Find token at current position
        for (const token of tokens) {
          if (col >= token.start && col < token.end) {
            stream.pos = token.end;
            return token.type;
          }
        }

        stream.next();
        return null;
      },

      blankLine: function(state) {
        state.line++;
      }
    };
  });

  CodeMirror.defineMIME("text/x-weft", "weft");
});
