use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct BinaryExpr {
    pub op: String,
    pub left: Box<ASTNode>,
    pub right: Box<ASTNode>,
}

#[derive(Debug, Clone)]
pub struct UnaryExpr {
    pub op: String,
    pub expr: Box<ASTNode>,
}

#[derive(Debug, Clone)]
pub struct CallExpr {
    pub name: Box<ASTNode>,
    pub args: Vec<ASTNode>,
}

#[derive(Debug, Clone)]
pub struct VarExpr {
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct NumExpr {
    pub v: f64,
}

#[derive(Debug, Clone)]
pub struct StrExpr {
    pub v: String,
}

#[derive(Debug, Clone)]
pub struct MeExpr {
    pub field: String,
}

// Tuple: (expr1, expr2, ...)
#[derive(Debug, Clone)]
pub struct TupleExpr {
    pub items: Vec<ASTNode>,
}

#[derive(Debug, Clone)]
pub struct IndexExpr {
    pub base: Box<ASTNode>,
    pub index: Box<ASTNode>,
}

#[derive(Debug, Clone)]
pub struct StrandAccessExpr {
    pub base: Box<ASTNode>,
    pub out: Box<ASTNode>,
}

#[derive(Debug, Clone)]
pub struct StrandRemapExpr {
    pub base: Box<ASTNode>,
    pub strand: String,
    pub mappings: Vec<AxisMapping>,
}

#[derive(Debug, Clone)]
pub struct AxisMapping {
    pub axis: Box<ASTNode>,
    pub expr: Box<ASTNode>,
}

#[derive(Debug, Clone)]
pub struct IfExpr {
    pub condition: Box<ASTNode>,
    pub then_expr: Box<ASTNode>,
    pub else_expr: Box<ASTNode>,
}

#[derive(Debug, Clone)]
pub struct AssignmentExpr {
    pub name: String,
    pub op: String,
    pub expr: Box<ASTNode>,
    pub is_output: bool,
}

#[derive(Debug, Clone)]
pub struct NamedArg {
    pub name: String,
    pub value: Box<ASTNode>,
}

#[derive(Debug, Clone)]
pub struct BackendExpr {
    pub context: String,
    pub args: Vec<ASTNode>,
    pub named_args: HashMap<String, ASTNode>,
    pub positional_args: Vec<ASTNode>,
}

#[derive(Debug, Clone)]
pub struct SpindleDef {
    pub name: String,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub body: Box<ASTNode>,
}

#[derive(Debug, Clone)]
pub struct InstanceBindExpr {
    pub name: String,
    pub outputs: Vec<String>,
    pub expr: Box<ASTNode>,
}

#[derive(Debug, Clone)]
pub struct Program {
    pub statements: Vec<ASTNode>,
}
#[derive(Debug, Clone)]
pub struct BlockExpr {
    pub body: Vec<ASTNode>,
}

#[derive(Debug, Clone)]
pub struct ForLoopExpr {
    pub var: String,
    pub start: Box<ASTNode>,
    pub end: Box<ASTNode>,
    pub body: Box<ASTNode>,
}

#[derive(Debug, Clone)]
pub enum ASTNode {
    // Expressions
    Binary(BinaryExpr),
    Unary(UnaryExpr),
    Call(CallExpr),
    Var(VarExpr),
    Num(NumExpr),
    Str(StrExpr),
    Me(MeExpr),
    Tuple(TupleExpr),
    Index(IndexExpr),
    StrandAccess(StrandAccessExpr),
    StrandRemap(StrandRemapExpr),
    If(IfExpr),

    // Statements
    Assignment(AssignmentExpr),
    NamedArg(NamedArg),
    Backend(BackendExpr),
    SpindleDef(SpindleDef),
    InstanceBinding(InstanceBindExpr),
    ForLoop(ForLoopExpr),
    Block(BlockExpr),
    Program(Program),
}
