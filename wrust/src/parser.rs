use crate::{ast::*, backend};
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
        Rule::backend_expr => build_output_statement(pair),
        // Rule::pragma => build_pragma(pair),
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
        is_output: false,
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
    let mut inner = pair.into_inner();
    let name = inner.next().unwrap().as_str().to_string();
    let inputs = build_ident_list(inner.next().unwrap());
    let outputs = build_output_spec(inner.next().unwrap());
    let body = Box::new(build_block(inner.next().unwrap()));

    ASTNode::SpindleDef(SpindleDef {
        name,
        inputs,
        outputs,
        body,
    })
}

fn build_block(pair: Pair<Rule>) -> ASTNode {
    let mut body = Vec::new();
    for stmt_pair in pair.into_inner() {
        body.push(build_block_statement(stmt_pair));
    }

    ASTNode::Block(BlockExpr { body })
}

fn build_block_statement(pair: Pair<Rule>) -> ASTNode {
    let inner = pair.into_inner().next().unwrap();
    match inner.as_rule() {
        Rule::output_assignment => build_output_assignment(inner),
        Rule::assignment => build_assignment(inner),
        Rule::for_loop => build_for_loop(inner),
        Rule::if_expr => build_if_expr(inner),
        _ => unreachable!(),
    }
}

fn build_output_assignment(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();
    let name = inner.next().unwrap().as_str().to_string();
    let expr = Box::new(build_expr(inner.next().unwrap()));

    ASTNode::Assignment(AssignmentExpr {
        name,
        op: "=".to_string(),
        expr,
        is_output: true,
    })
}

fn build_for_loop(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();
    let var = inner.next().unwrap().as_str().to_string();
    let start = Box::new(build_expr(inner.next().unwrap()));
    let end = Box::new(build_expr(inner.next().unwrap()));
    let body = Box::new(build_block(inner.next().unwrap()));

    ASTNode::ForLoop(ForLoopExpr {
        var,
        start,
        end,
        body,
    })
}

fn build_env_assignment(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();
    let ident = inner.next().unwrap().as_str().to_string();
    let expr = Box::new(build_expr(inner.next().unwrap()));

    ASTNode::Assignment(AssignmentExpr {
        name: ident,
        op: "=".to_string(),
        expr,
        is_output: false,
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
    // Extract multiplier from source string (e.g., "blur<3>(...)" -> "3")
    let source = pair.as_str();
    let mult_start = source.find('<').unwrap() + 1;
    let mult_end = source.find('>').unwrap();
    let multiplier = source[mult_start..mult_end].parse::<usize>().unwrap();

    let mut inner = pair.into_inner();

    let func_name = inner.next().unwrap().as_str().to_string();
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
                args_slots.push((0..multiplier).map(|_| single.clone()).collect());
            }
            _ => unreachable!(),
        }
    }

    let mut calls = Vec::new();
    for i in 0..multiplier {
        let call_args: Vec<ASTNode> = args_slots.iter().map(|slot| slot[i].clone()).collect();
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

//fn build_pragma(pair: Pair<Rule>) -> ASTNode {
//let inner = pair.into_inner();

// Grammar: "#" ~ ident ~ pragma_body
// Children: ident (type), pragma_body
// pragma_body.as_str() gives the full text
// Note: Pragma validation happens at runtime, not parse time!

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
    if let Some(right_pair) = inner.next() {
        let right = build_power(right_pair);

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
    let source = pair.as_str();
    let mut inner = pair.into_inner();
    let first = inner.next().unwrap();

    match first.as_rule() {
        Rule::unary => {
            let op = if source.trim_start().starts_with('-') {
                "-".to_string()
            } else {
                "NOT".to_string()
            };
            let expr = build_unary(first);

            ASTNode::Unary(UnaryExpr {
                op,
                expr: Box::new(expr),
            })
        }
        Rule::postfix => build_postfix(first),
        _ => unreachable!(),
    }
}

fn build_postfix(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();
    let mut base = build_atom(inner.next().unwrap());

    for postfix_op_pair in inner {
        base = build_postfix_op(base, postfix_op_pair);
    }

    base
}

fn build_postfix_op(base: ASTNode, pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();
    let first = inner.next().unwrap();

    match first.as_rule() {
        Rule::ident => {
            let strand_name = first.as_str().to_string();
            if let Some(axis_mapping_list_pair) = inner.next() {
                let mappings = build_axis_mapping_list(axis_mapping_list_pair);
                ASTNode::StrandRemap(StrandRemapExpr {
                    base: Box::new(base),
                    strand: strand_name,
                    mappings,
                })
            } else {
                ASTNode::StrandAccess(StrandAccessExpr {
                    base: Box::new(base),
                    out: Box::new(ASTNode::Var(VarExpr { name: strand_name })),
                })
            }
        }
        Rule::expr_list => {
            let args = build_expr_list(first);
            ASTNode::Call(CallExpr {
                name: Box::new(base),
                args,
            })
        }
        Rule::expr => ASTNode::Index(IndexExpr {
            base: Box::new(base),
            index: Box::new(build_expr(first)),
        }),
        _ => unreachable!("Unexpected postfix_op rule: {:?}", first.as_rule()),
    }
}

fn build_atom(pair: Pair<Rule>) -> ASTNode {
    let source = pair.as_str();
    let mut inner = pair.into_inner();
    let first = inner.next().unwrap();

    if source.starts_with("me") && source.contains('@') {
        let field = first.as_str().to_string();
        return ASTNode::Me(MeExpr { field });
    }

    match first.as_rule() {
        Rule::ident => {
            let ident = first.as_str().to_string();
            ASTNode::Var(VarExpr { name: ident })
        }
        Rule::number => {
            let value = first.as_str().parse::<f64>().unwrap();
            ASTNode::Num(NumExpr { v: value })
        }
        Rule::string => ASTNode::Str(StrExpr {
            v: first.as_str().to_string(),
        }),
        Rule::expr => build_expr(first),
        Rule::expr_list => {
            let items = build_expr_list(first);
            ASTNode::Tuple(TupleExpr { items })
        }
        _ => todo!("Implement other atom expressions: {:?}", first.as_rule()),
    }
}

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

fn build_axis_mapping_list(pair: Pair<Rule>) -> Vec<AxisMapping> {
    pair.into_inner()
        .map(|mapping_pair| build_axis_mapping(mapping_pair))
        .collect()
}

fn build_axis_mapping(pair: Pair<Rule>) -> AxisMapping {
    let mut inner = pair.into_inner();
    let axis_ref = build_axis_ref(inner.next().unwrap());
    let value_expr = build_expr(inner.next().unwrap());

    AxisMapping {
        axis: Box::new(axis_ref),
        expr: Box::new(value_expr),
    }
}

fn build_axis_ref(pair: Pair<Rule>) -> ASTNode {
    let mut inner = pair.into_inner();
    let instance_name = inner.next().unwrap().as_str().to_string();
    let output_name = inner.next().unwrap().as_str().to_string();

    ASTNode::StrandAccess(StrandAccessExpr {
        base: Box::new(ASTNode::Var(VarExpr {
            name: instance_name,
        })),
        out: Box::new(ASTNode::Var(VarExpr { name: output_name })),
    })
}

fn build_output_statement(pair: Pair<Rule>) -> ASTNode {
    use std::collections::HashMap;

    let mut inner = pair.into_inner();
    let context = inner.next().unwrap().as_str().to_string();
    let stmt_arg_list = inner.next().unwrap();

    let mut args = Vec::new();
    let mut named_args = HashMap::new();
    let mut positional_args = Vec::new();

    for stmt_arg_pair in stmt_arg_list.into_inner() {
        let inner = stmt_arg_pair.into_inner();
        let children: Vec<_> = inner.collect();

        if children.len() == 2 {
            let name = children[0].as_str().to_string();
            let value = build_expr(children[1].clone());

            let named_arg = ASTNode::NamedArg(NamedArg {
                name: name.clone(),
                value: Box::new(value.clone()),
            });

            args.push(named_arg);
            named_args.insert(name, value);
        } else {
            let expr = build_expr(children[0].clone());
            args.push(expr.clone());
            positional_args.push(expr);
        }
    }

    ASTNode::Backend(BackendExpr {
        context,
        args,
        named_args,
        positional_args,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_number_literal() {
        let result = parse("x<a> = 42").unwrap();
        assert_eq!(result.statements.len(), 1);

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => match bind.expr.as_ref() {
                ASTNode::Num(num) => assert_eq!(num.v, 42.0),
                _ => panic!("Expected Num"),
            },
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_string_literal() {
        let result = parse("x<a> = \"hello\"").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => match bind.expr.as_ref() {
                ASTNode::Str(s) => assert_eq!(s.v, "\"hello\""),
                _ => panic!("Expected Str"),
            },
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_variable() {
        let result = parse("x<a> = foo").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => match bind.expr.as_ref() {
                ASTNode::Var(v) => assert_eq!(v.name, "foo"),
                _ => panic!("Expected Var"),
            },
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_arithmetic() {
        let result = parse("x<a> = 1 + 2 * 3").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => {
                match bind.expr.as_ref() {
                    ASTNode::Binary(bin) => {
                        assert_eq!(bin.op, "+");
                        // Left is 1
                        match bin.left.as_ref() {
                            ASTNode::Num(n) => assert_eq!(n.v, 1.0),
                            _ => panic!("Expected Num"),
                        }
                        // Right is 2 * 3
                        match bin.right.as_ref() {
                            ASTNode::Binary(mul) => {
                                assert_eq!(mul.op, "*");
                            }
                            _ => panic!("Expected Binary"),
                        }
                    }
                    _ => panic!("Expected Binary"),
                }
            }
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_comparison() {
        let result = parse("x<a> = 5>>3").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => match bind.expr.as_ref() {
                ASTNode::Binary(bin) => assert_eq!(bin.op, ">>"),
                _ => panic!("Expected Binary"),
            },
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_logical() {
        let result = parse("x<a> = true and false").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => match bind.expr.as_ref() {
                ASTNode::Binary(bin) => assert_eq!(bin.op, "and"),
                _ => panic!("Expected Binary"),
            },
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_if_expression() {
        let result = parse("x<a> = if 1 >> 2 then 10 else 20").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => match bind.expr.as_ref() {
                ASTNode::If(if_expr) => {
                    match if_expr.condition.as_ref() {
                        ASTNode::Binary(_) => {}
                        _ => panic!("Expected Binary condition"),
                    }
                    match if_expr.then_expr.as_ref() {
                        ASTNode::Num(n) => assert_eq!(n.v, 10.0),
                        _ => panic!("Expected Num"),
                    }
                    match if_expr.else_expr.as_ref() {
                        ASTNode::Num(n) => assert_eq!(n.v, 20.0),
                        _ => panic!("Expected Num"),
                    }
                }
                _ => panic!("Expected If"),
            },
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_unary() {
        let result = parse("x<a> = -5").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => match bind.expr.as_ref() {
                ASTNode::Unary(un) => {
                    assert_eq!(un.op, "-");
                    match un.expr.as_ref() {
                        ASTNode::Num(n) => assert_eq!(n.v, 5.0),
                        _ => panic!("Expected Num"),
                    }
                }
                _ => panic!("Expected Unary"),
            },
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_bundle() {
        let result = parse("x<a, b> = <1, 2>").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => {
                assert_eq!(bind.outputs.len(), 2);
                assert_eq!(bind.outputs[0], "a");
                assert_eq!(bind.outputs[1], "b");

                match bind.expr.as_ref() {
                    ASTNode::Tuple(tup) => {
                        assert_eq!(tup.items.len(), 2);
                    }
                    _ => panic!("Expected Tuple"),
                }
            }
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_direct_bind() {
        let result = parse("myInst<result> = 42").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => {
                assert_eq!(bind.name, "myInst");
                assert_eq!(bind.outputs, vec!["result"]);
            }
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_spindle_call() {
        let result = parse("blur(img, 5) :: result<value>").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => {
                assert_eq!(bind.name, "result");
                assert_eq!(bind.outputs, vec!["value"]);

                match bind.expr.as_ref() {
                    ASTNode::Call(call) => {
                        match call.name.as_ref() {
                            ASTNode::Var(v) => assert_eq!(v.name, "blur"),
                            _ => panic!("Expected Var"),
                        }
                        assert_eq!(call.args.len(), 2);
                    }
                    _ => panic!("Expected Call"),
                }
            }
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_multi_spindle_call() {
        let result = parse("blur<3>(<1, 2, 3>, radius) :: myInstance<a, b, c>").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => {
                assert_eq!(bind.name, "myInstance");
                assert_eq!(bind.outputs, vec!["a", "b", "c"]);

                match bind.expr.as_ref() {
                    ASTNode::Tuple(tup) => {
                        assert_eq!(tup.items.len(), 3);
                        // Each item should be a Call
                        for item in &tup.items {
                            match item {
                                ASTNode::Call(_) => {}
                                _ => panic!("Expected Call in tuple"),
                            }
                        }
                    }
                    _ => panic!("Expected Tuple"),
                }
            }
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_env_assignment() {
        let result = parse("me<width> = 800").unwrap();

        match &result.statements[0] {
            ASTNode::Assignment(assign) => {
                assert_eq!(assign.name, "width");
                assert_eq!(assign.op, "=");
                assert_eq!(assign.is_output, false);
            }
            _ => panic!("Expected Assignment"),
        }
    }

    #[test]
    fn test_spindle_def() {
        let result = parse("spindle add(a, b) :: <sum> { out sum = a + b }").unwrap();

        match &result.statements[0] {
            ASTNode::SpindleDef(def) => {
                assert_eq!(def.name, "add");
                assert_eq!(def.inputs, vec!["a", "b"]);
                assert_eq!(def.outputs, vec!["sum"]);

                match def.body.as_ref() {
                    ASTNode::Block(block) => {
                        assert_eq!(block.body.len(), 1);
                        match &block.body[0] {
                            ASTNode::Assignment(assign) => {
                                assert_eq!(assign.name, "sum");
                                assert_eq!(assign.is_output, true);
                            }
                            _ => panic!("Expected Assignment"),
                        }
                    }
                    _ => panic!("Expected Block"),
                }
            }
            _ => panic!("Expected SpindleDef"),
        }
    }

    #[test]
    fn test_for_loop() {
        let result = parse("spindle test() :: <x> { for i in (0 to 10) { out x = i } }").unwrap();

        match &result.statements[0] {
            ASTNode::SpindleDef(def) => match def.body.as_ref() {
                ASTNode::Block(block) => match &block.body[0] {
                    ASTNode::ForLoop(for_loop) => {
                        assert_eq!(for_loop.var, "i");
                        match for_loop.start.as_ref() {
                            ASTNode::Num(n) => assert_eq!(n.v, 0.0),
                            _ => panic!("Expected Num"),
                        }
                        match for_loop.end.as_ref() {
                            ASTNode::Num(n) => assert_eq!(n.v, 10.0),
                            _ => panic!("Expected Num"),
                        }
                    }
                    _ => panic!("Expected ForLoop"),
                },
                _ => panic!("Expected Block"),
            },
            _ => panic!("Expected SpindleDef"),
        }
    }

    #[test]
    fn test_play_stmt() {
        let result = parse("play(audio)").unwrap();

        match &result.statements[0] {
            ASTNode::Backend(stmt) => {
                assert_eq!(stmt.positional_args.len(), 1);
            }
            _ => panic!("Expected Backend"),
        }
    }

    #[test]
    fn test_compute_stmt() {
        let result = parse("compute(x, workers: 4)").unwrap();

        match &result.statements[0] {
            ASTNode::Backend(stmt) => {
                assert_eq!(stmt.args.len(), 2);
                assert_eq!(stmt.named_args.len(), 1);
            }
            _ => panic!("Expected Backend"),
        }
    }

    #[test]
    fn test_multiple_statements() {
        let result = parse("me<width> = 800\nx<a> = 42\nrender(x)").unwrap();
        assert_eq!(result.statements.len(), 3);
    }

    #[test]
    fn test_nested_expressions() {
        let result = parse("x<a> = (1 + 2) * (3 + 4)").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => {
                match bind.expr.as_ref() {
                    ASTNode::Binary(mul) => {
                        assert_eq!(mul.op, "*");
                        // Both sides should be Binary (addition)
                        match mul.left.as_ref() {
                            ASTNode::Binary(add) => assert_eq!(add.op, "+"),
                            _ => panic!("Expected Binary"),
                        }
                        match mul.right.as_ref() {
                            ASTNode::Binary(add) => assert_eq!(add.op, "+"),
                            _ => panic!("Expected Binary"),
                        }
                    }
                    _ => panic!("Expected Binary"),
                }
            }
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_power_operator() {
        let result = parse("x<a> = 2 ^ 3").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => match bind.expr.as_ref() {
                ASTNode::Binary(bin) => assert_eq!(bin.op, "^"),
                _ => panic!("Expected Binary"),
            },
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_operator_precedence() {
        let result = parse("x<a> = 2 + 3 * 4").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => {
                match bind.expr.as_ref() {
                    ASTNode::Binary(add) => {
                        assert_eq!(add.op, "+");
                        // Right side should be multiplication
                        match add.right.as_ref() {
                            ASTNode::Binary(mul) => assert_eq!(mul.op, "*"),
                            _ => panic!("Expected Binary mul"),
                        }
                    }
                    _ => panic!("Expected Binary add"),
                }
            }
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_assignment_operators() {
        let result = parse("spindle test() :: <x> { x += 5 }").unwrap();

        match &result.statements[0] {
            ASTNode::SpindleDef(def) => match def.body.as_ref() {
                ASTNode::Block(block) => match &block.body[0] {
                    ASTNode::Assignment(assign) => {
                        assert_eq!(assign.op, "+=");
                        assert_eq!(assign.is_output, false);
                    }
                    _ => panic!("Expected Assignment"),
                },
                _ => panic!("Expected Block"),
            },
            _ => panic!("Expected SpindleDef"),
        }
    }

    #[test]
    fn test_function_call_in_expr() {
        let result = parse("x<a> = sqrt(25)").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => match bind.expr.as_ref() {
                ASTNode::Call(call) => {
                    match call.name.as_ref() {
                        ASTNode::Var(v) => assert_eq!(v.name, "sqrt"),
                        _ => panic!("Expected Var"),
                    }
                    assert_eq!(call.args.len(), 1);
                }
                _ => panic!("Expected Call"),
            },
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_strand_access() {
        let result = parse("x<a> = image@rgb").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => match bind.expr.as_ref() {
                ASTNode::StrandAccess(access) => {
                    match access.base.as_ref() {
                        ASTNode::Var(v) => assert_eq!(v.name, "image"),
                        _ => panic!("Expected Var"),
                    }
                    match access.out.as_ref() {
                        ASTNode::Var(v) => assert_eq!(v.name, "rgb"),
                        _ => panic!("Expected Var"),
                    }
                }
                _ => panic!("Expected StrandAccess"),
            },
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_strand_remap() {
        let result = parse("x<a> = image@rgb(coord@x ~ newX, coord@y ~ newY)").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => match bind.expr.as_ref() {
                ASTNode::StrandRemap(remap) => {
                    match remap.base.as_ref() {
                        ASTNode::Var(v) => assert_eq!(v.name, "image"),
                        _ => panic!("Expected Var"),
                    }
                    assert_eq!(remap.strand, "rgb");
                    assert_eq!(remap.mappings.len(), 2);
                    // First mapping: coord@x
                    match remap.mappings[0].axis.as_ref() {
                        ASTNode::StrandAccess(access) => {
                            match access.base.as_ref() {
                                ASTNode::Var(v) => assert_eq!(v.name, "coord"),
                                _ => panic!("Expected Var"),
                            }
                            match access.out.as_ref() {
                                ASTNode::Var(v) => assert_eq!(v.name, "x"),
                                _ => panic!("Expected Var"),
                            }
                        }
                        _ => panic!("Expected StrandAccess for axis"),
                    }
                    // Second mapping: coord@y
                    match remap.mappings[1].axis.as_ref() {
                        ASTNode::StrandAccess(access) => {
                            match access.base.as_ref() {
                                ASTNode::Var(v) => assert_eq!(v.name, "coord"),
                                _ => panic!("Expected Var"),
                            }
                            match access.out.as_ref() {
                                ASTNode::Var(v) => assert_eq!(v.name, "y"),
                                _ => panic!("Expected Var"),
                            }
                        }
                        _ => panic!("Expected StrandAccess for axis"),
                    }
                }
                _ => panic!("Expected StrandRemap"),
            },
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_strand_remap_complex_axis() {
        let result = parse("x<a> = image@rgb(inst@r ~ newX)").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => match bind.expr.as_ref() {
                ASTNode::StrandRemap(remap) => {
                    assert_eq!(remap.strand, "rgb");
                    assert_eq!(remap.mappings.len(), 1);
                    // Check that axis is a strand access
                    match remap.mappings[0].axis.as_ref() {
                        ASTNode::StrandAccess(access) => {
                            match access.base.as_ref() {
                                ASTNode::Var(v) => assert_eq!(v.name, "inst"),
                                _ => panic!("Expected Var"),
                            }
                            match access.out.as_ref() {
                                ASTNode::Var(v) => assert_eq!(v.name, "r"),
                                _ => panic!("Expected Var"),
                            }
                        }
                        _ => panic!("Expected StrandAccess for axis"),
                    }
                }
                _ => panic!("Expected StrandRemap"),
            },
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_me_field_access() {
        let result = parse("x<a> = me@width").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => match bind.expr.as_ref() {
                ASTNode::Me(me_expr) => {
                    assert_eq!(me_expr.field, "width");
                }
                _ => panic!("Expected Me"),
            },
            _ => panic!("Expected InstanceBinding"),
        }
    }

    #[test]
    fn test_indexing() {
        let result = parse("x<a> = arr[5]").unwrap();

        match &result.statements[0] {
            ASTNode::InstanceBinding(bind) => match bind.expr.as_ref() {
                ASTNode::Index(index) => {
                    match index.base.as_ref() {
                        ASTNode::Var(v) => assert_eq!(v.name, "arr"),
                        _ => panic!("Expected Var"),
                    }
                    match index.index.as_ref() {
                        ASTNode::Num(n) => assert_eq!(n.v, 5.0),
                        _ => panic!("Expected Num"),
                    }
                }
                _ => panic!("Expected Index"),
            },
            _ => panic!("Expected InstanceBinding"),
        }
    }
}
