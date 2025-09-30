import { clamp, isNum } from '../utils/math.js';
import { logger } from '../utils/logger.js';
import { AbstractRenderer } from './abstract-renderer.js';
import { CrossContextManager, MediaManager } from './shared-utils.js';

class AudioWorkletRenderer extends AbstractRenderer {
  constructor(env, rendererManager = null) {
    super(env, 'Audio');

    // Audio-specific properties
    this.audioContext = null;
    this.workletNode = null;
    this.compiledProcessor = null;
    this.currentSourceCode = '';
    this.processorCount = 0;

    // Reference to renderer manager for visual sampling
    this.rendererManager = rendererManager;
    this.visualSamplerParams = []; // Parameter names for visual samplers
    this.visualDependencyMap = new Map(); // Maps instance@strand -> sampler parameter name

    // Audio processing state
    this.audioStatements = [];
    this.jsCode = [];
    this.processExpressions = new Map();

    // Media handling
    this.audioBuffers = new Map();
    this.audioCounter = 0;
    this.mediaCounter = 0;

    // Set supported routes
    this.supportedRoutes.add('audio');

    // Initialize shared utilities
    this.crossContextManager = new CrossContextManager(env, 'Audio');
    this.mediaManager = new MediaManager(env, 'Audio');

    // Timing parameters for worklet synchronization
    this.timingParams = {
      startTime: Date.now(),
      currentFrame: 0,
      targetFps: 30,
      loop: 600,
      bpm: 120,
      timesig_num: 4,
      timesig_den: 4
    };

    this.debug = false;
  }

  // ===== Implementation of abstract methods =====

  /**
   * Initialize Audio renderer resources
   */
  async initialize() {
    try {
      await this.initializeAudioContext();
      logger.info('Audio', 'Audio Renderer initialized successfully');
      return true;
    } catch (error) {
      logger.error('Audio', 'Audio initialization failed:', error);
      throw error;
    }
  }

  /**
   * Compile AST for Audio rendering
   */
  async compile(ast) {
    try {
      this.filterStatements(ast);

      if (this.filteredStatements.length === 0) {
        logger.debug('Audio', 'No audio statements to compile');
        return true;
      }

      // Compile play statements into audio worklet
      const success = await this.compilePlayStatements(ast);
      if (!success) {
        throw new Error('Audio worklet compilation failed');
      }
      logger.info('Audio', 'Audio compilation completed successfully');
      return true;
    } catch (error) {
      logger.error('Audio', 'Audio compilation failed:', error);
      return false;
    }
  }

  /**
   * Render audio (handled by worklet)
   */
  render() {
    // Audio rendering is handled by the worklet
    // This method is called for consistency but doesn't do frame-based rendering
    this.updateWorkletParameters();
  }

  /**
   * Clean up Audio renderer resources
   */
  cleanup() {
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.audioBuffers.clear();
    logger.debug('Audio', 'Audio renderer cleanup complete');
  }

  // ===== Audio-specific implementation methods =====

  /**
   * Initialize AudioContext and worklet support
   */
  async initializeAudioContext() {
    if (!this.audioContext) {
      try {
        this.updateTimingFromEnv();

        // Detect browser for compatibility
        const userAgent = navigator.userAgent;
        const isSafari = /Safari/.test(userAgent) && !/Chrome/.test(userAgent);
        const isIOS = /iPad|iPhone|iPod/.test(userAgent);

        logger.debug('Audio', 'Browser detected:', isSafari ? 'Safari' : isIOS ? 'iOS' : 'Other');

        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        logger.debug('Audio', 'AudioContext created, state:', this.audioContext.state);

        // Check for AudioWorklet support
        if (!this.audioContext.audioWorklet) {
          if (isSafari || isIOS) {
            logger.warn('Audio', 'AudioWorklet not supported in Safari/iOS - try Chrome for audio features');
          } else {
            logger.warn('Audio', 'AudioWorklet not supported in this browser, audio features disabled');
          }
          return false;
        }

        if (isSafari) {
          logger.warn('Audio', 'Safari detected - audio may be limited. Chrome recommended for best audio support');
        }

        // Handle autoplay policy
        if (this.audioContext.state === 'suspended') {
          logger.debug('Audio', 'AudioContext suspended, will resume on user interaction');
        }
      } catch (error) {
        logger.error('Audio', 'Failed to create AudioContext:', error);
        throw error;
      }
    }
  }

  /**
   * Update timing parameters from environment
   */
  updateTimingFromEnv() {
    this.timingParams.startTime = this.env.startTime || Date.now();
    this.timingParams.currentFrame = this.env.frame || 0;
    this.timingParams.targetFps = this.env.targetFps || 30;
    this.timingParams.loop = this.env.loop || 600;
    this.timingParams.bpm = this.env.bpm || 120;
    this.timingParams.timesig_num = this.env.timesig_num || 4;
    this.timingParams.timesig_den = this.env.timesig_den || 4;
  }

  /**
   * Compile play statements into audio worklet
   */
  async compilePlayStatements(ast) {
    // Find play statements
    const playStmts = [];
    const traverse = (node) => {
      if (!node) return;
      if (node.type === 'PlayStmt') {
        playStmts.push(node);
      }
      if (node.statements) node.statements.forEach(traverse);
      if (node.args) node.args.forEach(traverse);
    };

    traverse(ast);

    if (playStmts.length === 0) {
      logger.debug('Audio', 'No play statements found');
      return true;
    }

    if (!this.audioContext || !this.audioContext.audioWorklet) {
      logger.warn('Audio', 'AudioWorklet not available, skipping audio compilation');
      return false;
    }

    const stmt = playStmts[0];

    // Setup visual sampling if we have a renderer manager
    if (this.rendererManager && stmt.args && stmt.args.length > 0) {
      const audioExpr = stmt.args[0]?.expr || stmt.args[0];
      const samplingResult = this.rendererManager.setupVisualSamplingForAudio(audioExpr);
      this.visualSamplerParams = samplingResult.paramNames;
      this.visualDependencyMap = samplingResult.dependencyMap;
      logger.info('Audio', `Setup ${this.visualSamplerParams.length} visual samplers`);
    }

    // Process statements and generate worklet code
    await this.processAudioStatements();

    const processorCode = this.generateProcessorCode(stmt);

    if (processorCode === this.currentSourceCode) {
      logger.debug('Audio', 'Audio worklet code unchanged, skipping reload');
      return true;
    }

    this.currentSourceCode = processorCode;
    await this.loadWorkletModule(processorCode);

    this.compiledProcessor = stmt;
    this.updateWorkletParameters();
    return true;
  }

  /**
   * Legacy method - delegates to compilePlayStatements
   */
  async compileAudioWorklet(playStatements) {
    // For backwards compatibility, create a mock AST
    const mockAST = {
      statements: playStatements || []
    };
    return this.compilePlayStatements(mockAST);
  }

  /**
   * Process audio statements and prepare compilation data
   */
  async processAudioStatements() {
    this.audioStatements = this.filteredStatements.filter(stmt =>
      stmt.type !== 'PlayStmt' && this.hasAudioRoute(stmt)
    );

    this.instanceOutputs = {};
    this.jsCode = [];
    this.processExpressions.clear();

    // Process load statements
    await this.processAllLoadStatements(this.filteredStatements);

    // Process other audio statements
    this.audioStatements.forEach(stmt => {
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
      }
    });

    // Collect cross-context parameters
    const usedVars = this.findUsedVariables(this.audioStatements);
    this.crossContextManager.collectCrossContextParams(this.env.currentProgram || { statements: this.audioStatements }, usedVars);
  }

  /**
   * Load worklet module
   */
  async loadWorkletModule(processorCode) {
    this.processorCount++;
    const blob = new Blob([processorCode], { type: 'application/javascript' });
    const processorUrl = URL.createObjectURL(blob);

    try {
      await this.audioContext.audioWorklet.addModule(processorUrl);
    } catch (error) {
      logger.error('Audio', 'Failed to load worklet module:', error);
      throw error;
    }

    // Disconnect old worklet if exists
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    // Create new worklet node
    const processorName = `weft-audio-processor-${this.processorCount}`;
    this.workletNode = new AudioWorkletNode(this.audioContext, processorName);
    this.workletNode.connect(this.audioContext.destination);

    // Setup message handling
    this.setupWorkletMessageHandler();

    URL.revokeObjectURL(processorUrl);
    logger.debug('Audio', 'Audio worklet loaded successfully');
  }

  /**
   * Setup worklet message handler
   */
  setupWorkletMessageHandler() {
    if (!this.workletNode) return;

    this.workletNode.port.onmessage = (event) => {
      if (event.data.type === 'diagnostic') {
        logger.debug('Audio', 'Audio processor diagnostic:', event.data.message);
      } else if (event.data.type === 'test_response') {
        logger.debug('Audio', 'Audio processor responded to test:', event.data.message);
      } else if (event.data.type === 'keepalive_response') {
        if (event.data.processorFrame % 44100 === 0) {
          logger.debug('Audio', 'Audio processor keep-alive: frame', event.data.processorFrame);
        }
      }
    };
  }

  /**
   * Update worklet parameters
   */
  updateWorkletParameters() {
    if (!this.workletNode || !this.workletNode.port) return;

    // Update timing parameters
    this.updateTimingFromEnv();
    this.workletNode.port.postMessage({
      type: 'updateTiming',
      startTime: this.timingParams.startTime,
      targetFps: this.timingParams.targetFps,
      loop: this.timingParams.loop,
      bpm: this.timingParams.bpm,
      timesig_num: this.timingParams.timesig_num,
      timesig_den: this.timingParams.timesig_den
    });

    // Update cross-context parameters
    const paramValues = this.crossContextManager.updateParameterValues();
    if (Object.keys(paramValues).length > 0) {
      this.workletNode.port.postMessage({
        type: 'updateCrossContext',
        params: paramValues
      });
    }
  }

  /**
   * Find variables used in audio statements
   */
  findUsedVariables(statements) {
    const usedVars = new Set();

    const traverse = (node) => {
      if (!node) return;

      if (node.type === 'Var') {
        usedVars.add(node.name);
      } else if (node.type === 'StrandAccess') {
        const baseName = node.base?.name || node.base;
        if (baseName && baseName !== 'me') {
          usedVars.add(baseName);
        }
      }

      // Traverse children
      if (node.args) node.args.forEach(traverse);
      if (node.expr) traverse(node.expr);
      if (node.left) traverse(node.left);
      if (node.right) traverse(node.right);
    };

    statements.forEach(traverse);
    return usedVars;
  }

  /**
   * Handle parameter updates
   */
  onParameterUpdate(paramName, value) {
    logger.debug('Audio', `Parameter updated: ${paramName} = ${value}`);
    this.updateWorkletParameters();
  }

  /**
   * Get performance label
   */
  getPerformanceLabel() {
    return 'Audio Processing';
  }

  /**
   * Override start method to handle audio context resumption
   */
  async start() {
    // Resume audio context if suspended
    if (this.audioContext && this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
      } catch (error) {
        logger.error('Audio', 'Failed to resume AudioContext:', error);
        return;
      }
    }

    // Call parent start method
    await super.start();

    // Start audio-specific monitoring
    this.startAudioMonitoring();

    // Start visual sampling if we have samplers
    if (this.rendererManager && this.visualSamplerParams.length > 0) {
      this.rendererManager.startVisualSampling();
    }
  }

  /**
   * Start audio-specific monitoring
   */
  startAudioMonitoring() {
    // Send periodic keep-alive and parameter updates
    if (this.timingUpdateId) {
      clearInterval(this.timingUpdateId);
    }

    this.timingUpdateId = setInterval(() => {
      if (this.running) {
        this.updateWorkletParameters();
      }
    }, 100); // Update every 100ms
  }

  // ===== Missing helper methods (stubs for now) =====

  hasAudioRoute(stmt) {
    return stmt.routes && stmt.routes.has('audio') || stmt.primaryRoute === 'audio';
  }

  async processAllLoadStatements(statements) {
    // Process load statements for audio buffers
    for (const stmt of statements) {
      if (stmt.type === 'CallInstance' && stmt.callee === 'load') {
        // Handle audio loading - stub for now
        logger.debug('Audio', 'Processing load statement:', stmt.inst);
      }
    }
  }

  processDirectStatement(stmt) {
    // Process direct statements - stub for now
    logger.debug('Audio', 'Processing direct statement:', stmt.inst);
  }

  processLetStatement(stmt) {
    // Process let statements - stub for now
    logger.debug('Audio', 'Processing let statement:', stmt.name);
  }

  processAssignmentStatement(stmt) {
    // Process assignment statements - stub for now
    logger.debug('Audio', 'Processing assignment statement:', stmt.name);
  }

  generateProcessorCode(stmt) {
    logger.debug('Audio', 'Generating processor code for play statement');
    console.log('🔥 Audio: generateProcessorCode (first method) called with:', {
      stmt,
      hasArgs: !!stmt?.args,
      argsType: typeof stmt?.args,
      argsLength: stmt?.args ? stmt.args.length : 'N/A'
    });

    if (!stmt || !stmt.args || stmt.args.length === 0) {
      logger.warn('Audio', 'Play statement has no audio expression');
      return this.generateSilentProcessor();
    }

    // Get the audio expression
    const audioExpr = stmt.args[0];

    // Generate JavaScript code for the audio expression
    const audioCode = this.compileAudioExpression(audioExpr);

    return `
      class WeftAudioProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.sampleFrame = 0;
          this.visualFrame = 0;
          this.startTime = Date.now();
          this.targetFps = 30;
          this.loop = 600;
          this.bpm = 120;
          this.timesig_num = 4;
          this.timesig_den = 4;

          // Cross-context parameters
          this.crossContextParams = {};

          // Listen for parameter updates
          this.port.onmessage = (e) => {
            if (e.data.type === 'updateTiming') {
              this.startTime = e.data.startTime;
              this.targetFps = e.data.targetFps;
              this.loop = e.data.loop;
              this.bpm = e.data.bpm;
              this.timesig_num = e.data.timesig_num;
              this.timesig_den = e.data.timesig_den;
            } else if (e.data.type === 'updateCrossContext') {
              this.crossContextParams = e.data.params || {};
            }
          };
        }

        process(inputs, outputs, parameters) {
          const output = outputs[0];
          if (!output || !output[0]) return true;

          const channel = output[0];
          const bufferSize = channel.length;

          for (let i = 0; i < bufferSize; i++) {
            const sampleTime = this.sampleFrame / sampleRate;
            const visualTime = (this.visualFrame % this.loop) / this.targetFps;

            // Create audio 'me' context
            const me = {
              time: sampleTime,
              frame: this.sampleFrame,
              visualTime: visualTime,
              visualFrame: this.visualFrame % this.loop,
              abstime: (Date.now() - this.startTime) / 1000,
              sampleRate: sampleRate
            };

            try {
              // Evaluate audio expression
              const sample = ${audioCode};
              channel[i] = Math.max(-1, Math.min(1, sample || 0));
            } catch (error) {
              channel[i] = 0; // Silent fallback
            }

            this.sampleFrame++;

            // Advance visual frame based on sample rate and target FPS
            if (this.sampleFrame % Math.floor(sampleRate / this.targetFps) === 0) {
              this.visualFrame++;
            }
          }

          return true;
        }
      }

      registerProcessor('weft-audio-processor-${this.processorCount}', WeftAudioProcessor);
    `;
  }

  generateSilentProcessor() {
    return `
      class WeftAudioProcessor extends AudioWorkletProcessor {
        process(inputs, outputs, parameters) {
          const output = outputs[0];
          if (output && output[0]) {
            output[0].fill(0); // Silent
          }
          return true;
        }
      }

      registerProcessor('weft-audio-processor-${this.processorCount}', WeftAudioProcessor);
    `;
  }

  compileAudioExpression(expr) {
    // Simple audio expression compiler - converts WEFT expressions to JavaScript
    if (!expr) return '0';

    switch (expr.type) {
      case 'Num':
        return expr.v.toString();

      case 'StrandAccess':
        if (expr.base === 'me' || (expr.base?.name === 'me')) {
          return `me.${expr.out}`;
        }
        return '0';

      case 'Call':
        const args = expr.args.map(arg => this.compileAudioExpression(arg)).join(', ');
        switch (expr.name) {
          case 'sin': return `Math.sin(${args})`;
          case 'cos': return `Math.cos(${args})`;
          case 'noise': return `(Math.random() * 2 - 1) * 0.1`; // Simple noise
          default: return '0';
        }

      case 'Bin':
        const left = this.compileAudioExpression(expr.left);
        const right = this.compileAudioExpression(expr.right);
        switch (expr.op) {
          case '+': return `(${left} + ${right})`;
          case '-': return `(${left} - ${right})`;
          case '*': return `(${left} * ${right})`;
          case '/': return `(${right} !== 0 ? (${left}) / (${right}) : 0)`;
          case '^': return `Math.pow(${left}, ${right})`;
          default: return '0';
        }

      default:
        return '0';
    }
  }

  // ===== Utility methods =====

  log(...args) {
    if (this.debug) {
      console.log('🎵 [Audio]', ...args);
      logger.debug('Audio', args.join(' '));
    }
  }

  warn(...args) {
    logger.warn('Audio', args.join(' '));
  }

  error(...args) {
    logger.error('Audio', args.join(' '));
  }

  /**
   * Load audio file and create AudioBuffer
   * @param {string} url - URL to audio file (MP3, WAV, OGG)
   * @param {string} instName - Instance name for the loaded audio
   * @returns {Object} Audio buffer information
   */
  async loadAudioBuffer(url, instName) {
    if (this.audioBuffers.has(instName)) {
      return this.audioBuffers.get(instName);
    }

    if (!this.audioContext) {
      await this.initialize();
    }

    if (!this.audioContext) {
      this.error('AudioContext not available for loading audio files');
      return null;
    }

    const bufferId = this.audioCounter++;

    const bufferInfo = {
      buffer: null,
      url: url,
      id: bufferId,
      loaded: false,
      sampleRate: 44100,
      channels: 1,
      length: 0,
      duration: 0
    };

    this.audioBuffers.set(instName, bufferInfo);

    try {
      this.log('Loading audio file:', url);
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to fetch audio: ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

      bufferInfo.buffer = audioBuffer;
      bufferInfo.loaded = true;
      bufferInfo.sampleRate = audioBuffer.sampleRate;
      bufferInfo.channels = audioBuffer.numberOfChannels;
      bufferInfo.length = audioBuffer.length;
      bufferInfo.duration = audioBuffer.duration;
      this.log(`Audio loaded: ${url} - ${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.numberOfChannels}ch, ${audioBuffer.sampleRate}Hz`);

      return bufferInfo;
    } catch (error) {
      this.error('Failed to load audio file:', url, error.message);
      bufferInfo.loaded = false;
      return bufferInfo;
    }
  }

  async initialize() {
    if (!this.audioContext) {
      try {
        this.timingParams.startTime = this.env.startTime || Date.now();
        this.timingParams.currentFrame = this.env.frame || 0;
        this.timingParams.targetFps = this.env.targetFps || 30;
        this.timingParams.loop = this.env.loop || 600;
        this.timingParams.bpm = this.env.bpm || 120;
        this.timingParams.timesig_num = this.env.timesig_num || 4;
        this.timingParams.timesig_den = this.env.timesig_den || 4;

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

      // Start periodic timing updates (includes parameter updates)
      this.startTimingUpdates();
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
    if (this.timingUpdateId) {
      clearInterval(this.timingUpdateId);
      this.timingUpdateId = null;
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

  // Send periodic timing updates to processor
  startTimingUpdates() {
    if (this.timingUpdateId) {
      clearInterval(this.timingUpdateId);
    }

    // Send initial timing update
    this.updateTimingParams();

    // Send timing updates every 100ms to keep audio in sync
    // Also update parameters on each timing update
    this.timingUpdateId = setInterval(() => {
      if (this.running) {
        this.updateTimingParams();
        this.updateCrossContextParams(); // Update parameters frequently like visual renderers
      }
    }, 100);
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

      this.audioStatements = [];
      this.instanceOutputs = {};
      this.crossContextParams = [];
      this.jsCode = [];
      this.processExpressions.clear();

      const ast = this.env.currentProgram;
      if (!ast) {
        throw new Error('No AST available for compilation');
      }

      this.filterAudioStatements(ast.statements);

      // Process all load statements (audio, image, video)
      await this.processAllLoadStatements(ast.statements);
      // Also process audio-specific load statements for backward compatibility
      await this.processAudioLoadStatements(ast.statements);

      // First collect cross-context params so instanceOutputs is populated
      this.collectCrossContextParams(ast);

      // Then process audio statements (this uses instanceOutputs for compilation)
      this.processAudioStatements();

      this.processorCount++;
      const stmt = playStatements[0];
      const processorCode = this.generateProcessorCode(stmt);

      if (processorCode === this.currentSourceCode) {
        return;
      }
      this.currentSourceCode = processorCode;
      const blob = new Blob([processorCode], { type: 'application/javascript' });
      const processorUrl = URL.createObjectURL(blob);

      try {
        await this.audioContext.audioWorklet.addModule(processorUrl);
      } catch (error) {
        console.error('🎵 Failed to load worklet module:', error);
        throw error;
      }

      if (this.workletNode) {
        this.workletNode.disconnect();
        this.workletNode = null;
      }

      const processorName = `weft-audio-processor-${this.processorCount}`;
      this.workletNode = new AudioWorkletNode(this.audioContext, processorName);
      this.workletNode.connect(this.audioContext.destination);

      this.workletNode.port.onmessage = (event) => {
        if (event.data.type === 'diagnostic') {
          this.log('Audio processor diagnostic:', event.data.message);
        } else if (event.data.type === 'test_response') {
          this.log('Audio processor responded to test:', event.data.message);
        } else if (event.data.type === 'keepalive_response') {
          if (event.data.processorFrame % 44100 === 0) {
            this.log('Audio processor keep-alive: frame', event.data.processorFrame);
          }
        }
      };

      URL.revokeObjectURL(processorUrl);

      this.compiledProcessor = stmt;
      this.log('Audio compiled');

      // Parameters will be updated by the timing system

      this.updateCrossContextParams();

    } catch (error) {
      this.error('Audio compilation failed:', error);
      throw error;
    }
  }

  filterAudioStatements(statements) {
    for (const stmt of statements) {
      if (this.hasAudioRoute(stmt)) {
        this.audioStatements.push(stmt);
      }
    }
  }

  /**
   * Process CallInstance statements for audio file loading
   * @param {Array} statements - AST statements to process
   */
  async processAudioLoadStatements(statements) {
    for (const stmt of statements) {
      if (stmt.type === 'CallInstance' && stmt.callee === 'load' && this.hasAudioRoute(stmt)) {
        const audioPath = stmt.args[0] && stmt.args[0].type === 'Str' ? stmt.args[0].v : null;
        if (audioPath) {
          this.log('Processing audio load:', stmt.inst, 'from', audioPath);
          const bufferInfo = await this.loadAudioBuffer(audioPath, stmt.inst);
          for (const output of stmt.outs) {
            const outName = output.type === 'AliasedIdent' ? output.alias : output;
            const varName = `${stmt.inst}_${outName}`;

            let bufferProperty = 'sample';
            if (outName === 'sample' || outName === 's') bufferProperty = 'sample';
            else if (outName === 't' || outName === 'time') bufferProperty = 'sample'; // 't' maps to time-based sampling
            else if (outName === 'duration' || outName === 'd') bufferProperty = 'duration';
            else if (outName === 'channels' || outName === 'ch') bufferProperty = 'channels';
            else if (outName === 'sampleRate' || outName === 'rate') bufferProperty = 'sampleRate';
            else if (outName === 'length' || outName === 'len') bufferProperty = 'length';

            this.generateAudioBufferAccess(varName, stmt.inst, bufferProperty);
            this.instanceOutputs[`${stmt.inst}@${outName}`] = varName;
          }
        }
      }
    }
  }

  /**
   * Process all CallInstance load statements (including images/video for audio contexts)
   * @param {Array} statements - AST statements to process
   */
  async processAllLoadStatements(statements) {
    for (const stmt of statements) {
      if (stmt.type === 'CallInstance' && stmt.callee === 'load') {
        const mediaPath = stmt.args[0]?.v;
        if (mediaPath) {
          // Get the shared Sampler instance from environment
          const sampler = this.env.instances.get(stmt.inst)?.sampler;
          if (sampler) {
            await this.createMediaAccessors(sampler, stmt.inst, stmt.outs);
          } else {
            this.warn(`No sampler found for instance '${stmt.inst}' - media may not be loaded yet`);
          }
        }
      }
    }
  }

  /**
   * Create media accessors for different media types in audio context
   * @param {Object} sampler - The media sampler instance
   * @param {string} instName - Instance name
   * @param {Array} outputs - Output specifications
   */
  async createMediaAccessors(sampler, instName, outputs) {
    for (const output of outputs) {
      const outName = output.alias || output;
      const varName = `${instName}_${outName}`;

      // Create accessor based on media type and output name
      if (sampler.kind === 'image' || sampler.kind === 'video') {
        this.generateImageAudioAccess(varName, instName, outName, sampler);
      } else if (sampler.kind === 'audio') {
        // Use existing audio buffer logic
        let bufferProperty = 'sample';
        if (outName === 'sample' || outName === 's') bufferProperty = 'sample';
        else if (outName === 'duration' || outName === 'd') bufferProperty = 'duration';
        else if (outName === 'channels' || outName === 'ch') bufferProperty = 'channels';
        else if (outName === 'sampleRate' || outName === 'rate') bufferProperty = 'sampleRate';
        else if (outName === 'length' || outName === 'len') bufferProperty = 'length';

        this.generateAudioBufferAccess(varName, instName, bufferProperty);
      } else {
        // Unknown media type, create placeholder
        this.jsCode.push(`this.${varName} = 0.0;`);
      }

      this.instanceOutputs[`${instName}@${outName}`] = varName;
    }
  }

  /**
   * Generate JavaScript code for accessing audio buffer properties
   * @param {string} varName - Variable name to assign
   * @param {string} instName - Instance name of the audio buffer
   * @param {string} property - Property to access ('sample', 'duration', etc.)
   */
  generateAudioBufferAccess(varName, instName, property) {
    const bufferId = this.audioBuffers.get(instName)?.id || 0;

    switch (property) {
      case 'sample':
        this.jsCode.push(`this.${varName} = this.sampleAudioBuffer_${bufferId}.bind(this);`);
        break;
      case 'duration':
        this.jsCode.push(`this.${varName} = ${this.audioBuffers.get(instName)?.duration || 0};`);
        break;
      case 'channels':
        this.jsCode.push(`this.${varName} = ${this.audioBuffers.get(instName)?.channels || 1};`);
        break;
      case 'sampleRate':
        this.jsCode.push(`this.${varName} = ${this.audioBuffers.get(instName)?.sampleRate || 44100};`);
        break;
      case 'length':
        this.jsCode.push(`this.${varName} = ${this.audioBuffers.get(instName)?.length || 0};`);
        break;
      default:
        this.jsCode.push(`this.${varName} = 0.0;`);
    }
  }

  /**
   * Generate methods for sampling visual media as audio
   * Note: Visual sampling now handled by RendererManager, not by copying to worklet
   * @param {string} varName - Variable name to assign
   * @param {string} instName - Instance name
   * @param {string} outName - Output name
   * @param {Object} sampler - The media sampler instance
   */
  generateImageAudioAccess(varName, instName, outName, sampler) {
    // Visual media sampling is now handled via the cross-context sampling system
    // This method is kept for compatibility but should not be called for visual data
    logger.warn('Audio', `generateImageAudioAccess called for ${instName}@${outName} - visual sampling should be handled by RendererManager`);
    this.jsCode.push(`this.${varName} = 0.0; // Visual sampling handled by cross-context system`);
  }

  hasAudioRoute(node) {
    if (!node) return false;

    const hasRoutes = node.routes && node.routes.has('audio');
    const hasPrimaryRoute = node.primaryRoute === 'audio';
    const hasExprRoute = node.expr && this.hasAudioRoute(node.expr);
    let hasArgRoute = false;

    if (node.args) {
      for (const arg of node.args) {
        if (this.hasAudioRoute(arg)) {
          hasArgRoute = true;
          break;
        }
      }
    }

    return hasRoutes || hasPrimaryRoute || hasExprRoute || hasArgRoute;
  }

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
          this.log('Found PlayStmt - will process during code generation');
          break;
        default:
          this.log('Skipping statement type:', stmt.type);
      }
    }
  }

  processDirectStatement(stmt) {
    for (let i = 0; i < stmt.outs.length; i++) {
      const outputName = stmt.outs[i];
      const varName = `${stmt.name}_${outputName}`;
      this.jsCode.push(`this.${varName} = 0.0; // Will be computed in process loop`);
      this.instanceOutputs[`${stmt.name}@${outputName}`] = varName;

      if (!this.processExpressions) {
        this.processExpressions = new Map();
      }
      this.processExpressions.set(varName, stmt.expr);

      this.log('Direct:', `${stmt.name}@${outputName} → ${varName} (expression stored for process loop)`);
    }
  }

  processLetStatement(stmt) {
    const jsExpr = this.compileToJS(stmt.expr);
    this.jsCode.push(`this.${stmt.name} = ${jsExpr};`);
    this.instanceOutputs[stmt.name] = stmt.name;

    this.log('Let:', `${stmt.name} = ${jsExpr}`);
  }

  processAssignmentStatement(stmt) {
    const jsExpr = this.compileToJS(stmt.expr);

    if (stmt.op === '=') {
      this.jsCode.push(`this.${stmt.name} = ${jsExpr};`);
    } else {
      this.jsCode.push(`this.${stmt.name} ${stmt.op.slice(0, -1)}= ${jsExpr};`);
    }

    this.instanceOutputs[stmt.name] = stmt.name;
    this.log('Assignment:', `${stmt.name} ${stmt.op} ${jsExpr}`);
  }

  collectCrossContextParams(ast) {
    this.crossContextParams = [];
    const usedInAudio = new Set();
    this.audioStatements.forEach(stmt => {
      this.findVariableReferences(stmt, usedInAudio);
    });

    ast.statements.forEach(stmt => {
      if (this.isDefiningStatement(stmt)) {
        const varName = this.getDefinedVariable(stmt);
        if (usedInAudio.has(varName) && !this.hasAudioRoute(stmt)) {
          this.crossContextParams.push({
            name: varName,
            statement: stmt,
            outputs: this.getStatementOutputs(stmt)
          });
        }
      }
    });

    if (ast.pragmas) {
      ast.pragmas.forEach(pragma => {
        if (['slider', 'color', 'xy', 'toggle'].includes(pragma.type) && pragma.config) {
          const instanceName = pragma.config.name;
          if (usedInAudio.has(instanceName)) {
            this.log('Found pragma parameter used in audio:', instanceName);
            pragma.config.strands.forEach(strand => {
              const paramKey = `${instanceName}@${strand}`;
              const varName = `${instanceName}_${strand}`;

              this.instanceOutputs[paramKey] = varName;
              this.log(`Mapping pragma ${paramKey} → ${varName}`);

              this.crossContextParams.push({
                name: instanceName,
                paramKey: paramKey,
                strand: strand,
                pragma: pragma,
                type: 'pragma'
              });
            });
          }
        }
      });
    }

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
    } else if (node.type === 'StrandRemap') {
      const baseName = node.base?.name || node.base;
      if (baseName && baseName !== 'me') {
        usedVars.add(baseName);
      }
    }

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
    const initLines = [];

    // Add cross-context parameters
    if (this.crossContextParams.length > 0) {
      this.crossContextParams.forEach(param => {
        if (param.type === 'pragma') {
          // Pragma parameters like sliders: test2<f>
          const varName = `${param.name}_${param.strand}`;
          initLines.push(`this.${varName} = 440; // Pragma parameter, will be updated from main thread`);
        } else if (param.outputs && param.outputs.length > 0) {
          // Direct statements with outputs: test<t> = value
          param.outputs.forEach(output => {
            const varName = `${param.name}_${output}`;
            this.instanceOutputs[`${param.name}@${output}`] = varName;
            initLines.push(`this.${varName} = 0; // Will be updated from main thread`);
          });
        } else {
          // Let/Assignment statements: test = value
          this.instanceOutputs[param.name] = param.name;
          initLines.push(`this.${param.name} = 0; // Will be updated from main thread`);
        }
      });
    }

    // Add visual sampler parameters
    if (this.visualSamplerParams.length > 0) {
      this.visualSamplerParams.forEach(paramName => {
        initLines.push(`this.${paramName} = 0.0; // Visual sampler, updated from main thread`);
        // Also add to instanceOutputs so it can be referenced in expressions
        this.instanceOutputs[paramName] = paramName;
      });
    }

    if (initLines.length === 0) {
      return '// No cross-context parameters';
    }

    return initLines.join('\n    ');
  }

  /**
   * Generate audio buffer sampling methods for the processor
   * @returns {string} JavaScript code for buffer sampling methods
   */
  generateAudioBufferMethods() {
    if (this.audioBuffers.size === 0) {
      return '// No audio buffers loaded';
    }

    const methods = [];

    // Generate buffer data arrays
    for (const [instName, bufferInfo] of this.audioBuffers) {
      if (bufferInfo.loaded && bufferInfo.buffer) {
        const bufferId = bufferInfo.id;
        const buffer = bufferInfo.buffer;

        // Copy audio data to arrays for worklet access
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
          const channelData = Array.from(buffer.getChannelData(ch));
          methods.push(`this.audioBuffer_${bufferId}_ch${ch} = [${channelData.join(',')}];`);
        }

        methods.push(`this.audioBuffer_${bufferId}_sampleRate = ${buffer.sampleRate};`);
        methods.push(`this.audioBuffer_${bufferId}_channels = ${buffer.numberOfChannels};`);
        methods.push(`this.audioBuffer_${bufferId}_length = ${buffer.length};`);
      }
    }

    // Add sampling method
    methods.push('',
      '    // Sample audio buffer with interpolation',
      '    this.sampleBuffer = function(bufferId, time, channel = 0) {',
      '      const bufferKey = "audioBuffer_" + bufferId + "_ch" + Math.floor(channel);',
      '      const buffer = this[bufferKey];',
      '      if (!buffer) return 0.0;',
      '      ',
      '      const sampleRate = this["audioBuffer_" + bufferId + "_sampleRate"] || 44100;',
      '      const sampleIndex = time * sampleRate;',
      '      const index = Math.floor(sampleIndex);',
      '      const frac = sampleIndex - index;',
      '      ',
      '      if (index < 0 || index >= buffer.length - 1) return 0.0;',
      '      ',
      '      // Linear interpolation between samples',
      '      const sample1 = buffer[index] || 0.0;',
      '      const sample2 = buffer[index + 1] || 0.0;',
      '      return sample1 + frac * (sample2 - sample1);',
      '    };',
      '',
      '    // Initialize DSP state variables',
      '    this.delayBuffers = {};',
      '    this.filterState = {};',
      '    this.envelopeState = {};',
      '    this.noiseState = { pink: 0, pinkAccum: [0,0,0,0,0,0,0] };',
      '',
      '    // White noise generator',
      '    this.whiteNoise = function() {',
      '      return (Math.random() - 0.5) * 2.0;',
      '    };',
      '',
      '    // Pink noise generator (1/f noise)',
      '    this.pinkNoise = function() {',
      '      let white = Math.random() - 0.5;',
      '      this.noiseState.pinkAccum[0] = 0.99886 * this.noiseState.pinkAccum[0] + white * 0.0555179;',
      '      this.noiseState.pinkAccum[1] = 0.99332 * this.noiseState.pinkAccum[1] + white * 0.0750759;',
      '      this.noiseState.pinkAccum[2] = 0.96900 * this.noiseState.pinkAccum[2] + white * 0.1538520;',
      '      this.noiseState.pinkAccum[3] = 0.86650 * this.noiseState.pinkAccum[3] + white * 0.3104856;',
      '      this.noiseState.pinkAccum[4] = 0.55000 * this.noiseState.pinkAccum[4] + white * 0.5329522;',
      '      this.noiseState.pinkAccum[5] = -0.7616 * this.noiseState.pinkAccum[5] - white * 0.0168980;',
      '      let pink = this.noiseState.pinkAccum[0] + this.noiseState.pinkAccum[1] + this.noiseState.pinkAccum[2] + this.noiseState.pinkAccum[3] + this.noiseState.pinkAccum[4] + this.noiseState.pinkAccum[5] + this.noiseState.pinkAccum[6] + white * 0.5362;',
      '      this.noiseState.pinkAccum[6] = white * 0.115926;',
      '      return pink * 0.11;',
      '    };',
      '',
      '    // Simple delay line with feedback',
      '    this.delayLine = function(signal, delayTime, feedback = 0.0) {',
      '      const bufferId = "delay_" + Math.floor(delayTime * 1000);',
      '      if (!this.delayBuffers[bufferId]) {',
      '        const bufferSize = Math.max(1, Math.floor(delayTime * sampleRate));',
      '        this.delayBuffers[bufferId] = {',
      '          buffer: new Array(bufferSize).fill(0),',
      '          index: 0,',
      '          size: bufferSize',
      '        };',
      '      }',
      '      ',
      '      const delay = this.delayBuffers[bufferId];',
      '      const output = delay.buffer[delay.index];',
      '      delay.buffer[delay.index] = signal + output * feedback;',
      '      delay.index = (delay.index + 1) % delay.size;',
      '      return output;',
      '    };',
      '',
      '    // Simple one-pole low-pass filter',
      '    this.lowpassFilter = function(signal, cutoff) {',
      '      const filterId = "lowpass_" + Math.floor(cutoff);',
      '      if (!this.filterState[filterId]) {',
      '        this.filterState[filterId] = { y1: 0 };',
      '      }',
      '      ',
      '      const alpha = 1.0 - Math.exp(-2.0 * Math.PI * cutoff / sampleRate);',
      '      const state = this.filterState[filterId];',
      '      state.y1 = state.y1 + alpha * (signal - state.y1);',
      '      return state.y1;',
      '    };',
      '',
      '    // Simple one-pole high-pass filter',
      '    this.highpassFilter = function(signal, cutoff) {',
      '      const filterId = "highpass_" + Math.floor(cutoff);',
      '      if (!this.filterState[filterId]) {',
      '        this.filterState[filterId] = { x1: 0, y1: 0 };',
      '      }',
      '      ',
      '      const alpha = 1.0 - Math.exp(-2.0 * Math.PI * cutoff / sampleRate);',
      '      const state = this.filterState[filterId];',
      '      const output = alpha * (state.y1 + signal - state.x1);',
      '      state.x1 = signal;',
      '      state.y1 = output;',
      '      return output;',
      '    };',
      '',
      '    // Simple ADSR envelope',
      '    this.adsrEnvelope = function(trigger, attack, decay, sustain, release) {',
      '      const envId = "adsr_" + Math.floor(attack * 1000) + "_" + Math.floor(decay * 1000);',
      '      if (!this.envelopeState[envId]) {',
      '        this.envelopeState[envId] = {',
      '          stage: 0, // 0=idle, 1=attack, 2=decay, 3=sustain, 4=release',
      '          level: 0,',
      '          time: 0,',
      '          triggerPrev: 0',
      '        };',
      '      }',
      '      ',
      '      const env = this.envelopeState[envId];',
      '      const dt = 1.0 / sampleRate;',
      '      ',
      '      // Trigger detection',
      '      if (trigger > 0.5 && env.triggerPrev <= 0.5) {',
      '        env.stage = 1; // Start attack',
      '        env.time = 0;',
      '      }',
      '      if (trigger <= 0.5 && env.triggerPrev > 0.5) {',
      '        env.stage = 4; // Start release',
      '        env.time = 0;',
      '      }',
      '      env.triggerPrev = trigger;',
      '      ',
      '      switch (env.stage) {',
      '        case 1: // Attack',
      '          env.level = env.time / Math.max(0.001, attack);',
      '          if (env.level >= 1.0) {',
      '            env.level = 1.0;',
      '            env.stage = 2;',
      '            env.time = 0;',
      '          }',
      '          break;',
      '        case 2: // Decay',
      '          env.level = 1.0 - (1.0 - sustain) * (env.time / Math.max(0.001, decay));',
      '          if (env.level <= sustain) {',
      '            env.level = sustain;',
      '            env.stage = 3;',
      '          }',
      '          break;',
      '        case 3: // Sustain',
      '          env.level = sustain;',
      '          break;',
      '        case 4: // Release',
      '          env.level = env.level * (1.0 - env.time / Math.max(0.001, release));',
      '          if (env.level <= 0.001) {',
      '            env.level = 0;',
      '            env.stage = 0;',
      '          }',
      '          break;',
      '        default:',
      '          env.level = 0;',
      '      }',
      '      ',
      '      env.time += dt;',
      '      return Math.max(0, Math.min(1, env.level));',
      '    };',
      '',
      '    // Waveshaping distortion',
      '    this.distortion = function(signal, amount) {',
      '      const drive = Math.max(1, amount);',
      '      const x = signal * drive;',
      '      return Math.sign(x) * (1 - Math.exp(-Math.abs(x))) / drive;',
      '    };'
    );

    return methods.join('\n    ');
  }

  generateProcessorCode(playStmt) {
    console.log('🔥 Audio: generateProcessorCode called with:', {
      playStmt,
      hasArgs: !!playStmt.args,
      argsType: typeof playStmt.args,
      argsLength: playStmt.args ? playStmt.args.length : 'N/A'
    });

    // Extract left and right channel expressions
    let leftExpr = null;
    let rightExpr = null;

    if (!playStmt.args) {
      console.error('❌ Audio: playStmt.args is undefined');
      return null;
    }

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
      '    this.frame = 0;  // Sample counter for continuous audio timing',
      '    this.sampleRate = ' + (this.audioContext?.sampleRate || 44100) + ';',
      '    ',
      '    // Initialize timing parameters (will be updated from main thread)',
      '    this.startTime = ' + this.timingParams.startTime + ';',
      '    this.targetFps = ' + this.timingParams.targetFps + ';',
      '    this.loop = ' + this.timingParams.loop + ';',
      '    this.bpm = ' + this.timingParams.bpm + ';',
      '    this.timesig_num = ' + this.timingParams.timesig_num + ';',
      '    this.timesig_den = ' + this.timingParams.timesig_den + ';',
      '',
      '    // Initialize all audio variables',
      '    ' + this.jsCode.join('\n    '),
      '',
      '    // Initialize cross-context parameters',
      '    ' + this.generateCrossContextInit(),
      '',
      '    // Initialize audio buffer sampling methods',
      '    ' + this.generateAudioBufferMethods(),
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
      '      } else if (event.data.type === \'updateTiming\') {',
      '        // Update timing parameters from main thread',
      '        this.startTime = event.data.startTime || this.startTime;',
      '        this.targetFps = event.data.targetFps || this.targetFps;',
      '        this.loop = event.data.loop || this.loop;',
      '        this.bpm = event.data.bpm || this.bpm;',
      '        this.timesig_num = event.data.timesig_num || this.timesig_num;',
      '        this.timesig_den = event.data.timesig_den || this.timesig_den;',
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
      '    // Debug: Log first few samples',
      '    let debugSample = false;',
      '    if (this.frame < 128) debugSample = true;',
      '',
      '    let nonZeroSamples = 0;',
      '    let maxSample = 0;',
      '',
      '    // Calculate timing once per buffer for efficiency',
      '    const currentTime = (Date.now() - this.startTime) / 1000;',
      '    const visualFrame = Math.floor(currentTime * this.targetFps);',
      '    const loopFrame = visualFrame % this.loop;',
      '    const visualTime = loopFrame / this.targetFps;',
      '    const beatsPerSecond = this.bpm / 60;',
      '    const totalBeats = currentTime * beatsPerSecond;',
      '    const beat = Math.floor(totalBeats) % this.timesig_num;',
      '    const measure = Math.floor(totalBeats / this.timesig_num);',
      '    ',
      '    for (let i = 0; i < leftChannel.length; i++) {',
      '      // Calculate continuous audio time for sample-accurate synthesis',
      '      const sampleIndex = this.frame + i;',
      '      const audioTime = sampleIndex / this.sampleRate;',
      '      const loopDuration = this.loop / this.targetFps;',
      '      const loopedAudioTime = audioTime % loopDuration;',
      '      ',
      '      const me = {',
      '        time: loopedAudioTime,      // Continuous audio time for smooth synthesis',
      '        abstime: currentTime,       // Absolute time since start',
      '        sample: sampleIndex,        // Continuous audio sample counter',
      '        frame: loopFrame,          // Visual frame (synced with GPU)',
      '        absframe: visualFrame,     // Absolute visual frame',
      '        beat: beat,                // Current beat in measure',
      '        measure: measure           // Current measure',
      '      };',
      '',
      '      // Evaluate stored expressions that depend on me',
      this.generateProcessExpressions(),
      '',
      '      try {',
      '        const leftSample = ' + leftCode + ';',
      '        const rightSample = ' + rightCode + ';',
      '',
      '        // Debug logging for first few samples',
      '        if (debugSample && i === 0) {',
      '          this.port.postMessage({',
      '            type: \'diagnostic\',',
      '            message: \'Sample 0: L=\' + leftSample + \', test2_f=\' + this.test2_f',
      '          });',
      '        }',
      '',
      '        // Track statistics for diagnostics',
      '        if (Math.abs(leftSample) > 0.001) nonZeroSamples++;',
      '        maxSample = Math.max(maxSample, Math.abs(leftSample));',
      '',
      '        // Clamp and output samples',
      '        leftChannel[i] = Math.max(-1, Math.min(1, isFinite(leftSample) ? leftSample : 0));',
      '        rightChannel[i] = Math.max(-1, Math.min(1, isFinite(rightSample) ? rightSample : 0));',
      '      } catch (error) {',
      '        this.port.postMessage({',
      '          type: \'diagnostic\',',
      '          message: \'Error: \' + error.message',
      '        });',
      '        leftChannel[i] = 0;',
      '        rightChannel[i] = 0;',
      '      }',
      '    }',
      '',
      '    // Increment frame counter by buffer size for continuous sample counting',
      '    this.frame += leftChannel.length;',
      '',
      '    // Report statistics every 5 seconds for performance monitoring',
      '    if (this.frame % 220500 === 0) {',
      '      this.port.postMessage({',
      '        type: \'diagnostic\',',
      '        message: \'Audio stats: \' + nonZeroSamples + \'/\' + leftChannel.length + \' active samples, peak: \' + maxSample.toFixed(4)',
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

  generateProcessExpressions() {
    if (!this.processExpressions || this.processExpressions.size === 0) {
      return '      // No process expressions to evaluate';
    }

    const lines = [];
    this.processExpressions.forEach((expr, varName) => {
      const jsExpr = this.compileToJS(expr);
      lines.push(`      this.${varName} = ${jsExpr};`);
    });

    return lines.join('\n');
  }

  /**
   * Compile WEFT expression to JavaScript code for audio worklet execution
   * @param {Object} expr - WEFT AST expression node
   * @returns {string} JavaScript code equivalent
   */
  compileToJS(expr) {
    if (!expr) return '0.0';

    switch (expr.type) {
      case 'Num':
        const numValue = expr.v;
        return Number.isInteger(numValue) ? numValue + '.0' : numValue.toString();

      case 'Var':
        // Look up variable in instanceOutputs
        const varRef = this.instanceOutputs[expr.name];
        return varRef ? `this.${varRef}` : '0.0';

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
          default: return '0.0';
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
          switch (expr.out) {
            case 'time': return 'me.time';
            case 'abstime': return 'me.abstime';
            case 'sample': return 'me.sample';
            case 'frame': return 'me.frame';
            default: return '0.0';
          }
        }
        // For other strand accesses, refer to instance variables
        const baseName = expr.base?.name || expr.base;
        const outputName = expr.out;
        const key = `${baseName}@${outputName}`;
        const strandVar = this.instanceOutputs[key];
        // console.log('🎵 [Compile] StrandAccess:', key, '→', strandVar || '0.0');
        return strandVar ? `this.${strandVar}` : '0.0';

      case 'StrandRemap':
        return this.compileStrandRemap(expr);

      case 'If':
        const cond = this.compileToJS(expr.cond);
        const thenExpr = this.compileToJS(expr.t);
        const elseExpr = this.compileToJS(expr.e);
        return `(${cond} ? ${thenExpr} : ${elseExpr})`;

      default:
        this.warn('Unsupported expression type:', expr.type);
        return '0.0';
    }
  }

  /**
   * Compile WEFT function call to JavaScript
   * @param {string} name - Function name
   * @param {Array} args - Function arguments (WEFT AST nodes)
   * @returns {string} JavaScript function call
   */
  compileFunction(name, args) {
    const compiledArgs = args.map(arg => this.compileToJS(arg));

    switch (name) {
      // Basic math functions
      case 'sin':
        return `Math.sin(${compiledArgs[0] || '0.0'})`;
      case 'cos':
        return `Math.cos(${compiledArgs[0] || '0.0'})`;
      case 'tan':
        return `Math.tan(${compiledArgs[0] || '0.0'})`;
      case 'abs':
        return `Math.abs(${compiledArgs[0] || '0.0'})`;
      case 'sqrt':
        return `Math.sqrt(Math.max(0, ${compiledArgs[0] || '0.0'}))`; // Prevent NaN
      case 'pow':
        return `Math.pow(${compiledArgs[0] || '0.0'}, ${compiledArgs[1] || '1.0'})`;
      case 'exp':
        return `Math.exp(${compiledArgs[0] || '0.0'})`;
      case 'log':
        return `Math.log(Math.max(1e-10, ${compiledArgs[0] || '1.0'}))`; // Prevent -Infinity

      // Min/max functions
      case 'min':
        return compiledArgs.length > 0 ? `Math.min(${compiledArgs.join(', ')})` : '0.0';
      case 'max':
        return compiledArgs.length > 0 ? `Math.max(${compiledArgs.join(', ')})` : '0.0';

      // Rounding functions
      case 'floor':
        return `Math.floor(${compiledArgs[0] || '0.0'})`;
      case 'ceil':
        return `Math.ceil(${compiledArgs[0] || '0.0'})`;
      case 'round':
        return `Math.round(${compiledArgs[0] || '0.0'})`;

      // Trigonometry
      case 'atan2':
        return `Math.atan2(${compiledArgs[0] || '0.0'}, ${compiledArgs[1] || '0.0'})`;

      // Random generation
      case 'random':
        return 'Math.random()';

      // Audio-specific functions
      case 'clamp':
        return compiledArgs.length >= 3
          ? `Math.max(${compiledArgs[1]}, Math.min(${compiledArgs[2]}, ${compiledArgs[0]}))`
          : `Math.max(0.0, Math.min(1.0, ${compiledArgs[0] || '0.0'}))`;

      // Audio sampling functions
      case 'sample':
        // sample(buffer, time) or sample(buffer, time, channel)
        if (compiledArgs.length >= 2) {
          const channel = compiledArgs[2] || '0';
          return `this.sampleBuffer(${compiledArgs[0]}, ${compiledArgs[1]}, ${channel})`;
        }
        return '0.0';

      case 'lerp':
      case 'mix':
        // lerp(a, b, t) - linear interpolation
        if (compiledArgs.length >= 3) {
          return `(${compiledArgs[0]} + (${compiledArgs[2]}) * (${compiledArgs[1]} - ${compiledArgs[0]}))`;
        }
        return compiledArgs[0] || '0.0';

      // DSP Functions
      case 'smoothstep':
        // smoothstep(edge0, edge1, x) - smooth interpolation
        if (compiledArgs.length >= 3) {
          const edge0 = compiledArgs[0];
          const edge1 = compiledArgs[1];
          const x = compiledArgs[2];
          return `(() => {
            const t = Math.max(0, Math.min(1, (${x} - ${edge0}) / (${edge1} - ${edge0})));
            return t * t * (3 - 2 * t);
          })()`;
        }
        return '0.0';

      case 'step':
        // step(edge, x) - step function
        if (compiledArgs.length >= 2) {
          return `(${compiledArgs[1]} < ${compiledArgs[0]} ? 0.0 : 1.0)`;
        }
        return '0.0';

      case 'fract':
        // fract(x) - fractional part
        return `(${compiledArgs[0] || '0.0'} - Math.floor(${compiledArgs[0] || '0.0'}))`;

      case 'mod':
        // mod(x, y) - modulo with proper handling
        if (compiledArgs.length >= 2) {
          return `(((${compiledArgs[0]}) % (${compiledArgs[1]})) + (${compiledArgs[1]})) % (${compiledArgs[1]})`;
        }
        return '0.0';

      // Audio-specific DSP
      case 'delay':
        // delay(signal, time, feedback) - simple delay line
        if (compiledArgs.length >= 2) {
          const feedback = compiledArgs[2] || '0.0';
          return `this.delayLine(${compiledArgs[0]}, ${compiledArgs[1]}, ${feedback})`;
        }
        return compiledArgs[0] || '0.0';

      case 'lowpass':
        // lowpass(signal, cutoff) - simple low-pass filter
        if (compiledArgs.length >= 2) {
          return `this.lowpassFilter(${compiledArgs[0]}, ${compiledArgs[1]})`;
        }
        return compiledArgs[0] || '0.0';

      case 'highpass':
        // highpass(signal, cutoff) - simple high-pass filter
        if (compiledArgs.length >= 2) {
          return `this.highpassFilter(${compiledArgs[0]}, ${compiledArgs[1]})`;
        }
        return compiledArgs[0] || '0.0';

      case 'envelope':
        // envelope(trigger, attack, decay, sustain, release)
        if (compiledArgs.length >= 5) {
          return `this.adsrEnvelope(${compiledArgs[0]}, ${compiledArgs[1]}, ${compiledArgs[2]}, ${compiledArgs[3]}, ${compiledArgs[4]})`;
        }
        return '0.0';

      case 'noise':
        // noise() - white noise
        return 'this.whiteNoise()';

      case 'pinknoise':
        // pinknoise() - pink noise
        return 'this.pinkNoise()';

      case 'distort':
        // distort(signal, amount) - waveshaping distortion
        if (compiledArgs.length >= 2) {
          return `this.distortion(${compiledArgs[0]}, ${compiledArgs[1]})`;
        }
        return compiledArgs[0] || '0.0';

      default:
        this.warn(`Unsupported audio function: ${name}`);
        return '0.0';
    }
  }

  /**
   * Compile WEFT StrandRemap expression to JavaScript
   * @param {Object} expr - StrandRemap expression node
   * @returns {string} JavaScript code for coordinate remapping
   */
  compileStrandRemap(expr) {
    const baseName = expr.base?.name || expr.base;
    const strandName = expr.strand?.name || expr.strand;
    const key = `${baseName}@${strandName}`;

    // Check if this is a visual dependency with a sampler parameter
    if (this.visualDependencyMap.has(key)) {
      const samplerParam = this.visualDependencyMap.get(key);
      logger.debug('Audio', `Using visual sampler for ${key} -> ${samplerParam}`);
      return `this.${samplerParam}`;
    }

    // Compile coordinate expressions for non-visual dependencies
    const coordinateExprs = expr.coordinates.map(coord => this.compileToJS(coord));
    const remappedX = coordinateExprs[0] || '0.0';
    const remappedY = coordinateExprs[1] || '0.0';

    // Check if this is referencing a cross-context instance
    const crossContextVar = this.instanceOutputs[key];

    if (crossContextVar) {
      // If it's a simple cross-context variable, return it directly
      return `this.${crossContextVar}`;
    } else {
      // For audio buffer sampling or other complex cases, generate sampling code
      // Note: This fallback should rarely be hit now that visual sampling is handled above
      logger.warn('Audio', `StrandRemap ${key} not found in visual dependencies or instanceOutputs`);
      return '0.0';
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

  /**
   * Update timing parameters in the audio worklet
   * Should be called whenever timing parameters change in the environment
   */
  updateTimingParams() {
    if (this.workletNode && this.workletNode.port) {
      // Update our local timing params from environment
      this.timingParams.startTime = this.env.startTime;
      this.timingParams.currentFrame = this.env.frame;
      this.timingParams.targetFps = this.env.targetFps;
      this.timingParams.loop = this.env.loop;
      this.timingParams.bpm = this.env.bpm;
      this.timingParams.timesig_num = this.env.timesig_num;
      this.timingParams.timesig_den = this.env.timesig_den;

      // Send to worklet
      this.workletNode.port.postMessage({
        type: 'updateTiming',
        startTime: this.timingParams.startTime,
        targetFps: this.timingParams.targetFps,
        loop: this.timingParams.loop,
        bpm: this.timingParams.bpm,
        timesig_num: this.timingParams.timesig_num,
        timesig_den: this.timingParams.timesig_den
      });
    }
  }

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
          case 'NOT': return operand > 0 ? 0 : 1;
          default: return operand;
        }

      case 'Call':
        const args = expr.args.map(arg => this.evaluateSimpleExpression(arg));
        return this.evaluateFunction(expr.name, args);

      case 'StrandAccess':
        return this.evaluateStrandAccess(expr);

      case 'Var':
        return this.evaluateVariable(expr.name);

      case 'If':
        const condition = this.evaluateSimpleExpression(expr.cond);
        if (condition > 0) {
          return this.evaluateSimpleExpression(expr.t);
        } else {
          return this.evaluateSimpleExpression(expr.e);
        }

      default:
        this.warn('Cannot evaluate expression type:', expr.type);
        return 0;
    }
  }

  /**
   * Evaluate function calls in expressions
   * @param {string} name - Function name
   * @param {Array} args - Evaluated arguments
   * @returns {number} Function result
   */
  evaluateFunction(name, args) {
    switch (name) {
      // Basic math functions
      case 'sin': return Math.sin(args[0] || 0);
      case 'cos': return Math.cos(args[0] || 0);
      case 'tan': return Math.tan(args[0] || 0);
      case 'abs': return Math.abs(args[0] || 0);
      case 'sqrt': return Math.sqrt(Math.max(0, args[0] || 0));
      case 'pow': return Math.pow(args[0] || 0, args[1] || 1);
      case 'exp': return Math.exp(args[0] || 0);
      case 'log': return Math.log(Math.max(1e-10, args[0] || 1));
      case 'floor': return Math.floor(args[0] || 0);
      case 'ceil': return Math.ceil(args[0] || 0);
      case 'round': return Math.round(args[0] || 0);
      case 'min': return args.length > 0 ? Math.min(...args) : 0;
      case 'max': return args.length > 0 ? Math.max(...args) : 0;
      case 'atan2': return Math.atan2(args[0] || 0, args[1] || 0);

      // Boolean/logic functions
      case 'step': return args.length >= 2 ? (args[1] >= args[0] ? 1 : 0) : 0;

      // Clamping and interpolation
      case 'clamp':
        if (args.length >= 3) {
          return Math.max(args[1], Math.min(args[2], args[0]));
        } else {
          return Math.max(0, Math.min(1, args[0] || 0));
        }
      case 'lerp':
      case 'mix':
        if (args.length >= 3) {
          return args[0] + args[2] * (args[1] - args[0]);
        }
        return args[0] || 0;

      // Fractional and modulo
      case 'fract':
        const val = args[0] || 0;
        return val - Math.floor(val);
      case 'mod':
        if (args.length >= 2) {
          const x = args[0] || 0;
          const y = args[1] || 1;
          return ((x % y) + y) % y;
        }
        return 0;

      // Random
      case 'random': return Math.random();

      // Complex functions that need special handling
      case 'noise': return (Math.random() - 0.5) * 2; // Simple white noise
      case 'pinknoise': return (Math.random() - 0.5) * 2; // Simplified
      case 'envelope': return 0; // Default - envelope needs state
      case 'delay': return args[0] || 0; // Default - delay needs buffer
      case 'lowpass': return args[0] || 0; // Default - filter needs state
      case 'highpass': return args[0] || 0; // Default - filter needs state
      case 'distort': return args[0] || 0; // Default - can be approximated

      default:
        this.warn(`Unsupported function in cross-context evaluation: ${name}`);
        return 0;
    }
  }

  /**
   * Evaluate strand access expressions (like me@time)
   * @param {Object} expr - StrandAccess expression
   * @returns {number} Strand value
   */
  evaluateStrandAccess(expr) {
    const baseName = expr.base?.name || expr.base;
    const outputName = expr.out;

    // Handle me@ expressions
    if (baseName === 'me') {
      const currentTime = (Date.now() - this.env.startTime) / 1000;
      const visualFrame = Math.floor(currentTime * this.env.targetFps);

      switch (outputName) {
        case 'time':
          return (visualFrame % this.env.loop) / this.env.targetFps;
        case 'abstime':
          return currentTime;
        case 'frame':
          return visualFrame % this.env.loop;
        case 'absframe':
          return visualFrame;
        case 'bpm':
          return this.env.bpm;
        case 'loop':
          return this.env.loop;
        case 'fps':
          return this.env.targetFps;
        case 'timesig_num':
          return this.env.timesig_num;
        case 'timesig_den':
          return this.env.timesig_den;
        case 'beat': {
          const beatsPerSecond = this.env.bpm / 60;
          const totalBeats = currentTime * beatsPerSecond;
          return Math.floor(totalBeats) % this.env.timesig_num;
        }
        case 'measure': {
          const beatsPerSecond = this.env.bpm / 60;
          const totalBeats = currentTime * beatsPerSecond;
          return Math.floor(totalBeats / this.env.timesig_num);
        }
        case 'width':
          return this.env.resW || 800;
        case 'height':
          return this.env.resH || 600;
        case 'x':
          return this.env.mouse?.x || 0.5;
        case 'y':
          return this.env.mouse?.y || 0.5;
        default:
          this.warn(`Unknown me@ property: ${outputName}`);
          return 0;
      }
    }

    // Handle other strand access (variables from instance outputs)
    const key = `${baseName}@${outputName}`;
    if (this.instanceOutputs[key]) {
      // For now, return 0 as we don't have the actual runtime value
      // This could be enhanced to get real values from environment
      return 0;
    }

    this.warn(`Unknown strand access: ${key}`);
    return 0;
  }

  /**
   * Evaluate variable references
   * @param {string} varName - Variable name
   * @returns {number} Variable value
   */
  evaluateVariable(varName) {
    // Check if it's a known instance output
    if (this.instanceOutputs[varName]) {
      // For now, return 0 as we don't have runtime evaluation
      // This could be enhanced to get actual values
      return 0;
    }

    switch (varName) {
      case 'time': return (this.env.frame % this.env.loop) / this.env.targetFps;
      case 'frame': return this.env.frame;
      case 'bpm': return this.env.bpm;
      case 'loop': return this.env.loop;
      default:
        return 0;
    }
  }
  updateCrossContextParams() {
    if (this.crossContextParams.length === 0 || !this.workletNode?.port) {
      return;
    }

    const paramValues = {};

    this.crossContextParams.forEach(param => {
      try {
        let result;

        if (param.type === 'pragma') {
          // Handle pragma parameters (sliders, etc.)
          // Look up the strand directly, not the instance
          const paramStrand = this.env.getParameterStrand(param.strand);
          if (paramStrand && paramStrand.value !== undefined) {
            result = paramStrand.value;
            this.log(`Pragma param ${param.paramKey} = ${result}`);
          } else {
            result = 440; // Default fallback for frequency
            this.warn(`Pragma param ${param.paramKey} not found, using default ${result}`);
          }
          const varName = `${param.name}_${param.strand}`;
          paramValues[varName] = result;
        } else {
          // Handle regular statement parameters
          if (param.statement.type === 'Direct' && param.statement.expr) {
            // For Direct statements (patterns), we need to create a function for evaluation
            // Get the actual instance from the environment to create a sampling function
            const instance = this.env.instances?.get(param.name);
            if (instance && param.outputs) {
              param.outputs.forEach(output => {
                const varName = `${param.name}_${output}`;
                const strand = instance.outs[output];
                if (strand && strand.kind === 'strand' && strand.evalAt) {
                  // Create a function that evaluates the strand at given coordinates
                  paramValues[varName] = {
                    type: 'function',
                    // We can't send functions directly, so we'll handle this differently
                    // For now, mark it as needing special handling
                    needsRuntimeEval: true,
                    instanceName: param.name,
                    strandName: output
                  };
                } else {
                  paramValues[varName] = 0;
                }
              });
            } else if (param.statement.expr.type === 'Num') {
              result = param.statement.expr.v;
              if (param.outputs && param.outputs.length > 0) {
                param.outputs.forEach(output => {
                  const varName = `${param.name}_${output}`;
                  paramValues[varName] = result;
                });
              } else {
                paramValues[param.name] = result;
              }
            } else {
              // Fallback to simple evaluation
              result = this.evaluateSimpleExpression(param.statement.expr);
              if (param.outputs && param.outputs.length > 0) {
                param.outputs.forEach(output => {
                  const varName = `${param.name}_${output}`;
                  paramValues[varName] = result;
                });
              } else {
                paramValues[param.name] = result;
              }
            }
          } else {
            // Handle other statement types
            if (param.statement.expr) {
              if (param.statement.expr.type === 'Num') {
                result = param.statement.expr.v;
              } else {
                result = this.evaluateSimpleExpression(param.statement.expr);
              }
            } else {
              result = 0; // Default fallback
            }

            if (param.outputs && param.outputs.length > 0) {
              param.outputs.forEach(output => {
                const varName = `${param.name}_${output}`;
                paramValues[varName] = result;
              });
            } else {
              paramValues[param.name] = result;
            }
          }
        }
      } catch (error) {
        this.warn('Failed to evaluate cross-context param:', param.name, error);
      }
    });

    console.log('🎵 Sending params to worklet:', paramValues);
    this.workletNode.port.postMessage({
      type: 'updateCrossContext',
      params: paramValues
    });

    // Send test message to verify worklet communication
    this.workletNode.port.postMessage({
      type: 'test',
      message: 'Testing worklet communication'
    });
  }
}

export { AudioWorkletRenderer };