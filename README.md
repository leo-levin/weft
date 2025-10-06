# WEFT

A creative programming language for working with images, video, audio, and data.

## 🪐 What is WEFT?
WEFT is built on a simple insight: **all media is just functions over coordinate spaces**.

🖼️ Images are `(x, y) → color`
🎥 Video is `(x, y, time) → color`
🔊 Audio is `(time) → amplitude`
📊 Data is `(any_coordinates) → value`

Since everything reduces to coordinate mappings, the same mathematical patterns work everywhere. WEFT doesn't care if its coordinates represent pixels, audio samples, or data points — it transforms mathematical relationships. This abstraction lets you write creative techniques once and apply them to video, audio, visualization, and control without rewriting code.

## 🧵 Core Concepts

### Strands

Everything in WEFT is a **strand**—a scalar function that maps coordinates to real numbers (ℝ).

Strands can be:
- **Domain coordinates**: `me@x`, `me@y`, `me@time`
- **Constants**: `4`, `0.1`, `100` (treated as constant-valued strands)
- **Expressions**: `sin(me@time * 2)`, `mouse@x + 10`
- **Instance outputs**: `img@r`, `audio@intensity`

There are no artificial distinctions between types of inputs. A constant `4` and a time-varying expression `sin(me@time)` are both strands — one happens to be constant, the other varies.

### Spindles

**Spindles** are templates that programmatically generate strands. They're reusable functions that take parameters and output named strands.

```weft
spindle ripple(x, y, cx, cy, freq) :: <wave> {
  let dx = x - cx
  let dy = y - cy
  let dist = sqrt(dx*dx + dy*dy)
  wave = sin(dist * freq)
}
```
Spindles abstract patterns. The same ripple spindle works on spatial coordinates, color coordinates, or any other domain—it's just math over numbers.

### Instances
When you call a spindle or create an expression with outputs, you generate an **instance**—a named bundle of strands. Instances organize related strands under a namespace.

```weft
// Load creates an instance 'img' with strands r, g, b
load("photo.jpg")::img<r, g, b>

// Access strands from the instance
red_channel = img@r(me@x, me@y)
```
Instances are just organizational containers. The real computational units are the strands inside them.

### Coordinate Transformation
Most transformation occurs in domain space. Changing where a function is evaluated, not what the function is. We call this warping:

```weft
// Shift the left by 0.1
shifted<r> = img@r(me@x ~ me@x + 0.1, me@y ~ me@y)

// Animate the shift over time
animated<r> = img@r(me@x ~ me@x + sin(me@time * 2), me@y ~ me@y)

// React to audio
reactive<r> = img@r(me@x ~ me@x + audio@intensity * 0.5, me@y)
```
This is the core of WEFT's expressive power: **you don't process samples, you warp the coordinate space itself**.

## Language Basics

### Environment Variables (`me`)

The `me` object provides access to canvas properties and per-pixel state:

```weft
me<width> = 1000          // Set canvas width
me<height> = 1000         // Set canvas height
me<fps> = 60             // Set FPS

me@x                      // Current pixel x-coordinate (0-1 normalized)
me@y                      // Current pixel y-coordinate (0-1 normalized)
me@time                   // Current time in seconds
```

### Spindles: Computational Units

Spindles are the core abstraction in WEFT. They define reusable computations with named inputs and outputs:

```weft
spindle circle(x, y, cx, cy, r) :: <result> {
  let dx = x - cx
  let dy = y - cy
  let d = sqrt(dx * dx + dy * dy)
  result = if d < r then 1 else 0
}
```

### Strands: Data Flow

Strands connect outputs from spindles. Use the `@` operator to access specific output strands:

```weft
// Load an image with r, g, b output strands
load("image.jpg")::img<r, g, b>

// Access individual color channels
redChannel = img@r(me@x, me@y)
greenChannel = img@g(me@x, me@y)
blueChannel = img@b(me@x, me@y)
```

### Instance Bindings

Create instances of spindles with specific outputs:

```weft
// Direct binding
gradient<r, g, b> = <me@x, me@y, 0.5>

// Function call binding
circle(me@x, me@y, 0.5, 0.5, 0.2)::shape<value>

// Strand remapping (coordinate transformation)
img2<r> = img@r(me@x + 0.1, me@y)
```

### Display and Render

Output visual results using `display()` or `render()`:

```weft
// Display RGB channels
display(red, green, blue)

// Display a single grayscale value
display(intensity)

// Render with named arguments
render(r: red, g: green, b: blue)
```

### Audio Synthesis

Generate audio with the `play()` statement:

```weft
// Play a 440Hz sine wave
play(sin(me@time * 440 * 2 * 3.14159))

// Time-varying synthesis
play(sin(me@time * (200 + 100 * sin(me@time))))
```

### Expressions

WEFT supports rich expression syntax:

```weft
// Arithmetic
x + y, x - y, x * y, x / y, x ^ y, x % y

// Comparisons
x == y, x != y, x << y, x >> y  // << and >> are "much less" and "much greater"

// Logical
x and y, x or y, not x

// Conditionals
if condition then valueA else valueB

// Function calls
sin(x), cos(x), abs(x), sqrt(x), min(a, b), max(a, b)
```

## Example Programs

### Image Displacement

```weft
me<width> = 1000
me<height> = 1000

load("flowers.jpg")::img<r, g, b>

// Displace red and green channels
img2<r> = img@r(me@x - 0.2, me@y)
img2<g> = img@g(me@x, me@y + 0.2)

display(img2@r, img2@g, img@b)
```

### Mouse Interaction

```weft
me<width> = 1000
me<height> = 1000

load("image.jpg")::img<r, g, b>

// Vertical split controlled by mouse x position
img2<r> = img@r(me@x, if me@x >> mouse@x then me@y else mouse@y)
img2<g> = img@g(me@x, if me@x >> mouse@x then me@y else mouse@y)
img2<b> = img@b(me@x, if me@x >> mouse@x then me@y else mouse@y)

display(img2)
```

### Animated Circle

```weft
me<width> = 800
me<height> = 600

// Animated circle position
cx = 0.5 + 0.3 * sin(me@time)
cy = 0.5 + 0.3 * cos(me@time)

// Create circle
let dx = me@x - cx
let dy = me@y - cy
let dist = sqrt(dx * dx + dy * dy)
brightness = if dist < 0.1 then 1 else 0

display(brightness)
```

## Standard Library

WEFT includes a standard library (`public/standard.weft`) with common functions:

- **Math**: `sin`, `cos`, `abs`, `sqrt`, `min`, `max`
- **Utilities**: `clamp`, `mix`, `smoothstep`
- **Graphics**: `circle`, `threshold`, `compose`

## Project Structure

```
weft/
├── public/
│   ├── index.html          # Main IDE interface
│   ├── style.css           # UI styling
│   ├── standard.weft       # Standard library
│   └── assets/             # Media files
├── src/
│   ├── lang/               # Parser and grammar
│   ├── backends/           # CPU and WebGL renderers
│   ├── runtime/            # Runtime evaluation
│   ├── compilers/          # Code generators
│   └── ui/                 # UI components
└── examples/               # Example .wft programs
```

## Architecture

WEFT uses a dual-renderer architecture:

1. **Parser** (`src/lang/parser-new.js`): Ohm.js-based grammar parser that converts WEFT source to AST
2. **Compiler** (`src/compilers/`): Transforms AST into executable representations
3. **Renderers**:
   - **WebGL Backend** (`src/backends/webgl-backend-full.js`): Compiles to GLSL fragment shaders for GPU execution
   - **CPU Backend** (`src/backends/cpu-evaluator.js`): JavaScript-based fallback renderer
4. **Coordinator** (`src/backends/coordinator.js`): Manages render pipeline and frame scheduling

## Contributing

WEFT is an experimental language under active development. Contributions, bug reports, and feedback are welcome!

## License

[Add your license here]

## Learn More

- Explore the [example programs](https://github.com/leo-levin/weft/tree/main) in the repository
- Read the [implementation docs](https://github.com/leo-levin/weft/blob/main/.claude/claude.md) for architecture details
- Open the playground and start experimenting!
