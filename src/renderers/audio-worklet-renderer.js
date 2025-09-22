// audio-worklet-renderer.js — Route-aware Audio Worklet renderer for WEFT
import { clamp, isNum, logger } from '../runtime/runtime.js';

class AudioWorkletRenderer {
  constructor(env) {
    this.env = env;
    this.audioContext = null;
    this.workletNode = null;
    this.running = false;
    this.compiledProcessor = null;
    this.currentSourceCode = '';
    this.processorCount = 0;

    // Audio-specific compilation state
    this.audioStatements = [];      // Only statements tagged for audio route
    this.instanceOutputs = {};      // Maps instance@output → variable name
    this.crossContextParams = [];   // Parameters from other routes
    this.jsCode = [];              // Generated JavaScript lines

    // Debug logging control
    this.debug = true;              // Set to true to enable verbose logging
  }

  log(...args) {
    if (this.debug) {
      logger.debug('Audio', args.join(' '));
    }
  }

  warn(...args) {
    logger.warn('Audio', args.join(' '));
  }

  error(...args) {
    logger.error('Audio', args.join(' '));
  }

  async initialize() {
    if (!this.audioContext) {
      try {
        // Detect browser
        const userAgent = navigator.userAgent;
        const isSafari = /Safari/.test(userAgent) && !/Chrome/.test(userAgent);
        const isIOS = /iPad|iPhone|iPod/.test(userAgent);

        this.log('Browser detected:', isSafari ? 'Safari' : isIOS ? 'iOS' : 'Other');

        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        this.log('AudioContext created, state:', this.audioContext.state);

        // Check for AudioWorklet support
        if (!this.audioContext.audioWorklet) {
          if (isSafari || isIOS) {
            this.warn('AudioWorklet not supported in Safari/iOS - try Chrome for audio features');
          } else {
            this.warn('AudioWorklet not supported in this browser, audio features disabled');
          }
          return; // Don't throw, just disable audio
        }

        if (isSafari) {
          this.warn('Safari detected - audio may be limited. Chrome recommended for best audio support');
        }

        // Handle autoplay policy - context starts suspended
        if (this.audioContext.state === 'suspended') {
          this.log('AudioContext suspended, will resume on user interaction');
        }
      } catch (error) {
        this.error('Failed to create AudioContext:', error);
        throw error;
      }
    }
  }

  async start() {
    if (!this.audioContext) await this.initialize();

    // Verify AudioContext is available
    if (!this.audioContext) {
      this.warn('Cannot start audio - no AudioContext available');
      return;
    }

    // Resume context if suspended
    if (this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
      } catch (error) {
        this.error('Failed to resume AudioContext:', error);
        return;
      }
    }

    this.running = true;

    // Verify worklet node is connected
    if (this.workletNode && this.compiledProcessor) {
      // Send a test message to verify communication
      if (this.workletNode.port) {
        this.workletNode.port.postMessage({
          type: 'test',
          message: 'Connection test from main thread'
        });
      }

      // Start frame advancement loop for audio renderer only if no visual display
      if (!this.env.displayAst && !this.env.displayFns) {
        this.startFrameAdvancement();
      }

      // Start keep-alive ping to ensure processor stays active
      this.startKeepAlive();
    } else {
      this.warn('Audio worklet not ready');
    }
  }

  stop() {
    this.running = false;
    if (this.workletNode) {
      this.workletNode.disconnect();
    }
    if (this.frameAdvancementId) {
      cancelAnimationFrame(this.frameAdvancementId);
      this.frameAdvancementId = null;
    }
    if (this.keepAliveId) {
      clearInterval(this.keepAliveId);
      this.keepAliveId = null;
    }
  }

  // Send periodic keep-alive messages to processor
  startKeepAlive() {
    if (this.keepAliveId) {
      clearInterval(this.keepAliveId);
    }

    this.keepAliveId = setInterval(() => {
      if (this.running && this.workletNode && this.workletNode.port) {
        this.workletNode.port.postMessage({
          type: 'keepalive',
          timestamp: Date.now()
        });
      }
    }, 1000); // Send keep-alive every second
  }

  // Start frame advancement loop - advances env.frame at target FPS
  startFrameAdvancement() {
    if (this.frameAdvancementId) {
      cancelAnimationFrame(this.frameAdvancementId);
    }

    let lastTime = 0;
    const targetInterval = 1000 / this.env.targetFps; // milliseconds between frames

    const advanceFrame = (currentTime) => {
      if (!this.running) return;

      // Only advance frame if enough time has passed
      if (currentTime - lastTime >= targetInterval) {
        this.env.frame++;
        lastTime = currentTime;

        // Log frame advancement occasionally
        if (this.env.frame % 600 === 0) { // Every 10 seconds at 60fps
          this.log('Audio frames:', this.env.frame);
        }
      }

      this.frameAdvancementId = requestAnimationFrame(advanceFrame);
    };

    this.frameAdvancementId = requestAnimationFrame(advanceFrame);
  }

  // Compile WEFT expressions to Audio Worklet processor using route-aware filtering
  async compile(playStatements) {
    if (!playStatements || playStatements.length === 0) {
      return;
    }

    try {
      // Initialize AudioContext if needed
      if (!this.audioContext) {
        await this.initialize();
      }

      // Check if AudioWorklet is available
      if (!this.audioContext || !this.audioContext.audioWorklet) {
        this.warn('AudioWorklet not available, skipping audio compilation');
        return;
      }

      // Reset compilation state
      this.audioStatements = [];
      this.instanceOutputs = {};
      this.crossContextParams = [];
      this.jsCode = [];

      // Get the AST from environment
      const ast = this.env.currentProgram;
      if (!ast) {
        throw new Error('No AST available for compilation');
      }

      // Filter statements for audio route
      this.filterAudioStatements(ast.statements);

      // Process audio statements to build dependency graph
      this.processAudioStatements();

      // Find and collect cross-context parameters needed by audio
      this.collectCrossContextParams(ast);

      // Generate processor code for the first play statement
      this.processorCount++;
      const stmt = playStatements[0];
      const processorCode = this.generateProcessorCode(stmt);

      // Only recompile if source changed
      if (processorCode === this.currentSourceCode) {
        return;
      }
      this.currentSourceCode = processorCode;

      // Create blob URL for the processor
      const blob = new Blob([processorCode], { type: 'application/javascript' });
      const processorUrl = URL.createObjectURL(blob);

      // Register the worklet module
      await this.audioContext.audioWorklet.addModule(processorUrl);

      // Clean up old worklet
      if (this.workletNode) {
        this.workletNode.disconnect();
        this.workletNode = null;
      }

      // Create new worklet node with unique processor name
      const processorName = `weft-audio-processor-${this.processorCount}`;
      this.workletNode = new AudioWorkletNode(this.audioContext, processorName);
      this.workletNode.connect(this.audioContext.destination);

      // Add diagnostic event listeners
      this.workletNode.port.onmessage = (event) => {
        if (event.data.type === 'diagnostic') {
          this.log('Audio processor diagnostic:', event.data.message);
        } else if (event.data.type === 'test_response') {
          this.log('Audio processor responded to test:', event.data.message);
        } else if (event.data.type === 'keepalive_response') {
          // Only log occasionally to avoid spam
          if (event.data.processorFrame % 44100 === 0) {
            this.log('Audio processor keep-alive: frame', event.data.processorFrame);
          }
        }
      };

      // Clean up blob URL
      URL.revokeObjectURL(processorUrl);

      this.compiledProcessor = stmt;
      this.log('Audio compiled');

      // Update cross-context parameters with current values
      this.updateCrossContextParams();

    } catch (error) {
      this.error('Audio compilation failed:', error);
      throw error;
    }
  }

  // Filter statements that are tagged for audio route
  filterAudioStatements(statements) {
    for (const stmt of statements) {
      if (this.hasAudioRoute(stmt)) {
        this.audioStatements.push(stmt);
        this.log('Audio statement:', stmt.type, stmt.name || 'unnamed');
      }
    }
  }

  // Check if a node is tagged for audio route
  hasAudioRoute(node) {
    if (!node) return false;

    // Check routes set
    if (node.routes && node.routes.has('audio')) return true;

    // Check primaryRoute
    if (node.primaryRoute === 'audio') return true;

    // For statements, also check their expressions
    if (node.expr && this.hasAudioRoute(node.expr)) return true;
    if (node.args) {
      for (const arg of node.args) {
        if (this.hasAudioRoute(arg)) return true;
      }
    }

    return false;
  }

  // Process audio statements to build dependency graph
  processAudioStatements() {
    for (const stmt of this.audioStatements) {
      switch (stmt.type) {
        case 'Direct':
          this.processDirectStatement(stmt);
          break;
        case 'Let':
        case 'LetBinding':
          this.processLetStatement(stmt);
          break;
        case 'Assignment':
          this.processAssignmentStatement(stmt);
          break;
        case 'PlayStmt':
          // PlayStmt is an output statement, not a variable definition
          // We'll process its expressions during generateProcessorCode
          this.log('Found PlayStmt - will process during code generation');
          break;
        default:
          this.log('Skipping statement type:', stmt.type);
      }
    }
  }

  processDirectStatement(stmt) {
    // freq<f> = 440 → this.freq_f = 440;
    for (let i = 0; i < stmt.outs.length; i++) {
      const outputName = stmt.outs[i];
      const varName = `${stmt.name}_${outputName}`;
      const jsExpr = this.compileToJS(stmt.expr);

      this.jsCode.push(`this.${varName} = ${jsExpr};`);
      this.instanceOutputs[`${stmt.name}@${outputName}`] = varName;

      this.log('Direct:', `${stmt.name}@${outputName} → ${varName} = ${jsExpr}`);
    }
  }

  processLetStatement(stmt) {
    // let x = expr → this.x = expr;
    const jsExpr = this.compileToJS(stmt.expr);
    this.jsCode.push(`this.${stmt.name} = ${jsExpr};`);
    this.instanceOutputs[stmt.name] = stmt.name;

    this.log('Let:', `${stmt.name} = ${jsExpr}`);
  }

  processAssignmentStatement(stmt) {
    // x = expr or x += expr, etc.
    const jsExpr = this.compileToJS(stmt.expr);

    if (stmt.op === '=') {
      this.jsCode.push(`this.${stmt.name} = ${jsExpr};`);
    } else {
      this.jsCode.push(`this.${stmt.name} ${stmt.op.slice(0, -1)}= ${jsExpr};`);
    }

    this.instanceOutputs[stmt.name] = stmt.name;
    this.log('Assignment:', `${stmt.name} ${stmt.op} ${jsExpr}`);
  }

  // Collect cross-context parameters needed by audio route
  collectCrossContextParams(ast) {
    this.crossContextParams = [];

    // Find all cross-context expressions used in audio statements
    const usedInAudio = new Set();

    // Collect all variables referenced in audio statements
    this.audioStatements.forEach(stmt => {
      this.findVariableReferences(stmt, usedInAudio);
    });

    // Find definitions for these variables in the main AST
    ast.statements.forEach(stmt => {
      if (this.isDefiningStatement(stmt)) {
        const varName = this.getDefinedVariable(stmt);
        if (usedInAudio.has(varName) && !this.hasAudioRoute(stmt)) {
          // This variable is used in audio but defined outside audio route
          this.crossContextParams.push({
            name: varName,
            statement: stmt,
            outputs: this.getStatementOutputs(stmt)
          });
        }
      }
    });

    if (this.crossContextParams.length > 0) {
      this.log('Cross-context params:', this.crossContextParams.map(p => p.name).join(', '));
    }
  }

  findVariableReferences(node, usedVars) {
    if (!node) return;

    if (node.type === 'Var') {
      usedVars.add(node.name);
    } else if (node.type === 'StrandAccess') {
      const baseName = node.base?.name || node.base;
      if (baseName && baseName !== 'me') {
        usedVars.add(baseName);
      }
    }

    // Recursively check all properties
    Object.values(node).forEach(value => {
      if (Array.isArray(value)) {
        value.forEach(item => this.findVariableReferences(item, usedVars));
      } else if (typeof value === 'object') {
        this.findVariableReferences(value, usedVars);
      }
    });
  }

  isDefiningStatement(stmt) {
    return ['Direct', 'Let', 'LetBinding', 'Assignment'].includes(stmt.type);
  }

  getDefinedVariable(stmt) {
    return stmt.name;
  }

  getStatementOutputs(stmt) {
    if (stmt.type === 'Direct') {
      return stmt.outs || [];
    }
    return [];
  }

  generateCrossContextInit() {
    if (this.crossContextParams.length === 0) {
      return '// No cross-context parameters';
    }

    const initLines = this.crossContextParams.map(param => {
      if (param.outputs.length > 0) {
        // Direct statements with outputs: test<t> = value
        return param.outputs.map(output => {
          const varName = `${param.name}_${output}`;
          this.instanceOutputs[`${param.name}@${output}`] = varName;
          return `this.${varName} = 0; // Will be updated from main thread`;
        }).join('\n    ');
      } else {
        // Let/Assignment statements: test = value
        this.instanceOutputs[param.name] = param.name;
        return `this.${param.name} = 0; // Will be updated from main thread`;
      }
    }).join('\n    ');

    // Cross-context variables initialized
    return initLines;
  }

  generateProcessorCode(playStmt) {
    // Extract left and right channel expressions
    let leftExpr = null;
    let rightExpr = null;

    for (const arg of playStmt.args) {
      if (arg.type === 'NamedArg') {
        if (arg.name === 'audio') {
          leftExpr = rightExpr = arg.expr;
        } else if (arg.name === 'left') {
          leftExpr = arg.expr;
        } else if (arg.name === 'right') {
          rightExpr = arg.expr;
        }
      } else {
        // Positional argument - treat as mono audio
        leftExpr = rightExpr = arg;
        break; // Only take first positional argument
      }
    }

    // Default to silence if no expressions
    if (!leftExpr) leftExpr = { type: 'Num', v: 0 };
    if (!rightExpr) rightExpr = { type: 'Num', v: 0 };

    // Compile expressions to JavaScript
    const leftCode = this.compileToJS(leftExpr);
    const rightCode = this.compileToJS(rightExpr);

    // Generate processor code using string concatenation to avoid template literal issues
    const processorCode = [
      'class WEFTAudioProcessor extends AudioWorkletProcessor {',
      '  constructor() {',
      '    super();',
      '    this.frame = 0;',
      '',
      '    // Initialize all audio variables',
      '    ' + this.jsCode.join('\n    '),
      '',
      '    // Initialize cross-context parameters',
      '    ' + this.generateCrossContextInit(),
      '',
      '    // Handle messages from main thread',
      '    this.port.onmessage = (event) => {',
      '      if (event.data.type === \'test\') {',
      '        this.port.postMessage({',
      '          type: \'test_response\',',
      '          message: \'Processor received: \' + event.data.message',
      '        });',
      '      } else if (event.data.type === \'keepalive\') {',
      '        // Respond to keep-alive to confirm processor is running',
      '        this.port.postMessage({',
      '          type: \'keepalive_response\',',
      '          timestamp: event.data.timestamp,',
      '          processorFrame: this.frame',
      '        });',
      '      } else if (event.data.type === \'updateCrossContext\') {',
      '        // Update cross-context parameter values',
      '        Object.assign(this, event.data.params);',
      '      }',
      '    };',
      '  }',
      '',
      '  process(inputs, outputs, parameters) {',
      '    const output = outputs[0];',
      '    if (!output || !output[0]) {',
      '      this.port.postMessage({',
      '        type: \'diagnostic\',',
      '        message: \'No output channels available\'',
      '      });',
      '      return true;',
      '    }',
      '',
      '    const leftChannel = output[0];',
      '    const rightChannel = output[1] || output[0];',
      '',
      '    // Send diagnostic on first call',
      '    if (this.frame === 0) {',
      '      this.port.postMessage({',
      '        type: \'diagnostic\',',
      '        message: \'Audio processor started. Channels: \' + output.length + \', Buffer size: \' + leftChannel.length',
      '      });',
      '    }',
      '',
      '    let nonZeroSamples = 0;',
      '    let maxSample = 0;',
      '',
      '    for (let i = 0; i < leftChannel.length; i++) {',
      '      const me = {',
      '        time: this.frame / sampleRate,',
      '        abstime: this.frame / sampleRate,',
      '        sample: this.frame,',
      '        frame: this.frame % 600',
      '      };',
      '',
      '      try {',
      '        // Test with hardcoded sine wave (louder for debugging)',
      '        const testSine = Math.sin(me.time * 440 * 2 * Math.PI) * 0.3;',
      '',
      '        const leftSample = ' + leftCode + ';',
      '        const rightSample = ' + rightCode + ';',
      '',
      '        // Use test sine if compiled sample is silent',
      '        const finalLeft = Math.abs(leftSample) > 0.001 ? leftSample : testSine;',
      '        const finalRight = Math.abs(rightSample) > 0.001 ? rightSample : testSine;',
      '',
      '        // Track statistics',
      '        if (Math.abs(leftSample) > 0.001) nonZeroSamples++;',
      '        maxSample = Math.max(maxSample, Math.abs(leftSample));',
      '',
      '        // Debug log every 0.5 seconds',
      '        if (this.frame % 22050 === 0) {',
      '          this.port.postMessage({',
      '            type: \'diagnostic\',',
      '            message: \'Frame \' + this.frame + \': compiled=\' + leftSample.toFixed(4) + \', final=\' + finalLeft.toFixed(4)',
      '          });',
      '        }',
      '',
      '        // Clamp and output',
      '        leftChannel[i] = Math.max(-1, Math.min(1, isFinite(finalLeft) ? finalLeft : 0));',
      '        rightChannel[i] = Math.max(-1, Math.min(1, isFinite(finalRight) ? finalRight : 0));',
      '      } catch (error) {',
      '        this.port.postMessage({',
      '          type: \'diagnostic\',',
      '          message: \'Error: \' + error.message',
      '        });',
      '        leftChannel[i] = 0;',
      '        rightChannel[i] = 0;',
      '      }',
      '',
      '      this.frame++;',
      '    }',
      '',
      '    // Report statistics every second',
      '    if (this.frame % 44100 === 0) {',
      '      this.port.postMessage({',
      '        type: \'diagnostic\',',
      '        message: \'Stats: \' + nonZeroSamples + \'/\' + leftChannel.length + \' non-zero, max: \' + maxSample.toFixed(4)',
      '      });',
      '    }',
      '',
      '    return true;',
      '  }',
      '}',
      '',
      `registerProcessor('weft-audio-processor-${this.processorCount}', WEFTAudioProcessor);`
    ];

    return processorCode.join('\n');
  }

  generateTimeUpdates() {
    // Generate code to update any time-dependent variables in the audio loop
    // For now, this is empty since we compute everything fresh each sample
    return '';
  }

  // Compile WEFT expressions to JavaScript (like WebGL's compileToGLSL)
  compileToJS(expr) {
    if (!expr) return '0';

    switch (expr.type) {
      case 'Num':
        return expr.v.toString();

      case 'Var':
        // Look up variable in instanceOutputs
        const varRef = this.instanceOutputs[expr.name];
        return varRef ? `this.${varRef}` : '0';

      case 'Bin':
        const left = this.compileToJS(expr.left);
        const right = this.compileToJS(expr.right);

        switch (expr.op) {
          case '+': return `(${left} + ${right})`;
          case '-': return `(${left} - ${right})`;
          case '*': return `(${left} * ${right})`;
          case '/': return `(${left} / ${right})`;
          case '^': return `Math.pow(${left}, ${right})`;
          case '%': return `(${left} % ${right})`;
          default: return '0';
        }

      case 'Unary':
        const operand = this.compileToJS(expr.expr);
        switch (expr.op) {
          case '-': return `(-(${operand}))`;
          case 'NOT': return `(!(${operand}))`;
          default: return operand;
        }

      case 'Call':
        return this.compileFunction(expr.name, expr.args);

      case 'StrandAccess':
        if (expr.base === 'me' || (expr.base && expr.base.type === 'Var' && expr.base.name === 'me')) {
          // Handle me@time, me@sample, etc.
          switch (expr.out) {
            case 'time': return 'me.time';
            case 'abstime': return 'me.abstime';
            case 'sample': return 'me.sample';
            case 'frame': return 'me.frame';
            default: return '0';
          }
        }
        // For other strand accesses, refer to instance variables
        const baseName = expr.base?.name || expr.base;
        const outputName = expr.out;
        const key = `${baseName}@${outputName}`;
        const strandVar = this.instanceOutputs[key];
        return strandVar ? `this.${strandVar}` : '0';

      case 'If':
        const cond = this.compileToJS(expr.cond);
        const thenExpr = this.compileToJS(expr.t);
        const elseExpr = this.compileToJS(expr.e);
        return `(${cond} ? ${thenExpr} : ${elseExpr})`;

      default:
        this.warn('Unsupported expression type:', expr.type);
        return '0';
    }
  }

  compileFunction(name, args) {
    const compiledArgs = args.map(arg => this.compileToJS(arg));

    switch (name) {
      case 'sin':
        return `Math.sin(${compiledArgs[0] || '0'})`;
      case 'cos':
        return `Math.cos(${compiledArgs[0] || '0'})`;
      case 'tan':
        return `Math.tan(${compiledArgs[0] || '0'})`;
      case 'abs':
        return `Math.abs(${compiledArgs[0] || '0'})`;
      case 'sqrt':
        return `Math.sqrt(${compiledArgs[0] || '0'})`;
      case 'pow':
        return `Math.pow(${compiledArgs[0] || '0'}, ${compiledArgs[1] || '1'})`;
      case 'min':
        return `Math.min(${compiledArgs.join(', ')})`;
      case 'max':
        return `Math.max(${compiledArgs.join(', ')})`;
      case 'floor':
        return `Math.floor(${compiledArgs[0] || '0'})`;
      case 'ceil':
        return `Math.ceil(${compiledArgs[0] || '0'})`;
      case 'round':
        return `Math.round(${compiledArgs[0] || '0'})`;
      case 'exp':
        return `Math.exp(${compiledArgs[0] || '0'})`;
      case 'log':
        return `Math.log(${compiledArgs[0] || '1'})`;
      case 'atan2':
        return `Math.atan2(${compiledArgs[0] || '0'}, ${compiledArgs[1] || '0'})`;
      case 'random':
        return 'Math.random()';
      default:
        console.warn(`🎵 Unsupported function: ${name}`);
        return '0';
    }
  }

  // Update parameters from main thread
  updateUniforms(uniforms) {
    if (this.workletNode && this.workletNode.port) {
      this.workletNode.port.postMessage({
        type: 'updateUniforms',
        uniforms: uniforms
      });
    }
  }

  // Simple expression evaluator for cross-context parameters
  evaluateSimpleExpression(expr) {
    if (!expr) return 0;

    switch (expr.type) {
      case 'Num':
        return expr.v;
      case 'Bin':
        const left = this.evaluateSimpleExpression(expr.left);
        const right = this.evaluateSimpleExpression(expr.right);
        switch (expr.op) {
          case '+': return left + right;
          case '-': return left - right;
          case '*': return left * right;
          case '/': return right !== 0 ? left / right : 0;
          case '^': return Math.pow(left, right);
          default: return 0;
        }
      case 'Unary':
        const operand = this.evaluateSimpleExpression(expr.expr);
        switch (expr.op) {
          case '-': return -operand;
          default: return operand;
        }
      default:
        this.warn('Cannot evaluate complex expression type:', expr.type);
        return 0;
    }
  }

  // Update cross-context parameters with current values
  updateCrossContextParams() {
    if (this.crossContextParams.length === 0 || !this.workletNode?.port) {
      return;
    }

    const paramValues = {};

    this.crossContextParams.forEach(param => {
      try {
        let result;

        // Extract value directly from the statement's expression
        if (param.statement.expr) {
          if (param.statement.expr.type === 'Num') {
            result = param.statement.expr.v;
          } else {
            // For complex expressions, try to compile them
            result = this.evaluateSimpleExpression(param.statement.expr);
          }
        } else {
          result = 0; // Default fallback
        }

        if (param.outputs.length > 0) {
          // Direct statements: test<t> = value
          param.outputs.forEach(output => {
            const varName = `${param.name}_${output}`;
            paramValues[varName] = result;
          });
        } else {
          // Let/Assignment statements: test = value
          paramValues[param.name] = result;
        }

        // Cross-context param updated
      } catch (error) {
        this.warn('Failed to evaluate cross-context param:', param.name, error);
      }
    });

    // Send updated values to processor
    this.workletNode.port.postMessage({
      type: 'updateCrossContext',
      params: paramValues
    });
  }
}

export { AudioWorkletRenderer };