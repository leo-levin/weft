// WEFT syntax highlighting for CodeMirror using Ohm.js + doc.markText()
// Inspired by https://observablehq.com/@ajbouh/editor

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
                | ident sym<"("> ListOf<Expr, ","> sym<")">       -- call
                | sym<"<"> ListOf<Expr, ","> sym<">">             -- bundle
                | kw<"mouse"> sym<"@"> ident                      -- mouse
                | ident                                           -- var
                | number
                | string

    AxisMapping = Expr sym<"~"> Expr

    ident = ~keyword letter identRest* space*
    identRest = letter | digit | "_"
    keyword = "spindle" | "if" | "then" | "else" | "not" | "and" | "or"
            | "display" | "render" | "play" | "compute" | "let" | "for" | "in" | "to" | "mouse"

    number = numCore space*
    numCore = digit+ "." digit* expPart?    -- d1
            | "." digit+ expPart?           -- d2
            | digit+ expPart?               -- d3
    expPart = ("e" | "E") ("+" | "-")? digit+

    string = "\\"" (~"\\"" any)* "\\"" space*

    sym<tok> = tok space*
    kw<word> = word ~identRest space*

    space += lineComment | blockComment | pragmaComment
    lineComment = "//" (~"\\n" any)*
    blockComment = "/*" (~"*/" any)* "*/"
    pragmaComment = "#" pragmaType pragmaBody "\\n"?
    pragmaType = "slider" | "color" | "xy" | "toggle" | "curve" | "badge"
    pragmaBody = (~"\\n" any)*
  }
  `);

// Create semantics for collecting tokens
const semantics = grammar.createSemantics().addOperation('highlight', {
  _nonterminal(...children) {
    // Default: collect highlights from all children
    const result = [];
    for (const child of children) {
      const childResult = child.highlight();
      if (Array.isArray(childResult)) {
        result.push(...childResult);
      }
    }
    return result;
  },

  _iter(...children) {
    return children.flatMap(c => c.highlight());
  },

  _terminal() {
    // Highlight keyword terminals
    const text = this.sourceString;
    const keywords = ['spindle', 'if', 'then', 'else', 'not', 'and', 'or',
                      'display', 'render', 'play', 'compute', 'let', 'for', 'in', 'to'];
    if (keywords.includes(text)) {
      return [{
        start: this.source.startIdx,
        end: this.source.endIdx,
        class: 'cm-keyword'
      }];
    }
    // Highlight 'mouse' as builtin
    if (text === 'mouse') {
      return [{
        start: this.source.startIdx,
        end: this.source.endIdx,
        class: 'cm-builtin'
      }];
    }
    return [];
  },

  // Numbers
  number(numCore, _space) {
    return [{
      start: this.source.startIdx,
      end: numCore.source.endIdx,
      class: 'cm-number'
    }];
  },

  // Strings
  string(_q1, _chars, _q2, _space) {
    return [{
      start: this.source.startIdx,
      end: this.source.endIdx - _space.sourceString.length,
      class: 'cm-string'
    }];
  },

  // Comments
  lineComment(_start, _body) {
    return [{
      start: this.source.startIdx,
      end: this.source.endIdx,
      class: 'cm-comment'
    }];
  },

  blockComment(_start, _body, _end) {
    return [{
      start: this.source.startIdx,
      end: this.source.endIdx,
      class: 'cm-comment'
    }];
  },

  pragmaComment(_hash, _type, _body, _newline) {
    return [{
      start: this.source.startIdx,
      end: this.source.endIdx,
      class: 'cm-comment'
    }];
  },

  // Operators - these are the lexical rules
  AddOp(_op) {
    return [{
      start: this.source.startIdx,
      end: this.source.endIdx,
      class: 'cm-operator'
    }];
  },

  MulOp(_op) {
    return [{
      start: this.source.startIdx,
      end: this.source.endIdx,
      class: 'cm-operator'
    }];
  },

  CmpOp(_op) {
    return [{
      start: this.source.startIdx,
      end: this.source.endIdx,
      class: 'cm-operator'
    }];
  },

  AssignOp(_op) {
    return [{
      start: this.source.startIdx,
      end: this.source.endIdx,
      class: 'cm-operator'
    }];
  },

  // Identifiers - highlight 'me' when used as identifier
  ident(_letter, _rest, _space) {
    const text = this.sourceString.trim();
    if (text === 'me') {
      return [{
        start: this.source.startIdx,
        end: this.source.endIdx - _space.sourceString.length,
        class: 'cm-builtin'
      }];
    }
    return [];
  },

  // Instance bindings - highlight the instance name
  InstanceBinding_direct(name, _sp1, outputs, _sp2, _eq, _sp3, expr) {
    return [
      {
        start: name.source.startIdx,
        end: name.source.endIdx,
        class: 'cm-def'
      },
      ...name.highlight(),
      ...outputs.highlight(),
      ...expr.highlight()
    ];
  },

  InstanceBinding_call(func, _lp, args, _rp, _dc, inst, outputs) {
    return [
      {
        start: inst.source.startIdx,
        end: inst.source.endIdx,
        class: 'cm-def'
      },
      ...func.highlight(),
      ...args.highlight(),
      ...outputs.highlight()
    ];
  },

  InstanceBinding_strandRemap(base, _at1, strand, _lp, mappings, _rp, _dc, inst, outputs) {
    return [
      {
        start: inst.source.startIdx,
        end: inst.source.endIdx,
        class: 'cm-def'
      },
      ...base.highlight(),
      ...strand.highlight(),
      ...mappings.highlight(),
      ...outputs.highlight()
    ];
  },

  InstanceBinding_multiCall(func, _lt, count, _gt, _lp, args, _rp, _dc, inst, outputs) {
    return [
      {
        start: inst.source.startIdx,
        end: inst.source.endIdx,
        class: 'cm-def'
      },
      ...func.highlight(),
      ...count.highlight(),
      ...args.highlight(),
      ...outputs.highlight()
    ];
  },

  // Output specs - highlight the field names inside < >
  OutputSpec(_lt, idents, _gt) {
    const result = [];

    // Highlight < bracket
    result.push({
      start: _lt.source.startIdx,
      end: _lt.source.startIdx + 1,
      class: 'cm-bracket'
    });

    // Highlight each identifier in the output spec
    if (idents.numChildren > 0) {
      const identNodes = idents.asIteration().children;
      for (const identNode of identNodes) {
        result.push({
          start: identNode.source.startIdx,
          end: identNode.source.startIdx + identNode.children[0].sourceString.length + identNode.children[1].sourceString.length,
          class: 'cm-property'
        });
      }
    }

    // Highlight > bracket
    result.push({
      start: _gt.source.startIdx,
      end: _gt.source.startIdx + 1,
      class: 'cm-bracket'
    });

    return result;
  },

  // Strand access expressions
  PrimaryExpr_strand(base, _at, output) {
    // Don't double-highlight if base is 'me' (already handled)
    const baseText = base.sourceString.trim();
    const result = [...base.highlight()];

    // Highlight instance name
    if (baseText !== 'me' && baseText !== 'mouse') {
      result.push({
        start: base.source.startIdx,
        end: base.source.endIdx,
        class: 'cm-variable'
      });
    }

    // Highlight @ symbol
    result.push({
      start: _at.source.startIdx,
      end: _at.source.startIdx + 1,
      class: 'cm-operator'
    });

    // Highlight strand name after @
    result.push({
      start: output.source.startIdx,
      end: output.source.endIdx - output.children[2].sourceString.length, // exclude trailing space
      class: 'cm-property'
    });

    return result;
  },

  PrimaryExpr_strandRemap(base, _at, strand, _lp, mappings, _rp) {
    const baseText = base.sourceString.trim();
    const result = [...base.highlight(), ...mappings.highlight()];

    // Highlight instance name
    if (baseText !== 'me' && baseText !== 'mouse') {
      result.push({
        start: base.source.startIdx,
        end: base.source.endIdx,
        class: 'cm-variable'
      });
    }

    // Highlight @ symbol
    result.push({
      start: _at.source.startIdx,
      end: _at.source.startIdx + 1,
      class: 'cm-operator'
    });

    // Highlight strand name
    result.push({
      start: strand.source.startIdx,
      end: strand.source.endIdx - strand.children[2].sourceString.length, // exclude trailing space
      class: 'cm-property'
    });

    return result;
  },

  PrimaryExpr_mouse(_mouse, _at, field) {
    return [
      {
        start: this.source.startIdx,
        end: _at.source.startIdx,
        class: 'cm-builtin'
      },
      {
        start: _at.source.startIdx,
        end: _at.source.startIdx + 1,
        class: 'cm-operator'
      },
      {
        start: field.source.startIdx,
        end: field.source.endIdx - field.children[2].sourceString.length,
        class: 'cm-property'
      }
    ];
  }
});

// Export highlighting function
export function highlightWEFT(editor) {
  const doc = editor.getDoc();
  const source = doc.getValue();

  // Clear existing WEFT marks
  doc.getAllMarks().forEach(mark => {
    if (mark.className && mark.className.startsWith('cm-')) {
      mark.clear();
    }
  });

  try {
    const match = grammar.match(source);
    if (!match.succeeded()) {
      console.warn('WEFT parse failed:', match.message);
      return;
    }

    // Collect all tokens to highlight
    const tokens = semantics(match).highlight();

    // Apply marks
    tokens.forEach(token => {
      if (token.end > token.start) {
        const from = doc.posFromIndex(token.start);
        const to = doc.posFromIndex(token.end);
        doc.markText(from, to, { className: token.class });
      }
    });
  } catch (e) {
    console.error('WEFT highlighting error:', e);
  }
}
