use std::collections::HashMap;

#[derive(Clone)]
pub struct BinaryExpr {
    pub op: String,
    pub left: Box<ASTNode>,
    pub right: Box<ASTNode>,
}

#[derive(Clone)]
pub struct UnaryExpr {
    pub op: String,
    pub expr: Box<ASTNode>,
}

#[derive(Clone)]
pub struct CallExpr {
    pub name: Box<ASTNode>,
    pub args: Vec<ASTNode>,
}

#[derive(Clone)]
pub struct VarExpr {
    pub name: String,
}

#[derive(Clone)]
pub struct NumExpr {
    pub v: f64,
}

#[derive(Clone)]
pub struct StrExpr {
    pub v: String,
}

#[derive(Clone)]
pub struct MeExpr {
    pub field: String,
}

// Tuple: (expr1, expr2, ...)
#[derive(Clone)]
pub struct TupleExpr {
    pub items: Vec<ASTNode>,
}

#[derive(Clone)]
pub struct IndexExpr {
    pub base: Box<ASTNode>,
    pub index: Box<ASTNode>,
}

#[derive(Clone)]
pub struct StrandAccessExpr {
    pub base: Box<ASTNode>,
    pub out: Box<ASTNode>,
}

#[derive(Clone)]
pub struct StrandRemapExpr {
    pub base: Box<ASTNode>,
    pub strand: String,
    pub mappings: Vec<AxisMapping>,
}

#[derive(Clone)]
pub struct AxisMapping {
    pub axis: String,
    pub expr: Box<ASTNode>,
}

#[derive(Clone)]
pub struct IfExpr {
    pub condition: Box<ASTNode>,
    pub then_expr: Box<ASTNode>,
    pub else_expr: Box<ASTNode>,
}

#[derive(Clone)]
pub struct AssignmentExpr {
    pub name: String,
    pub op: String,
    pub expr: Box<ASTNode>,
}

#[derive(Clone)]
pub struct NamedArg {
    pub name: String,
    pub value: Box<ASTNode>,
}

#[derive(Clone)]
pub struct OutputStatement {
    pub args: Vec<ASTNode>,
    pub named_args: HashMap<String, ASTNode>,
    pub positional_args: Vec<ASTNode>,
}

#[derive(Clone)]
pub struct SpindleDef {
    pub name: String,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub body: Box<ASTNode>,
}

#[derive(Clone)]
pub struct InstanceBindExpr {
    pub name: String,
    pub outputs: Vec<String>,
    pub expr: Box<ASTNode>,
}

#[derive(Clone)]
pub struct Program {
    pub statements: Vec<ASTNode>,
}

#[derive(Clone)]
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
    DisplayStmt(OutputStatement),
    RenderStmt(OutputStatement),
    PlayStmt(OutputStatement),
    ComputeStmt(OutputStatement),
    SpindleDef(SpindleDef),
    InstanceBinding(InstanceBindExpr),
    Program(Program),
}
