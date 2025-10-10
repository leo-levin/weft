# Cache Strand Design

## Overview

Frame buffering system that caches evaluated WEFT strand values across time. Dimension-agnostic: automatically optimizes storage based on whether data is spatial (varies per pixel) or uniform (constant across space).

## Core Concept

```weft
camera()::cam<r,g,b>
cache(cam, 10)::cached<r,g,b>

// Access via cache-specific k dimension
prev<r> = cached@r(cached@k ~ 1)     // 1 frame ago
old<r> = cached@r(cached@k ~ 5)      // 5 frames ago
```

## Key Design Decisions

### 2. Instance-Specific `k`, Not Global `me@k`

- Each cache has its own frame dimension
- `cached@k` only exists for that cache instance
- Enables multiple caches with different depths

```weft
cache(cam, 10)::short<r,g,b>
cache(cam, 100)::long<r,g,b>

s<r> = short@r(short@k ~ 5)   // Independent k dimensions
l<r> = long@r(long@k ~ 50)
```

### 3. Frame-Based, Not Time-Based

- Discrete integer indices match cache slots
- Deterministic: frame N always accesses same data
- `k ~ 0` = current, `k ~ 1` = previous, etc.

### 4. Caches Evaluated WEFT Strands, Not Media

- Camera/video produce textures → evaluated to strand values → cache captures those values
- Works for ANY strand: camera, computed, previous output, etc.
- Never touches media sources directly

### 5. Render Graph Integration

Leverages existing render graph infrastructure to detect dimensionality:

```javascript
// Check which specific me fields are used
function analyzeDimensionality(expr) {
  const meFields = findMeFieldsInExpr(expr);

  // Spatial if uses me@x or me@y
  if (meFields.has("x") || meFields.has("y")) {
    return "SPATIAL_2D"; // Varies per pixel → texture
  } else {
    return "UNIFORM"; // Constant per frame → scalar
  }
}
```

**Key distinction:**

- **Spatial `me` fields**: `me@x`, `me@y` → value varies per pixel → needs texture
- **Uniform `me` fields**: `me@time`, `me@frame`, `me@width`, `me@height` → same everywhere → scalar storage

**Examples:**

- `cam@r` → uses `me@x`, `me@y` (via texture sampling) → SPATIAL_2D → texture
- `me@x` → uses `me@x` → SPATIAL_2D → texture (varies left to right)
- `me@time` → uses `me@time` (uniform field) → UNIFORM → scalar
- `sin(me@frame)` → uses `me@frame` (uniform) → UNIFORM → scalar
- `me@x + me@time` → uses `me@x` (spatial) → SPATIAL_2D → texture

### 6. Multi-Strand Packing

```weft
cache(cam, 10)::cached<r,g,b>  // One RGB texture, 3 channels
cache(luma, 10)::cached<val>   // Single R texture, 1 channel
cache(me@time, 100)::time<val> // Float32Array, no texture!
```

## Examples

### Spatial Cache (Slit-Scan)

```weft
camera()::cam<r,g,b>
cache(cam, 100)::cached<r,g,b>

offset<val> = me@x * 100
scan<r> = cached@r(cached@k ~ offset)
render(scan, scan, scan)
```

### Uniform Cache (Time History)

```weft
cache(me@time, 100)::time_cache<val>
past_time<val> = time_cache@val(time_cache@k ~ 10)
diff<val> = me@time - past_time
render(diff, diff, diff)
```

### Motion Trail

```weft
camera()::cam<r,g,b>
cache(cam, 10)::cached<r,g,b>

trail<r> = (
  cached@r(cached@k ~ 0) * 0.3 +
  cached@r(cached@k ~ 2) * 0.2 +
  cached@r(cached@k ~ 5) * 0.15
)
render(trail, trail, trail)
```

### Feedback

```weft
render(target: "fb", cam@r, cam@g, cam@b)::fb<r,g,b>
cache(fb, 1)::cached<r,g,b>
feedback<r> = fb@r * 0.95 + cached@r(cached@k ~ 1) * 0.05
render(feedback, feedback, feedback)
```

## Implementation Notes

### Storage Strategy

**SPATIAL_2D**: WebGL2 `TEXTURE_2D_ARRAY` (or WebGL1 atlas)

- One texture per cache with depth = frame count
- Format based on channel count (R, RG, RGB, RGBA)
- Framebuffer per layer for capture

**UNIFORM**: `Float32Array`

- Just stores scalar values: `buffer[frame * channels + channel]`
- No GPU memory, no textures
- Ring buffer index management same as spatial

### Render Loop

```javascript
render() {
  // 1. Update media sources
  this.updateMediaSources();

  // 2. Capture current frame to all caches
  for (const cache of this.caches.values()) {
    if (cache.dimensionality === 'SPATIAL_2D') {
      const tex = this.renderToTexture(cache.source);
      cache.storage.push(tex);
    } else {
      const values = this.evaluateUniform(cache.source);
      cache.storage.push(values);
    }
  }

  // 3. Render main output
  this.renderMain();
}
```

### Shader Codegen

**SPATIAL_2D:**

```glsl
uniform sampler2DArray u_cache_name;
uniform int u_cache_name_offset;  // Ring buffer position

vec4 sample_cache(vec2 xy, float k) {
  int layer = (u_cache_name_offset - int(k) - 1 + depth) % depth;
  return texture(u_cache_name, vec3(xy, float(layer)));
}
```

**UNIFORM:**

```glsl
uniform float u_cache_name[100];  // Scalar array
uniform int u_cache_name_offset;

float get_cache(int k) {
  int idx = (u_cache_name_offset - k - 1 + 100) % 100;
  return u_cache_name[idx];
}
```

### Grammar

```ohm
// cache() as instance binding (like spindle calls)
InstanceBinding_call = ident sym<"("> ... sym<")"> sym<"::"> ident OutputSpec

// Detect cache@k in strand access
PrimaryExpr_strand = ident sym<"@"> ident
// If base is cache instance and strand is "k", treat as frame dimension
```

### Semantics

- **Default k**: `k ~ 0` (current frame) if not specified
- **Negative k**: wraps around (e.g., `-1` = `depth - 1`)
- **Fractional k**: floor to integer (2.5 → 2)
- **Ring buffer**: rotates each frame, index 0 = most recent

## Memory

**SPATIAL_2D**: `width × height × channels × depth × 1 byte`

- 1920×1080 RGB × 30 frames ≈ 186 MB

**UNIFORM**: `channels × depth × 4 bytes`

- 1 channel × 100 frames = 400 bytes

**Strategy**: Warn if total cache memory exceeds threshold (~500 MB)

## Implementation Phases

1. **Parser**: `cache(source, N)::name<outputs>` syntax, `instance@k` detection
2. **Render Graph**: Dimensionality analysis (`deps.has('me')`)
3. **WebGL2 Backend**: `FrameCache` class, texture arrays, shader codegen
4. **Uniform Support**: `ScalarCache` class, array storage, uniform passing
5. **Testing**: Camera, computed values, feedback, performance
6. **WebGL1 Fallback**: Atlas/tiling approach
7. **Optimizations**: Lazy allocation, memory limits, cache pooling
