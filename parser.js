
(() => {
  const externalEl = typeof document !== 'undefined' && document.getElementById('weft-grammar');
  const externalSrc = externalEl ? externalEl.textContent : null;

  const fallbackGrammar = String.raw`
Weft {
  Program        = space* (Stmt space*)*             --top

  Stmt           = SpindleDef
                 | DisplayStmt
                 | Direct
                 | CallInstance
                 | EnvStmt

  DisplayStmt    = kw<"display"> sym<"("> ArgList? sym<")">
  SpindleDef     = kw<"spindle"> ident sym<"("> ParamList? sym<")"> sym<"::"> Outputs Block
  ParamList      = ident (sym<","> ident)*
  Outputs        = sym<"<"> IdentList sym<">">
  IdentList      = ident (sym<","> ident)*
  AliasedOutputs = sym<"<"> AliasedIdentList sym<">">
  AliasedIdentList = AliasedIdent (sym<","> AliasedIdent)*
  AliasedIdent   = ident sym<":"> ident  --alias
                 | ident                 --normal

  Block          = sym<"{"> BodyStmt* sym<"}">
  BodyStmt       = LetStmt | ForStmt | AssignStmt

  LetStmt        = kw<"let"> ident sym<"="> Exp
  AssignStmt     = ident AssignOp Exp
  AssignOp       = sym<"="> | sym<"+="> | sym<"-="> | sym<"*="> | sym<"/=">

  ForStmt        = kw<"for"> ident kw<"in"> sym<"("> Exp kw<"to"> Exp sym<")"> Block

  Direct         = ident space* Outputs space* sym<"="> space* Exp
  CallInstance   = ident sym<"("> ArgList? sym<")"> sym<"::"> ident AliasedOutputs
  EnvStmt        = kw<"me"> sym<"."> ident sym<"==="> Exp
  ArgList        = Exp (sym<","> Exp)*

  Exp            = IfExp | OrExp
  IfExp          = kw<"if"> Exp kw<"then"> Exp kw<"else"> Exp

  OrExp          = OrExp kw<"or"> AndExp   --or
                 | AndExp
  AndExp         = AndExp kw<"and"> CmpExp --and
                 | CmpExp
  CmpExp         = CmpExp CmpOp AddExp     --bin
                 | AddExp
  CmpOp          = sym<"==="> | sym<"=="> | sym<"!="> | sym<"<="> | sym<">="> | sym<"<"> | sym<">">

  AddExp         = AddExp AddOp MulExp     --bin
                 | MulExp
  AddOp          = sym<"+"> | sym<"-">

  MulExp         = MulExp MulOp PowExp     --bin
                 | PowExp
  MulOp          = sym<"*"> | sym<"/"> | sym<"%">

  PowExp         = Unary sym<"^"> PowExp   --pow
                 | Unary

  Unary          = sym<"-"> Unary          --neg
                 | kw<"not"> Unary         --not
                 | Primary

  Primary        = sym<"("> TupleInner sym<")">          --tuple
                 | sym<"("> Exp sym<")">                 --paren
                 | number
                 | string
                 | kwMe                                   --me
                 | kwMouse                                --mouse
                 | ident sym<"@"> ident                   --strand
                 | ident sym<"("> ArgList? sym<")">       --call
                 | ident                                   --var

  TupleInner     = Exp (sym<","> Exp)*

  kwMe           = kw<"me"> sym<"."> ident
  kwMouse        = kw<"mouse"> sym<"@"> ident

  ident          = ~keyword letter identRest* space*
  identRest      = letter | digit | "_"
  keyword        = "spindle" | "if" | "then" | "else" | "not" | "and" | "or" | "display" | "let" | "for" | "in" | "to" | "me" | "mouse"

  number         = numCore space*
  numCore        = digit+ "." digit* expPart?    --d1
                 | "." digit+ expPart?           --d2
                 | digit+ expPart?               --d3
  expPart        = ("e" | "E") ("+" | "-")? digit+

  string         = "\"" (~"\"" any)* "\"" space*

  sym<tok>       = tok space*
  kw<word>       = word ~identRest space*

  space += lineComment | blockComment
  lineComment = "//" (~"\n" any)*
  blockComment   = "/*" (~"*/" any)* "*/"
}
`;

  const grammarSrc = externalSrc && externalSrc.trim() ? externalSrc : fallbackGrammar;
  let g;
  try {
    g = ohm.grammar(grammarSrc);
  } catch (e) {
    console.error('🧨 Ohm grammar parse error:', e.message);
    throw e;
  }

  const sem = g.createSemantics().addOperation('ast', {
    Program_top(_sp1, stmts, _sp2) { return { type: 'Program', body: stmts.children.map(s => s.children[0].ast()) }; },

    SpindleDef(_kw, name, _lp, params, _rp, _dc, outs, body) {
      return { type: 'SpindleDef', name: name.sourceString.trim(),
               params: params.numChildren > 0 ? params.ast() : [],
               outs: outs.ast(), body: body.ast() };
    },
    ParamList(first, _sep, rest) {
      const items = [first.sourceString.trim()];
      if (rest && rest.children) {
        rest.children.forEach(item => {
          items.push(item.ast());
        });
      }
      return items;
    },
    Outputs(_lt, ids, _gt) { return ids.ast(); },
    IdentList(first, _sep, rest) {
      const items = [first.sourceString.trim()];
      if (rest && rest.children) {
        rest.children.forEach(item => {
          items.push(item.ast());
        });
      }
      return items;
    },
    AliasedOutputs(_lt, ids, _gt) { return ids.ast(); },
    AliasedIdentList(first, _sep, rest) {
      const items = [first.ast()];
      if (rest && rest.children) {
        rest.children.forEach(item => {
          items.push(item.ast());
        });
      }
      return items;
    },
    AliasedIdent_alias(alias, _colon, actual) {
      return { type: 'AliasedIdent', alias: alias.sourceString.trim(), actual: actual.sourceString.trim() };
    },
    AliasedIdent_normal(id) {
      return { type: 'NormalIdent', name: id.sourceString.trim() };
    },

    Block(_l, stmts, _r) { return { type: 'Block', body: stmts.ast() }; },

    LetStmt(_let, id, _eq, expr) { return { type: 'Let', name: id.sourceString.trim(), expr: expr.ast() }; },
    AssignStmt(id, op, expr) { return { type: 'Assign', name: id.sourceString.trim(), op: op.sourceString.trim(), expr: expr.ast() }; },

    ForStmt(_for, v, _in, _lp, start, _to, end, _rp, block) {
      return { type: 'For', v: v.sourceString.trim(), start: start.ast(), end: end.ast(), body: block.ast() };
    },

    Direct(name, _sp1, outs, _sp2, _eq, _sp3, expr) { return { type: 'Direct', name: name.sourceString.trim(), outs: outs.ast(), expr: expr.ast() }; },
    EnvStmt(_me, _dot, field, _eq, expr) { return { type: 'EnvStmt', field: field.sourceString.trim(), expr: expr.ast() }; },
    CallInstance(callee, _lp, args, _rp, _dc, inst, outs) {
      let argList = [];
      if (args.numChildren > 0) {
        const rawArgs = args.ast();
        argList = Array.isArray(rawArgs) && Array.isArray(rawArgs[0]) ? rawArgs[0] : rawArgs;
      }
      return { type: 'CallInstance', callee: callee.sourceString.trim(),
               args: argList,
               inst: inst.sourceString.trim(), outs: outs.ast() };
    },
    DisplayStmt(_kw, _lp, args, _rp) {
      if (args.numChildren === 0) {
        return { type: 'Display', args: [] };
      }
      // args.ast() returns a nested array, so unwrap it
      const argList = args.ast();
      const flatArgs = Array.isArray(argList) && Array.isArray(argList[0]) ? argList[0] : argList;
      return { type: 'Display', args: flatArgs };
    },
    ArgList(first, _sep, rest) {
      const items = [first.ast()];
      if (rest && rest.children) {
        rest.children.forEach(ch => {
          items.push((ch.children && ch.children[1]) ? ch.children[1].ast() : ch.ast());
        });
      }
      return items;
    },

    IfExp(_if, c, _then, t, _else, e) { return { type: 'If', cond: c.ast(), t: t.ast(), e: e.ast() }; },
    OrExp_or(l, _or, r)  { return { type: 'Bin', op: 'OR',  left: l.ast(), right: r.ast() }; },
    AndExp_and(l, _and, r){ return { type: 'Bin', op: 'AND', left: l.ast(), right: r.ast() }; },
    CmpExp_bin(l, op, r) { return { type: 'Bin', op: op.sourceString.trim(), left: l.ast(), right: r.ast() }; },
    AddExp_bin(l, op, r) { return { type: 'Bin', op: op.sourceString.trim(), left: l.ast(), right: r.ast() }; },
    MulExp_bin(l, op, r) { return { type: 'Bin', op: op.sourceString.trim(), left: l.ast(), right: r.ast() }; },
    PowExp_pow(l, _caret, r) { return { type: 'Bin', op: '^', left: l.ast(), right: r.ast() }; },

    Unary_neg(_m, e) { return { type: 'Unary', op: '-',   expr: e.ast() }; },
    Unary_not(_n, e) { return { type: 'Unary', op: 'NOT', expr: e.ast() }; },

    Primary_paren(_l, e, _r)  { return e.ast(); },
    Primary_tuple(_l, items, _r) {
      const itemsArray = items.ast();
      if (itemsArray.length === 1) {
        return itemsArray[0];
      }
      return { type: 'Tuple', items: itemsArray };
    },

    TupleInner(first, _sep, rest) {
      const out = [first.ast()];
      if (rest && rest.children) {
        rest.children.forEach(ch => {
          out.push((ch.children && ch.children[1]) ? ch.children[1].ast() : ch.ast());
        });
      }
      return out;
    },

    number(numCore, _sp) { return { type: 'Num', v: parseFloat(numCore.sourceString) }; },

    string(_q1, _chars, _q2, _sp) {
      const raw = this.sourceString;
      return { type: 'Str', v: raw.slice(1, -1).replace(/\\"/g, '"') };
    },

    kwMe(_me, _dot, field) { return { type: 'Me', field: field.sourceString.trim() }; },
    kwMouse(_mouse, _at, field) { return { type: 'Mouse', field: field.sourceString.trim() }; },

    Primary_strand(base, _at, out) { return { type: 'StrandAccess', base: base.sourceString.trim(), out: out.sourceString.trim() }; },
    Primary_call(name, _lp, args, _rp) { return { type: 'Call', name: name.sourceString.trim(), args: args.numChildren > 0 ? args.ast() : [] }; },
    Primary_var(name) { return { type: 'Var', name: name.sourceString.trim() }; },

    ident(_kw, _letter, _rest) { return this.sourceString.trim(); },
    _iter(...xs) { return xs.map(x => x.ast()); }
  });

  class Parser {
    static parse(src) {
      const m = g.match(src, 'Program');
      if (!m.succeeded()) throw new Error(m.message);
      return sem(m).ast();
    }
  }
  window.Parser = Parser;
})();