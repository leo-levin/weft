# WEFT

A creative programming language for working with images, video, audio, and data.
Play with WEFT on the [playground](https://leo-levin.github.io/weft/public/index.html)

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
  dx = x - cx
  dy = y - cy
  dist = sqrt(dx*dx + dy*dy)
  out wave = sin(dist * freq)
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

## Getting Started

WEFT runs entirely in the browser with no build step required.

### Running Locally

```bash
# Serve the project
python3 -m http.server 8000
# or
npx http-server .
```

Then open `http://localhost:8000/public/index.html` in your browser.

### Your First Program

```weft
me<width> = 800
me<height> = 600

// Create a gradient
gradient<r, g, b> = <me@x, me@y, 0.5>

display(gradient)
```

This creates a simple gradient where red increases left-to-right and green increases top-to-bottom.

## Writing WEFT

### Setup

```weft
me<width> = 1000          // Canvas resolution
me<height> = 1000
me<fps> = 60              // Frame rate
me<loop> = 600            // Loop duration in frames
```

### Creating Instances

**Direct binding** creates instances from expressions:

```weft
gradient<r, g, b> = <me@x, me@y, 0.5>
pulse<intensity> = sin(me@time * 2)
```

**Spindle calls** create instances from templates:

```weft
load("image.jpg")::img<r, g, b>
noise(me@x, me@y, me@time)::n<value>
```

**User-defined spindles** encapsulate reusable patterns:

```weft
spindle circle(x, y, cx, cy, radius) :: <result> {
  dx = x - cx
  dy = y - cy
  dist = sqrt(dx*dx + dy*dy)
  out result = if dist < radius then 1 else 0
}

circle(me@x, me@y, 0.5, 0.5, 0.2)::shape<value>
```

**Multiple outputs:**

```weft
spindle polar(x, y, cx, cy) :: <r, theta> {
  dx = x - cx
  dy = y - cy
  out r = sqrt(dx*dx + dy*dy)
  out theta = atan2(dy, dx)
}
```

### Local Variables and Outputs

Inside spindles, use regular assignments for local variables and `out` for outputs:

```weft
// Inside spindles
spindle kaleidoscope(x, y, segments) :: <kx, ky> {
  angle = atan2(y - 0.5, x - 0.5)
  radius = sqrt((x - 0.5)^2 + (y - 0.5)^2)
  segment_angle = (2 * 3.14159) / segments
  folded = abs(angle % segment_angle - segment_angle/2)

  out kx = 0.5 + radius * cos(folded)
  out ky = 0.5 + radius * sin(folded)
}
```

### Control Flow

**Conditional expressions:**

```weft
mask<value> = if me@x > 0.5 then 1 else 0

// Nested conditionals
channel<r> = if me@x < 0.33 then img@r(me@x, me@y)
             else if me@x < 0.66 then img@g(me@x, me@y)
             else img@b(me@x, me@y)
```

**For loops** (inside spindles only):

```weft
spindle box_blur(x, y, radius, samples) :: <result> {
  sum = 0
  count = 0

  for i in (-samples to samples) {
    for j in (-samples to samples) {
      sum = sum + img@r(x + i * radius, y + j * radius)
      count = count + 1
    }
  }

  out result = sum / count
}
```

### Accessing and Transforming Strands

```weft
// Sample a strand at coordinates
value = img@r(me@x, me@y)

// Apply coordinate transformation
shifted = img@r(me@x + 0.1, me@y - 0.05)

// Explicit axis remapping with ~
warped<r> = img@r(
  me@x ~ me@x * 2,
  me@y ~ me@y + sin(me@time)
)

// Chain transformations
ripple(me@x, me@y, mouse@x, mouse@y, 0.1)::water<wave>
displaced<r> = img@r(
  me@x ~ me@x + water@wave * 0.05,
  me@y ~ me@y
)
```

### Output Statements

**`display()`** renders to the canvas (legacy syntax, auto-detects based on arguments):

```weft
display(img@r, img@g, img@b)        // Three args → RGB rendering
display(grayscale)                   // Single arg → grayscale or auto-detect
```

**`render()`** explicitly renders to the GPU pipeline with named outputs:

```weft
render(r: final@r, g: final@g, b: final@b)  // RGB rendering
render(rgb: final)                          // Auto-expand instance outputs
```

**`play()`** synthesizes audio:

```weft
play(sin(me@time * 440 * 2 * 3.14159))      // Mono audio
play(left: osc1, right: osc2)               // Stereo with named channels
```

**`compute()`** executes on CPU without rendering:

```weft
compute(analysis@value)                     // Data processing only
```

### Expression Syntax

```weft
// Arithmetic: + - * / ^ %
// Comparison: == != << >> (less/greater)
// Logic: and or not
// Control: if condition then value else value
// Math functions: sin cos abs sqrt min max clamp mix smoothstep
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
dx = me@x - cx
dy = me@y - cy
dist = sqrt(dx * dx + dy * dy)
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

WEFT's execution pipeline:

1. **Parser** (`src/lang/parser-new.js`): Ohm.js-based grammar parser that converts WEFT source to AST
2. **Compiler** (`src/compilers/`): Transforms AST into executable representations
3. **Backends** (execution targets):
   - **WebGL Backend** (`src/backends/webgl-backend-full.js`): Compiles to GLSL fragment shaders for GPU execution
   - **CPU Backend** (`src/backends/cpu-evaluator.js`): JavaScript-based evaluation
   - **Audio Backend**: Processes `play()` statements for audio synthesis. WORK IN PROGRESS.
4. **Coordinator** (`src/backends/coordinator.js`): Routes execution to appropriate backends and manages frame scheduling

The backend system is designed to be extensible—future backends could target additional domains like data (via csv/json), 3d rendering, web sockets, OSC, NDI, etc. Each backend receives the same AST and adapts it to its execution model, maintaining WEFT's domain-agnostic abstraction.