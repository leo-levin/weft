# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WEFT is a domain-specific programming language and interactive playground for creating visual graphics and animations. It features a web-based IDE with real-time compilation and visualization, supporting both CPU and GPU-accelerated rendering through WebGL.

## Core Architecture

### Language Processing Pipeline
1. **Parser** (`parser.js`): Ohm.js-based grammar parser that converts WEFT source code to AST
2. **Runtime** (`runtime.js`): Executes AST with Environment management, Logger, and Executor classes
3. **Renderers**: Dual rendering system
   - `webgl-renderer.js`: Compiles WEFT to GLSL for GPU execution
   - `renderer.js`: CPU-based fallback renderer

### Key Language Concepts
- **Spindles**: Core abstraction for defining computational units with named inputs/outputs
- **Strands**: Data flow connections between spindle outputs
- **Display statements**: Render expressions to the canvas
- **Environment variables**: Special `me.` prefix for pixel coordinates and canvas properties

### Standard Library
The `standard.weft` file contains built-in functions. When modifying or extending:
- Functions are defined as spindles with specific input/output signatures
- GPU implementations require corresponding GLSL code in `webgl-renderer.js`
- CPU implementations are handled through the runtime's function evaluation

## Development Commands

### Running the Project
```bash
# Serve the project locally (no build required)
python3 -m http.server 8000
# or
npx http-server .
```

### Building Standard Library
```bash
node build-stdlib.js
```

## Code Organization

### Parser Grammar Structure
The Ohm grammar in `parser.js` defines:
- Statement types: SpindleDef, DisplayStmt, Direct, CallInstance, EnvStmt
- Expression hierarchy: Logical → Comparison → Arithmetic → Primary
- Special constructs: Strand access (`@`), tuple syntax, environment access (`me.`)

### Renderer Implementation Notes
When working with renderers:
- WebGL renderer compiles entire WEFT program to a single fragment shader
- CPU renderer evaluates expressions recursively for each pixel
- Both renderers must maintain consistency in function implementations
- Performance-critical code paths are in the inner pixel loops

### UI Integration
The `main.js` file coordinates:
- Editor updates trigger recompilation
- Compilation errors display in the info panel
- Successful compilation triggers re-rendering
- Debug panel shows real-time execution state

## Testing Approach
Test programs are WEFT files (e.g., `test_blobs.weft`). When testing changes:
1. Load the test file in the playground
2. Verify visual output matches expected behavior
3. Check debug panel for runtime errors
4. Monitor performance metrics for regressions

## Common Modifications

### Adding New Built-in Functions
1. Add spindle definition to `standard.weft`
2. Implement CPU version in `runtime.js` under the math/function handlers
3. Add GLSL implementation in `webgl-renderer.js` (search for existing functions as examples)
4. Test with both renderers enabled/disabled

### Modifying Grammar
1. Update grammar rules in `parser.js`
2. Adjust semantic actions in the same file
3. Update runtime evaluation in `runtime.js` if new AST node types are added
4. Update both renderers if expression evaluation changes