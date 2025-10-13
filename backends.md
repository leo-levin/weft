# WEFT Backend Architecture

## Overview

WEFT's backend system enables context-agnostic code to execute efficiently across different output types (visual, audio, compute) and execution strategies (CPU interpreter, GPU shaders).

**Core concepts:**

1. **Render Graph** - Analyzes AST, partitions subgraphs, computes execution order
2. **Coordinator** - Routes subgraphs to backends in dependency order
3. **Backends** - Compile and execute subgraphs

---

## Core Philosophy

**Context-agnostic code is a feature.**

```weft
noise<val> = sin(me@x * 10)

display(noise@val, 0, 0)  // Visual
audio(noise@val)          // Audio
haptic(noise@val)         // Haptic
```

Each backend optimizes `noise` for its context:

- Visual: GPU shader
- Audio: Bytecode VM
- Haptic: Native code

**Cross-context value passing is fast** (function calls in shared memory on M1).

---

## 1. Render Graph (Does the Heavy Lifting)

**Pipeline:**

```
AST → Dependencies → Context Tagging → Subgraph Partitioning → Topological Sort → Execution Order
```

### Context Tagging

Nodes inherit context from their consumers:

- `display(val@x, 0, 0)` → `val` gets Visual context
- `audio(val@x)` → `val` gets Audio context

### Subgraph Partitioning

Group connected nodes sharing the same context:

- Each subgraph = one context
- Intra-subgraph: Direct references
- Cross-subgraph: Coordinator lookup

### Execution Order

**Key insight: Execution order is at SUBGRAPH level.**

Topological sort ensures dependencies execute before consumers.

**Example:**

```weft
a<val> = expensive()           // CPU context
b<val> = a@val * 2             // Visual context (depends on a)
c<val> = a@val + b@val         // CPU context (depends on a, b)
compute(c@val)
```

**Graph produces:**

```
Subgraph A: context=CPU,    nodes=[a], deps=[]
Subgraph B: context=Visual, nodes=[b], deps=[A]
Subgraph C: context=CPU,    nodes=[c], deps=[A,B]

Execution order: [A, B, C]
```

**Coordinator executes:** A on CPU → B on Visual → C on CPU

---

## 2. Coordinator (Simple Router)

**Data structures:**

```rust
struct Coordinator {
    graph: RenderGraph,
    backends: Vec<Box<dyn Backend>>,
    subgraphs: Vec<Subgraph>,           // From graph
    execution_order: Vec<usize>,        // From graph
    registry: HashMap<String, usize>,   // "instance@output" -> backend_idx
}

struct Subgraph {
    id: usize,
    context: Context,
    nodes: Vec<GraphNode>,
    depends_on: Vec<usize>,
}
```

### Compilation

```rust
// 1. Build graph
(subgraphs, execution_order) = graph.build(&ast, &env)

// 2. Assign backends by context
for subgraph in subgraphs {
    subgraph.backend = find_backend(subgraph.context)
}

// 3. Compile in execution order
for sg_id in execution_order {
    subgraph = subgraphs[sg_id]
    backend = backends[subgraph.backend]
    backend.compile_subgraph(subgraph, env, coordinator)
}
```

### Execution

```rust
for sg_id in execution_order {
    subgraph = subgraphs[sg_id]
    backend = backends[subgraph.backend]
    backend.execute_subgraph(subgraph, env, coordinator)
}
```

### Registry

Maps outputs to owning backends:

- Populated during compilation via `expose()`
- Used during evaluation via `lookup()`

---

## 3. Backend Trait

```rust
trait Backend {
    fn context(&self) -> &str;

    fn compile_subgraph(&mut self, subgraph: &Subgraph, env: &Env,
                        coordinator: &mut Coordinator) -> Result<()>;

    fn execute_subgraph(&mut self, subgraph: &Subgraph, env: &Env,
                        coordinator: &Coordinator) -> Result<()>;

    fn get_value_at(&self, instance: &str, output: &str,
                    coords: &HashMap<String, f64>, env: &Env,
                    coordinator: &Coordinator) -> Result<f64>;

    fn get_handle(&self, instance: &str, output: &str) -> Result<Handle> {
        Err(WeftError::Runtime("No handle".into()))
    }
}
```

**Backend types:**

- **Output**: VisualCPU, VisualMetal, AudioCPU, AudioMetal
- **Compute**: CPUBackend (bytecode VM, fallback for any context)

**Coordinator calls backend once per subgraph assigned to it.**

---

## Cross-Context Value Passing

### Expose (Compilation)

Backend registers outputs with coordinator:

```rust
coordinator.expose("noise", "val", self.context());
// Coordinator: registry["noise@val"] = backend_idx
```

### Lookup (Evaluation)

Backend requests value from coordinator:

```rust
let data_ref = coordinator.lookup("noise", "val")?;
match data_ref {
    ValueGetter(f) => f(&coords, env, coordinator),  // CPU function call
    Handle(h) => /* GPU handle */
}
```

### Performance on M1

| Lookup    | Speed   | Why                            |
| --------- | ------- | ------------------------------ |
| CPU → CPU | Fast    | Function call in shared memory |
| GPU → GPU | Instant | Zero-copy handle passing       |
| CPU → GPU | Medium  | Per-pixel function calls       |
| GPU → CPU | Slow    | Synchronization + readback     |

**Key: No memory transfer cost on M1 unified memory.**

---

## Subgraph Optimization

**Without subgraphs:**

```weft
noise<val> = sin(me@x * 10)
bright<val> = noise@val * 0.5
display(bright@val, 0, 0)
```

→ 3 evaluations + 2 lookups per pixel

**With subgraphs:**

Backend receives all three nodes together:
→ Inline everything into single shader/bytecode
→ 1 evaluation, 0 lookups per pixel

### Optimization Examples

**Inlining:**

```glsl
// From: display(bright@val, 0, 0), bright=noise*0.5, noise=sin(x*10)
// To:
vec3(sin(coords.x * 10.0) * 0.5, 0, 0)
```

**Common Subexpression Elimination:**

```weft
a<val> = expensive()
b<val> = a@val + 1
c<val> = a@val + 2
display(b@val, c@val, 0)
```

→ Evaluate `a@val` once, reuse for both `b` and `c`

**Frame-constant Hoisting:**

```weft
time_wave<val> = sin(me@time)
display(time_wave@val, 0, 0)
```

→ Evaluate once per frame, pass as uniform
→ 1 eval/frame instead of width×height evals/frame

---

## Extensibility

### Adding a Backend

```rust
struct HapticCPUBackend {
    vm_cache: HashMap<String, Bytecode>,
    buffer: Vec<f32>,
}

impl Backend for HapticCPUBackend {
    fn context(&self) -> &str { "haptic" }

    fn compile_subgraph(&mut self, subgraph, env, coordinator) {
        // Compile to bytecode, call coordinator.expose()
    }

    fn execute_subgraph(&mut self, subgraph, env, coordinator) {
        // Generate haptic samples
    }

    fn get_value_at(&self, instance, output, coords, env, coord) -> f64 {
        // Evaluate on-demand
    }
}

// Register
coordinator.add_backend(Box::new(HapticCPUBackend::new()));

// Use
haptic(noise@val)  // Automatically routed!
```

No changes to coordinator, graph, or other backends required.

---

## Summary

### Division of Responsibility

| Component        | Responsibility                                |
| ---------------- | --------------------------------------------- |
| **Render Graph** | Analyze, partition, compute execution order   |
| **Coordinator**  | Route subgraphs to backends, manage lookups   |
| **Backend**      | Compile/execute subgraphs, respond to lookups |

### Key Design Decisions

- **Subgraph-level execution** (not node or backend level)
- **Graph does heavy lifting** (coordinator is thin router)
- **Backends optimize within subgraphs** (inlining, CSE, hoisting)
- **Lookup via closures** (clean abstraction)
- **M1 unified memory** (no transfer overhead)

### Trade-offs

- Cross-backend per-pixel lookups slower than same-backend
- Subgraph granularity affects optimization opportunities
- Graph complexity (topological sort, cycle detection)
