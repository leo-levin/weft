import { ASTNode, BinaryExpr, UnaryExpr, CallExpr, VarExpr, NumExpr, StrExpr,
  MeExpr, MouseExpr, TupleExpr, IndexExpr, StrandAccessExpr, StrandRemapExpr, IfExpr,
  LetBinding, Assignment, NamedArg, DisplayStmt, RenderStmt, PlayStmt, ComputeStmt,
  SpindleDef, InstanceBinding, Program
} from './ast-node.js';
import { match, _, inst } from '../utils/match.js';

const ohm = window.ohm;

const grammar = ohm.grammar(`
  Weft {
    Program = Statement*

    Statement = Pragma
              | Definition
              | EnvAssignment
              | Binding
              | SideEffect

    Pragma = "#" pragmaType pragmaBody

    EnvAssignment = kw<"me"> sym<"<"> ident sym<">"> sym<"="> Expr
    Definition = SpindleDef
    SpindleDef = kw<"spindle"> ident sym<"("> ListOf<ident, ","> sym<")"> sym<"::"> OutputSpec Block

    Binding = InstanceBinding    // func()::inst<outputs> or name<outputs> = expr

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
    BlockStatement = OutputAssignment | Assignment | ForLoop
    OutputAssignment = kw<"out"> ident sym<"="> Expr
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
            | "display" | "render" | "play" | "compute" | "let" | "out" | "for" | "in" | "to" | "mouse"

    number = numCore space*
    numCore = digit+ "." digit* expPart?    -- d1
            | "." digit+ expPart?           -- d2
            | digit+ expPart?               -- d3
    expPart = ("e" | "E") ("+" | "-")? digit+

    string = "\\"" (~"\\"" any)* "\\"" space*

    sym<tok> = tok space*
    kw<word> = word ~identRest space*

    pragmaType = "slider" | "color" | "xy" | "toggle" | "curve" | "badge"
    pragmaBody = (~"\\n" any)* "\\n"?

    space += lineComment | blockComment
    lineComment = "//" (~"\\n" any)*
    blockComment = "/*" (~"*/" any)* "*/"

    tokens = (pragma | keyword | specialIdent | ident | number | string | comment | strandOp | instanceOp | operator | bracket | punctuation | any)*

    // Comments
    comment = lineComment | blockComment

    // Pragmas
    pragma = "#" pragmaType

    // Special identifiers that deserve their own highlighting
    specialIdent = (("me" | "mouse") ~identRest) space*

    // Operators - ordered from most specific to least specific
    strandOp = sym<"@">          // Strand access operator
    instanceOp = sym<"::">        // Instance binding operator
    remapOp = sym<"~">           // Axis remapping operator

    operator = sym<"==="> | sym<"=="> | sym<"!=">          // Comparison
             | sym<"<<="> | sym<">>="> | sym<"<<"> | sym<">>">  // Bit shift (if used)
             | sym<"+="> | sym<"-="> | sym<"*="> | sym<"/=">    // Assignment operators
             | sym<"^">                                         // Power operator
             | sym<"+"> | sym<"-"> | sym<"*"> | sym<"/"> | sym<"%">  // Arithmetic
             | sym<"<="> | sym<">="> | sym<"<"> | sym<">">      // Comparison
             | sym<"=">                                         // Assignment

    // Brackets
    bracket = sym<"("> | sym<")">
            | sym<"["> | sym<"]">
            | sym<"{"> | sym<"}">
            | sym<"<"> | sym<">">  // Also used in output specs and bundles

    // Punctuation
    punctuation = sym<","> | sym<";">
  }
  `);

function expandInstancesInExpr(node, index) {
  if (!node) return node;

  return match(node,
    inst(VarExpr, _), (name) =>
      new StrandAccessExpr(new VarExpr(name), index),
    inst(BinaryExpr, _, _, _), (op, left, right) =>
      new BinaryExpr(
        op,
        expandInstancesInExpr(left, index),
        expandInstancesInExpr(right, index)
      ),
    inst(UnaryExpr, _, _), (op, expr) =>
      new UnaryExpr(
        op,
        expandInstancesInExpr(expr, index)
      ),
    inst(CallExpr, _, _), (name, args) =>
      new CallExpr(
        name,
        args.map(arg => expandInstancesInExpr(arg, index))
      ),
    inst(IfExpr, _, _, _), (condition, thenExpr, elseExpr) =>
      new IfExpr(
        expandInstancesInExpr(condition, index),
        expandInstancesInExpr(thenExpr, index),
        expandInstancesInExpr(elseExpr, index)
      ),
    _, (n) => n
  );
}

const semantics = grammar.createSemantics()
  .addOperation('toAST', {
    // Handle iteration nodes (*, +, ?)
    _iter(...children) {
      return children.map(c => c.toAST());
    },

    // Handle ListOf and NonemptyListOf
    NonemptyListOf(first, _sep, rest) {
      return [first.toAST(), ...rest.toAST()];
    },

    EmptyListOf() {
      return [];
    },

    Program(stmts) {
      const allStatements = stmts.toAST().flat();
      const pragmas = allStatements.filter(s => s.type === 'Pragma');
      const statements = allStatements.filter(s => s.type !== 'Pragma');

      const program = new Program(statements);
      program.pragmas = pragmas.map(p => this.parsePragmaConfig(p));
      return program;
    },

  // ======== STATEMENTS ========
  Pragma(_hash, type, body) {
    return {
      type: 'Pragma',
      pragmaType: type.sourceString,
      body: body.sourceString.trim()
    };
  },

  EnvAssignment(_me, _lt, field, _gt, _eq, expr) {
    return {
      type: 'EnvAssignment',
      field: field.toAST(),
      value: expr.toAST()
    };
  },

  SpindleDef(_kw, name, _lp, params, _rp, _dc, outputs, block) {
    return new SpindleDef(
      name.toAST(),
      params.toAST(),
      outputs.toAST(),
      block.toAST()
    );
  },

  LetBinding(_kw, name, _eq, expr) {
    return new LetBinding(name.toAST(), expr.toAST());
  },

  OutputAssignment(_out, name, _eq, expr) {
    const assignment = new Assignment(name.toAST(), '=', expr.toAST());
    assignment.isOutput = true;
    return assignment;
  },

  InstanceBinding_direct(name, _sp1, outputs, _sp2, _eq, _sp3, expr) {
    const instName = name.toAST();
    const outputList = outputs.toAST();
    const exprAST = expr.toAST();

    if(exprAST.type == 'Bundle') {
      const items = exprAST.items;
      if(items.length !== 1 && items.length !== outputList.length) {
        throw new Error(`Instance has length ${items.length} items but ${outputList.length} outputs`);
      }
      const exprs = items.length === 1
      ? Array(outputList.length).fill(items[0]) : items;

      return outputList.map((out, i) =>
        new InstanceBinding(instName, [out], exprs[i]));
    }

    // For multi-output directs, expand potential instances component-wise
    return outputList.map((out, i) => {
      const expandedExpr = expandInstancesInExpr(exprAST, i);
      return new InstanceBinding(instName, [out], expandedExpr);
    });
  },

  InstanceBinding_call(func, _lp, args, _rp, _dc, inst, outputs) {
    return new InstanceBinding(
      inst.toAST(),
      outputs.toAST(),
      new CallExpr(func.toAST(), args.toAST())
    );
  },

  InstanceBinding_multiCall(func, _lt, countNode, _gt, _lp, args, _rp, _dc, inst, outputs) {
    const count = parseInt(countNode.sourceString);
    const funcName = func.toAST();
    const instName = inst.toAST();
    const outputList = outputs.toAST();
    const argList = args.toAST();

    if (outputList.length !== count) {
      throw new Error(
        `Multi-call count <${count}> doesn't match ${outputList.length} outputs`
      );
    }

    const expandedArgs = argList.map(arg => {
      if (arg.type === 'Bundle') {
        const items = arg.items;
        if (items.length !== 1 && items.length !== count) {
          throw new Error(`Bundle has ${items.length} items, expected 1 or ${count}`);
        }
        return items.length === 1 ? Array(count).fill(items[0]) : items;
      }

      if (arg.type === 'Var') {
        return Array.from({length: count}, (_, i) =>
          new StrandAccessExpr(arg, i)
        );
      }
      return Array(count).fill(arg);
    });

    return Array.from({length: count}, (_, i) => {
      const callArgs = expandedArgs.map(expanded => expanded[i]);
      return new InstanceBinding(
        instName,
        [outputList[i]],
        new CallExpr(funcName, callArgs)
      );
    });
  },

  Assignment(name, op, expr) {
    return new Assignment(name.toAST(), op.sourceString, expr.toAST());
  },

  DisplayStmt(_kw, _lp, args, _rp) {
    return new DisplayStmt(args.toAST());
  },

  RenderStmt(_kw, _lp, args, _rp) {
    return new RenderStmt(args.toAST());
  },

  PlayStmt(_kw, _lp, args, _rp) {
    return new PlayStmt(args.toAST());
  },

  ComputeStmt(_kw, _lp, args, _rp) {
    return new ComputeStmt(args.toAST());
  },

  // ======== STMT ARGS ========
  StmtArg_named(name, _colon, expr) {
    return new NamedArg(name.toAST(), expr.toAST());
  },

  StmtArg_positional(expr) {
    return expr.toAST();
  },

  // ======== BLOCKS + CONTROL ========
  Block(_lb, stmts, _rb) {
    return {
      type: 'Block',
      body: stmts.toAST()
    };
  },

  ForLoop(_for, v, _in, _lp, start, _to, end, _rp, block) {
    return {
      type: 'For',
      v: v.toAST(),
      start: start.toAST(),
      end: end.toAST(),
      body: block.toAST()
    };
  },

  // ======== LOGIC ========
  IfExpr(_if, cond, _then, t, _else, e) {
    return new IfExpr(cond.toAST(), t.toAST(), e.toAST());
  },

  LogicalExpr_or(left, _op, right) {
    return new BinaryExpr('OR', left.toAST(), right.toAST());
  },

  LogicalExpr_and(left, _op, right) {
    return new BinaryExpr('AND', left.toAST(), right.toAST());
  },

  ComparisonExpr_compare(left, op, right) {
    return new BinaryExpr(op.sourceString.trim(), left.toAST(), right.toAST());
  },

  // ======== Arithmetic ========
  AddExpr_addsub(left, op, right) {
    return new BinaryExpr(op.sourceString.trim(), left.toAST(), right.toAST());
  },

  MulExpr_muldiv(left, op, right) {
    return new BinaryExpr(op.sourceString.trim(), left.toAST(), right.toAST());
  },

  PowerExpr_power(left, _op, right) {
    return new BinaryExpr('^', left.toAST(), right.toAST());
  },

  UnaryExpr_neg(_op, expr) {
    return new UnaryExpr('-', expr.toAST());
  },

  UnaryExpr_not(_op, expr) {
    return new UnaryExpr('NOT', expr.toAST());
  },

  // ======== PRIMARIES ========
  PrimaryExpr_paren(_lp, expr, _rp) {
    return expr.toAST();
  },

  PrimaryExpr_tuple(_lp, items, _rp) {
    const list = items.toAST();
    return list.length === 1 ? list[0] : new TupleExpr(list);
  },

  PrimaryExpr_index(base, _lb, index, _rb) {
    return new IndexExpr(base.toAST(), index.toAST());
  },

  PrimaryExpr_strandRemap(base, _at, strand, _lp, mappings, _rp) {
    return new StrandRemapExpr(
      new VarExpr(base.toAST()),
      strand.toAST(),
      mappings.toAST()
    );
  },

  PrimaryExpr_strand(base, _at, output) {
    // Special case: me@field → MeExpr
    if (base.toAST() === 'me') {
      return new MeExpr(output.toAST());
    }
    // Regular strand access
    return new StrandAccessExpr(
      new VarExpr(base.toAST()),
      output.toAST()
    );
  },

  PrimaryExpr_call(func, _lp, args, _rp) {
    return new CallExpr(func.toAST(), args.toAST());
  },

  PrimaryExpr_bundle(_lt, items, _gt) {
    return {
      type: 'Bundle',
      items: items.toAST()
    };
  },

  PrimaryExpr_mouse(_mouse, _at, field) {
    return new MouseExpr(field.toAST());
  },

  PrimaryExpr_var(name) {
    return new VarExpr(name.toAST());
  },

  // ======== TERMINALS ========
  ident(letter, rest, _space) {
    return letter.sourceString + rest.sourceString;
  },

  number(_digits, _space) {
    return new NumExpr(parseFloat(this.sourceString));
  },

  string(_q1, chars, _q2, _space) {
    return new StrExpr(chars.sourceString);
  },

  // ======== HELPERS ========
  AxisMapping(sourceExpr, _tilde, targetExpr) {
    return {
      source: sourceExpr.toAST(),
      target: targetExpr.toAST()
    };
  },

  OutputSpec(_lt, items, _gt) {
    return items.toAST();
  },

  BundleOrExpr_bundle(_lt, items, _gt) {
    return { type: 'Bundle', items: items.toAST() };
  },

  BundleOrExpr_regular(expr) {
    return expr.toAST();
  },

  // ======== DELEGATION ========
  Expr(node) {
    return node.toAST();
  },

  LogicalExpr(node) {
    return node.toAST();
  },

  ComparisonExpr(node) {
    return node.toAST();
  },

  ArithExpr(node) {
    return node.toAST();
  },

  AddExpr(node) {
    return node.toAST();
  },

  MulExpr(node) {
    return node.toAST();
  },

  PowerExpr(node) {
    return node.toAST();
  },

  UnaryExpr(node) {
    return node.toAST();
  },

  PrimaryExpr(node) {
    return node.toAST();
  }
})
.addOperation('syntaxHighlight', {
  // Main tokens rule
  tokens(iter) {
    return iter.children.map(c => c.syntaxHighlight()).join('');
  },

  // Iteration nodes
  _iter(...children) {
    return children.map(c => c.syntaxHighlight()).join('');
  },

  // Terminal nodes
  _terminal() {
    return this.sourceString;
  },

  // Pragmas
  pragma(_hash, type) {
    const text = this.sourceString;
    return `<span class="weft-pragma">${escapeHtml(text)}</span>`;
  },

  // Keywords
  keyword(_) {
    const text = this.sourceString;
    return `<span class="weft-keyword">${escapeHtml(text)}</span>`;
  },

  // Special identifiers (me, mouse)
  specialIdent(word, _space) {
    const text = this.sourceString;
    return `<span class="weft-special-ident">${escapeHtml(text)}</span>`;
  },

  // Identifiers
  ident(letter, rest, _space) {
    const text = this.sourceString;
    return `<span class="weft-ident">${escapeHtml(text)}</span>`;
  },

  // Numbers
  number(_digits, _space) {
    const text = this.sourceString;
    return `<span class="weft-number">${escapeHtml(text)}</span>`;
  },

  // Strings
  string(_q1, chars, _q2, _space) {
    const text = this.sourceString;
    return `<span class="weft-string">${escapeHtml(text)}</span>`;
  },

  // Comments
  comment(c) {
    const text = this.sourceString;
    return `<span class="weft-comment">${escapeHtml(text)}</span>`;
  },

  lineComment(_slash, _rest) {
    const text = this.sourceString;
    return `<span class="weft-comment">${escapeHtml(text)}</span>`;
  },

  blockComment(_open, _content, _close) {
    const text = this.sourceString;
    return `<span class="weft-comment">${escapeHtml(text)}</span>`;
  },

  // Strand access operator (@)
  strandOp(_at) {
    const text = this.sourceString;
    return `<span class="weft-strand-access">${escapeHtml(text)}</span>`;
  },

  // Instance binding operator (::)
  instanceOp(_colon) {
    const text = this.sourceString;
    return `<span class="weft-instance-binding">${escapeHtml(text)}</span>`;
  },

  // Remap operator (~)
  remapOp(_tilde) {
    const text = this.sourceString;
    return `<span class="weft-remap">${escapeHtml(text)}</span>`;
  },

  // Generic operators
  operator(op) {
    const text = this.sourceString;
    return `<span class="weft-operator">${escapeHtml(text)}</span>`;
  },

  // Brackets
  bracket(b) {
    const text = this.sourceString;
    return `<span class="weft-bracket">${escapeHtml(text)}</span>`;
  },

  // Punctuation
  punctuation(p) {
    const text = this.sourceString;
    return `<span class="weft-punctuation">${escapeHtml(text)}</span>`;
  },

  // Pragma types
  pragmaType(_) {
    const text = this.sourceString;
    return `<span class="weft-pragma">${escapeHtml(text)}</span>`;
  },

  // Default for any other node
  _nonterminal(...children) {
    return children.map(c => c.syntaxHighlight()).join('');
  }
});

// Helper function to escape HTML
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export class Parser {
  parse(source) {
    const match = grammar.match(source);
    if (match.failed()) {
      throw new Error(match.message);
    }
    return semantics(match).toAST();
  }

  // Generate syntax-highlighted HTML from source code
  static highlightSyntax(source) {
    const match = grammar.match(source, 'tokens');
    if (match.failed()) {
      // If matching fails, return escaped source
      return escapeHtml(source);
    }
    return semantics(match).syntaxHighlight();
  }
}

export function parse(source) {
  return new Parser().parse(source);
}

export function highlightSyntax(source) {
  return Parser.highlightSyntax(source);
}
