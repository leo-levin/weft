import { ASTNode, BinaryExpr, UnaryExpr, CallExpr, VarExpr, NumExpr, StrExpr,
  MeExpr, MouseExpr, TupleExpr, IndexExpr, StrandAccessExpr, StrandRemapExpr, IfExpr,
  LetBinding, Assignment, NamedArg, DisplayStmt, RenderStmt, PlayStmt, ComputeStmt,
  SpindleDef, InstanceBinding, Program
} from '../ast/ast-node.js';

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

    pragmaType = "slider" | "color" | "xy" | "toggle" | "curve" | "badge"
    pragmaBody = (~"\\n" any)* "\\n"?

    space += lineComment | blockComment
    lineComment = "//" (~"\\n" any)*
    blockComment = "/*" (~"*/" any)* "*/"
  }
  `);

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
      const allStatements = stmts.toAST();
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

  InstanceBinding_direct(name, _sp1, outputs, _sp2, _eq, _sp3, expr) {
    return new InstanceBinding(
      name.toAST(),
      outputs.toAST(),
      expr.toAST()
    );
  },

  InstanceBinding_call(func, _lp, args, _rp, _dc, inst, outputs) {
    return new InstanceBinding(
      inst.toAST(),
      outputs.toAST(),
      new CallExpr(func.toAST(), args.toAST())
    );
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
});

export class Parser {
  parse(source) {
    const match = grammar.match(source);
    if (match.failed()) {
      throw new Error(match.message);
    }
    return semantics(match).toAST();
  }
}

export function parse(source) {
  return new Parser().parse(source);
}
