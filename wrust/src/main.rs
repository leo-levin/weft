use clap::{Parser, Subcommand};
use std::fs;
use std::path::PathBuf;
use wrust::{parser, Env, WeftError};

#[derive(Parser)]
#[command(name = "weft")]
#[command(about = "WEFT language compiler and runtime", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Parse {
        file: PathBuf,

        #[arg(short, long)]
        pretty: bool,
    },

    Graph {
        file: PathBuf,

        #[arg(short, long)]
        order: bool,

        #[arg(short, long)]
        verbose: bool,
    },

    Check {
        file: PathBuf,
    },

    Info {
        file: PathBuf,
    },

    Run {
        file: PathBuf,

        #[arg(short, long, default_value = "800")]
        width: u32,

        #[arg(short = 'H', long, default_value = "600")]
        height: u32,

        #[arg(short, long, default_value = "60.0")]
        fps: f64,
    },
}

fn main() {
    let cli = Cli::parse();

    let result = match cli.command {
        Commands::Parse { file, pretty } => cmd_parse(file, pretty),
        Commands::Graph {
            file,
            order,
            verbose,
        } => cmd_graph(file, order, verbose),
        Commands::Check { file } => cmd_check(file),
        Commands::Info { file } => cmd_info(file),
        Commands::Run {
            file,
            width,
            height,
            fps,
        } => cmd_run(file, width, height, fps),
    };

    if let Err(e) = result {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}

fn read_file(path: PathBuf) -> Result<String, WeftError> {
    fs::read_to_string(&path)
        .map_err(|e| WeftError::Runtime(format!("Failed to read file {:?}: {}", path, e)))
}

fn cmd_parse(file: PathBuf, pretty: bool) -> Result<(), WeftError> {
    let source = read_file(file)?;
    let ast =
        parser::parse(&source).map_err(|e| WeftError::Runtime(format!("Parse error: {}", e)))?;

    if pretty {
        print_ast(&ast, 0);
    } else {
        println!("{:?}", ast);
    }

    Ok(())
}

fn print_ast(program: &wrust::Program, indent: usize) {
    let ind = "  ".repeat(indent);
    println!("{}Program ({} statements)", ind, program.statements.len());
    for stmt in &program.statements {
        print_node(stmt, indent + 1);
    }
}

fn print_node(node: &wrust::ASTNode, indent: usize) {
    let ind = "  ".repeat(indent);

    match node {
        wrust::ASTNode::Backend(backend) => {
            println!("{}Backend: {}", ind, backend.context);
            for arg in &backend.positional_args {
                print_node(arg, indent + 1);
            }
            for (name, value) in &backend.named_args {
                println!("{}  {}: ", ind, name);
                print_node(value, indent + 2);
            }
        }
        wrust::ASTNode::InstanceBinding(bind) => {
            println!("{}Instance: {} <{}>", ind, bind.name, bind.outputs.join(", "));
            print_node(&bind.expr, indent + 1);
        }
        wrust::ASTNode::SpindleDef(def) => {
            println!(
                "{}Spindle: {}({}) :: <{}>",
                ind,
                def.name,
                def.inputs.join(", "),
                def.outputs.join(", ")
            );
            print_node(&def.body, indent + 1);
        }
        wrust::ASTNode::Block(block) => {
            println!("{}Block", ind);
            for stmt in &block.body {
                print_node(stmt, indent + 1);
            }
        }
        wrust::ASTNode::Assignment(assign) => {
            println!("{}Assignment: {} {}", ind, assign.name, assign.op);
            print_node(&assign.expr, indent + 1);
        }
        wrust::ASTNode::Binary(bin) => {
            println!("{}Binary: {}", ind, bin.op);
            print_node(&bin.left, indent + 1);
            print_node(&bin.right, indent + 1);
        }
        wrust::ASTNode::Unary(un) => {
            println!("{}Unary: {}", ind, un.op);
            print_node(&un.expr, indent + 1);
        }
        wrust::ASTNode::Call(call) => {
            print!("{}Call: ", ind);
            if let wrust::ASTNode::Var(v) = call.name.as_ref() {
                println!("{}", v.name);
            } else {
                println!("<complex>");
                print_node(&call.name, indent + 1);
            }
            for arg in &call.args {
                print_node(arg, indent + 1);
            }
        }
        wrust::ASTNode::If(if_expr) => {
            println!("{}If", ind);
            println!("{}  condition:", ind);
            print_node(&if_expr.condition, indent + 2);
            println!("{}  then:", ind);
            print_node(&if_expr.then_expr, indent + 2);
            println!("{}  else:", ind);
            print_node(&if_expr.else_expr, indent + 2);
        }
        wrust::ASTNode::ForLoop(for_loop) => {
            println!("{}For: {} in", ind, for_loop.var);
            print_node(&for_loop.start, indent + 1);
            println!("{}  to", ind);
            print_node(&for_loop.end, indent + 1);
            println!("{}  body:", ind);
            print_node(&for_loop.body, indent + 2);
        }
        wrust::ASTNode::Tuple(tuple) => {
            println!("{}Tuple ({} items)", ind, tuple.items.len());
            for item in &tuple.items {
                print_node(item, indent + 1);
            }
        }
        wrust::ASTNode::Index(index) => {
            println!("{}Index", ind);
            print_node(&index.base, indent + 1);
            println!("{}  [", ind);
            print_node(&index.index, indent + 1);
            println!("{}  ]", ind);
        }
        wrust::ASTNode::StrandAccess(access) => {
            print!("{}StrandAccess: ", ind);
            if let wrust::ASTNode::Var(base) = access.base.as_ref() {
                if let wrust::ASTNode::Var(out) = access.out.as_ref() {
                    println!("{}@{}", base.name, out.name);
                } else {
                    println!();
                    print_node(&access.base, indent + 1);
                    println!("{}  @", ind);
                    print_node(&access.out, indent + 1);
                }
            } else {
                println!();
                print_node(&access.base, indent + 1);
                println!("{}  @", ind);
                print_node(&access.out, indent + 1);
            }
        }
        wrust::ASTNode::StrandRemap(remap) => {
            print!("{}StrandRemap: ", ind);
            if let wrust::ASTNode::Var(base) = remap.base.as_ref() {
                println!("{}@{}", base.name, remap.strand);
            } else {
                println!();
                print_node(&remap.base, indent + 1);
            }
            for mapping in &remap.mappings {
                println!("{}  mapping:", ind);
                print_node(&mapping.axis, indent + 2);
                println!("{}    ~", ind);
                print_node(&mapping.expr, indent + 2);
            }
        }
        wrust::ASTNode::Num(num) => {
            println!("{}Num: {}", ind, num.v);
        }
        wrust::ASTNode::Str(s) => {
            println!("{}Str: {}", ind, s.v);
        }
        wrust::ASTNode::Var(v) => {
            println!("{}Var: {}", ind, v.name);
        }
        wrust::ASTNode::Me(me) => {
            println!("{}Me: @{}", ind, me.field);
        }
        wrust::ASTNode::NamedArg(arg) => {
            println!("{}NamedArg: {}", ind, arg.name);
            print_node(&arg.value, indent + 1);
        }
        wrust::ASTNode::Program(_) => {
            println!("{}Program (nested - unexpected)", ind);
        }
    }
}

fn cmd_graph(file: PathBuf, show_order: bool, verbose: bool) -> Result<(), WeftError> {
    let source = read_file(file)?;
    let ast =
        parser::parse(&source).map_err(|e| WeftError::Runtime(format!("Parse error: {}", e)))?;

    let env = Env::new(800, 600);

    let mut graph = wrust::runtime::render_graph::RenderGraph::new();
    let exec_order = graph.build(&ast, &env)?;

    if !show_order && !verbose {
        for node_name in &exec_order {
            if let Some(node) = graph.get_node(node_name) {
                let outputs: Vec<String> = node.outputs.keys().map(|s| s.to_string()).collect();
                let node_type = match node.node_type {
                    wrust::runtime::render_graph::NodeType::Expression => "expr",
                    wrust::runtime::render_graph::NodeType::Spindle => "spindle",
                    wrust::runtime::render_graph::NodeType::Builtin => "builtin",
                };

                print!("{} <{}>", node.instance_name, outputs.join(", "));
                print!(" ({})", node_type);

                if !node.deps.is_empty() {
                    let deps: Vec<String> = node.deps.iter().map(|s| s.to_string()).collect();
                    print!(" <- {}", deps.join(", "));
                }

                if !node.contexts.is_empty() {
                    let contexts: Vec<_> = node.contexts.iter().map(|c| format!("{:?}", c)).collect();
                    print!(" [{}]", contexts.join(", "));
                }

                println!();
            }
        }
    }

    if show_order {
        println!("Execution order:");
        for (i, node_name) in exec_order.iter().enumerate() {
            if let Some(node) = graph.get_node(node_name) {
                let outputs: Vec<String> = node.outputs.keys().map(|s| s.to_string()).collect();
                println!("  {}. {} <{}>", i + 1, node_name, outputs.join(", "));
            }
        }
        println!();
    }

    if verbose {
        for node_name in &exec_order {
            if let Some(node) = graph.get_node(node_name) {
                let node_type = match node.node_type {
                    wrust::runtime::render_graph::NodeType::Expression => "expr",
                    wrust::runtime::render_graph::NodeType::Spindle => "spindle",
                    wrust::runtime::render_graph::NodeType::Builtin => "builtin",
                };

                let outputs: Vec<String> = node.outputs.keys().map(|s| s.to_string()).collect();
                println!("{} <{}> ({})", node.instance_name, outputs.join(", "), node_type);

                if !node.deps.is_empty() {
                    let deps: Vec<String> = node.deps.iter().map(|s| s.to_string()).collect();
                    println!("  depends on: {}", deps.join(", "));
                }

                if !node.required_outputs.is_empty() {
                    let req: Vec<String> = node.required_outputs.iter().map(|s| s.to_string()).collect();
                    println!("  required outputs: {}", req.join(", "));
                }

                if !node.contexts.is_empty() {
                    let contexts: Vec<_> = node.contexts.iter().map(|c| format!("{:?}", c)).collect();
                    println!("  contexts: {}", contexts.join(", "));
                }

                println!();
            }
        }
    }

    if !verbose {
        println!("\n{} nodes", exec_order.len());
    }

    Ok(())
}

fn cmd_check(file: PathBuf) -> Result<(), WeftError> {
    let source = read_file(file.clone())?;

    let ast =
        parser::parse(&source).map_err(|e| WeftError::Runtime(format!("Parse error: {}", e)))?;

    println!("✓ Syntax is valid");
    println!("✓ Found {} statement(s)", ast.statements.len());

    let env = Env::new(800, 600);
    let mut graph = wrust::runtime::render_graph::RenderGraph::new();
    let exec_order = graph.build(&ast, &env)?;

    println!("✓ Dependency graph is valid");
    println!("✓ Execution order: {} nodes", exec_order.len());

    println!("\n{:?} passes all checks!", file);

    Ok(())
}

fn cmd_info(file: PathBuf) -> Result<(), WeftError> {
    let source = read_file(file.clone())?;
    let ast =
        parser::parse(&source).map_err(|e| WeftError::Runtime(format!("Parse error: {}", e)))?;

    println!("File: {:?}", file);
    println!("Size: {} bytes", source.len());
    println!();

    let mut spindle_defs = 0;
    let mut instance_bindings = 0;
    let mut backends = 0;
    let mut assignments = 0;

    for stmt in &ast.statements {
        match stmt {
            wrust::ASTNode::SpindleDef(_) => spindle_defs += 1,
            wrust::ASTNode::InstanceBinding(_) => instance_bindings += 1,
            wrust::ASTNode::Backend(_) => backends += 1,
            wrust::ASTNode::Assignment(_) => assignments += 1,
            _ => {}
        }
    }

    println!("Statements:");
    println!("  Total: {}", ast.statements.len());
    println!("  Spindle definitions: {}", spindle_defs);
    println!("  Instance bindings: {}", instance_bindings);
    println!("  Backend outputs: {}", backends);
    println!("  Environment assignments: {}", assignments);

    let env = Env::new(800, 600);
    let mut graph = wrust::runtime::render_graph::RenderGraph::new();
    if let Ok(exec_order) = graph.build(&ast, &env) {
        println!();
        println!("Dependency Graph:");
        println!("  Computation nodes: {}", exec_order.len());

        let mut visual_nodes = 0;
        let mut audio_nodes = 0;
        let mut compute_nodes = 0;

        for node_name in &exec_order {
            if let Some(node) = graph.get_node(node_name) {
                if node
                    .contexts
                    .contains(&wrust::runtime::backend_registry::Context::Visual)
                {
                    visual_nodes += 1;
                }
                if node
                    .contexts
                    .contains(&wrust::runtime::backend_registry::Context::Audio)
                {
                    audio_nodes += 1;
                }
                if node
                    .contexts
                    .contains(&wrust::runtime::backend_registry::Context::Compute)
                {
                    compute_nodes += 1;
                }
            }
        }

        println!("  Visual context nodes: {}", visual_nodes);
        println!("  Audio context nodes: {}", audio_nodes);
        println!("  Compute context nodes: {}", compute_nodes);
    }

    Ok(())
}

fn cmd_run(file: PathBuf, width: u32, height: u32, fps: f64) -> Result<(), WeftError> {
    let source = read_file(file.clone())?;
    let _ast =
        parser::parse(&source).map_err(|e| WeftError::Runtime(format!("Parse error: {}", e)))?;

    println!("Running WEFT program: {:?}", file);
    println!("Canvas: {}x{}, Target FPS: {}", width, height, fps);
    println!();

    let mut _env = Env::new(width, height);
    _env.target_fps = fps;

    println!("⚠ Backend implementations not yet available");
    println!("The program parsed successfully but cannot execute yet.");
    println!();
    println!("To run this program, backends need to be implemented:");
    println!("  - CPU backend (wrust/src/backend/cpu.rs)");
    println!("  - Mac Visual backend (wrust/src/backend/mac_visual.rs)");
    println!("  - Mac Audio backend (wrust/src/backend/mac_audio.rs)");

    Ok(())
}
