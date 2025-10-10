use std::collections::HashMap;

pub struct BinaryExpr {
    pub op: String,
    pub left: Box<ASTNode>,
    pub right: Box<ASTNode>,
}

pub struct UnaryExpr {
    pub op: String,
    pub expr: Box<ASTNode>,
}

pub struct CallExpr {
    pub name: Box<ASTNode>,
    pub args: Vec<ASTNode>,
}

pub struct VarExpr {
    pub name: String,
}

pub struct NumExpr {
    pub v: f64,
}

pub struct StrExpr {
    pub v: String,
}

pub struct MeExpr {
    pub field: String,
}

// Tuple: (expr1, expr2, ...)
pub struct TupleExpr {
    pub items: Vec<ASTNode>,
}

pub struct IndexExpr {
    pub base: Box<ASTNode>,
    pub index: Box<ASTNode>,
}

pub struct StrandAccessExpr {
    pub base: Box<ASTNode>,
    pub out: Box<ASTNode>,
}

pub struct StrandRemapExpr {
    pub base: Box<ASTNode>,
    pub strand: String,
    pub mappings: Vec<AxisMapping>,
}
pub struct AxisMapping {
    pub axis: String,
    pub expr: Box<ASTNode>,
}

pub struct IfExpr {
    pub condition: Box<ASTNode>,
    pub then_expr: Box<ASTNode>,
    pub else_expr: Box<ASTNode>,
}

pub struct AssignmentExpr {
    pub name: String,
    pub op: String,
    pub expr: Box<ASTNode>,
}

pub struct NamedArg {
    pub name: String,
    pub value: Box<ASTNode>,
}

pub struct OutputStatement {
    pub args: Vec<ASTNode>,
    pub named_args: HashMap<String, ASTNode>,
    pub positional_args: Vec<ASTNode>,
}

pub struct SpindleDef {
    pub name: String,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub body: Box<ASTNode>,
}

pub struct InstanceBindExpr {
    pub name: String,
    pub outputs: Vec<String>,
    pub expr: Box<ASTNode>,
}

pub struct Program {
    pub statements: Vec<ASTNode>,
}

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
