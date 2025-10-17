# WEFT Backend Architecture

## Overview

WEFT's backend system enables context-agnostic code to execute efficiently across different output types (visual, audio, compute) and execution strategies (CPU interpreter, GPU shaders).

**Core concepts:**

1. **Render Graph** - Analyzes AST, partitions subgraphs, computes execution order
2. **Coordinator** - Routes subgraphs to backends in dependency order
3. **Backends** - Compile and execute subgraphs

**Status:** ✅ Render Graph + Coordinator fully implemented and tested. ⏳ Backends need implementation.

---

## Core Philosophy

**Context-agnostic code is a feature.**

```weft
noise<val> = sin(me@x * 10)

display(noise@val, 0, 0)  // Visual
audio(noise@val)          // Audio
haptic(noise@val)         // Haptic
```

Each backend optimizes `noise` for its context using **different compilation strategies**:

- Visual: GPU shader (Metal) OR bytecode VM (CPU)
- Audio: GPU compute shader (Metal) OR bytecode VM (CPU)
- Haptic: Bytecode VM (CPU)

**Cross-context value passing is fast** on Apple Silicon unified memory:
- CPU↔CPU: ~5ns (function call)
- GPU↔GPU: ~10ns (texture/buffer binding)
- CPU→GPU: ~100ns (upload uniform)
- GPU→CPU: ~50μs (sync + read from shared memory)

---

## Two-Layer Backend Architecture

WEFT separates **compilation strategy** from **execution context**:

```
                  ┌─────────────┐
                  │ AST (WEFT)  │
                  └──────┬──────┘
                         │
          ┏━━━━━━━━━━━━━━┻━━━━━━━━━━━━━━┓
          ▼                              ▼
    ┌───────────┐                  ┌──────────┐
    │ Bytecode  │                  │  Metal   │
    │ Compiler  │                  │ Compiler │
    └─────┬─────┘                  └────┬─────┘
          │                              │
          ▼                              ▼
    ┌───────────┐                  ┌──────────┐
    │ Bytecode  │                  │   MSL    │
    │   (IR)    │                  │ (shader) │
    └─────┬─────┘                  └────┬─────┘
          │                              │
    ┏━━━━━╋━━━━━┓                        │
    ▼     ▼     ▼                        ▼
┌───────┐┌────┐┌────┐               ┌────────┐
│ CPU   ││CPU ││CPU │               │ Metal  │
│Visual ││Aud ││Cmp │               │GPU (any)
└───────┘└────┘└────┘               └────────┘
```

### Layer 1: Compilation
- **Bytecode Compiler** (`bytecode.rs`): AST → stack-based bytecode instructions
  - Used by: All CPU backends
  - Why: Sequential execution model, portable, debuggable

- **Metal Compiler** (`metal.rs`): AST → Metal Shading Language (MSL)
  - Used by: All GPU backends (visual, audio, compute)
  - Why: Parallel execution model, hardware-accelerated

### Layer 2: Execution
- **CPU Backends**: Use bytecode VM for sequential evaluation
  - `cpu_visual.rs`: Renders pixels via bytecode interpreter
  - `cpu_audio.rs`: Generates audio samples via bytecode interpreter
  - `cpu_compute.rs`: General computation via bytecode interpreter

- **GPU Backends**: Dispatch Metal shaders for parallel evaluation
  - `metal_visual.rs`: Renders pixels via Metal fragment/compute shaders
  - `metal_audio.rs`: Generates audio samples via Metal compute shaders
  - `metal_compute.rs`: General computation via Metal compute shaders

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

### Performance on Apple Silicon

| From Backend | To Backend | Mechanism | Cost | Notes |
| ------------ | ---------- | --------- | ---- | ----- |
| CPU | CPU | ValueGetter→ValueGetter | ~5ns | Direct function call |
| GPU | GPU | Handle→Handle | ~10ns | Texture/buffer binding in shader |
| CPU | GPU | ValueGetter→Upload | ~100ns | Update uniform/buffer pointer |
| GPU | CPU (1 value) | Handle→Sync→Read | ~50μs | Wait for GPU + read from shared memory |
| GPU | CPU (batch) | Handle→Sync→Map | ~50μs + N×2ns | Sync once, then sequential reads |

**Key insights:**
- **Unified memory** eliminates PCIe DMA transfers entirely (100-1000x speedup vs discrete GPUs)
- **GPU→CPU sync** is the main cost (~50μs), not data transfer
- **Batch reads** amortize sync cost across many values
- **Target 60 FPS** = 16.6ms budget; GPU→CPU sync uses 0.3% of budget ✅

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

## Key Design Decisions

### Why Bytecode AND Metal?

**Bytecode (CPU):**
- ✅ Platform-independent (works on any CPU)
- ✅ Easy to debug (can inspect instructions, step through execution)
- ✅ Supports complex control flow (arbitrary branching, loops)
- ✅ Can access system resources (file I/O, network, CPU-only libraries)
- ⚠️ Sequential execution (one operation at a time)

**Metal (GPU):**
- ✅ Massively parallel (thousands of operations simultaneously)
- ✅ Hardware-accelerated (dedicated silicon for graphics/compute)
- ✅ Energy efficient (more ops/watt than CPU)
- ⚠️ Requires Apple Silicon or AMD/Intel GPU with Metal support
- ⚠️ Limited control flow (branching is slow on GPU)
- ⚠️ No access to system resources (sandboxed)

**Having both enables:**
- Start with CPU bytecode (universal compatibility)
- Optimize hot paths with Metal (performance)
- Mix strategies per-context (CPU audio, GPU visual)
- Graceful fallback when Metal unavailable

### Why Separate Backends Per Context?

Could have one CPUBackend handling all contexts, but separate backends enable:
- **Context-specific optimizations:** Visual can use 2D spatial caching, audio can use temporal buffering
- **Independent evolution:** Add WebGPU visual backend without touching audio
- **Clear separation of concerns:** Each backend focuses on one problem
- **User choice:** Mix CPU and GPU backends per-context

### Why Stack-Based Bytecode?

Alternatives: register-based (like LLVM), AST interpreter

**Stack-based wins because:**
- ✅ Simpler compiler (no register allocation)
- ✅ Smaller bytecode (implicit operands)
- ✅ Easier to implement (just Vec<f64> stack)
- ✅ Good enough performance (JVM uses stack-based)

**Example:**
```weft
result<val> = (5 + 3) * 2
```

Stack-based bytecode:
```
Push 5      # Stack: [5]
Push 3      # Stack: [5, 3]
Add         # Stack: [8]
Push 2      # Stack: [8, 2]
Mul         # Stack: [16]
Return      # Return 16
```

Register-based (more complex):
```
LoadConst r1, 5
LoadConst r2, 3
Add r3, r1, r2
LoadConst r4, 2
Mul r5, r3, r4
Return r5
```

### Why Not WebGPU?

WebGPU would enable browser support, but:
- Metal is simpler (one platform, better docs)
- Apple Silicon performance is exceptional
- Can add WebGPU later (same architecture, different compiler)
- Targeting native macOS first (WEFT's primary platform)

Future: Add `webgpu_visual.rs`, `webgpu_audio.rs` alongside Metal backends

### Coordinator Changes Needed?

**None!** The coordinator is already designed for this:
- `Backend` trait is implementation-agnostic
- `DataRef` enum handles both CPU (ValueGetter) and GPU (Handle)
- `supports_handles()` lets backends advertise capabilities
- `lookup()` automatically returns appropriate DataRef type

The separation between compilation strategy (bytecode/Metal) and execution context (visual/audio) is purely a backend implementation detail.

---

## Implementation Roadmap

### Current Status

✅ **Complete:**
- Parser (Pest-based, `parser.rs`)
- AST definitions (`ast.rs`)
- Render Graph (context tagging, partitioning, toposort - `render_graph.rs`)
- Coordinator (subgraph routing, expose/lookup registry - `coordinator.rs`)
- Backend trait (`backend/types.rs`)
- Comprehensive test suite (1,245 lines render_graph tests, 872 lines coordinator tests)

⏳ **In Progress:**
- Backend implementations

### Phase 1: CPU Backend (MVP) - START HERE

**Goal:** Get a minimal WEFT program running on CPU

1. **Implement `backend/bytecode.rs`** (~500 lines)
   - Define `Instruction` enum (Push, Add, Sub, Mul, LoadCoord, LoadStrand, Call, etc.)
   - Implement `BytecodeCompiler::compile(node, output) -> BytecodeProgram`
     - Walk AST recursively
     - Emit stack-based instructions
   - Implement `BytecodeVM::execute(program, coords, env, coordinator) -> f64`
     - Stack-based interpreter
     - Call builtin functions (sin, cos, etc.)
     - Handle coordinator.lookup() for cross-node dependencies

2. **Implement `backend/cpu_visual.rs`** (~300 lines)
   ```rust
   pub struct CPUVisualBackend {
       programs: HashMap<String, BytecodeProgram>,  // "instance@output" -> bytecode
       display_programs: Option<(BytecodeProgram, BytecodeProgram, BytecodeProgram)>,  // R, G, B
       buffer: Vec<u32>,  // RGBA pixel buffer
       vm: BytecodeVM,
   }

   impl Backend for CPUVisualBackend {
       fn context(&self) -> Context { Context::Visual }

       fn compile_subgraph(&mut self, subgraph, env, coordinator) {
           // For each node in subgraph:
           //   1. Compile outputs to bytecode
           //   2. Store in programs map
           //   3. Call coordinator.expose(instance, output, Context::Visual)
       }

       fn execute_subgraph(&mut self, subgraph, env, coordinator) {
           // If display_programs set:
           //   For each pixel (x, y):
           //     r = vm.execute(r_program, coords{x, y}, env, coordinator)
           //     g = vm.execute(g_program, coords{x, y}, env, coordinator)
           //     b = vm.execute(b_program, coords{x, y}, env, coordinator)
           //     buffer[y*width + x] = RGB(r, g, b)
       }

       fn get_value_at(&self, instance, output, coords, env, coordinator) {
           // Lookup bytecode program, execute with VM
       }
   }
   ```

3. **Update `main.rs`** (~100 lines)
   - Uncomment and fix the cmd_run() function
   - Create Coordinator, register CPUVisualBackend
   - Parse display() args, set on backend
   - Compile, then loop: execute + update window

4. **Test with simple WEFT program**
   ```weft
   test<val> = sin(me@x * 0.01)
   display(test@val, 0, 0)
   ```
   Expected: Vertical stripes animating

**Deliverable:** `cargo run --release -- run test.weft` shows a window with rendered graphics

### Phase 2: CPU Audio Backend

5. **Implement `backend/cpu_audio.rs`** (~250 lines)
   - Similar to cpu_visual, but generates audio samples instead of pixels
   - Uses same bytecode compiler/VM
   - Outputs `Vec<f32>` audio buffer

6. **Integrate with macOS CoreAudio** (~200 lines)
   - Hook up audio buffer to system audio output
   - Handle sample rate, buffering

**Deliverable:** Audio-visual WEFT programs work on CPU

### Phase 3: GPU Backend (Metal)

7. **Implement `backend/metal.rs`** (~800 lines)
   - `MetalCompiler::compile_to_msl(subgraph, env) -> String`
   - Walk AST, emit MSL code
   - Handle:
     - Arithmetic → MSL operators
     - Builtin calls → MSL functions (sin, cos, etc.)
     - me@x, me@y → thread position
     - Cross-context references → texture sampling or uniforms

8. **Implement `backend/metal_visual.rs`** (~400 lines)
   - Create Metal device, command queue
   - Compile MSL to pipeline
   - Dispatch compute/fragment shader
   - Return texture handles via `get_handle()`

9. **Implement `backend/metal_audio.rs`** (~300 lines)
   - Similar to metal_visual, but compute shader generates audio samples
   - Output to Metal buffer, not texture

**Deliverable:** High-performance GPU-accelerated WEFT programs

### Phase 4: Optimization & Polish

10. **Batch GPU→CPU reads** (~100 lines)
    - Add `get_texture_buffer()` to Backend trait
    - Implement in MetalVisualBackend
    - Update CPU backends to use batch reads when available

11. **Backend selection/fallback**
    - Auto-detect Metal support
    - Fall back to CPU if Metal unavailable
    - Environment variable for forcing CPU mode

12. **Benchmarking & profiling**
    - Compare CPU vs Metal performance
    - Optimize hot paths
    - Document performance characteristics

### File Structure After Implementation

```
wrust/src/backend/
├── mod.rs              # Export all backends
├── types.rs            # ✅ Backend trait, DataRef (done)
├── bytecode.rs         # ⏳ Bytecode compiler + VM
├── metal.rs            # ⏳ Metal/MSL compiler
├── cpu_visual.rs       # ⏳ CPU visual backend
├── cpu_audio.rs        # ⏳ CPU audio backend
├── cpu_compute.rs      # ⏳ CPU compute backend
├── metal_visual.rs     # ⏳ Metal visual backend
└── metal_audio.rs      # ⏳ Metal audio backend
```

### Estimated Effort

- Phase 1 (CPU MVP): ~2-3 days (800 lines, critical path)
- Phase 2 (CPU Audio): ~1 day (450 lines)
- Phase 3 (Metal GPU): ~3-4 days (1500 lines, complex)
- Phase 4 (Polish): ~1-2 days

**Total: ~1-2 weeks for full backend implementation**

### Testing Strategy

**Unit tests:**
- Bytecode compiler: AST → bytecode correctness
- Bytecode VM: Instruction execution
- Metal compiler: AST → MSL correctness

**Integration tests:**
- Simple WEFT programs (single node)
- Multi-node programs (dependencies)
- Cross-context programs (visual depends on audio)

**Visual tests:**
- Compare CPU vs GPU output (should be identical)
- Benchmark performance (60+ FPS target)

### Next Steps

1. **Start with Phase 1, Step 1**: Implement `bytecode.rs`
2. **Design bytecode instruction set** collaboratively
3. **Implement bytecode compiler** (AST walker)
4. **Implement bytecode VM** (stack interpreter)
5. **Move to cpu_visual.rs** once bytecode works
