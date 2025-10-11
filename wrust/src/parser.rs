use crate::ast::*;
use pest::iterators::Pair;
use pest::Parser;
use pest_derive::Parser;

#[derive(Parser)]
#[grammar = "weft.pest"]
pub struct WeftParser;

pub fn parse(source: &str) -> Result<Program, pest::error::Error<Rule>> {
    let pairs = WeftParser::parse(Rule::program, source)?;
    let program_pair = pairs.into_iter().next().unwrap();

    Ok(build_program(program_pair))
}

fn build_program(pair: Pair<Rule>) -> Program {
    let mut statements = Vec::new();
    for inner_pair in pair.into_inner() {
        match inner_pair.as_rule() {
            Rule::statement => {
                let stmt_pair = inner_pair.into_inner().next().unwrap();
                statements.push(build_statement(stmt_pair));
            }
            Rule::EOI => {}
            _ => unreachable!(),
        }
    }

    Program { statements }
}

fn build_statement(pair: Pair<Rule>) -> ASTNode {
    match pair.as_rule() {
        Rule::spindle_def => build_spindle_def(pair),
        Rule::env_assignment => build_env_assignment(pair),
        Rule::instance_binding => build_instance_binding(pair),
        Rule::assignment => build_assignment(pair),
        Rule::render_stmt => build_render_stmt(pair),
        Rule::play_stmt => build_play_stmt(pair),
        Rule::compute_stmt => build_compute_stmt(pair),
        Rule::pragma => build_pragma(pair),
        _ => unreachable!("Unexpected statement rule: {:?}", pair.as_rule()),
    }
}

fn build_assignment(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();

    let name = inner.next().unwrap().as_str().to_string();
    let op = inner.next().unwrap().as_str().to_string();
    let expr = build_expr(inner.next().unwrap());

    ASTNode::Assignment(AssignmentExpr {
        name,
        op,
        expr: Box::new(expr),
    })
}

fn build_expr(pair: Pair<Rule>) -> ASTNode {
    let inner = pair.into_inner().next().unwrap();

    match inner.as_rule() {
        Rule::if_expr => build_if_expr(inner),
        Rule::logical_expr => build_logical_expr(inner),
        _ => unreachable!(),
    }
}

fn build_logical_expr(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();

    let mut left = build_comparison_expr(inner.next().unwrap());

    while let Some(op_pair) = inner.next() {
        let op = op_pair.as_str().to_string();
        let right = build_comparison_expr(inner.next().unwrap());

        left = ASTNode::Binary(BinaryExpr {
            op,
            left: Box::new(left),
            right: Box::new(right),
        });
    }

    left
}

fn build_spindle_def(pair: Pair<Rule>) -> ASTNode {
    // TODO(human): Implement spindle definition parsing
    // Grammar: "spindle" ~ ident ~ "(" ~ ident_list ~ ")" ~ "::" ~ output_spec ~ block
    // Children (no literals): ident, ident_list, output_spec, block
    // Hint: Use build_ident_list() and build_output_spec() helpers
    // Hint: build_block() returns a different type - check the AST!
    todo!("Implement spindle_def parsing")
}

fn build_env_assignment(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();
    // Only 2 children: ident and expr (literals don't create children)
    let ident = inner.next().unwrap().as_str().to_string();
    let expr = Box::new(build_expr(inner.next().unwrap()));

    ASTNode::Assignment(AssignmentExpr {
        name: ident,
        op: "=".to_string(),
        expr,
    })
}

fn build_instance_binding(pair: Pair<Rule>) -> ASTNode {
    let inner = pair.into_inner().next().unwrap();

    match inner.as_rule() {
        Rule::multi_spindle_call => build_multi_spindle_call(inner),
        Rule::spindle_call => build_spindle_call(inner),
        Rule::direct_bind => build_direct_bind(inner),
        _ => unreachable!(),
    }
}

fn build_multi_spindle_call(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();

    let func_name = inner.next().unwrap().as_str().to_string();
    let multiplier = inner.next().unwrap().as_str().parse::<usize>().unwrap();
    let args_list = inner.next().unwrap();
    let name = inner.next().unwrap().as_str().to_string();
    let outputs = build_output_spec(inner.next().unwrap());

    let func_var = Box::new(ASTNode::Var(VarExpr { name: func_name }));

    let mut args_slots: Vec<Vec<ASTNode>> = Vec::new();
    for bundle_or_expr_pair in args_list.into_inner() {
        let arg_inner = bundle_or_expr_pair.into_inner().next().unwrap();
        match arg_inner.as_rule() {
            Rule::expr_list => {
                let items = build_expr_list(arg_inner);
                if items.len() != multiplier {
                    panic!(
                        "Bundle has {} items, but multi is {}",
                        items.len(),
                        multiplier
                    );
                }
                args_slots.push(items);
            }
            Rule::expr => {
                let single = build_expr(arg_inner);
                arg_slots.push((0..multiplier).map(|_| single.clone()).collect());
            }
            _ => unreachable!(),
        }
    }

    let mut calls = Vec::new();
    for i in 0..multiplier {
        let call_args: Vec<ASTNode> = arg_slots.iter().map(|slot| slot[i].clone()).collect();
        calls.push(ASTNode::Call(CallExpr {
            name: func_var.clone(),
            args: call_args,
        }));
    }

    ASTNode::InstanceBinding(InstanceBindExpr {
        name,
        outputs,
        expr: Box::new(ASTNode::Tuple(TupleExpr { items: calls })),
    })
}

fn build_spindle_call(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();
    let func_name = inner.next().unwrap().as_str().to_string();
    let func_var = Box::new(ASTNode::Var(VarExpr { name: func_name }));
    let args = build_expr_list(inner.next().unwrap());
    let expr = Box::new(ASTNode::Call(CallExpr {
        name: func_var,
        args,
    }));

    let name = inner.next().unwrap().as_str().to_string();
    let outputs = build_output_spec(inner.next().unwrap());

    ASTNode::InstanceBinding(InstanceBindExpr {
        name,
        outputs,
        expr,
    })
}

fn build_direct_bind(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();
    let name = inner.next().unwrap().as_str().to_string();
    let outputs = build_output_spec(inner.next().unwrap());
    let expr = Box::new(build_expr(inner.next().unwrap()));

    ASTNode::InstanceBinding(InstanceBindExpr {
        name,
        outputs,
        expr,
    })
}

fn build_output_spec(pair: Pair<Rule>) -> Vec<String> {
    let mut inner = pair.into_inner();

    let id_list = inner.next().unwrap();

    id_list
        .into_inner()
        .map(|ident_pair| ident_pair.as_str().to_string())
        .collect()
}

fn build_render_stmt(pair: Pair<Rule>) -> ASTNode {
    // TODO(human): Implement output statement parsing
    // Grammar: "render" ~ "(" ~ stmt_arg_list ~ ")"
    // Child: stmt_arg_list
    // Use build_stmt_arg_list() helper
    // Return RenderStmt (check OutputStatement in AST)
    todo!("Implement render_stmt parsing")
}

fn build_play_stmt(pair: Pair<Rule>) -> ASTNode {
    // TODO(human): Same pattern as render_stmt
    todo!("Implement play_stmt parsing")
}

fn build_compute_stmt(pair: Pair<Rule>) -> ASTNode {
    // TODO(human): Same pattern as render_stmt
    todo!("Implement compute_stmt parsing")
}

fn build_pragma(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();

    // TODO(human): Simple pragma parsing
    // Grammar: "#" ~ ident ~ pragma_body
    // Children: ident (type), pragma_body
    // pragma_body.as_str() gives the full text
    // Note: Pragma validation happens at runtime, not parse time!
    todo!("Implement pragma parsing")
}

fn build_if_expr(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();
    let condition = Box::new(build_expr(inner.next().unwrap()));
    let then_expr = Box::new(build_expr(inner.next().unwrap()));
    let else_expr = Box::new(build_expr(inner.next().unwrap()));

    ASTNode::If(IfExpr {
        condition,
        then_expr,
        else_expr,
    })
}

fn build_comparison_expr(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();

    let left = build_arith_expr(inner.next().unwrap());

    if let Some(op_pair) = inner.next() {
        let op = op_pair.as_str().to_string();
        let right = build_arith_expr(inner.next().unwrap());

        ASTNode::Binary(BinaryExpr {
            op,
            left: Box::new(left),
            right: Box::new(right),
        })
    } else {
        left
    }
}

fn build_arith_expr(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();

    let mut left = build_term(inner.next().unwrap());

    while let Some(op_pair) = inner.next() {
        let op = op_pair.as_str().to_string();
        let right = build_term(inner.next().unwrap());

        left = ASTNode::Binary(BinaryExpr {
            op,
            left: Box::new(left),
            right: Box::new(right),
        });
    }

    left
}

fn build_term(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();

    let mut left = build_factor(inner.next().unwrap());

    while let Some(op_pair) = inner.next() {
        let op = op_pair.as_str().to_string();
        let right = build_factor(inner.next().unwrap());

        left = ASTNode::Binary(BinaryExpr {
            op,
            left: Box::new(left),
            right: Box::new(right),
        });
    }
    left
}

fn build_factor(pair: Pair<Rule>) -> ASTNode {
    let inner = pair.into_inner().next().unwrap();
    build_power(inner)
}

fn build_power(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();

    let left = build_unary(inner.next().unwrap());

    if let Some(_caret) = inner.next() {
        let right = build_power(inner.next().unwrap());

        ASTNode::Binary(BinaryExpr {
            op: "^".to_string(),
            left: Box::new(left),
            right: Box::new(right),
        })
    } else {
        left
    }
}

fn build_unary(pair: Pair<Rule>) -> ASTNode {
    let inner = pair.into_inner().next().unwrap();

    match inner.as_rule() {
        Rule::unary => {
            // Recursive unary (-, not)
            let mut unary_inner = inner.into_inner();
            let op_pair = unary_inner.next().unwrap();
            let op = if op_pair.as_str() == "-" {
                "-".to_string()
            } else {
                "NOT".to_string()
            };
            let expr = build_unary(unary_inner.next().unwrap());

            ASTNode::Unary(UnaryExpr {
                op,
                expr: Box::new(expr),
            })
        }
        Rule::primary => build_primary(inner),
        _ => unreachable!(),
    }
}

fn build_primary(pair: Pair<Rule>) -> ASTNode {
    let inner = pair.into_inner().next().unwrap();

    match inner.as_rule() {
        Rule::number => {
            let value = inner.as_str().parse::<f64>().unwrap();
            ASTNode::Num(NumExpr { v: value })
        }
        Rule::string => ASTNode::Str(StrExpr {
            v: inner.as_str().to_string(),
        }),
        Rule::ident => ASTNode::Var(VarExpr {
            name: inner.as_str().to_string(),
        }),
        Rule::expr => build_expr(inner),
        Rule::expr_list => {
            let items = build_expr_list(inner);
            ASTNode::Tuple(TupleExpr { items: items })
        }
        _ => todo!("Implement other primary expressions: {:?}", inner.as_rule()),
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

fn build_ident_list(pair: Pair<Rule>) -> Vec<String> {
    pair.into_inner()
        .map(|ident_pair| ident_pair.as_str().to_string())
        .collect()
}

fn build_expr_list(pair: Pair<Rule>) -> Vec<ASTNode> {
    pair.into_inner()
        .map(|expr_pair| build_expr(expr_pair))
        .collect()
}

fn build_stmt_arg_list(pair: Pair<Rule>) -> Vec<ASTNode> {
    // TODO(human): Parse statement arguments (named and positional)
    // Grammar: (stmt_arg ~ ("," ~ stmt_arg)*)?
    // Each stmt_arg is either: ident ~ ":" ~ expr (named) OR expr (positional)
    // Hint: Check stmt_arg.as_rule() to see which variant
    // Named args become NamedArg nodes, positional are just expressions
    todo!("Implement stmt_arg_list parsing")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_assignment() {
        let source = "strand<x> = 5";
        let result = parse(source);

        match result {
            Ok(program) => {
                println!("✓ Parsed successfully!");
                println!("Program has {} statements", program.statements.len());
            }
            Err(e) => {
                println!("✗ Parse error: {}", e);
                panic!("Failed to parse");
            }
        }
    }
}
