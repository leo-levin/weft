import {
  ASTNode, BinaryExpr, UnaryExpr, CallExpr, VarExpr, NumExpr, StrExpr,
  MeExpr, MouseExpr, TupleExpr, IndexExpr, StrandAccessExpr, IfExpr,
  LetBinding, Assignment, NamedArg, OutputStatement, DisplayStmt, RenderStmt, PlayStmt, ComputeStmt,
  SpindleDef, InstanceBinding, Program
} from '../ast/ast-node.js';

// Access ohm from global scope (loaded via script tag)
const ohm = window.ohm || globalThis.ohm;

const externalEl = typeof document !== 'undefined' && document.getElementById('weft-grammar');
const externalSrc = externalEl ? externalEl.textContent : null;

const fallbackGrammar = String.raw`
Weft {
  Program = Statement*

  // MECE Statement Categories
  Statement = Definition
            | Binding
            | Mutation
            | SideEffect

  Definition = SpindleDef
  SpindleDef = kw<"spindle"> ident sym<"("> ListOf<ident, ","> sym<")"> sym<"::"> OutputSpec Block

  Binding = LetBinding         // let x = expr
          | InstanceBinding    // func()::inst<outputs> or name<outputs> = expr

  LetBinding = kw<"let"> ident sym<"="> Expr
  InstanceBinding = ident space* OutputSpec space* sym<"="> space* Expr  -- direct
                  | ident sym<"("> ListOf<Expr, ","> sym<")"> sym<"::"> ident OutputSpec -- call
                  | ident sym<"<"> digit+ sym<">"> sym<"("> ListOf<BundleOrExpr, ","> sym<")"> sym<"::"> ident OutputSpec -- multiCall

  Mutation = Assignment | EnvAssignment
  Assignment = ident AssignOp Expr
  AssignOp = sym<"="> | sym<"+="> | sym<"-="> | sym<"*="> | sym<"/=">
  EnvAssignment = kw<"me"> sym<"."> ident sym<"==="> Expr

  SideEffect = RenderStmt | PlayStmt | ComputeStmt

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
              | ident sym<"@"> ident                            -- strand
              | ident sym<"("> ListOf<Expr, ","> sym<")">       -- call
              | sym<"<"> ListOf<Expr, ","> sym<">">             -- bundle
              | kw<"me"> sym<"."> ident                         -- env
              | kw<"mouse"> sym<"@"> ident                      -- mouse
              | ident                                           -- var
              | number
              | string


  ident = ~keyword letter identRest* space*
  identRest = letter | digit | "_"
  keyword = "spindle" | "if" | "then" | "else" | "not" | "and" | "or"
          | "render" | "play" | "compute" | "let" | "for" | "in" | "to" | "me" | "mouse"

  number = numCore space*
  numCore = digit+ "." digit* expPart?    -- d1
          | "." digit+ expPart?           -- d2
          | digit+ expPart?               -- d3
  expPart = ("e" | "E") ("+" | "-")? digit+

  string = "\"" (~"\"" any)* "\"" space*

  sym<tok> = tok space*
  kw<word> = word ~identRest space*

  space += lineComment | blockComment | pragmaComment
  lineComment = "//" (~"\n" any)*
  blockComment = "/*" (~"*/" any)* "*/"
  pragmaComment = "#" pragmaType pragmaBody "\n"?
  pragmaType = "slider" | "color" | "xy" | "toggle" | "curve" | "badge"
  pragmaBody = (~"\n" any)*
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

// Pragma parsing utility
function extractPragmas(sourceCode) {
  const pragmas = [];
  const lines = sourceCode.split('\n');

  lines.forEach((line, lineNum) => {
    const pragmaMatch = line.match(/^#(\w+)\s*(.*)/);
    if (pragmaMatch) {
      const [, type, body] = pragmaMatch;
      const pragma = { type, body: body.trim(), line: lineNum + 1 };

      // Parse pragma body based on type
      if (type === 'slider') {
        console.log(`🔍 Parsing slider pragma body: "${body}"`);
        // Updated regex to use = instead of :
        const sliderMatch = body.match(/(\w+)<(.+?)>\s*=\s*([0-9.,\s]+)\s+"(.+?)"/);
        console.log('🎯 Slider match result:', sliderMatch);

        if (sliderMatch) {
          const [, name, strands, rangeStr, label] = sliderMatch;

          // Parse range - handle both "0.1,5.0" and "0..1"
          let range;
          if (rangeStr.includes('..')) {
            range = rangeStr.split('..').map(r => parseFloat(r.trim()));
          } else if (rangeStr.includes(',')) {
            range = rangeStr.split(',').map(r => parseFloat(r.trim()));
          } else {
            range = [0, parseFloat(rangeStr.trim())];
          }

          console.log(`📊 Parsed range from "${rangeStr}":`, range);

          pragma.config = {
            name,
            strands: strands.split(',').map(s => s.trim()).filter(s => s.length > 0),
            range,
            label
          };

          console.log('✅ Parsed slider config:', pragma.config);
        } else {
          console.log('❌ Slider pragma did not match regex');
        }
      } else if (type === 'color') {
        console.log(`🎨 Parsing color pragma body: "${body}"`);
        const colorMatch = body.match(/(\w+)<(.+?)>\s*=\s*"(.+?)"/);
        console.log('🎯 Color match result:', colorMatch);

        if (colorMatch) {
          const [, name, strands, label] = colorMatch;
          pragma.config = {
            name,
            strands: strands.split(',').map(s => s.trim()).filter(s => s.length > 0),
            label,
            defaultValue: '#ff0000'
          };
          console.log('✅ Parsed color config:', pragma.config);
        } else {
          console.log('❌ Color pragma did not match regex');
        }
      } else if (type === 'xy') {
        console.log(`📐 Parsing xy pragma body: "${body}"`);
        const xyMatch = body.match(/(\w+)<(.+?)>\s*=\s*\(([0-9.,\s]+)\),\s*\(([0-9.,\s]+)\)\s+"(.+?)"/);
        console.log('🎯 XY match result:', xyMatch);

        if (xyMatch) {
          const [, name, strands, xRange, yRange, label] = xyMatch;

          // Parse X and Y ranges
          const xRangeParts = xRange.split(',').map(r => parseFloat(r.trim()));
          const yRangeParts = yRange.split(',').map(r => parseFloat(r.trim()));

          pragma.config = {
            name,
            strands: strands.split(',').map(s => s.trim()).filter(s => s.length > 0),
            xRange: xRangeParts,
            yRange: yRangeParts,
            label,
            defaultValue: { x: (xRangeParts[0] + xRangeParts[1]) / 2, y: (yRangeParts[0] + yRangeParts[1]) / 2 }
          };
          console.log('✅ Parsed XY config:', pragma.config);
        } else {
          console.log('❌ XY pragma did not match regex');
        }
      } else if (type === 'toggle') {
        console.log(`🔘 Parsing toggle pragma body: "${body}"`);
        const toggleMatch = body.match(/(\w+)<(.+?)>\s*=\s*(true|false)\s+"(.+?)"/);
        console.log('🎯 Toggle match result:', toggleMatch);

        if (toggleMatch) {
          const [, name, strands, defaultVal, label] = toggleMatch;
          pragma.config = {
            name,
            strands: strands.split(',').map(s => s.trim()).filter(s => s.length > 0),
            label,
            defaultValue: defaultVal === 'true'
          };
          console.log('✅ Parsed toggle config:', pragma.config);
        } else {
          console.log('❌ Toggle pragma did not match regex');
        }
      } else if (type === 'badge') {
        const badgeMatch = body.match(/(\w+)<(.+?)>/);
        if (badgeMatch) {
          const [, name, output] = badgeMatch;
          pragma.config = { name, output };
        }
      }

      pragmas.push(pragma);
    }
  });

  return pragmas;
}

// Bundle expansion will be handled in post-processing to avoid parser corruption

const sem = g.createSemantics().addOperation('ast', {
  Program(stmts) {
    // Simple single-pass parsing - no expansion during parse
    console.log(`🚀 Program parsing started with ${stmts.children.length} statements`);
    const statements = [];
    for (let i = 0; i < stmts.children.length; i++) {
      const stmt = stmts.children[i];
      console.log(`📝 Processing statement ${i + 1}: ${stmt.sourceString.substring(0, 50)}...`);
      try {
        const ast = stmt.ast();
        if (ast.type === 'MultiCallExpanded') {
          statements.push(...ast.statements);
        } else {
          statements.push(ast);
        }
        console.log(`✅ Statement ${i + 1} parsed successfully as ${ast.type}`);
      } catch (error) {
        console.error(`❌ Statement ${i + 1} failed to parse:`, error.message);
        throw error;
      }
    }
    return new Program(statements);
  },

  // Use Ohm's built-in ListOf handling
  ListOf(items) {
    return items.asIteration().children.map(c => c.ast());
  },
  EmptyListOf() {
    return [];
  },
  NonemptyListOf(first, _sep, rest) {
    return [first.ast(), ...rest.children.map(r => r.ast())];
  },

    // Definitions
    SpindleDef(_kw, name, _lp, params, _rp, _dc, outs, body) {
      return {
        type: 'SpindleDef',
        name: name.ast(),
        params: params.ast(),
        outs: outs.ast(),
        body: body.ast()
      };
    },

    // Bindings
    LetBinding(_let, name, _eq, expr) {
      return { type: 'Let', name: name.ast(), expr: expr.ast() };
    },

    InstanceBinding_direct(name, _sp1, outputs, _sp2, _eq, _sp3, expr) {
      // Parse as regular Direct statement - expansion happens in post-processing
      console.log(`📋 Parsing direct: ${name.sourceString} with outputs: ${outputs.sourceString} = ${expr.sourceString}`);
      return {
        type: 'Direct',
        name: name.ast(),
        outs: outputs.ast(),
        expr: expr.ast()
      };
    },

    InstanceBinding_call(func, _lp, args, _rp, _dc, inst, outputs) {
      // Parse as regular call - expansion happens in post-processing
      console.log(`🔧 Parsing call: ${func.sourceString} with args: ${args.sourceString}`);
      return {
        type: 'CallInstance',
        callee: func.ast(),
        args: args.ast(),
        inst: inst.ast(),
        outs: outputs.ast()
      };
    },

    InstanceBinding_multiCall(spindleName, _lt, countDigits, _gt, _lp, args, _rp, _dc, instName, outputs) {
      const count = parseInt(countDigits.sourceString);
      const parsedArgs = args.ast();
      const outputStrands = outputs.ast();
      
      // Validate output count matches repetition count
      if (outputStrands.length !== count) {
        throw new Error(`Output bundle has ${outputStrands.length} strands, expected ${count} to match repetition count`);
      }
      
      // Parse arguments - identify bundles vs regular args vs thread inputs
      const argStructure = parsedArgs.map((arg, index) => {
        if (arg.type === 'Bundle') {
          if (arg.items.length !== count) {
            throw new Error(`Bundle parameter ${index + 1} has ${arg.items.length} elements, expected ${count} to match repetition count`);
          }
          return { isBundle: true, items: arg.items };
        } else if (arg.type === 'Var') {
          // This might be a thread input - we'll expand it to strand accesses
          return { isThread: true, threadName: arg.name, outputStrands: outputStrands };
        }
        return { isRegular: true, value: arg };
      });
      
      // Generate individual CallInstance nodes
      const statements = [];
      for (let i = 0; i < count; i++) {
        const expandedArgs = argStructure.map(arg => {
          if (arg.isBundle) {
            return arg.items[i];
          } else if (arg.isThread) {
            // Expand thread input to strand access: threadName@outputStrand[i]
            return {
              type: 'StrandAccess',
              base: { type: 'Var', name: arg.threadName },
              out: arg.outputStrands[i]
            };
          } else {
            return arg.value;
          }
        });
        
        statements.push({
          type: 'CallInstance',
          callee: spindleName.ast(),
          args: expandedArgs,
          inst: instName.ast(),
          outs: [outputStrands[i]]
        });
      }
      
      // Return a compound statement containing all expanded calls
      return {
        type: 'MultiCallExpanded',
        statements: statements
      };
    },

    // Mutations
    Assignment(name, op, expr) {
      return {
        type: 'Assign',
        name: name.ast(),
        op: op.sourceString.trim(),
        expr: expr.ast()
      };
    },

    EnvAssignment(_me, _dot, field, _eq, expr) {
      return { type: 'EnvStmt', field: field.ast(), expr: expr.ast() };
    },

    // Side Effects
    RenderStmt(_kw, _lp, args, _rp) {
      return new RenderStmt(args.ast());
    },

    PlayStmt(_kw, _lp, args, _rp) {
      return new PlayStmt(args.ast());
    },

    ComputeStmt(_kw, _lp, args, _rp) {
      return new ComputeStmt(args.ast());
    },

    StmtArg_named(name, _colon, expr) {
      return new NamedArg(name.ast(), expr.ast());
    },

    StmtArg_positional(expr) {
      return expr.ast();
    },

    // Output Specifications
    OutputSpec(_lt, items, _gt) {
      return items.ast();
    },

    // Blocks
    Block(_lb, stmts, _rb) {
      return { type: 'Block', body: stmts.children.map(s => s.ast()) };
    },

    ForLoop(_for, v, _in, _lp, start, _to, end, _rp, block) {
      return {
        type: 'For',
        v: v.ast(),
        start: start.ast(),
        end: end.ast(),
        body: block.ast()
      };
    },

    // Expressions
    IfExpr(_if, cond, _then, t, _else, e) {
      return { type: 'If', cond: cond.ast(), t: t.ast(), e: e.ast() };
    },

    LogicalExpr_or(left, _op, right) {
      return { type: 'Bin', op: 'OR', left: left.ast(), right: right.ast() };
    },

    LogicalExpr_and(left, _op, right) {
      return { type: 'Bin', op: 'AND', left: left.ast(), right: right.ast() };
    },

    ComparisonExpr_compare(left, op, right) {
      return { type: 'Bin', op: op.sourceString.trim(), left: left.ast(), right: right.ast() };
    },

    AddExpr_addsub(left, op, right) {
      return { type: 'Bin', op: op.sourceString.trim(), left: left.ast(), right: right.ast() };
    },

    MulExpr_muldiv(left, op, right) {
      return { type: 'Bin', op: op.sourceString.trim(), left: left.ast(), right: right.ast() };
    },

    PowerExpr_power(left, _op, right) {
      return { type: 'Bin', op: '^', left: left.ast(), right: right.ast() };
    },

    UnaryExpr_neg(_op, expr) {
      return { type: 'Unary', op: '-', expr: expr.ast() };
    },

    UnaryExpr_not(_op, expr) {
      return { type: 'Unary', op: 'NOT', expr: expr.ast() };
    },

    PrimaryExpr_paren(_lp, expr, _rp) {
      return expr.ast();
    },

    PrimaryExpr_tuple(_lp, items, _rp) {
      const list = items.ast();
      return list.length === 1 ? list[0] : { type: 'Tuple', items: list };
    },

    PrimaryExpr_index(base, _lb, index, _rb) {
      return { type: 'Index', base: base.ast(), index: index.ast() };
    },

    PrimaryExpr_strand(base, _at, output) {
      return { type: 'StrandAccess', base: base.ast(), out: output.ast() };
    },

    PrimaryExpr_call(func, _lp, args, _rp) {
      const parsedArgs = args.ast();
      
      // Expand explicit bundle literals only (not bundle variables)
      const expandedArgs = [];
      for (const arg of parsedArgs) {
        if (arg.type === 'Bundle') {
          // Bundle literals expand inline to their items
          expandedArgs.push(...arg.items);
        } else {
          // All other arguments stay as-is (including variables)
          expandedArgs.push(arg);
        }
      }
      
      return { type: 'Call', name: func.ast(), args: expandedArgs };
    },

    PrimaryExpr_bundle(_lt, items, _gt) {
      return { type: 'Bundle', items: items.ast() };
    },

    PrimaryExpr_env(_me, _dot, field) {
      return { type: 'Me', field: field.ast() };
    },

    PrimaryExpr_mouse(_mouse, _at, field) {
      return { type: 'Mouse', field: field.ast() };
    },

    PrimaryExpr_var(name) {
      return { type: 'Var', name: name.ast() };
    },

    // Bundle expressions
    BundleOrExpr_bundle(_lt, items, _gt) {
      return { type: 'Bundle', items: items.ast() };
    },

    BundleOrExpr_regular(expr) {
      return expr.ast();
    },

    // Terminals
    ident(_letter, _rest, _space) {
      return this.sourceString.trim();
    },

    number(_digits, _space) {
      return { type: 'Num', v: parseFloat(this.sourceString) };
    },

    string(_q1, chars, _q2, _space) {
      return { type: 'Str', v: chars.sourceString };
    },

    // Default iteration
    _iter(...children) {
      return children.map(c => c.ast());
    }
  });

// Post-processing AST transformation for bundle expansion
function transformAST(ast) {
  // Track which variables are bundles
  const bundleInfo = new Map();
  
  // First pass: collect bundle assignments
  const transformedStatements = [];
  for (const stmt of ast.statements) {
    if (stmt.type === 'Direct' && stmt.expr.type === 'Bundle' && stmt.outs.length > 1) {
      // This is a bundle assignment like newcol<r,g,b> = <0,1,1>
      if (stmt.expr.items.length !== stmt.outs.length) {
        throw new Error(`Bundle assignment has ${stmt.expr.items.length} values, expected ${stmt.outs.length} to match output strands`);
      }
      
      // Record this as a bundle
      bundleInfo.set(stmt.name, stmt.outs);
      
      // Expand into individual assignments
      for (let i = 0; i < stmt.outs.length; i++) {
        transformedStatements.push({
          type: 'Direct',
          name: stmt.name,
          outs: [stmt.outs[i]],
          expr: stmt.expr.items[i]
        });
      }
    } else if (stmt.type === 'CallInstance') {
      // Expand bundle arguments in calls
      const expandedArgs = [];
      for (const arg of stmt.args) {
        if (arg.type === 'Bundle') {
          // Bundle literals expand inline
          expandedArgs.push(...arg.items);
        } else if (arg.type === 'Var' && bundleInfo.has(arg.name)) {
          // Bundle variables expand to strand accesses
          const strands = bundleInfo.get(arg.name);
          for (const strand of strands) {
            expandedArgs.push({
              type: 'StrandAccess',
              base: { type: 'Var', name: arg.name },
              out: strand
            });
          }
        } else {
          expandedArgs.push(arg);
        }
      }
      
      transformedStatements.push({
        ...stmt,
        args: expandedArgs
      });
    } else {
      transformedStatements.push(stmt);
    }
  }
  
  return new Program(transformedStatements);
}

class Parser {
  static parse(src) {
    const m = g.match(src, 'Program');
    if (!m.succeeded()) throw new Error(m.message);
    const ast = sem(m).ast();

    // Apply post-processing bundle expansion
    const transformedAst = transformAST(ast);

    // Extract pragmas from source code
    const pragmas = extractPragmas(src);

    // Attach pragmas to AST for runtime access
    transformedAst.pragmas = pragmas;

    return transformedAst;
  }
}

export { Parser };

// Temporary bridge - also expose to global scope
if (typeof window !== 'undefined') {
  window.Parser = Parser;
}