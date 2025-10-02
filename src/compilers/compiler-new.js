import {match, _, inst} from '../utils/match.js'

import {
  ASTNode,
  BinaryExpr,
  UnaryExpr,
  CallExpr,
  VarExpr,
  NumExpr,
  StrExpr,
  MeExpr,
  MouseExpr,
  TupleExpr,
  IndexExpr,
  StrandAccessExpr,
  StrandRemapExpr,
  IfExpr,
  LetBinding,
  Assignment,
  NamedArg,
  OutputStatement,
  DisplayStmt,
  RenderStmt,
  PlayStmt,
  ComputeStmt,
  SpindleDef,
  InstanceBinding,
  Program
} from '../ast/ast-node.js'

function compileToJS(node, env) {
  if (Array.isArray(node)) {
    return node.length === 1 ? compileToJS(node[0], env) : '0';
  }

  return match(node,
    inst(NumExpr, _), (v) => String(v),
    inst(StrExp, _), (v) => `"${v.replace(/"/g, '\\"')}"`,
    inst(MeExpr, _), (field) => match(field,
      "x", () => "x",
      "y", () => "y",
      "time", () => "t",
      "frame", () => "f",
      "width", () => "w",
      "height", () => "h",
      _, (n) => "0"
    ),
    inst(MouseExpr, _), (field) => field == "x" ? "mx" : field === "y" ? "my" : "0",
    inst(BinaryExpr, _,_,_), (left, right, op) => {
      const leftCode = compileToJS(left, env);
      const rightCode = compileToJS(right, env);

      return match(op,
        "+", () =>`(${leftCode}+${rightCode})`,
        "-", () =>`(${leftCode}-${rightCode})`,
        "*", () =>`(${leftCode}*${rightCode})`,
        "/", () =>`(${leftCode}/${rightCode} || (1e-9))`,
        "^", () => `Math.pow(${leftCode},${rightCode})`,
        "%", () => `((${leftCode}%${rightCode}+${rightCode})%${rightCode})`,
        "==", () => `(${leftCode}===${rightCode}?1:0)`,
        "!=", () => `(${leftCode}!==${rightCode}?1:0)`,
         "<<", () => `(${leftCode}<${rightCode}?1:0)`,
         ">>", () => `(${leftCode}>${rightCode}?1:0)`,
          "<=", () => `(${leftCode}<=${rightCode}?1:0)`,
          ">=", () => `(${leftCode}>=${rightCode}?1:0)`,
          "AND", () => `(${leftCode}&&${rightCode}?1:0)`,
          "OR", () => `(${leftCode}||${rightCode}?1:0)`,
          _, (n) => "0"
      );
    },
    inst(Unary, _, _), (op, expr) => {
      const arg = compileToJS(expr, env);
      return match(op,
        "-", () => `(-${arg})`,
        "NOT", () => `(${arg}?0:1)`,
        _, () => {
          const mathFn = getMathFunction(op);
          return mathFn ? `${mathFn}(${arg})` : `(-${arg})`;
        }
      );
    },
    inst(If, _, _, _), (condition, thenExpr, elseExpr) => {
      const cond = compileToJS(condition, env);
      const thenCode = compileToJS(thenExpr, env);
      const elseCode = compileToJS(elseExpr, env);
      return `(${cond}?${thenCode}:${elseCode})`;
    },
    inst(Call, _, _), (name, args) => {
      const argCodes = args.map(arg => compileToJS(arg, env));

      // Check for built-in math functions
      const mathFn = getMathFunction(name);
      if (mathFn) {
        return `${mathFn}(${argCodes.join(',')})`;
      }

      return match(name,
        "clamp", () => {
          if (argCodes.length === 3) {
            return `(${argCodes[0]}<${argCodes[1]}?${argCodes[1]}:${argCodes[0]}>${argCodes[2]}?${argCodes[2]}:${argCodes[0]})`;
          }
          return `(${argCodes[0]}<0?0:${argCodes[0]}>1?1:${argCodes[0]})`;
        },
        "noise", () => `env.__noise3(${argCodes[0]}*3.1,${argCodes[1]}*3.1,${argCodes[2]}*0.5)`,
        _, () => `Math.sin(${argCodes.join(',')})`
      );
    },
    inst(Var, _), (name) => `getVar("${name}")`,
    inst(StrandAccess, _, _), (base, out) =>
      `getInstance("${base}","${out}")`,
    inst(StrandRemap, _, _, _), (base, out, coords) =>
      `evalStrandRemap(${JSON.stringify(node)})`,
    _, (n) => {
      console.warn('[js-compiler] Unhandled node:', node);
      return "0";
    }
  );
}

function getMathFunction(name) {
  const MAP = {
    sin: 'Math.sin', cos: 'Math.cos', tan: 'Math.tan',
    sqrt: 'Math.sqrt', abs: 'Math.abs', exp: 'Math.exp', log: 'Math.log',
    min: 'Math.min', max: 'Math.max', floor: 'Math.floor',
    ceil: 'Math.ceil', round: 'Math.round', atan2: 'Math.atan2'
  };
  return MAP[name];
}