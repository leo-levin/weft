# WEFT Rust Architecture: Coordinator & Backend Model

## Core Principles

### 1. WEFT is Domain-Agnostic

Every strand (me@x, foo@out1, me@time) represents values over the real numbers. There are no inherent "spatial" or "temporal" types - data can flow anywhere.

### 2. Backends are Extensible

Current: MacVisualBackend (Metal), MacAudioBackend (Metal)
Future: OSC, MIDI, File Export, Data Export, etc.

Not all backends use Metal shared memory, but those that do can share efficiently.

### 3. Apple Unified Memory is THE Reason for macOS/Metal

**This is the entire architectural motivation:**

- Metal buffers/textures live in unified memory
- Both GPU and CPU can access the same memory directly
- Zero-copy sharing between backends
- Audio backend produces Metal buffer → Visual backend binds it directly into shaders
- Visual backend produces Metal texture → OSC backend reads pixels directly via CPU

**Performance characteristics (Apple Silicon unified memory):**

- Full 4K texture CPU read: ~0.3-0.6ms
- Full 8K texture CPU read: ~1.3-2.6ms
- Individual pixel read: ~10-200ns (hot/cold cache)
- Metal buffer access: ~10-50ns

For non-Metal backends (OSC, file export), they can READ Metal data via CPU mapping of unified memory - still fast!

### 4. Explicit Cross-Domain Access

Users control how data crosses domains via strand remapping syntax:

```weft
audio<samples> = mic()                              // Audio: 1D temporal buffer
img<r> = audio@samples[me@time ~ me@x * 10]        // Visual samples audio over space
```

---

## Context Tagging

The RenderGraph tags nodes with contexts by walking backwards from backend statements:

```weft
sound<intensity> = mic()
viz<out> = me.x * sound@intensity
display(viz@out)
```

Context tagging:

- `display()` → Visual backend
- `viz` is used by display → tag `viz` with Visual
- `sound` is used by viz → tag `sound` with Visual

**Context tags mean "who needs this data"**, not "who produces it".

A node can have multiple contexts if used by multiple backends.

---

## Node Assignment

**Rule:** First backend to use a node (by source order) compiles it.

### Special Case: Builtins

Builtins always go to their natural backend regardless of context tags:

- `mic()` → MacAudioBackend
- `load()`, `camera()` → MacVisualBackend
- etc.

### Non-Builtins (Expressions, Spindles)

Go to the first backend that needs them (by source order):

```weft
img<r> = sin(me@x) + 0.5 * me@y
samp<x> = img@r[me@x ~ mouse@x, me@y ~ mouse@y]
play(sin(me@time * 880 * samp@x))  // Audio needs img (via samp) - FIRST
display(img@r)                      // Visual needs img - second
```

Since `play()` appears first in source, **Audio backend compiles `img`**.

The first backend produces data in its native domain (Audio → 1D buffer over time).
Other backends adapt by explicit coordinate remappings.

---

## Compilation Flow

### 1. Build Render Graph

```rust
graph.build(&ast, &env)?;
let exec_order = graph.topo_sort()?;
```

Produces:

- Dependency graph of nodes
- Context tags (who needs what)
- Topologically sorted execution order

### 2. Assign Nodes to Backends

For each node in topological order:

- If builtin → assign to natural backend
- Else → assign to first backend that needs it (by context + source order)

### 3. Batch Compile in Topological Order

**The coordinator batches consecutive nodes for the same backend while respecting dependencies:**

```rust
// Walk topo-sorted nodes and batch by backend
let mut batches: Vec<(usize, Vec<&GraphNode>)> = Vec::new();
let mut current_backend = None;
let mut current_batch = Vec::new();

for node_name in exec_order {
    let backend_idx = self.assignments[&node_name];

    if Some(backend_idx) != current_backend {
        // Backend changed - flush current batch
        if !current_batch.is_empty() {
            batches.push((current_backend.unwrap(), current_batch));
            current_batch = Vec::new();
        }
        current_backend = Some(backend_idx);
    }

    current_batch.push(self.graph.get_node(&node_name).unwrap());
}

// Flush final batch
if !current_batch.is_empty() {
    batches.push((current_backend.unwrap(), current_batch));
}

// Compile batches in order
for (backend_idx, nodes) in batches {
    self.backends[backend_idx].compile_nodes(&nodes, &self.env, self)?;
}
```

**Key:**

- Batching allows backends to optimize compilation of related nodes together
- Topological order guarantees cross-backend dependencies are ready
- Cannot batch ALL nodes per backend (might flip-flop between backends)

**Example:**

```weft
audio<s> = mic()              // Audio
img1<r> = sin(me@x)           // Visual
img2<g> = cos(me@y)           // Visual
samp<x> = audio@s[...]        // Visual
processed<p> = fx(img1@r)     // Audio
display(processed@p)
```

**Topo order:** `[audio, img1, img2, samp, processed]`

**Batched compilation:**

1. AudioBackend.compile_nodes([audio])
2. VisualBackend.compile_nodes([img1, img2, samp]) ← Batched!
3. AudioBackend.compile_nodes([processed])

Visual backend can optimize img1 and img2 together since they're consecutive!

### 4. Backends Expose Outputs

When a backend compiles a node, it:

1. Produces data in its native domain
   - Audio → 1D Metal buffer over time
   - Visual → 2D Metal texture over space
   - OSC → (send-only, no outputs to expose)
2. Exposes output to coordinator:
   ```rust
   coordinator.expose("img", "r", OutputHandle::new(texture));
   ```

### 5. Pre-wire Cross-Backend Connections (CRITICAL FOR PERFORMANCE)

**The coordinator can predict all inter-backend queries at compile time.**

When a backend compiles a node with dependencies on other backends:

```rust
// Visual compiling: img = audio@samples[me@time ~ me@x]
fn compile_node(&mut self, node: &GraphNode, coordinator: &Coordinator) {
    // Lookup dependency at compile time
    let data_ref = coordinator.lookup("audio", "samples")?;

    // Coordinator returns optimal access method based on backend types
    match data_ref {
        DataReference::MetalBuffer(buffer) => {
            // Fast path: bind buffer directly into shader
            self.audio_buffer = buffer;
            compile_shader_with_buffer_binding();
        }
        DataReference::ValueGetter(getter) => {
            // Compatibility path: read values on demand
            self.getters.insert("audio.samples", getter);
        }
    }
}
```

**At runtime:**

```rust
fn execute(&mut self) {
    // Zero coordinator queries!
    // Just use pre-wired references
    command_encoder.set_buffer(0, &self.audio_buffer);
    // Or: let val = self.getters["key"].get_value(coords);
}
```

**Zero runtime overhead** - all connections established during compilation.

---

## Cross-Backend Data Sharing

### The Two Paths

**Path 1: Direct Handle Access (Metal ↔ Metal)**

When both backends use Metal, they share buffer/texture handles directly:

```rust
// Audio exposes
coordinator.expose("audio", "samples", OutputHandle::new(metal_buffer));

// Visual looks up
let data_ref = coordinator.lookup("audio", "samples")?;
let buffer = data_ref.as_metal_buffer()?;
// Bind directly into shader - zero copy!
```

**Path 2: Value Access (Any ↔ Any)**

When backends need individual values (OSC, CPU, or cross-domain):

```rust
// Visual exposes texture
coordinator.expose("img", "r", OutputHandle::new(texture));

// OSC looks up
let data_ref = coordinator.lookup("img", "r")?;
// Coordinator provides value getter
let value = data_ref.get_value(&coords)?; // Reads via unified memory
```

**Both paths are fast** thanks to unified memory!

### Coordinator Decides Path

The coordinator automatically selects the optimal access method:

```rust
impl Coordinator {
    pub fn lookup(&self, instance: &str, output: &str) -> Result<DataReference> {
        let owner_idx = self.find_owner(instance)?;
        let owner_backend = &self.backends[owner_idx];

        // Coordinator knows both backend types
        // Returns appropriate reference type
        if both_are_metal() {
            DataReference::MetalHandle(owner_backend.get_handle(...))
        } else {
            DataReference::ValueGetter(Box::new(move |coords| {
                owner_backend.get_value_at(coords)
            }))
        }
    }
}
```

Backends just call `coordinator.lookup()` - coordinator handles optimization.

---

## Communication Pattern: expose / lookup

Backends communicate through coordinator using two methods:

### expose (Backend → Coordinator)

"Here's my output data"

```rust
impl Backend {
    fn compile_node(&mut self, coordinator: &mut Coordinator) {
        self.create_buffer();
        coordinator.expose("audio", "samples", OutputHandle::new(self.buffer.clone()));
    }
}
```

### lookup (Backend ← Coordinator)

"I need this input data"

```rust
impl Backend {
    fn compile_node(&mut self, coordinator: &Coordinator) {
        let audio_ref = coordinator.lookup("audio", "samples")?;
        // Use the reference...
    }
}
```

**Key properties:**

- All communication goes through coordinator (N relationships, not N²)
- Coordinator never copies data - just routes Arc/references
- Happens at compile time - zero runtime queries

---

## Standard Inter-Backend Data Type

All outputs ultimately produce scalar values:

```rust
pub type Value = f64;
```

This is WEFT's universal scalar type - all strands produce `f64` values.

For vector data (RGB, stereo audio), use multiple outputs:

```weft
img<r, g, b> = load("cat.jpg")  // Three outputs, each f64
```

---

## Backend Trait Design

```rust
pub trait Backend {
    /// What context does this backend handle?
    fn context(&self) -> Context;

    /// Compile a batch of nodes (called in topological order)
    /// Batching allows backend to optimize compilation of related nodes
    /// Can call coordinator.lookup() for dependencies
    fn compile_nodes(
        &mut self,
        nodes: &[&GraphNode],
        env: &Env,
        coordinator: &Coordinator,
    ) -> Result<()>;

    /// Get raw handle to output (for Metal-to-Metal fast path)
    fn get_handle(&self, instance: &str, output: &str) -> Result<OutputHandle>;

    /// Get value at specific coordinates (for compatibility path)
    fn get_value_at(&self, instance: &str, output: &str, coords: &HashMap<String, f64>) -> Result<Value>;

    /// Execute one frame/iteration
    /// All dependencies are pre-wired, no coordinator queries
    fn execute(&mut self, env: &Env) -> Result<()>;

    /// Cleanup resources
    fn cleanup(&mut self) {}
}
```

**Note:** Not all backends implement both `get_handle()` and `get_value_at()`:

- Metal backends: implement both
- OSC/export backends: only implement `get_value_at()` (or neither if send-only)
- Coordinator handles the routing

---

## Data Reference Types

```rust
pub enum DataReference {
    /// Direct Metal buffer/texture handle (zero-copy binding)
    MetalBuffer(Arc<metal::Buffer>),
    MetalTexture(Arc<metal::Texture>),

    /// Value getter function (for compatibility/CPU access)
    ValueGetter(Box<dyn Fn(&HashMap<String, f64>) -> Value + Send + Sync>),
}

pub struct OutputHandle {
    inner: Arc<dyn Any + Send + Sync>,
}

impl OutputHandle {
    pub fn new<T: Any + Send + Sync>(value: T) -> Self {
        Self { inner: Arc::new(value) }
    }

    pub fn downcast<T: Any + Send + Sync>(&self) -> Option<Arc<T>> {
        self.inner.clone().downcast::<T>().ok()
    }
}
```

Type-erased handles allow each backend to store whatever format it needs.

---

## Output Registry

Coordinator maintains registry of all outputs:

```rust
pub struct OutputLocation {
    instance: String,
    output: String,
    backend_index: usize,
    handle: OutputHandle,  // Type-erased: Arc<dyn Any>
}

pub struct OutputRegistry {
    outputs: HashMap<String, OutputLocation>, // "instance.output" -> location
}
```

---

## Coordinator Structure

```rust
pub struct Coordinator {
    ast: Program,
    env: Env,
    graph: RenderGraph,

    // Backends (owned)
    backends: Vec<Box<dyn Backend>>,

    // Output registry: "instance.output" -> location
    outputs: OutputRegistry,

    // Node assignments: node_name -> backend_index
    assignments: HashMap<String, usize>,

    // Lifecycle
    running: bool,
}

impl Coordinator {
    pub fn compile(&mut self) -> Result<()> {
        // 1. Build graph
        self.graph.build(&self.ast, &self.env)?;
        let exec_order = self.graph.topo_sort()?;

        // 2. Assign nodes to backends
        self.assign_nodes(&exec_order)?;

        // 3. Compile nodes in topological order
        for node_name in exec_order {
            let node = self.graph.get_node(&node_name).unwrap();
            let backend_idx = self.assignments[&node_name];

            // Backend compiles, may call coordinator.lookup() for deps
            self.backends[backend_idx].compile_node(node, &self.env, self)?;
        }

        Ok(())
    }

    /// Backend calls this to expose output
    pub fn expose(&mut self, instance: &str, output: &str, handle: OutputHandle, backend_idx: usize) {
        self.outputs.register(instance, output, handle, backend_idx);
    }

    /// Backend calls this to lookup input
    pub fn lookup(&self, instance: &str, output: &str) -> Result<DataReference> {
        let location = self.outputs.get(instance, output)?;
        let backend = &self.backends[location.backend_index];

        // Coordinator decides optimal path based on backend capabilities
        // Returns appropriate DataReference variant
        // ...
    }

    pub fn execute(&mut self) -> Result<()> {
        self.env.frame += 1;

        // Execute all backends in topological order
        for backend in &mut self.backends {
            backend.execute(&self.env)?;
        }

        Ok(())
    }
}
```

---

## Example Trace

```weft
audio<samples> = mic()
img<r> = audio@samples[me@time ~ me@x * 10]
display(img@r)
```

### Compilation:

**1. Build graph:**

- Nodes: `audio`, `img`
- Topo order: `[audio, img]`
- Context tags: `audio={Visual}`, `img={Visual}` (both needed by display)

**2. Assign:**

- `audio` (mic builtin) → MacAudioBackend (index 0)
- `img` (expression, Visual context) → MacVisualBackend (index 1)

**3. Compile batches:**

Batched compilation based on topo order:

- Batch 1: AudioBackend gets [audio]
- Batch 2: VisualBackend gets [img]

```rust
// Batch 1: Audio backend
MacAudioBackend.compile_nodes([audio_node], coordinator):
    - Set up microphone input stream
    - Create Metal buffer for samples (unified memory!)
    - coordinator.expose("audio", "samples", OutputHandle::new(buffer), 0)

// Batch 2: Visual backend
MacVisualBackend.compile_nodes([img_node], coordinator):
    - Parse expression: audio@samples[me@time ~ me@x * 10]
    - data_ref = coordinator.lookup("audio", "samples")?
        → Coordinator sees: Audio (Metal) → Visual (Metal)
        → Returns DataReference::MetalBuffer(buffer_arc)
    - Store buffer: self.audio_buffer = buffer_arc
    - Generate Metal shader:
        kernel void render_img(
            device float* audio_buffer [[buffer(0)]],
            texture2d<float> output [[texture(0)]]
        ) {
            float x = coords.x;
            float time_idx = x * 10.0;
            float value = audio_buffer[int(time_idx)];
            output.write(value, coords);
        }
    - Create output texture
    - coordinator.expose("img", "r", OutputHandle::new(texture), 1)
```

### Execution (each frame):

**1. MacAudioBackend.execute():**

- Fill Metal buffer with new mic samples
- No coordinator queries

**2. MacVisualBackend.execute():**

- Set buffer binding: `command_encoder.set_buffer(0, &self.audio_buffer)`
- Dispatch shader
- Shader reads directly from audio Metal buffer (unified memory!)
- Produces output texture
- Display texture to screen
- No coordinator queries

**Zero overhead** - all connections pre-wired during compilation.

---

## Performance Characteristics

### Compile Time:

- ✅ Graph analysis: O(nodes + edges)
- ✅ Backend compilation: O(nodes) with Metal shader compilation
- ✅ Dependency resolution: O(dependencies)

### Runtime (per frame):

- ✅ Zero coordinator lookups (all pre-wired)
- ✅ Zero memory copies (unified memory)
- ✅ Direct buffer bindings (Metal-to-Metal)
- ✅ Fast value reads when needed (10-200ns per pixel)
- ✅ Metal kernel dispatch overhead only

**The coordinator predicts all inter-backend queries at compile time and pre-wires everything.**

---

## Design Decisions

### 1. Two Access Paths

Both exist, coordinator chooses automatically:

- **Fast path**: Metal handle binding (zero runtime cost)
- **Compatibility path**: Value getters (10-200ns per read)

Both are performant on Apple Silicon unified memory.

### 2. Topological Execution Order

Backends execute in dependency order (from graph).
This guarantees all dependencies exist before they're needed:

- OSC reading texture → texture already rendered
- No "evaluation on demand" needed

### 3. Multiple Outputs (Tuples)

```weft
foo<x, y, z> = (1, 2, 3)
```

Creates three separate outputs: `foo@x`, `foo@y`, `foo@z`.
Each exposed independently to coordinator.

### 4. No Runtime Sampling

Backends do **not** query each other during execute().
All cross-backend connections established during compile().
Execute() just uses pre-wired references.

---

## Open Questions

1. **Spindle compilation:** How are user-defined spindles compiled?

   - Inline into calling expressions?
   - Separate functions?

2. **Error handling:** How are runtime errors surfaced?

   - Metal shader failures?
   - Audio buffer underruns?

3. **Hot reloading:** Can we recompile without recreating all backends?

   - Keep Metal device/context?
   - Just recompile shaders?

4. **Debug introspection:** How to inspect intermediate values?
   - Debug backend that logs all exposed outputs?
   - Special debug display mode?
