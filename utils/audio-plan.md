# Audio Backend Implementation Plan

## Overview

This document outlines the design, concerns, and implementation strategy for WEFT's audio backend using AudioWorklet for threaded audio processing.

## Core Architecture

### Threading Model

```
┌─────────────────────────────────────────────────────────┐
│ Main Thread                                             │
│ ┌──────────────┐    ┌──────────────┐                  │
│ │ Coordinator  │───▶│ AudioBackend │                   │
│ └──────────────┘    └──────┬───────┘                   │
│                             │                           │
│                             │ MessagePort               │
│                             │ SharedArrayBuffer         │
└─────────────────────────────┼───────────────────────────┘
                              │
┌─────────────────────────────┼───────────────────────────┐
│ Audio Thread (AudioWorklet) │                           │
│                      ┌──────▼────────────┐              │
│                      │ AudioProcessor    │              │
│                      │ - Read SharedBuf  │              │
│                      │ - Eval per sample │              │
│                      │ - Write to buffer │              │
│                      └───────────────────┘              │
└─────────────────────────────────────────────────────────┘
```

## Key Questions & Concerns

### 1. Cross-Context Communication

**Question**: How do we efficiently pass values from visual/compute contexts to audio?

**Options**:

- **A) SharedArrayBuffer (preferred)**

  - Pros: Zero-copy, low latency, fast reads in audio thread
  - Cons: Requires COOP/COEP headers, limited browser support
  - Implementation: Allocate slots for each cross-context dependency

- **B) MessagePort with Atomics**

  - Pros: More compatible, structured data
  - Cons: Higher latency, message overhead

- **C) Hybrid approach**
  - SharedArrayBuffer for high-frequency data (time, visual values)
  - MessagePort for one-time setup and metadata

**Concern**: How do we handle the case where SharedArrayBuffer is not available (older browsers, missing headers)?

- Fallback to MessagePort-based polling?
- Disable cross-context audio features?
- Show user warning?

**Proposed solution**: Start with SharedArrayBuffer, implement MessagePort fallback later if needed.

---

### 2. Sample Rate vs Frame Rate Mismatch

**Question**: Audio runs at 44.1kHz/48kHz, visuals at 60Hz. How do we handle time synchronization?

**Challenge**:

- Visual updates: ~60 times/second (16.67ms intervals)
- Audio samples: 44,100 times/second (0.023ms intervals)
- Each visual frame represents ~735 audio samples at 44.1kHz

**Options for cross-context values**:

- **A) Hold last value** - Simple, but causes stepping artifacts
- **B) Linear interpolation** - Smoother, but adds complexity
- **C) Sample-and-hold with timestamp** - Audio thread knows when value updated

**Example scenario**:

```weft
// Visual instance updates at 60Hz
visual<intensity> = sin(me@time * 2)

// Audio references it at 44.1kHz
play(sin(me@time * 440) * visual@intensity)
```

At 60Hz, `visual@intensity` changes every 735 audio samples. Should we:

1. Hold the value constant across those 735 samples? ✓ (simplest)
2. Interpolate between updates? (smoother but more complex)
3. Let visual run at audio rate? (defeats purpose of threading)

**Proposed solution**: Start with sample-and-hold (option 1), add interpolation flag later if needed.

---

### 3. Time Management in Audio Thread

**Question**: How does `me@time` work in the audio context?

**Challenge**: Audio needs sample-accurate time, not frame-accurate time.

```javascript
// Visual context (60 FPS)
me@time = currentFrame / 60

// Audio context (44.1 kHz)
me@time = currentSample / 44100
```

**Concern**: These will diverge over time due to different clocks. How do we sync?

**Options**:

- **A) Independent audio clock** - Audio has its own sample counter

  - Pro: Sample-accurate
  - Con: Drifts from visual time

- **B) Sync to visual clock** - Audio reads visual time from SharedArrayBuffer

  - Pro: Synchronized with visuals
  - Con: Not sample-accurate, can cause audio glitches

- **C) Hybrid** - Audio maintains sample count, periodically syncs with visual
  - Pro: Best of both worlds
  - Con: Complex to implement

**Proposed solution**: Independent audio clock (option A) for now. Accept that `me@time` differs slightly between contexts.

---

### 4. Memory Layout for SharedArrayBuffer

**Question**: How do we organize the SharedArrayBuffer?

**Proposed layout**:

```javascript
// 32-bit floats
[
  // Time values (indices 0-7)
  me@time,         // 0
  me@abstime,      // 1
  me@frame,        // 2
  me@absframe,     // 3
  me@bpm,          // 4
  me@beat,         // 5
  me@measure,      // 6
  me@fps,          // 7

  // Cross-context instance slots (indices 8+)
  visual1@value,   // 8
  visual2@output,  // 9
  compute@result,  // 10
  ...
]
```

**Questions**:

- How many slots do we allocate?

  - Start with 256 (1KB buffer)?
  - Dynamically resize?

- How do we handle slot assignment?

  - Coordinator assigns slots during compilation?
  - Hash-based slot mapping?

- What about multi-channel instances (r, g, b)?
  - Each strand gets its own slot
  - Pack multiple values per slot?

**Concern**: Slot allocation complexity. Need a clean strategy for mapping `instance@strand` → slot index.

**Proposed solution**:

1. During compilation, build dependency map of all audio→visual references - WE ALREADY HAVE THE RENDER GRAPH
2. Coordinator assigns contiguous slots starting at index 8
3. Store mapping in audio backend: `Map<"instance@strand", slotIndex>`

---

### 5. Compilation Strategy

**Question**: How do we compile WEFT expressions to JavaScript for audio?

**Two approaches**:

#### A) Full AST→JavaScript Compilation

Compile entire expression tree to JavaScript function:

```javascript
// WEFT: play(sin(me@time * 440 * 6.28) * 0.5)
// Compiled to:
function evaluate(time, sharedBuffer) {
  return Math.sin(time * 440 * 6.28) * 0.5;
}
```

Pros: Fast, no interpretation overhead
Cons: Static, harder to debug, limited dynamic behavior

#### B) Hybrid: Compile + Runtime Evaluation

Compile simple expressions, interpret complex ones:

```javascript
// Simple math → direct compilation
// Cross-context refs → SharedArrayBuffer read
// Spindle calls → runtime lookup

function evaluate(time, sharedBuffer, context) {
  const visual_value = sharedBuffer[8]; // cross-context
  const base_freq = 440;
  return Math.sin(time * base_freq * 6.28) * visual_value;
}
```

**Proposed solution**: Start with approach A (full compilation), add interpretation layer if needed.

---

### 6. Channel Routing

**Question**: How do we handle mono/stereo/multichannel audio?

**Syntax options**:

```weft
// Option 1: Positional arguments (mono/stereo auto-detect)
play(left_signal, right_signal)

// Option 2: Named arguments (explicit)
play(left: osc1, right: osc2)

// Option 3: Instance with channel strands
oscillator<left, right> = <sin(me@time * 440), sin(me@time * 442)>
play(oscillator)
```

**Concern**: What's the default behavior?

- Single arg → mono (duplicate to both channels)?
- Single arg → left channel only?
- Require explicit channel naming?

**Proposed solution**:

- Single arg → mono (same signal to all channels)
- Multiple args → one arg per channel (left, right, ...)
- Named args override positional
- Support up to 8 channels (for future surround sound)

---

### 7. Error Handling & Debugging

**Question**: What happens when audio compilation fails or produces NaN/Infinity?

**Scenarios**:

1. **Compilation error**: Expression can't be compiled to JavaScript

   - Log error, skip audio backend compilation
   - Don't crash entire program

2. **Runtime error**: Division by zero, NaN propagation

   - Detect NaN/Infinity in audio thread
   - Clamp to safe range? Mute audio? Log warning?

3. **Performance issues**: Expression too expensive per-sample
   - How do we warn user?
   - Automatic CPU fallback?

**Proposed solution**:

- Compilation errors → log and disable audio backend for this program
- Runtime NaN/Inf → clamp to [-1, 1] and warn once
- Performance → monitor audio thread timing, warn if approaching deadline

---

### 8. Integration with Existing Code

**Question**: How does this fit with the current backend system?

**Current state**:

- `main.js` references `AudioWorkletRenderer` (doesn't exist)
- `coordinator.js` has infrastructure for multiple backends
- `RenderGraph` already tags contexts ('visual', 'audio', 'compute')

**Implementation steps**:

1. Create `AudioBackend` class extending `BaseBackend`
2. Register with coordinator: `coordinator.setBackends({ audio: new AudioBackend() })`
3. Update `main.js` to import from correct location
4. Ensure `PlayStmt` filtering works in render graph

**Concern**: Naming confusion - should it be:

- `AudioBackend` (matches `WebGLBackend`)?
- `AudioWorkletBackend` (more specific)?
- Keep `AudioWorkletRenderer` for compatibility?

**Proposed**: Use `AudioBackend` for consistency with `WebGLBackend` and `BaseBackend`.

---

### 9. Standard Library Integration

**Question**: Which standard library functions should work in audio context?

**Current stdlib** (from `standard.weft`):

- `circle()` - spatial function, not useful for audio
- `threshold()` - could work for audio (gate/clipper)
- Math functions (sin, cos, etc.) - definitely needed

---

### 10. Performance Targets

**Question**: What are acceptable performance characteristics?

**Requirements**:

- Audio thread must complete processing in < 3ms for 128-sample buffer @ 48kHz
- Main thread writes to SharedArrayBuffer should be < 1ms
- Latency (user action → audio response) should be < 10ms

**Optimization strategies**:

- Pre-compile expressions to JavaScript (no interpretation in audio thread)
- Use typed arrays (Float32Array) for SharedArrayBuffer
- Minimize branching in per-sample loops
- Cache math function results where possible

**Monitoring**:

- Track audio thread processing time
- Warn if approaching buffer deadline
- Provide performance metrics in debug panel

---

## Implementation Phases

### Phase 1: Basic Audio Output (MVP)

- [ ] Create `AudioBackend` class
- [ ] Create `AudioProcessor` worklet
- [ ] Implement basic expression compilation (math, me@time)
- [ ] Support mono output
- [ ] Test with simple sine wave: `play(sin(me@time * 440 * 6.28))`

### Phase 2: Cross-Context Communication

- [ ] Implement SharedArrayBuffer setup
- [ ] Add coordinator integration for cross-context dependencies
- [ ] Support reading visual/compute values in audio
- [ ] Test with: `play(visual@intensity * sin(me@time * 440))`

### Phase 3: Advanced Features

- [ ] Stereo/multichannel support
- [ ] Named argument routing
- [ ] Performance monitoring
- [ ] Error handling and recovery

### Phase 4: Standard Library

- [ ] Audio-specific spindles (oscillators, filters)
- [ ] Integration with visual stdlib
- [ ] Example programs

---

## Open Questions for Discussion

1. **SharedArrayBuffer availability**: Do we need a fallback for browsers without it?

2. **Time synchronization**: Should audio and visual time be synced, or independent?

3. **Channel routing API**: Positional vs named arguments for stereo?

4. **Stateful audio**: How do we handle filters, delays, etc. that need memory?

5. **Standard library scope**: Which audio functions are must-haves for MVP?

6. **Performance fallbacks**: What happens if audio thread can't keep up?

7. **Testing strategy**: How do we unit test audio output without listening?

8. **Cross-browser compatibility**: AudioWorklet requires modern browsers - acceptable?

9. **Sample rate**: Fixed at 48kHz, or support 44.1kHz, 96kHz, etc.?

10. **Latency tuning**: Should buffer size be configurable? Trade latency for stability?

---

## References

- [Web Audio API - AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)
- [SharedArrayBuffer support](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
- [WebGL Backend implementation](src/backends/webgl-backend-full.js) - Similar pattern
- [Coordinator architecture](src/backends/coordinator.js) - Integration point
