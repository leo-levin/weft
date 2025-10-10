// Audio Backend - AudioWorklet-based audio rendering for WEFT
// Mirrors WebGLBackend architecture but compiles to JavaScript for audio thread

import { BaseBackend } from './base-backend.js';
import { match, inst, _ } from '../utils/match.js';
import {
  NumExpr, StrExpr, MeExpr, MouseExpr,
  BinaryExpr, UnaryExpr, IfExpr, CallExpr,
  StrandAccessExpr, StrandRemapExpr, VarExpr,
  TupleExpr, IndexExpr
} from '../lang/ast-node.js';

export class AudioBackend extends BaseBackend {
  constructor(env, name = 'audio', context = 'audio') {
    super(env, name, context);

    // Audio context and worklet
    this.audioContext = null;
    this.workletNode = null;

    // SharedArrayBuffer for cross-context communication
    this.sharedBuffer = null;
    this.sharedBufferView = null;
    this.crossContextSlots = new Map(); // 'instance@strand' → buffer index

    // Compiled state
    this.compiledChannelCode = [];
    this.playStatement = null;
    this.currentAST = null;

    // Configuration
    this.sampleRate = 48000;
    this.channelCount = 2;
  }

  // ===== BaseBackend Methods =====

  async init() {
    try {
      // Create AudioContext
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.sampleRate = this.audioContext.sampleRate;

      // Load AudioWorklet module
      this.log('Loading AudioWorklet module...');
      try {
        // Use correct path - file is in public/ directory
        await this.audioContext.audioWorklet.addModule('/public/audio-processor.js');
        this.log('AudioWorklet module loaded successfully');
      } catch (moduleError) {
        this.error('Failed to load audio-processor.js:', moduleError);
        throw new Error(`AudioWorklet module load failed: ${moduleError.message}`);
      }

      // Create worklet node
      this.log('Creating AudioWorklet node...');
      try {
        this.workletNode = new AudioWorkletNode(this.audioContext, 'weft-audio-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [this.channelCount]
        });
        this.log('AudioWorklet node created successfully');
      } catch (nodeError) {
        this.error('Failed to create AudioWorkletNode:', nodeError);
        throw new Error(`AudioWorkletNode creation failed: ${nodeError.message}`);
      }

      // Verify port exists
      if (!this.workletNode.port) {
        throw new Error('AudioWorkletNode.port is null - worklet not properly initialized');
      }

      // Connect to destination
      this.workletNode.connect(this.audioContext.destination);
      this.log('AudioWorkletNode connected to destination');

      // Listen for messages from worklet
      this.workletNode.port.onmessage = (e) => {
        this.log('Message from worklet:', e.data);
        this.handleWorkletMessage(e.data);
      };

      this.log('Audio context initialized', {
        sampleRate: this.sampleRate,
        state: this.audioContext.state
      });

      // Start the context immediately if possible
      if (this.audioContext.state === 'suspended') {
        // Context needs user interaction to start
        this.warn('AudioContext suspended - needs user interaction to start');

        // Add a one-time click handler to resume
        const resumeHandler = async () => {
          if (this.audioContext && this.audioContext.state === 'suspended') {
            try {
              await this.audioContext.resume();
              this.log('AudioContext resumed after user interaction');
            } catch (err) {
              this.error('Failed to resume AudioContext:', err);
            }
          }
          document.removeEventListener('click', resumeHandler);
        };
        document.addEventListener('click', resumeHandler);
      } else {
        this.log('AudioContext already running');
      }

      return true;
    } catch (error) {
      this.error('Failed to initialize audio backend:', error);
      this.error('Error details:', error.message);
      this.error('Stack:', error.stack);
      return false;
    }
  }

  async compile(ast) {
    try {
      // Initialize if not already done
      if (!this.audioContext) {
        const initialized = await this.init();
        if (!initialized) {
          throw new Error('Failed to initialize audio context');
        }
      }

      // Filter PlayStmt statements
      const playStmts = this.filterStatements(ast, 'PlayStmt');

      if (playStmts.length === 0) {
        this.warn('No play statements found');
        return false;
      }

      // Store for code generation
      this.playStatement = playStmts[0];
      this.currentAST = ast;

      // Compile channel expressions
      const success = await this.compileExpressions();
      if (!success) {
        throw new Error('Expression compilation failed');
      }

      this.log('Compilation successful', {
        channels: this.channelCount,
        crossContextSlots: this.crossContextSlots.size
      });

      return true;

    } catch (error) {
      this.error('Audio compilation failed:', error);
      return false;
    }
  }

  async compileExpressions() {
    try {
      // Get channel expressions from PlayStmt
      const channelExprs = this.playStatement.args || [];

      if (channelExprs.length === 0) {
        this.warn('Play statement has no arguments');
        return false;
      }

      // Determine channel count
      this.channelCount = channelExprs.length;

      // Compile each channel expression to JavaScript
      this.compiledChannelCode = channelExprs.map((expr, index) => {
        try {
          const code = this.compileToJS(expr, this.env, {}, {});
          console.log(`[AudioBackend] Compiled channel ${index}:`, code);
          this.log(`Compiled channel ${index}: ${code}`);
          return code;
        } catch (error) {
          this.error(`Failed to compile channel ${index}:`, error);
          return '0'; // Silence on error
        }
      });

      // Setup SharedArrayBuffer for cross-context communication
      this.setupSharedBuffer();

      // Send compiled code to audio worklet
      const message = {
        type: 'compile',
        channels: this.compiledChannelCode,
        channelCount: this.channelCount,
        sharedBuffer: this.sharedBuffer
      };
      this.log('Sending compile message to worklet:', message);
      this.workletNode.port.postMessage(message);
      this.log('Compile message sent successfully');

      return true;
    } catch (error) {
      this.error('Expression compilation failed:', error);
      return false;
    }
  }

  setupSharedBuffer() {
    // Analyze AST for cross-context dependencies using RenderGraph
    const graph = this.coordinator?.graph;

    if (!graph) {
      this.warn('No render graph available - skipping SharedArrayBuffer');
      this.sharedBuffer = null;
      this.sharedBufferView = null;
      return;
    }

    // Find all instances tagged with 'audio' context that depend on other contexts
    const audioInstances = Array.from(graph.nodes.values()).filter(node =>
      node.contexts.has('audio')
    );

    // Build map of cross-context dependencies
    this.crossContextSlots.clear();
    let slotIndex = 10; // First 10 slots reserved for time values + mouse

    console.log('[AudioBackend] NEW CODE VERSION v3 - setupSharedBuffer running');

    // Find direct references in PlayStmt (not transitive dependencies)
    const directReferences = new Set();
    const findDirectRefs = (expr) => {
      if (!expr || !expr.type) return;

      // Check for StrandAccess (using match to handle both class instance and type string)
      if ((expr.constructor && expr.constructor.name === 'StrandAccessExpr') || expr.type === 'StrandAccess') {
        if (expr.base && expr.base.name) {
          directReferences.add(expr.base.name);
          console.log('[AudioBackend] Found direct ref:', expr.base.name);
        }
      }

      // Recursively check children
      if (expr.left) findDirectRefs(expr.left);
      if (expr.right) findDirectRefs(expr.right);
      if (expr.arg) findDirectRefs(expr.arg);
      if (expr.expr) findDirectRefs(expr.expr);
      if (expr.args && Array.isArray(expr.args)) {
        expr.args.forEach(findDirectRefs);
      }
    };

    if (this.playStatement && this.playStatement.args) {
      this.playStatement.args.forEach(findDirectRefs);
    }

    console.log('[AudioBackend] Direct references from PlayStmt:', Array.from(directReferences));

    for (const node of audioInstances) {
      const isDirectRef = directReferences.has(node.instanceName);

      console.log('[AudioBackend] Checking audio node:', node.instanceName, {
        contexts: Array.from(node.contexts),
        requiredOutputs: Array.from(node.requiredOutputs),
        isDirectReference: isDirectRef
      });

      // Only allocate slots for DIRECT references in PlayStmt that also have visual/compute context
      if (isDirectRef && (node.contexts.has('visual') || node.contexts.has('compute'))) {
        for (const outputName of node.requiredOutputs) {
          const key = `${node.instanceName}@${outputName}`;
          if (!this.crossContextSlots.has(key)) {
            this.crossContextSlots.set(key, slotIndex);
            console.log(`[AudioBackend] ✓ Allocated slot ${slotIndex} for ${key} (direct ref in PlayStmt)`);
            this.log(`Allocated slot ${slotIndex} for cross-context ${key}`);
            slotIndex++;
          }
        }
      }
    }

    console.log('[AudioBackend] Final cross-context slots:', Array.from(this.crossContextSlots.entries()));

    // Check if we need mouse coordinates in audio (scan AST for mouse@ usage in PlayStmt)
    let needsMouse = false;
    const checkForMouse = (node) => {
      if (!node) return;
      if (node.type === 'Mouse') {
        needsMouse = true;
        return;
      }
      // Recursively check all properties
      for (const key in node) {
        if (typeof node[key] === 'object') {
          if (Array.isArray(node[key])) {
            node[key].forEach(checkForMouse);
          } else {
            checkForMouse(node[key]);
          }
        }
      }
    };
    if (this.playStatement) {
      checkForMouse(this.playStatement);
    }

    // Always allocate SharedArrayBuffer if we have cross-context deps OR need mouse
    if (this.crossContextSlots.size === 0 && !needsMouse) {
      this.log('No cross-context dependencies - skipping SharedArrayBuffer');
      this.sharedBuffer = null;
      this.sharedBufferView = null;
    } else {
      const totalSlots = slotIndex;
      this.allocateSharedBuffer(totalSlots);
      console.log(`[AudioBackend] SharedArrayBuffer allocated:`, {
        totalSlots,
        needsMouse,
        crossContextSlots: Array.from(this.crossContextSlots.entries())
      });
      this.log(`SharedArrayBuffer allocated with mouse support: ${needsMouse}`);
    }
  }

  allocateSharedBuffer(slotCount) {
    // Allocate SharedArrayBuffer
    const byteLength = slotCount * 4; // 4 bytes per float32

    try {
      this.sharedBuffer = new SharedArrayBuffer(byteLength);
      this.sharedBufferView = new Float32Array(this.sharedBuffer);

      this.log(`Allocated SharedArrayBuffer: ${slotCount} slots (${byteLength} bytes)`);
    } catch (error) {
      this.warn('SharedArrayBuffer not available, using fallback', error);
      // Fallback to regular ArrayBuffer (won't be shared, but works for testing)
      const buffer = new ArrayBuffer(byteLength);
      this.sharedBufferView = new Float32Array(buffer);
      this.sharedBuffer = buffer;
    }
  }

  render() {
    // If no SharedArrayBuffer, nothing to update (pure audio case)
    if (!this.sharedBufferView) {
      return;
    }

    // Update time values (indices 0-9)
    const env = this.env;
    const absTime = (Date.now() - env.startTime) / 1000;
    const beatsPerSecond = env.bpm / 60;

    this.sharedBufferView[0] = (env.frame % env.loop) / env.targetFps; // me@time (visual time)
    this.sharedBufferView[1] = absTime; // me@abstime
    this.sharedBufferView[2] = env.frame % env.loop; // me@frame
    this.sharedBufferView[3] = env.frame; // me@absframe
    this.sharedBufferView[4] = env.bpm; // me@bpm
    this.sharedBufferView[5] = Math.floor(absTime * beatsPerSecond) % env.timesig_num; // me@beat
    this.sharedBufferView[6] = Math.floor(absTime * beatsPerSecond / env.timesig_num); // me@measure
    this.sharedBufferView[7] = env.targetFps; // me@fps
    this.sharedBufferView[8] = env.mouse.x; // mouse@x
    this.sharedBufferView[9] = env.mouse.y; // mouse@y

    // Update cross-context values using CPUEvaluator (fallback when canGetValue() = false)
    for (const [key, slotIndex] of this.crossContextSlots) {
      const [instName, outName] = key.split('@');
      try {
        // coordinator.getValue() will use CPUEvaluator since WebGL.canGetValue() = false
        const value = this.coordinator.getValue(instName, outName, {});
        this.sharedBufferView[slotIndex] = value;

        // Debug: log first few frames
        if (this.env.frame < 5) {
          const inst = this.env.instances?.get(instName);
          console.log(`[AudioBackend] Frame ${this.env.frame}: ${key} = ${value}`, {
            hasInstances: !!this.env.instances,
            instanceKeys: this.env.instances ? Array.from(this.env.instances.keys()) : [],
            hasSampler: !!inst?.sampler,
            samplerReady: inst?.sampler?.ready,
            samplerKind: inst?.sampler?.kind,
            samplerWidth: inst?.sampler?.width,
            samplerHeight: inst?.sampler?.height
          });
        }
      } catch (error) {
        // Silent failure, use 0
        this.sharedBufferView[slotIndex] = 0;
        if (this.env.frame < 5) {
          console.error(`[AudioBackend] Error getting ${key}:`, error);
        }
      }
    }
  }

  async pause() {
    if (this.audioContext && this.audioContext.state === 'running') {
      try {
        await this.audioContext.suspend();
        this.log('AudioContext suspended (paused)');
      } catch (error) {
        this.error('Failed to suspend AudioContext:', error);
      }
    }
  }

  async resume() {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
        this.log('AudioContext resumed (playing)');
      } catch (error) {
        this.error('Failed to resume AudioContext:', error);
      }
    }
  }

  cleanup() {
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.sharedBuffer = null;
    this.sharedBufferView = null;
    this.crossContextSlots.clear();

    this.log('Audio backend cleanup complete');
  }

  canGetValue() {
    return false; // Audio cannot provide values back to other contexts
  }

  getCompiledCode() {
    if (!this.compiledChannelCode || this.compiledChannelCode.length === 0) {
      return '// No audio code compiled yet';
    }

    const lines = ['// Compiled Audio Channels (JavaScript)\n'];

    this.compiledChannelCode.forEach((code, index) => {
      lines.push(`// Channel ${index}:`);
      lines.push(`function channel${index}(t, absTime, shared, bpm, beat, measure) {`);
      lines.push(`  return (${code});`);
      lines.push(`}\n`);
    });

    if (this.crossContextSlots.size > 0) {
      lines.push('// Cross-Context Slots:');
      for (const [key, index] of this.crossContextSlots) {
        lines.push(`//   shared[${index}] = ${key}`);
      }
    }

    return lines.join('\n');
  }

  handleWorkletMessage(data) {
    switch (data.type) {
      case 'compiled':
        this.log('Worklet compilation complete', data);
        break;
      case 'warning':
        this.warn(data.message, data);
        break;
      case 'error':
        this.error('Worklet error:', data.message);
        break;
    }
  }

  // ===== JavaScript Compilation (mirrors WebGL's GLSL compilation) =====

  compileToJS(node, env, instanceOutputs = {}, localScope = {}) {
    if (Array.isArray(node)) {
      return node.length === 1 ? this.compileToJS(node[0], env, instanceOutputs, localScope) : '0';
    }

    const result = match(node,
      inst(NumExpr, _), (v) => v.toString(),

      inst(StrExpr, _), () => '0', // Strings evaluate to 0 in audio

      inst(MeExpr, _), (field) => {
        return match(field,
          'x', () => '0.5', // Center x position in audio context
          'y', () => '0.5', // Center y position in audio context
          'time', () => 't', // Audio time (sample-accurate)
          'frame', () => 'sample', // Sample index
          'abstime', () => 't', // Absolute time same as t in audio
          'absframe', () => 'sample', // Absolute sample
          'width', () => '1',
          'height', () => '1',
          'fps', () => '60',
          'loop', () => '1000',
          'bpm', () => '120',
          'beat', () => 'Math.floor(t * 2) % 4', // Simple beat counter
          'measure', () => 'Math.floor(t * 2 / 4)', // Simple measure counter
          _, (n) => '0'
        );
      },

      inst(MouseExpr, _), (field) => {
        return match(field,
          'x', () => 'shared[8]',  // Mouse x from SharedArrayBuffer slot 8
          'y', () => 'shared[9]',  // Mouse y from SharedArrayBuffer slot 9
          _, () => '0'
        );
      },

      inst(BinaryExpr, _, _, _), (op, left, right) => {
        const leftCode = this.compileToJS(left, env, instanceOutputs, localScope);
        const rightCode = this.compileToJS(right, env, instanceOutputs, localScope);

        return match(op,
          '+', () => `(${leftCode} + ${rightCode})`,
          '-', () => `(${leftCode} - ${rightCode})`,
          '*', () => `(${leftCode} * ${rightCode})`,
          '/', () => `(${leftCode} / (${rightCode} === 0 ? 1e-9 : ${rightCode}))`,
          '^', () => `Math.pow(${leftCode}, ${rightCode})`,
          '%', () => `((${leftCode} % ${rightCode} + ${rightCode}) % ${rightCode})`,
          '==', () => `(${leftCode} === ${rightCode} ? 1 : 0)`,
          '!=', () => `(${leftCode} !== ${rightCode} ? 1 : 0)`,
          '<<', () => `(${leftCode} < ${rightCode} ? 1 : 0)`,
          '>>', () => `(${leftCode} > ${rightCode} ? 1 : 0)`,
          '<=', () => `(${leftCode} <= ${rightCode} ? 1 : 0)`,
          '>=', () => `(${leftCode} >= ${rightCode} ? 1 : 0)`,
          'AND', () => `(${leftCode} && ${rightCode} ? 1 : 0)`,
          'OR', () => `(${leftCode} || ${rightCode} ? 1 : 0)`,
          _, (n) => '0'
        );
      },

      inst(UnaryExpr, _, _), (op, expr) => {
        const arg = this.compileToJS(expr, env, instanceOutputs, localScope);
        return match(op,
          '-', () => `(-${arg})`,
          'NOT', () => `(${arg} ? 0 : 1)`,
          _, (n) => {
            const mathFn = this.getMathFunction(op);
            return mathFn ? `${mathFn}(${arg})` : `(-${arg})`;
          }
        );
      },

      inst(IfExpr, _, _, _), (condition, thenExpr, elseExpr) => {
        const cond = this.compileToJS(condition, env, instanceOutputs, localScope);
        const thenCode = this.compileToJS(thenExpr, env, instanceOutputs, localScope);
        const elseCode = this.compileToJS(elseExpr, env, instanceOutputs, localScope);
        return `(${cond} ? ${thenCode} : ${elseCode})`;
      },

      inst(CallExpr, _, _), (name, args) => {
        const argCodes = args.map(arg => this.compileToJS(arg, env, instanceOutputs, localScope));
        return this.compileFunctionCall(name, argCodes);
      },

      inst(StrandAccessExpr, _, _), (base, out) => {
        const baseName = base.name;
        const key = `${baseName}@${out}`;

        // Handle me@ access
        if (baseName === 'me') {
          return this.compileToJS(new MeExpr(out), env, instanceOutputs, localScope);
        }

        // Handle mouse@ access
        if (baseName === 'mouse') {
          return match(out,
            'x', () => 'shared[8]',  // Mouse x from SharedArrayBuffer slot 8
            'y', () => 'shared[9]',  // Mouse y from SharedArrayBuffer slot 9
            _, () => '0'
          );
        }

        // Cross-context access: read from SharedArrayBuffer
        const slotIndex = this.crossContextSlots.get(key);
        if (slotIndex !== undefined) {
          return `shared[${slotIndex}]`;
        }

        // Local instance output
        return instanceOutputs[key] || instanceOutputs[baseName] || '0';
      },

      inst(StrandRemapExpr, _, _, _), (base, strand, mappings) => {
        this.warn('StrandRemap not yet supported in audio context - returning 0');
        return '0';
      },

      inst(VarExpr, _), (name) => {
        return localScope[name] || instanceOutputs[name] || '0';
      },

      inst(TupleExpr, _), (items) => {
        if (items.length === 0) return '0';
        return this.compileToJS(items[0], env, instanceOutputs, localScope);
      },

      inst(IndexExpr, _, _), (base, index) => {
        this.warn('Index expressions not yet supported in audio context - returning base');
        return this.compileToJS(base, env, instanceOutputs, localScope);
      },

      _, (n) => {
        // Fallback to plain object handling
        if (node && typeof node === 'object' && node.type) {
          return this.compileObjectToJS(node, env, instanceOutputs, localScope);
        }
        this.warn(`Unhandled node:`, node);
        return '0';
      }
    );

    return result;
  }

  compileObjectToJS(node, env, instanceOutputs, localScope) {
    const nodeType = node.type;

    switch(nodeType) {
      case 'Num':
        return node.v.toString();

      case 'Me':
        return this.compileToJS(new MeExpr(node.field), env, instanceOutputs, localScope);

      case 'Mouse':
        return node.field === 'x' ? 'shared[8]' : node.field === 'y' ? 'shared[9]' : '0';

      case 'Var':
        return localScope[node.name] || instanceOutputs[node.name] || '0';

      case 'StrandAccess':
        const baseName = typeof node.base === 'string' ? node.base : node.base.name;
        const outName = typeof node.out === 'string' ? node.out : node.out.name;
        const key = `${baseName}@${outName}`;

        // Cross-context access
        const slotIndex = this.crossContextSlots.get(key);
        if (slotIndex !== undefined) {
          return `shared[${slotIndex}]`;
        }

        return instanceOutputs[key] || '0';

      case 'Bin':
        const left = this.compileToJS(node.left, env, instanceOutputs, localScope);
        const right = this.compileToJS(node.right, env, instanceOutputs, localScope);

        return match(node.op,
          '+', () => `(${left} + ${right})`,
          '-', () => `(${left} - ${right})`,
          '*', () => `(${left} * ${right})`,
          '/', () => `(${left} / (${right} === 0 ? 1e-9 : ${right}))`,
          _, (n) => '0'
        );

      case 'Call':
        const args = node.args.map(arg => this.compileToJS(arg, env, instanceOutputs, localScope));
        return this.compileFunctionCall(node.name, args);

      default:
        return '0';
    }
  }

  compileFunctionCall(name, argCodes) {
    // Direct math function mapping
    const mathFn = {
      'sin': 'sin', 'cos': 'cos', 'tan': 'tan',
      'sqrt': 'sqrt', 'abs': 'abs', 'exp': 'exp', 'log': 'log',
      'min': 'min', 'max': 'max', 'floor': 'floor',
      'ceil': 'ceil', 'round': 'round', 'pow': 'pow',
      'asin': 'Math.asin', 'acos': 'Math.acos', 'atan': 'Math.atan',
      'atan2': 'Math.atan2'
    }[name];

    if (mathFn) {
      return `${mathFn}(${argCodes.join(', ')})`;
    }

    return match(name,
      'clamp', () => {
        if (argCodes.length === 3) {
          return `Math.max(${argCodes[1]}, Math.min(${argCodes[2]}, ${argCodes[0]}))`;
        }
        return `Math.max(0, Math.min(1, ${argCodes[0]}))`;
      },
      'noise', () => {
        this.warn('noise() not yet implemented in audio context - returning 0');
        return '0';
      },
      'mix', () => argCodes.length >= 3
        ? `(${argCodes[0]} * (1 - ${argCodes[2]}) + ${argCodes[1]} * ${argCodes[2]})`
        : argCodes.length === 2 ? `(${argCodes[0]} * 0.5 + ${argCodes[1]} * 0.5)` : '0',
      'lerp', () => argCodes.length >= 3
        ? `(${argCodes[0]} * (1 - ${argCodes[2]}) + ${argCodes[1]} * ${argCodes[2]})`
        : '0',
      'step', () => argCodes.length >= 2
        ? `(${argCodes[1]} < ${argCodes[0]} ? 0 : 1)`
        : '0',
      'fract', () => argCodes[0] ? `(${argCodes[0]} - Math.floor(${argCodes[0]}))` : '0',
      'sign', () => argCodes[0] ? `Math.sign(${argCodes[0]})` : '0',
      'threshold', () => argCodes.length >= 2
        ? `(${argCodes[0]} > ${argCodes[1]} ? 1 : 0)`
        : argCodes[0] ? `(${argCodes[0]} > 0.5 ? 1 : 0)` : '0',
      _, (n) => '0'
    );
  }

  getMathFunction(name) {
    const MAP = {
      sin: 'Math.sin', cos: 'Math.cos', tan: 'Math.tan',
      sqrt: 'Math.sqrt', abs: 'Math.abs', exp: 'Math.exp', log: 'Math.log',
      min: 'Math.min', max: 'Math.max', floor: 'Math.floor',
      ceil: 'Math.ceil', round: 'Math.round', atan2: 'Math.atan2',
      pow: 'Math.pow',
      asin: 'Math.asin', acos: 'Math.acos', atan: 'Math.atan'
    };
    return MAP[name];
  }
}
