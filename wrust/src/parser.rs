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
            Rule::EOI => {} // End of input, ignore
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
    todo!("Implement spindle_def parsing")
}

fn build_env_assignment(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();
    inner.next();
    inner.next();
    let ident = inner.next().unwrap().as_str().to_string();
    inner.next();
    inner.next();
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
    todo!("Implement compute_stmt parsing")
}
fn build_spindle_call(pair: Pair<Rule>) -> ASTNode {
    todo!("Implement compute_stmt parsing")
}

fn build_direct_bind(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();
    let name = inner.next().unwrap().as_str().to_string();
    let outputs = build_output_spec(inner.next().unwrap());
    inner.next();
    let expr = Box::new(build_expr(inner.next().unwrap()));

    ASTNode::InstanceBinding(InstanceBindExpr {
        name,
        outputs,
        expr,
    })
}

fn build_output_spec(pair: Pair<Rule>) -> Vec<String> {
    let mut inner = pair.into_inner();
    inner.next();
    let id_list = inner.next().unwrap();

    id_list
        .into_inner()
        .map(|ident_pair| ident_pair.as_str().to_string())
        .collect()
}

fn build_render_stmt(pair: Pair<Rule>) -> ASTNode {
    todo!("Implement render_stmt parsing")
}

fn build_play_stmt(pair: Pair<Rule>) -> ASTNode {
    todo!("Implement play_stmt parsing")
}

fn build_compute_stmt(pair: Pair<Rule>) -> ASTNode {
    todo!("Implement compute_stmt parsing")
}

fn build_pragma(pair: Pair<Rule>) -> ASTNode {
    todo!("Implement pragma parsing")
}

fn build_if_expr(pair: Pair<Rule>) -> ASTNode {
    todo!("Implement if_expr parsing")
}

fn build_comparison_expr(pair: Pair<Rule>) -> ASTNode {
    todo!("Implement comparison_expr parsing")
}
