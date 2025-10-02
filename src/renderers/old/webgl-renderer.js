// WebGL Renderer with WEFT-to-GLSL compiler for GPU acceleration
import { logger } from '../../utils/logger.js';
import { AbstractRenderer } from './abstract-renderer.js';
import { CrossContextManager, MediaManager } from '../shared-utils.js';

class WebGLRenderer extends AbstractRenderer {
  constructor(canvas, env) {
    super(env, 'WebGL');

    // WebGL-specific properties
    this.canvas = canvas;
    this.gl = null;
    this.program = null;
    this.uniforms = {};
    this.textures = new Map();
    this.textureCounter = 0;
    this.maxTextureUnits = 8;
    this.availableTextureUnits = [];
    this.frameBuffer = null;

    // Set supported routes
    this.supportedRoutes.add('gpu');
    this.supportedRoutes.add('cpu'); // Can also handle CPU routes

    // Initialize shared utilities
    this.crossContextManager = new CrossContextManager(env, 'WebGL');
    this.mediaManager = new MediaManager(env, 'WebGL');

    // Vertex buffer for full-screen quad
    this.vertexBuffer = null;

    // Delay WebGL context initialization to avoid conflicts with CPU renderer
    // this.initWebGL(); // Moved to initialize() method
  }

  // ===== Implementation of abstract methods =====

  /**
   * Initialize WebGL renderer resources
   */
  async initialize() {
    // Initialize WebGL context now (delayed from constructor)
    if (!this.initWebGL()) {
      throw new Error('Failed to initialize WebGL context');
    }

    if (!this.gl) {
      throw new Error('WebGL context not available');
    }
    this.setupQuadGeometry();
    logger.info('WebGL', 'WebGL Renderer initialized successfully');
    return true;
  }

  /**
   * Compile AST for WebGL rendering
   */
  async compile(ast) {
    try {
      console.log('🔥 WebGL compile starting...');

      // Ensure WebGL context is initialized before compilation
      if (!this.gl) {
        console.log('🔥 WebGL context not available, initializing...');
        if (!this.initWebGL()) {
          throw new Error('Failed to initialize WebGL context during compilation');
        }
        this.setupQuadGeometry();
      }

      this.filterStatements(ast);
      await this.mediaManager.processLoadStatements(this.filteredStatements);

      // Store AST for shader generation
      this.env.currentProgram = ast;

      // Collect cross-context parameters
      const usedVars = this.findUsedVariables(this.filteredStatements);
      this.crossContextManager.collectCrossContextParams(ast, usedVars);

      console.log('🔥 About to compile shaders...');
      // Compile display statements into shaders
      const success = this.compileDisplayShaders(ast);
      if (!success) {
        console.error('❌ Shader compilation returned false');
        throw new Error('Shader compilation failed');
      }
      logger.info('WebGL', 'WebGL compilation completed successfully');
      return true;
    } catch (error) {
      logger.error('WebGL', 'WebGL compilation failed:', error);
      return false;
    }
  }

  /**
   * Render a single frame using WebGL
   */
  render() {
    if (!this.program) {
      logger.warn('WebGL', 'No shader program available for rendering');
      return;
    }

    this.updateCanvasSize();
    this.updateUniforms();
    this.drawFrame();
  }

  /**
   * Clean up WebGL renderer resources
   */
  cleanup() {
    if (this.program) {
      this.gl.deleteProgram(this.program);
      this.program = null;
    }
    if (this.vertexBuffer) {
      this.gl.deleteBuffer(this.vertexBuffer);
      this.vertexBuffer = null;
    }
    // Cleanup textures
    for (const [, textureInfo] of this.textures) {
      if (textureInfo.texture) {
        this.gl.deleteTexture(textureInfo.texture);
      }
    }
    this.textures.clear();
    logger.debug('WebGL', 'WebGL renderer cleanup complete');
  }

  // ===== WebGL-specific implementation methods =====

  /**
   * Initialize WebGL context and check capabilities
   */
  initWebGL() {
    // Try to get WebGL context
    this.gl = this.canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ||
              this.canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!this.gl) {
      console.error('WebGL not supported, falling back to CPU renderer');
      return false;
    }

    // Check WebGL limits
    const maxViewportDims = this.gl.getParameter(this.gl.MAX_VIEWPORT_DIMS);
    const maxTextureSize = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    const maxTextureUnits = this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS);

    this.maxWidth = maxViewportDims[0];
    this.maxHeight = maxViewportDims[1];
    this.maxTextureUnits = Math.min(maxTextureUnits, 8); // Conservative limit

    // Initialize available texture units pool
    this.availableTextureUnits = [];
    for (let i = 0; i < this.maxTextureUnits; i++) {
      this.availableTextureUnits.push(i);
    }

    logger.info('WebGL', 'WebGL context initialized successfully');
    return true;
  }

  /**
   * Setup full-screen quad geometry
   */
  setupQuadGeometry() {
    const vertices = new Float32Array([
      -1, -1,   // bottom-left
       1, -1,   // bottom-right
      -1,  1,   // top-left
      -1,  1,   // top-left
       1, -1,   // bottom-right
       1,  1    // top-right
    ]);

    const buffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.STATIC_DRAW);
    this.vertexBuffer = buffer;
  }

  /**
   * Compile display statements into shaders
   */
  compileDisplayShaders(ast) {
    // Find display statements
    const displayStmts = [];
    const traverse = (node) => {
      if (!node) return;
      if (node.type === 'DisplayStmt' || node.type === 'RenderStmt') {
        displayStmts.push(node);
      }
      if (node.statements) node.statements.forEach(traverse);
      if (node.args) node.args.forEach(traverse);
    };

    traverse(ast);

    if (displayStmts.length === 0) {
      console.error('❌ No display statements found in AST');
      console.log('AST statements:', ast.statements.map(s => s.type));
      logger.debug('WebGL', 'No display statements found');
      return false;
    }
    console.log('✅ Found display statements:', displayStmts.length);

    // Store the display statement and full AST for shader generation
    this.displayStatement = displayStmts[0];
    this.currentAST = ast;

    // Generate and compile shaders
    return this.compileShaders();
  }

  /**
   * Compile shaders and create program
   */
  compileShaders() {
    const vertexShader = `
      attribute vec2 a_position;
      varying vec2 v_texCoord;

      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = (a_position + 1.0) * 0.5;
        v_texCoord.y = 1.0 - v_texCoord.y;
      }
    `;

    console.log('🔥 Generating fragment shader...');
    let fragmentShader;
    try {
      fragmentShader = this.generateFragmentShader();
      console.log('🔥 Fragment shader generation completed, checking result...');
    } catch (error) {
      console.error('❌ Fragment shader generation threw error:', error);
      logger.error('WebGL', 'Fragment shader generation threw error:', error);
      return false;
    }

    if (!fragmentShader) {
      console.error('❌ Fragment shader generation returned null');
      logger.error('WebGL', 'Failed to generate fragment shader');
      return false;
    }
    logger.debug('WebGL', `Fragment shader generated: ${fragmentShader.length} characters`);

    this.program = this.createProgram(vertexShader, fragmentShader);
    if (!this.program) {
      return false;
    }

    this.setupProgram();
    return true;
  }

  /**
   * Setup shader program attributes and uniforms
   */
  setupProgram() {
    const gl = this.gl;
    gl.useProgram(this.program);

    // Setup attributes
    const positionLoc = gl.getAttribLocation(this.program, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    // Cache uniform locations
    this.cacheUniformLocations();
  }

  /**
   * Normalize a coordinate expression for texture sampling
   * @param {string} coord - The coordinate expression
   * @returns {string} - Normalized coordinate expression
   */
  normalizeTextureCoordinate(coord) {
    // v_texCoord components are already normalized [0,1]
    if (coord === 'v_texCoord.x' || coord === 'v_texCoord.y') {
      return coord;
    }

    // Time-based coordinates don't need spatial normalization but may need wrapping
    if (coord.includes('u_time') || coord.includes('u_frame') ||
        coord.includes('u_abstime') || coord.includes('u_absframe')) {
      // For time coordinates, wrap to [0,1] range for texture sampling
      return `mod(${coord}, 1.0)`;
    }

    // Check if it's already a normalized expression (contains division or mod)
    if (coord.includes('/') || coord.includes('mod(')) {
      return coord;
    }

    // For pixel coordinates, normalize by resolution
    if (coord.includes('u_resolution') || coord.match(/^\d+\.?\d*$/)) {
      return `(${coord} / u_resolution.x)`; // Assume x for now, could be improved
    }

    // Default: assume it's already normalized or handle as-is
    return coord;
  }

  /**
   * Cache uniform locations for better performance
   */
  cacheUniformLocations() {
    const gl = this.gl;
    this.uniforms = {
      resolution: gl.getUniformLocation(this.program, 'u_resolution'),
      time: gl.getUniformLocation(this.program, 'u_time'),
      frame: gl.getUniformLocation(this.program, 'u_frame'),
      abstime: gl.getUniformLocation(this.program, 'u_abstime'),
      absframe: gl.getUniformLocation(this.program, 'u_absframe'),
      fps: gl.getUniformLocation(this.program, 'u_fps'),
      loop: gl.getUniformLocation(this.program, 'u_loop'),
      bpm: gl.getUniformLocation(this.program, 'u_bpm'),
      timesig_num: gl.getUniformLocation(this.program, 'u_timesig_num'),
      timesig_den: gl.getUniformLocation(this.program, 'u_timesig_den'),
      beat: gl.getUniformLocation(this.program, 'u_beat'),
      measure: gl.getUniformLocation(this.program, 'u_measure'),
      mouse: gl.getUniformLocation(this.program, 'u_mouse')
    };

    // Cache texture uniform locations
    for (const [, textureInfo] of this.textures) {
      this.uniforms[textureInfo.uniformName] = gl.getUniformLocation(this.program, textureInfo.uniformName);
      if (this.uniforms[textureInfo.uniformName]) {
        gl.uniform1i(this.uniforms[textureInfo.uniformName], textureInfo.unit);
      }
    }

    // Cache parameter uniform locations
    if (this.env.parameters) {
      for (const [paramName] of this.env.parameters) {
        const uniformName = `u_param_${paramName}`;
        this.uniforms[uniformName] = gl.getUniformLocation(this.program, uniformName);
      }
    }
  }

  /**
   * Update canvas size to match environment resolution
   */
  updateCanvasSize() {
    const width = this.env.resW;
    const height = this.env.resH;

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      logger.debug('WebGL', `Canvas resized to: ${width}×${height}`);
      this.updateResolutionDisplay();
    }

    this.gl.viewport(0, 0, width, height);
  }

  /**
   * Update shader uniforms
   */
  updateUniforms() {
    const gl = this.gl;
    const env = this.env;

    // Set resolution
    gl.uniform2f(this.uniforms.resolution, env.resW, env.resH);

    // Time uniforms
    const absTime = (Date.now() - env.startTime) / 1000;
    const beatsPerSecond = env.bpm / 60;
    gl.uniform1f(this.uniforms.time, (env.frame % env.loop) / env.targetFps);
    gl.uniform1f(this.uniforms.frame, env.frame % env.loop);
    gl.uniform1f(this.uniforms.abstime, absTime);
    gl.uniform1f(this.uniforms.absframe, env.frame);
    gl.uniform1f(this.uniforms.fps, env.targetFps);
    gl.uniform1f(this.uniforms.loop, env.loop);
    gl.uniform1f(this.uniforms.bpm, env.bpm);
    gl.uniform1f(this.uniforms.timesig_num, env.timesig_num);
    gl.uniform1f(this.uniforms.timesig_den, env.timesig_den);
    gl.uniform1f(this.uniforms.beat, Math.floor(absTime * beatsPerSecond) % env.timesig_num);
    gl.uniform1f(this.uniforms.measure, Math.floor(absTime * beatsPerSecond / env.timesig_num));

    gl.uniform2f(this.uniforms.mouse, env.mouse.x, env.mouse.y);

    // Set parameter uniforms
    if (env.parameters) {
      for (const [paramName, paramStrand] of env.parameters) {
        const uniformName = `u_param_${paramName}`;
        if (this.uniforms[uniformName]) {
          gl.uniform1f(this.uniforms[uniformName], paramStrand.value);
        }
      }
    }
  }

  /**
   * Draw the frame
   */
  drawFrame() {
    const gl = this.gl;

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this.env.frame++;
  }

  /**
   * Find variables used in filtered statements
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
    logger.debug('WebGL', `Parameter updated: ${paramName} = ${value}`);
  }

  /**
   * Get performance label
   */
  getPerformanceLabel() {
    return 'GPU Accelerated';
  }

  /**
   * Sample pixel value at normalized coordinates [0,1]
   * @param {number} x - Normalized X coordinate (0-1)
   * @param {number} y - Normalized Y coordinate (0-1)
   * @param {number} channel - Channel index (0=r, 1=g, 2=b, 3=a)
   * @returns {number} Normalized pixel value (0-1)
   */
  samplePixel(x, y, channel = 0) {
    if (!this.gl) return 0;

    // Clamp and normalize coordinates
    x = Math.max(0, Math.min(1, x));
    y = Math.max(0, Math.min(1, y));

    // Convert to pixel coordinates
    const px = Math.floor(x * this.env.resW);
    const py = Math.floor(y * this.env.resH);

    // Read pixel from framebuffer (WebGL reads from bottom-left, flip Y)
    const glY = this.env.resH - 1 - py;
    const pixels = new Uint8Array(4);
    this.gl.readPixels(px, glY, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels);

    // Return normalized value [0,1]
    return pixels[channel] / 255.0;
  }

  // ===== Keep existing WebGL methods =====

  loadTexture(url, instName) {
    if (this.textures.has(instName)) {
      return this.textures.get(instName);
    }

    if (!this.gl) {
      console.error('❌ WebGL context not available for texture loading');
      logger.error('WebGL', 'Cannot load texture - WebGL context is null', { url, instName });
      return null;
    }

    const gl = this.gl;
    const texture = gl.createTexture();
    const textureUnit = this.textureCounter++;

    gl.activeTexture(gl.TEXTURE0 + textureUnit);
    gl.bindTexture(gl.TEXTURE_2D, texture);

    // Create 1x1 pixel placeholder
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                  new Uint8Array([128, 128, 128, 255]));

    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      gl.activeTexture(gl.TEXTURE0 + textureUnit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      console.log(`Loaded texture: ${url} on unit ${textureUnit}`);
    };
    image.onerror = () => {
      console.error(`Failed to load texture: ${url}`);
    };
    image.src = url;

    const textureInfo = {
      texture,
      unit: textureUnit,
      uniformName: `u_texture${textureUnit}`,
      loaded: false
    };

    this.textures.set(instName, textureInfo);
    return textureInfo;
  }

  compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      console.error('❌ WebGL Shader compilation error:', info);
      console.error('❌ Shader source:');
      console.error(source.split('\n').map((line, i) => `${i+1}: ${line}`).join('\n'));
      logger.error('WebGL', 'Shader compilation failed', {
        type: type === gl.VERTEX_SHADER ? 'vertex' : 'fragment',
        error: info,
        source: source.split('\n').map((line, i) => `${i+1}: ${line}`).join('\n')
      });
      gl.deleteShader(shader);
      return null;
    }

    return shader;
  }

  createProgram(vertexSource, fragmentSource) {
    const gl = this.gl;
    const vertexShader = this.compileShader(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource);

    if (!vertexShader || !fragmentShader) return null;

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      return null;
    }

    return program;
  }

  // Convert WEFT AST to GLSL code with full support
  compileToGLSL(node, env, instanceOutputs = {}, localScope = {}) {
    if (Array.isArray(node)) {
      return node.length === 1 ? this.compileToGLSL(node[0], env, instanceOutputs, localScope) : '0.0';
    }

    // Handle both plain objects and AST node instances
    const nodeType = node.type || (node.constructor && node.constructor.name);


    switch(nodeType) {
      case 'Num':
      case 'NumExpr':
        const numValue = node.v !== undefined ? node.v : node.value;
        return numValue.toString() + (Number.isInteger(numValue) ? '.0' : '');


      case 'Me':
      case 'MeExpr':
        const meField = node.field;
        switch (meField) {
          case 'x': return 'v_texCoord.x';
          case 'y': return 'v_texCoord.y';
          case 'time': return 'u_time';
          case 'frame': return 'u_frame';
          case 'abstime': return 'u_abstime';
          case 'absframe': return 'u_absframe';
          case 'width': return 'u_resolution.x';
          case 'height': return 'u_resolution.y';
          case 'fps': return 'u_fps';
          case 'loop': return 'u_loop';
          case 'bpm': return 'u_bpm';
          case 'beat': return 'u_beat';
          case 'measure': return 'u_measure';
          default: return '0.0';
        }

      case 'Mouse':
      case 'MouseExpr':
        const mouseField = node.field;
        return mouseField === 'x' ? 'u_mouse.x' :
               mouseField === 'y' ? 'u_mouse.y' : '0.0';

      case 'Unary':
      case 'UnaryExpr':
        const arg = this.compileToGLSL(node.expr, env, instanceOutputs, localScope);
        const unaryOp = node.op;
        if (unaryOp === 'NOT') return `(${arg} > 0.0 ? 0.0 : 1.0)`;
        if (unaryOp === '-') return `(-${arg})`;
        return arg;

      case 'Bin': {
        const left = this.compileToGLSL(node.left, env, instanceOutputs, localScope);
        const right = this.compileToGLSL(node.right, env, instanceOutputs, localScope);

        switch(node.op) {
          case '+': return `(${left} + ${right})`;
          case '-': return `(${left} - ${right})`;
          case '*':
            const multResult = `(${left} * ${right})`;
            return multResult;
          case '/': return `(${left} / max(${right}, 0.000001))`;
          case '^':
            return `pow(${left}, ${right})`;
          case '%': return `mod(${left}, ${right})`;
          case '==': case '===': return `(${left} == ${right} ? 1.0 : 0.0)`;
          case '!=': return `(${left} != ${right} ? 1.0 : 0.0)`;
          case '<': return `(${left} < ${right} ? 1.0 : 0.0)`;
          case '>': return `(${left} > ${right} ? 1.0 : 0.0)`;
          case '<=': return `(${left} <= ${right} ? 1.0 : 0.0)`;
          case '>=': return `(${left} >= ${right} ? 1.0 : 0.0)`;
          case '<<': return `(${left} < ${right} ? 1.0 : 0.0)`;
          case '>>': return `(${left} > ${right} ? 1.0 : 0.0)`;
          case '<<=': return `(${left} <= ${right} ? 1.0 : 0.0)`;
          case '>>=': return `(${left} >= ${right} ? 1.0 : 0.0)`;
          case 'AND': return `(${left} > 0.0 && ${right} > 0.0 ? 1.0 : 0.0)`;
          case 'OR': return `(${left} > 0.0 || ${right} > 0.0 ? 1.0 : 0.0)`;
          default: return '0.0';
        }
      }

      case 'If':
      case 'IfExpr': {
        const cond = this.compileToGLSL(node.condition, env, instanceOutputs, localScope);
        const thenExpr = this.compileToGLSL(node.thenExpr, env, instanceOutputs, localScope);
        const elseExpr = this.compileToGLSL(node.elseExpr, env, instanceOutputs, localScope);
        return `(${cond} > 0.0 ? ${thenExpr} : ${elseExpr})`;
      }

      case 'Call':
      case 'CallExpr': {
        const args = node.args.map(arg => this.compileToGLSL(arg, env, instanceOutputs, localScope));
        const name = node.name;

        // Map WEFT functions to GLSL
        switch(name) {
          case 'sin': return `sin(${args[0]})`;
          case 'cos': return `cos(${args[0]})`;
          case 'tan': return `tan(${args[0]})`;
          case 'sqrt': return `sqrt(${args[0]})`;
          case 'abs': return `abs(${args[0]})`;
          case 'exp': return `exp(${args[0]})`;
          case 'log': return `log(${args[0]})`;
          case 'min': return `min(${args.join(', ')})`;
          case 'max': return `max(${args.join(', ')})`;
          case 'floor': return `floor(${args[0]})`;
          case 'ceil': return `ceil(${args[0]})`;
          case 'round': return `floor(${args[0]} + 0.5)`;
          case 'atan2': return `atan(${args[0]}, ${args[1]})`;
          case 'clamp':
            return args.length === 3 ?
              `clamp(${args[0]}, ${args[1]}, ${args[2]})` :
              `clamp(${args[0]}, 0.0, 1.0)`;
          case 'length':
            return args.length === 2 ?
              `length(vec2(${args[0]}, ${args[1]}))` :
              `abs(${args[0]})`;
          case 'distance':
            return args.length === 4 ?
              `distance(vec2(${args[0]}, ${args[1]}), vec2(${args[2]}, ${args[3]}))` :
              '0.0';
          case 'normalize':
            return args.length === 3 ?
              `((${args[0]} - ${args[1]}) / max(${args[2]} - ${args[1]}, 0.000001))` :
              args[0];
          case 'noise':
            return args.length >= 3 ?
              `noise3(${args[0]} * 3.1, ${args[1]} * 3.1, ${args[2]} * 0.5)` :
              '0.0';

          // Additional WEFT functions
          case 'mix':
          case 'lerp':
            return args.length >= 3 ?
              `mix(${args[0]}, ${args[1]}, ${args[2]})` :
              args.length === 2 ? `mix(${args[0]}, ${args[1]}, 0.5)` : '0.0';

          case 'smoothstep':
            return args.length >= 3 ?
              `smoothstep(${args[0]}, ${args[1]}, ${args[2]})` :
              '0.0';

          case 'step':
            return args.length >= 2 ?
              `step(${args[0]}, ${args[1]})` :
              '0.0';

          case 'fract':
            return args.length >= 1 ?
              `fract(${args[0]})` :
              '0.0';

          case 'sign':
            return args.length >= 1 ?
              `sign(${args[0]})` :
              '0.0';

          case 'pow':
            return args.length >= 2 ?
              `pow(${args[0]}, ${args[1]})` :
              '0.0';

          case 'mod':
            return args.length >= 2 ?
              `mod(${args[0]}, ${args[1]})` :
              '0.0';

          case 'degrees':
            return args.length >= 1 ?
              `degrees(${args[0]})` :
              '0.0';

          case 'radians':
            return args.length >= 1 ?
              `radians(${args[0]})` :
              '0.0';

          case 'asin':
            return args.length >= 1 ?
              `asin(clamp(${args[0]}, -1.0, 1.0))` :
              '0.0';

          case 'acos':
            return args.length >= 1 ?
              `acos(clamp(${args[0]}, -1.0, 1.0))` :
              '0.0';

          case 'atan':
            return args.length >= 1 ?
              `atan(${args[0]})` :
              '0.0';

          case 'sinh':
            return args.length >= 1 ?
              `sinh(${args[0]})` :
              '0.0';

          case 'cosh':
            return args.length >= 1 ?
              `cosh(${args[0]})` :
              '0.0';

          case 'tanh':
            return args.length >= 1 ?
              `tanh(${args[0]})` :
              '0.0';

          case 'inverse':
          case 'invert':
            return args.length >= 1 ?
              `(1.0 - ${args[0]})` :
              '1.0';

          case 'threshold':
            return args.length >= 2 ?
              `(${args[0]} > ${args[1]} ? 1.0 : 0.0)` :
              args.length === 1 ? `(${args[0]} > 0.5 ? 1.0 : 0.0)` : '0.0';

          case 'saturate':
            return args.length >= 1 ?
              `clamp(${args[0]}, 0.0, 1.0)` :
              '0.0';

          case 'reflect':
            return args.length >= 2 ?
              `reflect(${args[0]}, ${args[1]})` :
              '0.0';

          case 'refract':
            return args.length >= 3 ?
              `refract(${args[0]}, ${args[1]}, ${args[2]})` :
              '0.0';

          case 'dot':
            return args.length >= 4 ?
              `dot(vec2(${args[0]}, ${args[1]}), vec2(${args[2]}, ${args[3]}))` :
              args.length >= 2 ? `(${args[0]} * ${args[1]})` : '0.0';

          case 'cross':
            // 2D cross product magnitude
            return args.length >= 4 ?
              `(${args[0]} * ${args[3]} - ${args[1]} * ${args[2]})` :
              '0.0';

          default:
            logger.warn('WebGL', `Unknown function: ${name}`);
            return '0.0';
        }
      }

      case 'StrandAccess':
      case 'StrandAccessExpr': {
        // Handle instance@output access - support both string and object formats
        const baseName = typeof node.base === 'string' ? node.base : node.base.name;
        const outputName = typeof node.out === 'string' ? node.out : node.out.name;
        const key = `${baseName}@${outputName}`;

        // Special handling for me@ outputs - map to uniforms
        if (baseName === 'me') {
          switch(outputName) {
            case 'x': return 'v_texCoord.x';
            case 'y': return 'v_texCoord.y';
            case 'abstime': return 'u_abstime';
            case 'absframe': return 'u_absframe';
            case 'time': return 'u_time';
            case 'frame': return 'u_frame';
            case 'width': return 'u_resolution.x';
            case 'height': return 'u_resolution.y';
            case 'fps': return 'u_fps';
            case 'loop': return 'u_loop';
            case 'bpm': return 'u_bpm';
            case 'timesig_num': return 'u_timesig_num';
            case 'timesig_den': return 'u_timesig_den';
            case 'beat': return 'u_beat';
            case 'measure': return 'u_measure';
            default:
              logger.warn('WebGL', `Unknown me output '${outputName}', defaulting to 0.0`);
              return '0.0';
          }
        }

        // Check if this is a parameter instance access (e.g., lvl@l)
        if (env.instances && env.instances.has(baseName)) {
          const instance = env.instances.get(baseName);
          if (instance.kind === 'instance' && instance.outs && instance.outs[outputName]) {
            const strand = instance.outs[outputName];
            if (strand.kind === 'strand' && strand.name) {
              // This is a parameter strand, use the uniform
              console.log(`🎮 WebGL: Converting ${baseName}@${outputName} to uniform u_param_${strand.name}`);
              return `u_param_${strand.name}`;
            }
          }
        }

        if (instanceOutputs[key]) {
          return instanceOutputs[key];
        }

        // Also try direct lookup
        if (instanceOutputs[baseName]) {
          return instanceOutputs[baseName];
        }

        return '0.0';
      }

      case 'StrandRemap':
      case 'StrandRemapExpr': {
        return this.compileStrandRemapToGLSL(node, env, instanceOutputs, localScope);
      }

      case 'Str':
      case 'StrExpr': {
        // Strings in GLSL context - convert to numeric if possible
        const strValue = node.v || node.value;
        return '0.0'; // Strings can't be used in numeric GLSL context
      }

      case 'Tuple':
      case 'TupleExpr': {
        const items = node.items || [];
        if (items.length === 0) return '0.0';
        if (items.length === 1) {
          return this.compileToGLSL(items[0], env, instanceOutputs, localScope);
        }

        // For multiple items, we'd need to return a vector type
        // For now, return first element
        return this.compileToGLSL(items[0], env, instanceOutputs, localScope);
      }

      case 'Index':
      case 'IndexExpr': {
        // Array/tuple indexing - limited support
        const base = this.compileToGLSL(node.base, env, instanceOutputs, localScope);
        const index = this.compileToGLSL(node.index, env, instanceOutputs, localScope);

        // For vectors, we can use swizzling
        if (index === '0.0' || index === '0') return `${base}.x`;
        if (index === '1.0' || index === '1') return `${base}.y`;
        if (index === '2.0' || index === '2') return `${base}.z`;
        if (index === '3.0' || index === '3') return `${base}.w`;

        // Fallback to first component
        return `${base}.x`;
      }

      case 'Var':
      case 'VarExpr': {
        const varName = node.name;

        // Check local scope first (for function parameters and let bindings)
        if (localScope[varName]) {
          return localScope[varName];
        }

        // Check instance outputs
        if (instanceOutputs[varName]) {
          return instanceOutputs[varName];
        }

        // Check for direct strand access (instance@output pattern)
        for (const key in instanceOutputs) {
          if (key.endsWith(`@${varName}`) || key === varName) {
            return instanceOutputs[key];
          }
        }

        // If it's a direct variable reference (like parameters), use the name directly
        return varName;
      }

      case 'Let':
      case 'LetBinding': {
        // Let binding should be handled at statement level, not expression level
        logger.warn('WebGL', 'Let binding found in expression context');
        return '0.0';
      }

      case 'Assignment': {
        // Assignment should be handled at statement level
        logger.warn('WebGL', 'Assignment found in expression context');
        return '0.0';
      }

      default:
        logger.warn('WebGL', `Unknown expression type: ${nodeType}`, node);
        return '0.0';
    }
  }

  generateFragmentShader() {
    console.log('🔥 generateFragmentShader called');

    // Use the stored display statement from compilation
    if (!this.displayStatement || !this.currentAST) {
      logger.error('WebGL', 'No display statement or AST available', {
        hasDisplayStatement: !!this.displayStatement,
        hasCurrentAST: !!this.currentAST
      });
      return null;
    }

    const program = this.currentAST;
    logger.info('WebGL', `Generating shader for display statement with ${program.statements.length} total statements`);

    const displayStmt = this.displayStatement;
    if (!displayStmt) {
      return null;
    }

    logger.info('WebGL', 'Generating fragment shader with enhanced GPU support');

    // Collect all instances and their definitions
    const instanceOutputs = {};
    const glslCode = [];
    console.log('🔥 Starting shader generation setup...');

    // Collect and generate GLSL functions for user-defined spindles
    const spindleFunctions = [];
    try {
      for (const [spindleName, spindleDef] of this.env.spindles) {
        if (this.canCompileSpindleToGLSL(spindleDef)) {
          logger.info('WebGL', `Generating GLSL function for spindle: ${spindleName}`);
          const glslFunction = this.generateSpindleGLSL(spindleDef);
          spindleFunctions.push(glslFunction);
        } else {
          logger.debug('WebGL', `Spindle '${spindleName}' cannot be compiled to GLSL`);
        }
      }
      console.log('🔥 Spindle functions processed, moving to statement processing...');
    } catch (error) {
      console.error('❌ Error in spindle processing:', error);
      throw error;
    }

    // Process all statements in the program
    const globalScope = {}; // Track variables defined at global scope

    try {
      console.log('🔥 Starting statement processing...');
      for (const stmt of program.statements) {
        console.log('🔥 Processing statement:', stmt.type);
      // Skip environment parameter updates - handled by runtime
      if (stmt.type === 'Direct' && stmt.name === 'me') {
        logger.debug('WebGL', 'Skipping me parameter update in shader');
        continue;
      }

      // Handle Let bindings
      if (stmt.type === 'Let' || stmt.type === 'LetBinding') {
        const varName = stmt.name;
        const glslExpr = this.compileToGLSL(stmt.expr, this.env, instanceOutputs, globalScope);
        glslCode.push(`  float ${varName} = ${glslExpr};`);
        globalScope[varName] = varName;
        instanceOutputs[varName] = varName;
        logger.debug('WebGL', `Let binding: ${varName} = ${glslExpr}`);
      }

      // Handle Assignment statements
      else if (stmt.type === 'Assign' || stmt.type === 'Assignment') {
        const varName = stmt.name;
        const op = stmt.op;
        const glslExpr = this.compileToGLSL(stmt.expr, this.env, instanceOutputs, globalScope);

        if (op === '=') {
          // Check if variable exists, if not declare it
          if (!globalScope[varName]) {
            glslCode.push(`  float ${varName} = ${glslExpr};`);
            globalScope[varName] = varName;
          } else {
            glslCode.push(`  ${varName} = ${glslExpr};`);
          }
        } else {
          // Compound assignment
          if (!globalScope[varName]) {
            glslCode.push(`  float ${varName} = 0.0;`);
            globalScope[varName] = varName;
          }
          const rhsCode = glslExpr;
          if (op === '+=') glslCode.push(`  ${varName} += ${rhsCode};`);
          else if (op === '-=') glslCode.push(`  ${varName} -= ${rhsCode};`);
          else if (op === '*=') glslCode.push(`  ${varName} *= ${rhsCode};`);
          else if (op === '/=') glslCode.push(`  ${varName} /= max(${rhsCode}, 0.000001);`);
        }
        instanceOutputs[varName] = varName;
        logger.debug('WebGL', `Assignment: ${varName} ${op} ${glslExpr}`);
      }

      // Handle Direct statements (existing logic)
      else if (stmt.type === 'Direct') {
        logger.debug('WebGL', `Processing Direct: ${stmt.name}`, { outputs: stmt.outs });

        // Special handling for StrandRemap expressions
        if (stmt.expr && stmt.expr.type === 'StrandRemap') {
          this.compileStrandRemapDirect(stmt, glslCode, instanceOutputs, globalScope);
        } else {
          for (let i = 0; i < stmt.outs.length; i++) {
            const outputName = stmt.outs[i];
            const varName = `${stmt.name}_${outputName}`;
            const glslExpr = this.compileToGLSL(stmt.expr, this.env, instanceOutputs, globalScope);

            if (stmt.outs.length === 1) {
              glslCode.push(`  float ${varName} = ${glslExpr};`);
              instanceOutputs[`${stmt.name}@${outputName}`] = varName;
              globalScope[varName] = varName;
              instanceOutputs[stmt.name] = varName; // Also allow direct access
            } else {
              // Handle tuple outputs - need better approach for this
              glslCode.push(`  float ${varName} = ${glslExpr};`);
              instanceOutputs[`${stmt.name}@${outputName}`] = varName;
              globalScope[varName] = varName;
            }

            logger.debug('WebGL', `Direct output: ${varName} = ${glslExpr}`);
          }
        }
      }

      // Handle image/media loading
      if (stmt.type === 'CallInstance' && stmt.callee === 'load') {
        const imagePath = stmt.args[0] && stmt.args[0].type === 'Str' ? stmt.args[0].v : null;
        if (imagePath) {
          const textureInfo = this.loadTexture(imagePath, stmt.inst);
          if (!textureInfo) {
            logger.warn('WebGL', `Failed to load texture, skipping: ${stmt.inst}`, { path: imagePath });
            continue; // Skip this load statement if texture loading failed
          }
          logger.info('WebGL', `Processing load instance: ${stmt.inst}`, { path: imagePath, outputs: stmt.outs });

          for (const output of stmt.outs) {
            const outName = typeof output === 'string' ? output : (output.name || output.alias);
            const varName = `${stmt.inst}_${outName}`;

            // Map output names to texture components more flexibly
            let component = '.r'; // default to red
            if (outName === 'r' || outName === 'red') component = '.r';
            else if (outName === 'g' || outName === 'green') component = '.g';
            else if (outName === 'b' || outName === 'blue') component = '.b';
            else if (outName === 'a' || outName === 'alpha') component = '.a';
            else {
              // For arbitrary names, use position-based mapping
              const outputIndex = stmt.outs.indexOf(output);
              component = ['.r', '.g', '.b', '.a'][Math.min(outputIndex, 3)];
            }

            glslCode.push(`  float ${varName} = texture2D(${textureInfo.uniformName}, v_texCoord)${component};`);
            instanceOutputs[`${stmt.inst}@${outName}`] = varName;
            logger.debug('WebGL', `Texture output: ${varName} → ${component}`);
          }
        }
      }

      // Handle general spindle calls - try to compile common ones to GLSL
      if (stmt.type === 'CallInstance' && stmt.callee !== 'load') {
        this.compileSpindleToGLSL(stmt, glslCode, instanceOutputs);
      }
    }
    } catch (error) {
      console.error('❌ Error in statement processing:', error);
      throw error;
    }

    // Compile render/display statement
    let rCode = '0.0', gCode = '0.0', bCode = '0.0';

    // Handle named arguments in render statements
    if (displayStmt.type === 'RenderStmt' && displayStmt.namedArgs && displayStmt.namedArgs.size > 0) {
      const namedArgs = displayStmt.namedArgs;
      if (namedArgs.has('r')) {
        rCode = this.compileToGLSL(namedArgs.get('r'), this.env, instanceOutputs, globalScope);
      }
      if (namedArgs.has('g')) {
        gCode = this.compileToGLSL(namedArgs.get('g'), this.env, instanceOutputs, globalScope);
      }
      if (namedArgs.has('b')) {
        bCode = this.compileToGLSL(namedArgs.get('b'), this.env, instanceOutputs, globalScope);
      }
      if (namedArgs.has('rgb')) {
        const rgbExpr = this.compileToGLSL(namedArgs.get('rgb'), this.env, instanceOutputs, globalScope);
        rCode = gCode = bCode = rgbExpr;
      }
      logger.info('WebGL', 'Using render statement with named arguments');
    } else {

    if (displayStmt.args && displayStmt.args.length === 1) {
      // Single argument - try to get first 3 outputs from the instance
      const arg = displayStmt.args[0];
      if (arg.type === 'Var') {
        const instName = arg.name;
        const availableOutputs = Object.keys(instanceOutputs).filter(key => key.startsWith(instName + '@'));

        if (availableOutputs.length >= 3) {
          // Use first 3 outputs for RGB
          const [r, g, b] = availableOutputs.slice(0, 3);
          rCode = instanceOutputs[r] || '0.0';
          gCode = instanceOutputs[g] || '0.0';
          bCode = instanceOutputs[b] || '0.0';
          logger.info('WebGL', `Display mapping: ${r} → r, ${g} → g, ${b} → b`);
        } else if (availableOutputs.length === 1) {
          // Single output - use as grayscale
          const singleOut = instanceOutputs[availableOutputs[0]];
          rCode = gCode = bCode = singleOut;
          logger.info('WebGL', `Display grayscale: ${availableOutputs[0]} → rgb`);
        } else {
          logger.warn('WebGL', `Instance ${instName} has insufficient outputs for display`);
        }
      }
    } else if (displayStmt.args && displayStmt.args.length >= 3) {
      rCode = this.compileToGLSL(displayStmt.args[0], this.env, instanceOutputs, globalScope);
      gCode = this.compileToGLSL(displayStmt.args[1], this.env, instanceOutputs, globalScope);
      bCode = this.compileToGLSL(displayStmt.args[2], this.env, instanceOutputs, globalScope);
      logger.info('WebGL', 'Using render statement with positional arguments');
    }
    } // End of render statement handling

    // Final safety check - if all colors are still 0.0, something went wrong
    if (rCode === '0.0' && gCode === '0.0' && bCode === '0.0') {
      logger.error('WebGL', 'All color channels are 0.0 - render statement not processed correctly');
    }

    logger.info('WebGL', 'Final color codes', { rCode, gCode, bCode });

    // Generate texture uniform declarations
    const textureUniforms = [];
    for (const [instName, textureInfo] of this.textures) {
      textureUniforms.push(`uniform sampler2D ${textureInfo.uniformName};`);
    }

    // Generate parameter uniform declarations
    const parameterUniforms = [];
    if (this.env.parameters) {
      for (const [paramName, paramStrand] of this.env.parameters) {
        parameterUniforms.push(`uniform float u_param_${paramName};`);
      }
    }

    console.log('🔥 About to return fragment shader with', {
      glslCodeLines: glslCode.length,
      textureUniforms: textureUniforms.length,
      parameterUniforms: parameterUniforms.length,
      spindleFunctions: spindleFunctions.length,
      rCode, gCode, bCode
    });

    return `
      precision highp float;

      uniform vec2 u_resolution;
      uniform float u_time;
      uniform float u_frame;
      uniform float u_abstime;
      uniform float u_absframe;
      uniform float u_fps;
      uniform float u_loop;
      uniform float u_bpm;
      uniform float u_timesig_num;
      uniform float u_timesig_den;
      uniform float u_beat;
      uniform float u_measure;
      uniform vec2 u_mouse;
      ${textureUniforms.join('\n      ')}
      ${parameterUniforms.join('\n      ')}

      varying vec2 v_texCoord;

      // Fast noise function for GPU
      float hash(vec3 p) {
        p = fract(p * vec3(443.8975, 397.2973, 491.1871));
        p += dot(p, p.yxz + 19.19);
        return fract((p.x + p.y) * p.z);
      }

      float noise3(float x, float y, float t) {
        vec3 i = floor(vec3(x, y, t));
        vec3 f = fract(vec3(x, y, t));
        f = f * f * (3.0 - 2.0 * f);

        float n000 = hash(i);
        float n100 = hash(i + vec3(1.0, 0.0, 0.0));
        float n010 = hash(i + vec3(0.0, 1.0, 0.0));
        float n110 = hash(i + vec3(1.0, 1.0, 0.0));
        float n001 = hash(i + vec3(0.0, 0.0, 1.0));
        float n101 = hash(i + vec3(1.0, 0.0, 1.0));
        float n011 = hash(i + vec3(0.0, 1.0, 1.0));
        float n111 = hash(i + vec3(1.0, 1.0, 1.0));

        float x00 = mix(n000, n100, f.x);
        float x10 = mix(n010, n110, f.x);
        float x01 = mix(n001, n101, f.x);
        float x11 = mix(n011, n111, f.x);

        float y0 = mix(x00, x10, f.y);
        float y1 = mix(x01, x11, f.y);

        return mix(y0, y1, f.z);
      }

      // User-defined spindle functions
      ${spindleFunctions.join('\n      ')}

      void main() {
        vec2 uv = v_texCoord;

        // Computed variables and instances
${glslCode.join('\n')}

        // Final color calculation
        float r = ${rCode};
        float g = ${gCode};
        float b = ${bCode};

        // Debug: Ensure we have valid colors (GLSL doesn't have isnan)
        // Use a simple check instead
        if (r != r) r = 1.0;  // NaN check: NaN != NaN is true
        if (g != g) g = 0.0;
        if (b != b) b = 1.0;  // Magenta for debugging

        gl_FragColor = vec4(
          clamp(r, 0.0, 1.0),
          clamp(g, 0.0, 1.0),
          clamp(b, 0.0, 1.0),
          1.0
        );
      }
    `;
  }

  // Check if a spindle definition can be compiled to GLSL
  canCompileSpindleToGLSL(spindleDef) {
    if (!spindleDef || !spindleDef.body || !spindleDef.body.body) {
      console.log(`Spindle ${spindleDef?.name || 'unknown'} failed basic checks:`, {
        hasSpindleDef: !!spindleDef,
        hasBody: !!(spindleDef && spindleDef.body),
        hasBodyBody: !!(spindleDef && spindleDef.body && spindleDef.body.body)
      });
      return false;
    }

    console.log(`Checking compilability of spindle '${spindleDef.name}':`, {
      bodyStatements: spindleDef.body.body.map(s => ({ type: s.type, name: s.name }))
    });

    // Check each statement in the spindle body
    for (const stmt of spindleDef.body.body) {
      // Only support Let and Assign statements for now
      if (stmt.type !== 'Let' && stmt.type !== 'Assign') {
        console.log(`Spindle '${spindleDef.name}' contains unsupported statement type: ${stmt.type}`);
        return false;
      }

      // Check if the expression can be compiled to GLSL
      if (!this.canCompileExpressionToGLSL(stmt.expr)) {
        console.log(`Spindle '${spindleDef.name}' contains non-compilable expression in statement:`, stmt);
        return false;
      }
    }

    console.log(`Spindle '${spindleDef.name}' is compilable to GLSL!`);
    return true;
  }

  // Check if an expression can be compiled to GLSL
  canCompileExpressionToGLSL(expr) {
    if (!expr) return false;

    switch (expr.type) {
      case 'Num':
      case 'Me':
      case 'Mouse':
        return true;

      case 'Var':
        // Variables are OK if they refer to parameters or local variables
        return true;

      case 'Unary':
        return this.canCompileExpressionToGLSL(expr.expr);

      case 'Bin':
        return this.canCompileExpressionToGLSL(expr.left) &&
               this.canCompileExpressionToGLSL(expr.right);

      case 'If':
        return this.canCompileExpressionToGLSL(expr.condition) &&
               this.canCompileExpressionToGLSL(expr.thenExpr) &&
               this.canCompileExpressionToGLSL(expr.elseExpr);

      case 'Call':
        // Only allow built-in mathematical functions
        const supportedFunctions = [
          'sin', 'cos', 'tan', 'sqrt', 'abs', 'exp', 'log',
          'min', 'max', 'floor', 'ceil', 'round', 'atan2',
          'clamp', 'length', 'distance', 'normalize', 'noise',
          'mix', 'lerp', 'smoothstep', 'step', 'fract', 'sign', 'pow', 'mod',
          'degrees', 'radians', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
          'inverse', 'invert', 'threshold', 'saturate', 'reflect', 'refract',
          'dot', 'cross'
        ];
        if (!supportedFunctions.includes(expr.name)) {
          return false;
        }
        return expr.args.every(arg => this.canCompileExpressionToGLSL(arg));

      case 'StrandAccess':
        // Strand access is not supported in GLSL functions
        return false;

      default:
        return false;
    }
  }

  // Generate GLSL function code for a user-defined spindle
  generateSpindleGLSL(spindleDef, paramMap = {}) {
    const functionName = `spindle_${spindleDef.name}`;
    let params = Array.isArray(spindleDef.params) ? spindleDef.params : [];
    const outputs = spindleDef.outs;

    // Flatten params if they're nested (common parsing issue)
    if (params.length === 1 && Array.isArray(params[0])) {
      params = params[0];
    }

    // Use only the declared parameters (user will pass coordinates explicitly)
    const allParams = [...params];

    // Generate parameter list - ensure all parameters are declared as float
    const glslParams = allParams.map(param => `float ${param}`).join(', ');

    // For single output, return float; for multiple outputs, we'll use separate functions
    if (outputs.length === 1) {
      const outputVar = outputs[0];
      let functionBody = '';
      let outputAssigned = false;

      // Create parameter mapping for this function
      const localParamMap = {
        ...paramMap
      };
      for (const param of params) {
        localParamMap[param] = param; // Parameters map to themselves in GLSL
      }


      // Process each statement in the body
      for (const stmt of spindleDef.body.body) {
        if (stmt.type === 'Let') {
          // Local variable declaration
          const glslExpr = this.compileToGLSL(stmt.expr, this.env, {}, localParamMap);
          functionBody += `    float ${stmt.name} = ${glslExpr};\n`;
          localParamMap[stmt.name] = stmt.name; // Add to local scope
        } else if (stmt.type === 'Assign' && stmt.name === outputVar) {
          // Assignment to output variable
          const glslExpr = this.compileToGLSL(stmt.expr, this.env, {}, localParamMap);
          if (stmt.op === '=') {
            functionBody += `    return ${glslExpr};\n`;
            outputAssigned = true;
          } else {
            // For compound assignments, we need a temporary variable
            functionBody += `    float ${outputVar} = 0.0;\n`;
            const rhs = this.compileToGLSL(stmt.expr, this.env, {}, localParamMap);
            if (stmt.op === '+=') functionBody += `    ${outputVar} += ${rhs};\n`;
            else if (stmt.op === '-=') functionBody += `    ${outputVar} -= ${rhs};\n`;
            else if (stmt.op === '*=') functionBody += `    ${outputVar} *= ${rhs};\n`;
            else if (stmt.op === '/=') functionBody += `    ${outputVar} /= max(${rhs}, 0.000001);\n`;
            functionBody += `    return ${outputVar};\n`;
            outputAssigned = true;
          }
        }
      }

      if (!outputAssigned) {
        functionBody += `    return 0.0;\n`;
      }

      return `float ${functionName}(${glslParams}) {\n${functionBody}}`;
    } else {
      // Multiple outputs - generate separate functions for each output
      const functions = [];
      for (let i = 0; i < outputs.length; i++) {
        const outputVar = outputs[i];
        const outputFunctionName = `${functionName}_${outputVar}`;
        let functionBody = '';
        let outputAssigned = false;

        // Process statements, tracking local variables and parameters
        const localParamMap = { ...paramMap };
        for (const param of params) {
          localParamMap[param] = param; // Parameters map to themselves in GLSL
        }

        for (const stmt of spindleDef.body.body) {
          if (stmt.type === 'Let') {
            const glslExpr = this.compileToGLSL(stmt.expr, this.env, {}, localParamMap);
            functionBody += `    float ${stmt.name} = ${glslExpr};\n`;
            localParamMap[stmt.name] = stmt.name;
          } else if (stmt.type === 'Assign' && stmt.name === outputVar) {
            const glslExpr = this.compileToGLSL(stmt.expr, this.env, {}, localParamMap);
            if (stmt.op === '=') {
              functionBody += `    return ${glslExpr};\n`;
              outputAssigned = true;
            } else {
              functionBody += `    float ${outputVar} = 0.0;\n`;
              const rhs = this.compileToGLSL(stmt.expr, this.env, {}, localParamMap);
              if (stmt.op === '+=') functionBody += `    ${outputVar} += ${rhs};\n`;
              else if (stmt.op === '-=') functionBody += `    ${outputVar} -= ${rhs};\n`;
              else if (stmt.op === '*=') functionBody += `    ${outputVar} *= ${rhs};\n`;
              else if (stmt.op === '/=') functionBody += `    ${outputVar} /= max(${rhs}, 0.000001);\n`;
              functionBody += `    return ${outputVar};\n`;
              outputAssigned = true;
            }
          }
        }

        if (!outputAssigned) {
          functionBody += `    return 0.0;\n`;
        }

        functions.push(`float ${outputFunctionName}(${glslParams}) {\n${functionBody}}`);
      }
      return functions.join('\n\n');
    }
  }

  // Compile a user-defined spindle to GLSL function calls
  compileUserSpindleToGLSL(stmt, spindleDef, glslCode, instanceOutputs) {
    const spindleName = stmt.callee;
    const args = stmt.args;
    const outputs = spindleDef.outs;

    logger.info('WebGL', `Compiling user-defined spindle '${spindleName}' to GLSL`);

    // Compile arguments to GLSL
    const compiledArgs = args.map(arg => this.compileToGLSL(arg, this.env, instanceOutputs, {}));

    // Generate output variables using function calls
    if (outputs.length === 1) {
      // Single output - direct function call
      const functionName = `spindle_${spindleName}`;

      for (const output of stmt.outs) {
        const outName = typeof output === 'string' ? output : (output.name || output.alias);
        const varName = `${stmt.inst}_${outName}`;
        const functionCall = `${functionName}(${compiledArgs.join(', ')})`;

        glslCode.push(`  float ${varName} = ${functionCall};`);
        instanceOutputs[`${stmt.inst}@${outName}`] = varName;

        logger.debug('WebGL', `User spindle output: ${varName} = ${functionCall}`);
      }
    } else {
      // Multiple outputs - separate function calls for each output
      for (let i = 0; i < stmt.outs.length && i < outputs.length; i++) {
        const output = stmt.outs[i];
        const outName = typeof output === 'string' ? output : (output.name || output.alias);
        const spindleOutput = outputs[i];
        const varName = `${stmt.inst}_${outName}`;
        const functionName = `spindle_${spindleName}_${spindleOutput}`;
        const functionCall = `${functionName}(${compiledArgs.join(', ')})`;

        glslCode.push(`  float ${varName} = ${functionCall};`);
        instanceOutputs[`${stmt.inst}@${outName}`] = varName;

        logger.debug('WebGL', `User spindle output: ${varName} = ${functionCall}`);
      }
    }

    return true;
  }

  // Compile specific spindles to GLSL when possible
  compileSpindleToGLSL(stmt, glslCode, instanceOutputs) {
    const spindleName = stmt.callee;
    const args = stmt.args;

    console.log(`=== Attempting to compile spindle: ${spindleName} ===`);

    // Check if this is a user-defined spindle that can be compiled to GLSL
    const spindleDef = this.env.spindles.get(spindleName);
    console.log(`Looking up user spindle '${spindleName}':`, {
      found: !!spindleDef,
      availableSpindles: Array.from(this.env.spindles.keys())
    });

    if (spindleDef && this.canCompileSpindleToGLSL(spindleDef)) {
      logger.info('WebGL', `Compiling user-defined spindle '${spindleName}' to GLSL`);
      return this.compileUserSpindleToGLSL(stmt, spindleDef, glslCode, instanceOutputs);
    }

    // Handle known built-in spindles that can be compiled to GLSL
    if (spindleName === 'circle') {
      // circle(x, y, cx, cy, radius)
      if (args.length >= 5) {
        const x = this.compileToGLSL(args[0], this.env, instanceOutputs, {});
        const y = this.compileToGLSL(args[1], this.env, instanceOutputs, {});
        const cx = this.compileToGLSL(args[2], this.env, instanceOutputs, {});
        const cy = this.compileToGLSL(args[3], this.env, instanceOutputs, {});
        const rad = this.compileToGLSL(args[4], this.env, instanceOutputs, {});

        for (const output of stmt.outs) {
          const outName = typeof output === 'string' ? output : (output.name || output.alias);
          const varName = `${stmt.inst}_${outName}`;
          glslCode.push(`  float dist_${varName} = distance(vec2(${x}, ${y}), vec2(${cx}, ${cy}));`);
          glslCode.push(`  float ${varName} = (dist_${varName} < ${rad}) ? 1.0 : 0.0;`);
          instanceOutputs[`${stmt.inst}@${outName}`] = varName;
          logger.debug('WebGL', `Compiled circle output: ${varName}`);
        }
        return true;
      }
    }

    else if (spindleName === 'threshold') {
      // threshold(i, level)
      if (args.length >= 2) {
        const input = this.compileToGLSL(args[0], this.env, instanceOutputs, {});
        const level = this.compileToGLSL(args[1], this.env, instanceOutputs, {});

        for (const output of stmt.outs) {
          const outName = typeof output === 'string' ? output : (output.name || output.alias);
          const varName = `${stmt.inst}_${outName}`;
          glslCode.push(`  float ${varName} = (${input} > ${level}) ? 0.0 : 1.0;`);
          instanceOutputs[`${stmt.inst}@${outName}`] = varName;
          logger.debug('WebGL', `Compiled threshold output: ${varName}`);
        }
        return true;
      }
    }

    else if (spindleName === 'mask') {
      // mask(mask, i)
      if (args.length >= 2) {
        const mask = this.compileToGLSL(args[0], this.env, instanceOutputs, {});
        const input = this.compileToGLSL(args[1], this.env, instanceOutputs);

        for (const output of stmt.outs) {
          const outName = typeof output === 'string' ? output : (output.name || output.alias);
          const varName = `${stmt.inst}_${outName}`;
          glslCode.push(`  float ${varName} = (${mask} == 0.0) ? 0.0 : ${input};`);
          instanceOutputs[`${stmt.inst}@${outName}`] = varName;
          logger.debug('WebGL', `Compiled mask output: ${varName}`);
        }
        return true;
      }
    }

    else if (spindleName === 'recolor') {
      // recolor(i, target, new)
      if (args.length >= 3) {
        const input = this.compileToGLSL(args[0], this.env, instanceOutputs, {});
        const target = this.compileToGLSL(args[1], this.env, instanceOutputs, {});
        const newVal = this.compileToGLSL(args[2], this.env, instanceOutputs, {});

        for (const output of stmt.outs) {
          const outName = typeof output === 'string' ? output : (output.name || output.alias);
          const varName = `${stmt.inst}_${outName}`;
          glslCode.push(`  float ${varName} = (${input} == ${target}) ? ${newVal} : ${input};`);
          instanceOutputs[`${stmt.inst}@${outName}`] = varName;
          logger.debug('WebGL', `Compiled recolor output: ${varName}`);
        }
        return true;
      }
    }

    else if (spindleName === 'compose') {
      // compose(r, g, b) or any number of args
      for (let i = 0; i < stmt.outs.length && i < args.length; i++) {
        const output = stmt.outs[i];
        const outName = typeof output === 'string' ? output : (output.name || output.alias);
        const varName = `${stmt.inst}_${outName}`;
        const argGLSL = this.compileToGLSL(args[i], this.env, instanceOutputs, {});
        glslCode.push(`  float ${varName} = ${argGLSL};`);
        instanceOutputs[`${stmt.inst}@${outName}`] = varName;
        logger.debug('WebGL', `Compiled compose output: ${varName} = ${argGLSL}`);
      }
      return true;
    }

    else if (spindleName === 'noise') {
      // noise(x, y, t, ...)
      const x = args[0] ? this.compileToGLSL(args[0], this.env, instanceOutputs, {}) : 'uv.x';
      const y = args[1] ? this.compileToGLSL(args[1], this.env, instanceOutputs, {}) : 'uv.y';
      const t = args[2] ? this.compileToGLSL(args[2], this.env, instanceOutputs, {}) : 'u_time';

      for (const output of stmt.outs) {
        const outName = typeof output === 'string' ? output : (output.name || output.alias);
        const varName = `${stmt.inst}_${outName}`;
        glslCode.push(`  float ${varName} = noise3(${x} * 3.1, ${y} * 3.1, ${t} * 0.5);`);
        instanceOutputs[`${stmt.inst}@${outName}`] = varName;
        logger.debug('WebGL', `Compiled noise output: ${varName}`);
      }
      return true;
    }

    // If we can't compile this spindle to GLSL, log it but don't error
    logger.warn('WebGL', `Cannot compile spindle '${spindleName}' to GLSL - will fallback to CPU`);
    return false;
  }

  // Duplicate method removed - use async compile(ast) instead

  render() {
    if (!this.program) return;

    const gl = this.gl;
    const env = this.env;

    // Update canvas size to match WEFT resolution
    const width = env.resW;
    const height = env.resH;

    // Resize canvas if needed
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      console.log(`WebGL canvas resized to: ${width}x${height}`);
    }

    gl.viewport(0, 0, width, height);

    // Set uniforms
    gl.uniform2f(this.uniforms.resolution, width, height);

    // Time uniforms
    const absTime = (Date.now() - env.startTime) / 1000;
    const beatsPerSecond = env.bpm / 60;
    gl.uniform1f(this.uniforms.time, (env.frame % env.loop) / env.targetFps);
    gl.uniform1f(this.uniforms.frame, env.frame % env.loop);
    gl.uniform1f(this.uniforms.abstime, absTime);
    gl.uniform1f(this.uniforms.absframe, env.frame);
    gl.uniform1f(this.uniforms.fps, env.targetFps);
    gl.uniform1f(this.uniforms.loop, env.loop);
    gl.uniform1f(this.uniforms.bpm, env.bpm);
    gl.uniform1f(this.uniforms.timesig_num, env.timesig_num);
    gl.uniform1f(this.uniforms.timesig_den, env.timesig_den);
    gl.uniform1f(this.uniforms.beat, Math.floor(absTime * beatsPerSecond) % env.timesig_num);
    gl.uniform1f(this.uniforms.measure, Math.floor(absTime * beatsPerSecond / env.timesig_num));

    gl.uniform2f(this.uniforms.mouse, env.mouse.x, env.mouse.y);

    // Set parameter uniforms
    if (env.parameters) {
      for (const [paramName, paramStrand] of env.parameters) {
        const uniformName = `u_param_${paramName}`;
        if (this.uniforms[uniformName]) {
          gl.uniform1f(this.uniforms[uniformName], paramStrand.value);
          // Only log for 'l' parameter to avoid spam
          if (paramName === 'l') {
            console.log(`🎮 WebGL: Set uniform ${uniformName} = ${paramStrand.value}`);
          }
        }
      }
    }

    // Clear and draw
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    env.frame++;
  }

  start() {
    this.running = true;
    this.compile();
    this.loop();
  }

  stop() {
    this.running = false;
  }

  loop() {
    if (!this.running) return;

    const now = performance.now();
    const targetFrameTime = 1000 / this.env.targetFps; // ms per frame
    const deltaTime = now - this.lastFrameTime;

    // Debug: Log FPS changes
    if (this.lastTargetFps !== this.env.targetFps) {
      console.log(`🎬 WebGL Renderer: Target FPS changed from ${this.lastTargetFps} to ${this.env.targetFps}`);
      this.lastTargetFps = this.env.targetFps;
    }

    this.frameTimeAccumulator += deltaTime;

    // Only render if enough time has accumulated for the target frame rate
    if (this.frameTimeAccumulator >= targetFrameTime) {
      this.render();

      // Update FPS counter
      this.frames++;
      if (now - this.lastTime > 500) {
        this.fps = Math.round(this.frames * 1000 / (now - this.lastTime));
        document.getElementById('fpsPill').textContent = `FPS: ${this.fps}`;
        document.getElementById('perfPill').textContent = `GPU Accelerated`;
        this.frames = 0;
        this.lastTime = now;
      }

      // Subtract one frame time but keep any remainder to prevent drift
      this.frameTimeAccumulator -= targetFrameTime;
    }

    this.lastFrameTime = now;
    requestAnimationFrame(() => this.loop());
  }

  /**
   * Compile StrandRemap Direct statement
   * @param {Object} stmt - Direct statement with StrandRemap expression
   * @param {Array} glslCode - GLSL code array to append to
   * @param {Object} instanceOutputs - Available instance outputs
   * @param {Object} globalScope - Global scope for variables
   */
  compileStrandRemapDirect(stmt, glslCode, instanceOutputs, globalScope) {
    const remapExpr = stmt.expr;
    const baseName = remapExpr.base?.name || remapExpr.base;
    const strandName = remapExpr.strand?.name || remapExpr.strand;
    const baseKey = `${baseName}@${strandName}`;

    logger.debug('WebGL', `Processing StrandRemap Direct: ${stmt.name} from ${baseKey}`);

    // Compile coordinate expressions
    const coords = remapExpr.coordinates.map(coord => this.compileToGLSL(coord, this.env, instanceOutputs, globalScope));

    for (let i = 0; i < stmt.outs.length; i++) {
      const outputName = stmt.outs[i];
      const varName = `${stmt.name}_${outputName}`;

      // Check if source is a texture
      const textureInfo = this.textures.get(baseName);
      if (textureInfo) {
        // Generate texture sampling with remapped coordinates
        const remappedX = coords[0] || 'uv.x';
        const remappedY = coords[1] || 'uv.y';

        // Map output to texture component
        let component = '.r';
        if (strandName === 'r' || strandName === 'red') component = '.r';
        else if (strandName === 'g' || strandName === 'green') component = '.g';
        else if (strandName === 'b' || strandName === 'blue') component = '.b';
        else if (strandName === 'a' || strandName === 'alpha') component = '.a';

        // Smart coordinate normalization for texture sampling
        const normalizedX = this.normalizeTextureCoordinate(remappedX);
        const normalizedY = this.normalizeTextureCoordinate(remappedY);
        glslCode.push(`  float ${varName} = texture2D(${textureInfo.uniformName}, vec2(${normalizedX}, ${normalizedY}))${component};`);
        logger.debug('WebGL', `StrandRemap texture: ${varName} = texture2D(..., vec2(${remappedX}, ${remappedY}))${component}`);
      } else {
        // Check if source is already a computed variable
        const sourceVar = instanceOutputs[baseKey];
        if (sourceVar) {
          // For computed variables, we can't easily remap coordinates in GLSL
          // Fall back to using the source directly for now
          glslCode.push(`  float ${varName} = ${sourceVar};`);
          logger.warn('WebGL', `StrandRemap fallback for computed variable: ${varName} = ${sourceVar}`);
        } else {
          // No source found, use default
          glslCode.push(`  float ${varName} = 0.0;`);
          logger.warn('WebGL', `StrandRemap source not found: ${baseKey}, defaulting to 0.0`);
        }
      }

      instanceOutputs[`${stmt.name}@${outputName}`] = varName;
      globalScope[varName] = varName;
      if (stmt.outs.length === 1) {
        instanceOutputs[stmt.name] = varName; // Also allow direct access
      }
    }
  }

  /**
   * Compile StrandRemap expression to GLSL
   * @param {Object} node - StrandRemap AST node
   * @param {Object} env - Environment
   * @param {Object} instanceOutputs - Available instance outputs
   * @param {Object} localScope - Local scope for variables
   * @returns {string} GLSL code for strand remapping
   */
  compileStrandRemapToGLSL(node, env, instanceOutputs, localScope) {
    const baseName = node.base?.name || node.base;
    const strandName = node.strand?.name || node.strand;
    const baseKey = `${baseName}@${strandName}`;

    // Compile coordinate expressions
    const coords = node.coordinates.map(coord => this.compileToGLSL(coord, env, instanceOutputs, localScope));
    const remappedX = coords[0] || 'v_texCoord.x';
    const remappedY = coords[1] || 'v_texCoord.y';

    // First check if source is a texture
    const textureInfo = this.textures.get(baseName);
    if (textureInfo) {
      // Map strand name to texture component
      let component = '.r';
      if (strandName === 'r' || strandName === 'red') component = '.r';
      else if (strandName === 'g' || strandName === 'green') component = '.g';
      else if (strandName === 'b' || strandName === 'blue') component = '.b';
      else if (strandName === 'a' || strandName === 'alpha') component = '.a';

      // Smart coordinate normalization for texture sampling
      const normalizedX = this.normalizeTextureCoordinate(remappedX);
      const normalizedY = this.normalizeTextureCoordinate(remappedY);
      return `texture2D(${textureInfo.uniformName}, vec2(${normalizedX}, ${normalizedY}))${component}`;
    }

    // Check for computed source variable
    const sourceVar = instanceOutputs[baseKey];
    if (sourceVar) {
      // Check if the source is already a texture sample
      if (typeof sourceVar === 'string' && sourceVar.includes('texture2D')) {
        // Replace v_texCoord with our remapped coordinates
        return sourceVar.replace(/v_texCoord/g, `vec2(${remappedX}, ${remappedY})`);
      } else {
        // For computed variables, coordinate remapping in GLSL is complex
        logger.warn('WebGL', `Complex strand remapping for computed variable: ${baseKey}`);
        return sourceVar;
      }
    }

    logger.warn('WebGL', `Source strand not found for remapping: ${baseKey}`);
    return '0.0';
  }
}
export { WebGLRenderer };