// Full-featured WebGL Backend adapted from original webgl-renderer.js
import { BaseBackend } from './base-backend.js';
import { match, inst, _ } from '../utils/match.js';
import {
  NumExpr, StrExpr, MeExpr, MouseExpr,
  BinaryExpr, UnaryExpr, IfExpr, CallExpr,
  StrandAccessExpr, StrandRemapExpr, VarExpr,
  TupleExpr, IndexExpr
} from '../ast/ast-node.js';

export class WebGLBackend extends BaseBackend {
  constructor(env, name, context) {
    super(env, name, context);

    this.canvas = env.canvas;
    this.gl = null;
    this.program = null;
    this.uniforms = {};
    this.textures = new Map();
    this.textureCounter = 0;
    this.maxTextureUnits = 8;
    this.availableTextureUnits = [];
    this.vertexBuffer = null;

    // For shader generation
    this.displayStatement = null;
    this.currentAST = null;
  }

  // ===== BaseBackend Methods =====

  async compile(ast) {
    try {
      // Initialize WebGL if needed
      if (!this.gl) {
        if (!this.initWebGL()) {
          throw new Error('Failed to initialize WebGL context');
        }
        this.setupQuadGeometry();
      }

      // Find display statements
      const displayStmts = this.filterStatements(ast, 'DisplayStmt', 'RenderStmt');

      if (displayStmts.length === 0) {
        this.warn('No display statements found');
        return false;
      }

      // Store for shader generation
      this.displayStatement = displayStmts[0];
      this.currentAST = ast;

      // Generate and compile shaders
      const success = this.compileShaders();
      if (!success) {
        throw new Error('Shader compilation failed');
      }

      this.log('Compilation successful');

      // Store compiled shader for viewing
      this.compiledShader = this.getCompiledShader();

      return true;

    } catch (error) {
      this.error('WebGL compilation failed:', error);
      return false;
    }
  }

  getCompiledCode() {
    // Override BaseBackend method
    if (!this.lastCompiledFragmentShader) {
      return '// No fragment shader compiled yet';
    }
    return `// Fragment Shader (GLSL)\n\n${this.lastCompiledFragmentShader}`;
  }

  // Deprecated - kept for compatibility
  getCompiledShader() {
    return this.getCompiledCode();
  }

  render() {
    if (!this.program) {
      this.warn('No shader program available for rendering');
      return;
    }

    this.updateVideoTextures();
    this.updateUniforms();
    this.drawFrame();
  }

  cleanup() {
    if (this.program) {
      this.gl.deleteProgram(this.program);
      this.program = null;
    }
    if (this.vertexBuffer) {
      this.gl.deleteBuffer(this.vertexBuffer);
      this.vertexBuffer = null;
    }
    // Cleanup textures and videos
    for (const [, textureInfo] of this.textures) {
      if (textureInfo.texture) {
        this.gl.deleteTexture(textureInfo.texture);
      }
      if (textureInfo.isVideo && textureInfo.videoElement) {
        textureInfo.videoElement.pause();
        textureInfo.videoElement.src = '';
        textureInfo.videoElement.load();
      }
    }
    this.textures.clear();
    this.log('WebGL renderer cleanup complete');
  }

  canGetValue() {
    return false; // WebGL can't efficiently read back pixels
  }

  // ===== WebGL Setup =====

  initWebGL() {
    // Try to get WebGL context
    this.gl = this.canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ||
              this.canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!this.gl) {
      this.error('WebGL not supported');
      return false;
    }

    // Check WebGL limits
    const maxTextureUnits = this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS);
    this.maxTextureUnits = Math.min(maxTextureUnits, 8); // Conservative limit

    // Initialize available texture units pool
    this.availableTextureUnits = [];
    for (let i = 0; i < this.maxTextureUnits; i++) {
      this.availableTextureUnits.push(i);
    }

    this.log('WebGL context initialized successfully');
    return true;
  }

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

    let fragmentShader;
    try {
      fragmentShader = this.generateFragmentShader();
    } catch (error) {
      this.error('Fragment shader generation failed:', error);
      return false;
    }

    if (!fragmentShader) {
      this.error('Fragment shader generation returned null');
      return false;
    }

    // Store for viewing
    this.lastCompiledFragmentShader = fragmentShader;

    this.program = this.createProgram(vertexShader, fragmentShader);
    if (!this.program) {
      return false;
    }

    this.setupProgram();
    return true;
  }

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


  updateVideoTextures() {
    const gl = this.gl;

    for (const [, textureInfo] of this.textures) {
      if (textureInfo.isVideo && textureInfo.videoElement) {
        const video = textureInfo.videoElement;

        // Only update if video has new frame data
        if (video.readyState >= video.HAVE_CURRENT_DATA) {
          gl.activeTexture(gl.TEXTURE0 + textureInfo.unit);
          gl.bindTexture(gl.TEXTURE_2D, textureInfo.texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        }
      }
    }
  }

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
    gl.uniform1f(this.uniforms.timesig_den, env.timesig_denom);
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

  drawFrame() {
    const gl = this.gl;

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this.env.frame++;
  }

  // ===== Shader Generation =====

  generateFragmentShader() {

    if (!this.displayStatement || !this.currentAST) {
      this.error('No display statement or AST available');
      return null;
    }

    const program = this.currentAST;
    this.log(`Generating shader for display statement with ${program.statements.length} total statements`);

    const instanceOutputs = {};
    const glslCode = [];
    const spindleFunctions = [];

    // Generate GLSL functions for user-defined spindles
    try {
      for (const [spindleName, spindleDef] of this.env.spindles) {
        if (this.canCompileSpindleToGLSL(spindleDef)) {
          this.log(`Generating GLSL function for spindle: ${spindleName}`);
          const glslFunction = this.generateSpindleGLSL(spindleDef);
          spindleFunctions.push(glslFunction);
        } else {
          this.log(`Spindle '${spindleName}' cannot be compiled to GLSL`);
        }
      }
    } catch (error) {
      this.error('Error in spindle processing:', error);
      throw error;
    }

    // Process all statements in dependency order
    const globalScope = {};

    // Get the render graph from coordinator to use execution order
    const graph = this.coordinator?.graph;

    try {
      if (graph && graph.execOrder && graph.execOrder.length > 0) {
        // Process in execution order from the graph
        for (const instanceName of graph.execOrder) {
          // Find ALL statements that define this instance (could be multiple outputs)
          const stmts = program.statements.filter(s =>
            s.type === 'InstanceBinding' && s.name === instanceName
          );
          for (const stmt of stmts) {
            this.processStatement(stmt, glslCode, instanceOutputs, globalScope);
          }
        }

        // Process any remaining statements (like DisplayStmt, RenderStmt)
        for (const stmt of program.statements) {
          if (stmt.type !== 'InstanceBinding') {
            this.processStatement(stmt, glslCode, instanceOutputs, globalScope);
          }
        }
      } else {
        // Fallback: process in source order if no graph available
        for (const stmt of program.statements) {
          this.processStatement(stmt, glslCode, instanceOutputs, globalScope);
        }
      }
    } catch (error) {
      this.error('Error in statement processing:', error);
      throw error;
    }

    // Compile render/display statement
    let rCode = '0.0', gCode = '0.0', bCode = '0.0';

    // Handle named arguments in render statements
    if (this.displayStatement.type === 'RenderStmt' && this.displayStatement.namedArgs && this.displayStatement.namedArgs.size > 0) {
      const namedArgs = this.displayStatement.namedArgs;
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
      this.log('Using render statement with named arguments');
    } else if (this.displayStatement.args && this.displayStatement.args.length === 1) {
      // Single argument - try to get first 3 outputs from the instance
      const arg = this.displayStatement.args[0];
      if (arg.type === 'Var') {
        const instName = arg.name;
        const availableOutputs = Object.keys(instanceOutputs).filter(key => key.startsWith(instName + '@'));

        if (availableOutputs.length >= 3) {
          // Use first 3 outputs for RGB
          const [r, g, b] = availableOutputs.slice(0, 3);
          rCode = instanceOutputs[r] || '0.0';
          gCode = instanceOutputs[g] || '0.0';
          bCode = instanceOutputs[b] || '0.0';
        } else if (availableOutputs.length === 1) {
          // Single output - use as grayscale
          const singleOut = instanceOutputs[availableOutputs[0]];
          rCode = gCode = bCode = singleOut;
        }
      }
    } else if (this.displayStatement.args && this.displayStatement.args.length >= 3) {
      rCode = this.compileToGLSL(this.displayStatement.args[0], this.env, instanceOutputs, globalScope);
      gCode = this.compileToGLSL(this.displayStatement.args[1], this.env, instanceOutputs, globalScope);
      bCode = this.compileToGLSL(this.displayStatement.args[2], this.env, instanceOutputs, globalScope);
    }

    // Generate texture uniform declarations
    const textureUniforms = [];
    for (const [, textureInfo] of this.textures) {
      textureUniforms.push(`uniform sampler2D ${textureInfo.uniformName};`);
    }

    // Generate parameter uniform declarations
    const parameterUniforms = [];
    if (this.env.parameters) {
      for (const [paramName] of this.env.parameters) {
        parameterUniforms.push(`uniform float u_param_${paramName};`);
      }
    }

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

        gl_FragColor = vec4(
          clamp(r, 0.0, 1.0),
          clamp(g, 0.0, 1.0),
          clamp(b, 0.0, 1.0),
          1.0
        );
      }
    `;
  }

  processStatement(stmt, glslCode, instanceOutputs, globalScope) {
    // Skip environment parameter updates
    if (stmt.type === 'Direct' && stmt.name === 'me') {
      this.log('Skipping me parameter update in shader');
      return;
    }

    // Handle InstanceBinding with load() - map outputs positionally to RGBA
    if (stmt.type === 'InstanceBinding' && stmt.expr && stmt.expr.type === 'Call' && stmt.expr.name === 'load') {
      const imagePath = stmt.expr.args[0] && stmt.expr.args[0].type === 'Str' ? stmt.expr.args[0].v : null;
      if (imagePath) {
        const textureInfo = this.loadTexture(imagePath, stmt.name);
        if (!textureInfo) {
          this.warn(`Failed to load texture, skipping: ${stmt.name}`);
          return;
        }

        // Map outputs positionally: first output -> .r, second -> .g, third -> .b, fourth -> .a
        const components = ['.r', '.g', '.b', '.a'];
        for (let i = 0; i < stmt.outputs.length; i++) {
          const outputName = stmt.outputs[i];
          const varName = `${stmt.name}_${outputName}`;
          const component = components[Math.min(i, 3)];

          glslCode.push(`        float ${varName} = texture2D(${textureInfo.uniformName}, v_texCoord)${component};`);
          instanceOutputs[`${stmt.name}@${outputName}`] = varName;
          globalScope[varName] = varName;
        }
      }
      return;
    }

    // Handle InstanceBinding with StrandRemapExpr
    if (stmt.type === 'InstanceBinding' && stmt.expr && stmt.expr.type === 'StrandRemap') {
      for (const outputName of stmt.outputs) {
        const varName = `${stmt.name}_${outputName}`;
        const glslExpr = this.compileToGLSL(stmt.expr, this.env, instanceOutputs, globalScope);

        glslCode.push(`        float ${varName} = ${glslExpr};`);
        instanceOutputs[`${stmt.name}@${outputName}`] = varName;
        globalScope[varName] = varName;
      }
      return;
    }

    // Handle general InstanceBinding (e.g., test<t> = sin(me@abstime))
    if (stmt.type === 'InstanceBinding') {
      for (const outputName of stmt.outputs) {
        const varName = `${stmt.name}_${outputName}`;
        const glslExpr = this.compileToGLSL(stmt.expr, this.env, instanceOutputs, globalScope);

        glslCode.push(`        float ${varName} = ${glslExpr};`);
        instanceOutputs[`${stmt.name}@${outputName}`] = varName;
        globalScope[varName] = varName;
      }
      return;
    }

    // Handle different statement types
    if (stmt.type === 'Let' || stmt.type === 'LetBinding') {
      const varName = stmt.name;
      const glslExpr = this.compileToGLSL(stmt.expr, this.env, instanceOutputs, globalScope);
      glslCode.push(`        float ${varName} = ${glslExpr};`);
      globalScope[varName] = varName;
      instanceOutputs[varName] = varName;
    }
    else if (stmt.type === 'Assign' || stmt.type === 'Assignment') {
      const varName = stmt.name;
      const op = stmt.op;
      const glslExpr = this.compileToGLSL(stmt.expr, this.env, instanceOutputs, globalScope);

      if (op === '=') {
        if (!globalScope[varName]) {
          glslCode.push(`        float ${varName} = ${glslExpr};`);
          globalScope[varName] = varName;
        } else {
          glslCode.push(`        ${varName} = ${glslExpr};`);
        }
      } else {
        // Compound assignment
        if (!globalScope[varName]) {
          glslCode.push(`        float ${varName} = 0.0;`);
          globalScope[varName] = varName;
        }
        if (op === '+=') glslCode.push(`        ${varName} += ${glslExpr};`);
        else if (op === '-=') glslCode.push(`        ${varName} -= ${glslExpr};`);
        else if (op === '*=') glslCode.push(`        ${varName} *= ${glslExpr};`);
        else if (op === '/=') glslCode.push(`        ${varName} /= max(${glslExpr}, 0.000001);`);
      }
      instanceOutputs[varName] = varName;
    }
    else if (stmt.type === 'Direct') {
      // Special handling for StrandRemap expressions
      if (stmt.expr && stmt.expr.type === 'StrandRemap') {
        this.compileStrandRemapDirect(stmt, glslCode, instanceOutputs, globalScope);
      } else {
        for (let i = 0; i < stmt.outs.length; i++) {
          const outputName = stmt.outs[i];
          const varName = `${stmt.name}_${outputName}`;
          const glslExpr = this.compileToGLSL(stmt.expr, this.env, instanceOutputs, globalScope);

          glslCode.push(`        float ${varName} = ${glslExpr};`);
          instanceOutputs[`${stmt.name}@${outputName}`] = varName;
          globalScope[varName] = varName;

          if (stmt.outs.length === 1) {
            instanceOutputs[stmt.name] = varName; // Allow direct access
          }
        }
      }
    }
    else if (stmt.type === 'CallInstance' && stmt.callee === 'load') {
      // Handle image/media loading
      const imagePath = stmt.args[0] && stmt.args[0].type === 'Str' ? stmt.args[0].v : null;
      if (imagePath) {
        const textureInfo = this.loadTexture(imagePath, stmt.inst);
        if (!textureInfo) {
          this.warn(`Failed to load texture, skipping: ${stmt.inst}`);
          return;
        }

        for (const output of stmt.outs) {
          const outName = typeof output === 'string' ? output : (output.name || output.alias);
          const varName = `${stmt.inst}_${outName}`;

          // Map output names to texture components more flexibly
          let component = '.r'; // default
          if (outName === 'r' || outName === 'red') component = '.r';
          else if (outName === 'g' || outName === 'green') component = '.g';
          else if (outName === 'b' || outName === 'blue') component = '.b';
          else if (outName === 'a' || outName === 'alpha') component = '.a';
          else {
            // For arbitrary names, use position-based mapping
            const outputIndex = stmt.outs.indexOf(output);
            component = ['.r', '.g', '.b', '.a'][Math.min(outputIndex, 3)];
          }

          glslCode.push(`        float ${varName} = texture2D(${textureInfo.uniformName}, v_texCoord)${component};`);
          instanceOutputs[`${stmt.inst}@${outName}`] = varName;
        }
      }
    }
    else if (stmt.type === 'CallInstance' && stmt.callee !== 'load') {
      // Handle general spindle calls
      this.compileSpindleToGLSL(stmt, glslCode, instanceOutputs);
    }
  }

  // ===== GLSL Compilation with match/inst =====

  compileToGLSL(node, env, instanceOutputs = {}, localScope = {}) {
    if (Array.isArray(node)) {
      return node.length === 1 ? this.compileToGLSL(node[0], env, instanceOutputs, localScope) : '0.0';
    }
    const result = match(node,
      inst(NumExpr, _), (v) => v.toString() + (Number.isInteger(v) ? '.0' : ''),

      inst(StrExpr, _), () => '0.0',

      inst(MeExpr, _), (field) => {
        return match(field,
          'x', () => 'v_texCoord.x',
          'y', () => 'v_texCoord.y',
          'time', () => 'u_time',
          'frame', () => 'u_frame',
          'abstime', () => 'u_abstime',
          'absframe', () => 'u_absframe',
          'width', () => 'u_resolution.x',
          'height', () => 'u_resolution.y',
          'fps', () => 'u_fps',
          'loop', () => 'u_loop',
          'bpm', () => 'u_bpm',
          'beat', () => 'u_beat',
          'measure', () => 'u_measure',
          _, () => '0.0'
        );
      },

      inst(MouseExpr, _), (field) => field === 'x' ? 'u_mouse.x' : field === 'y' ? 'u_mouse.y' : '0.0',

      inst(BinaryExpr, _, _, _), (op, left, right) => {
        const leftCode = this.compileToGLSL(left, env, instanceOutputs, localScope);
        const rightCode = this.compileToGLSL(right, env, instanceOutputs, localScope);

        return match(op,
          '+', () => `(${leftCode} + ${rightCode})`,
          '-', () => `(${leftCode} - ${rightCode})`,
          '*', () => `(${leftCode} * ${rightCode})`,
          '/', () => `(${leftCode} / max(${rightCode}, 0.000001))`,
          '^', () => `pow(${leftCode}, ${rightCode})`,
          '%', () => `mod(${leftCode}, ${rightCode})`,
          '==', () => `(${leftCode} == ${rightCode} ? 1.0 : 0.0)`,
          '!=', () => `(${leftCode} != ${rightCode} ? 1.0 : 0.0)`,
          '<<', () => `(${leftCode} < ${rightCode} ? 1.0 : 0.0)`,
          '>>', () => `(${leftCode} > ${rightCode} ? 1.0 : 0.0)`,
          '<=', () => `(${leftCode} <= ${rightCode} ? 1.0 : 0.0)`,
          '>=', () => `(${leftCode} >= ${rightCode} ? 1.0 : 0.0)`,
          'AND', () => `(${leftCode} > 0.0 && ${rightCode} > 0.0 ? 1.0 : 0.0)`,
          'OR', () => `(${leftCode} > 0.0 || ${rightCode} > 0.0 ? 1.0 : 0.0)`,
          _, () => '0.0'
        );
      },

      inst(UnaryExpr, _, _), (op, expr) => {
        const arg = this.compileToGLSL(expr, env, instanceOutputs, localScope);
        return match(op,
          '-', () => `(-${arg})`,
          'NOT', () => `(${arg} > 0.0 ? 0.0 : 1.0)`,
          _, () => {
            const mathFn = this.getMathFunction(op);
            return mathFn ? `${mathFn}(${arg})` : `(-${arg})`;
          }
        );
      },

      inst(IfExpr, _, _, _), (condition, thenExpr, elseExpr) => {
        const cond = this.compileToGLSL(condition, env, instanceOutputs, localScope);
        const thenCode = this.compileToGLSL(thenExpr, env, instanceOutputs, localScope);
        const elseCode = this.compileToGLSL(elseExpr, env, instanceOutputs, localScope);
        return `(${cond} > 0.0 ? ${thenCode} : ${elseCode})`;
      },

      inst(CallExpr, _, _), (name, args) => {
        const argCodes = args.map(arg => this.compileToGLSL(arg, env, instanceOutputs, localScope));
        return this.compileFunctionCall(name, argCodes);
      },

      inst(StrandAccessExpr, _, _), (base, out) => {
        const baseName = base.name;
        const key = `${baseName}@${out}`;
        if (baseName === 'me') {
          return match(out,
            'x', () => 'v_texCoord.x',
            'y', () => 'v_texCoord.y',
            'abstime', () => 'u_abstime',
            'absframe', () => 'u_absframe',
            'time', () => 'u_time',
            'frame', () => 'u_frame',
            'width', () => 'u_resolution.x',
            'height', () => 'u_resolution.y',
            'fps', () => 'u_fps',
            'loop', () => 'u_loop',
            'bpm', () => 'u_bpm',
            'beat', () => 'u_beat',
            'measure', () => 'u_measure',
            _, () => '0.0'
          );
        }
        if (env.instances && env.instances.has(baseName)) {
          const instance = env.instances.get(baseName);
          if (instance.kind === 'instance' && instance.outs && instance.outs[out]) {
            const strand = instance.outs[out];
            if (strand.kind === 'strand' && strand.name) {
              return `u_param_${strand.name}`;
            }
          }
        }

        return instanceOutputs[key] || instanceOutputs[baseName] || '0.0';
      },

      inst(StrandRemapExpr, _, _, _), (base, strand, mappings) => {
        return this.compileStrandRemapToGLSL(node, env, instanceOutputs, localScope);
      },

      inst(VarExpr, _), (name) => {
        return localScope[name] || instanceOutputs[name] || '0.0';
      },

      inst(TupleExpr, _), (items) => {
        if (items.length === 0) return '0.0';
        return this.compileToGLSL(items[0], env, instanceOutputs, localScope);
      },

      inst(IndexExpr, _, _), (base, index) => {
        const baseCode = this.compileToGLSL(base, env, instanceOutputs, localScope);
        const indexCode = this.compileToGLSL(index, env, instanceOutputs, localScope);

        // For vectors, use swizzling
        if (indexCode === '0.0' || indexCode === '0') return `${baseCode}.x`;
        if (indexCode === '1.0' || indexCode === '1') return `${baseCode}.y`;
        if (indexCode === '2.0' || indexCode === '2') return `${baseCode}.z`;
        if (indexCode === '3.0' || indexCode === '3') return `${baseCode}.w`;

        return `${baseCode}.x`;
      },

      _, () => {
        // Fallback to plain object handling
        if (node && typeof node === 'object' && node.type) {
          return this.compileObjectToGLSL(node, env, instanceOutputs, localScope);
        }
        this.warn(`Unhandled node:`, node);
        return '0.0';
      }
    );

    return result;
  }

  compileObjectToGLSL(node, env, instanceOutputs, localScope) {
    const nodeType = node.type;

    switch(nodeType) {
      case 'Num':
        const numValue = node.v;
        return numValue.toString() + (Number.isInteger(numValue) ? '.0' : '');

      case 'Me':
        return match(node.field,
          'x', () => 'v_texCoord.x',
          'y', () => 'v_texCoord.y',
          'time', () => 'u_time',
          'frame', () => 'u_frame',
          'abstime', () => 'u_abstime',
          'absframe', () => 'u_absframe',
          'width', () => 'u_resolution.x',
          'height', () => 'u_resolution.y',
          'fps', () => 'u_fps',
          'loop', () => 'u_loop',
          'bpm', () => 'u_bpm',
          'beat', () => 'u_beat',
          'measure', () => 'u_measure',
          _, () => '0.0'
        );

      case 'Mouse':
        return node.field === 'x' ? 'u_mouse.x' : node.field === 'y' ? 'u_mouse.y' : '0.0';

      case 'Var':
        return localScope[node.name] || instanceOutputs[node.name] || '0.0';

      case 'StrandAccess':
        const baseName = typeof node.base === 'string' ? node.base : node.base.name;
        const outName = typeof node.out === 'string' ? node.out : node.out.name;
        const key = `${baseName}@${outName}`;
        return instanceOutputs[key] || '0.0';

      case 'Bin':
        const left = this.compileToGLSL(node.left, env, instanceOutputs, localScope);
        const right = this.compileToGLSL(node.right, env, instanceOutputs, localScope);

        return match(node.op,
          '+', () => `(${left} + ${right})`,
          '-', () => `(${left} - ${right})`,
          '*', () => `(${left} * ${right})`,
          '/', () => `(${left} / max(${right}, 0.000001))`,
          _, () => '0.0'
        );

      case 'Call':
        const args = node.args.map(arg => this.compileToGLSL(arg, env, instanceOutputs, localScope));
        return this.compileFunctionCall(node.name, args);

      default:
        return '0.0';
    }
  }

  compileFunctionCall(name, argCodes) {
    const mathFn = this.getMathFunction(name);
    if (mathFn) {
      return `${mathFn}(${argCodes.join(', ')})`;
    }

    return match(name,
      'clamp', () => {
        if (argCodes.length === 3) {
          return `clamp(${argCodes[0]}, ${argCodes[1]}, ${argCodes[2]})`;
        }
        return `clamp(${argCodes[0]}, 0.0, 1.0)`;
      },
      'noise', () => argCodes.length >= 3
        ? `noise3(${argCodes[0]} * 3.1, ${argCodes[1]} * 3.1, ${argCodes[2]} * 0.5)`
        : '0.0',
      'mix', () => argCodes.length >= 3
        ? `mix(${argCodes[0]}, ${argCodes[1]}, ${argCodes[2]})`
        : argCodes.length === 2 ? `mix(${argCodes[0]}, ${argCodes[1]}, 0.5)` : '0.0',
      'lerp', () => argCodes.length >= 3
        ? `mix(${argCodes[0]}, ${argCodes[1]}, ${argCodes[2]})`
        : '0.0',
      'smoothstep', () => argCodes.length >= 3
        ? `smoothstep(${argCodes[0]}, ${argCodes[1]}, ${argCodes[2]})`
        : '0.0',
      'step', () => argCodes.length >= 2
        ? `step(${argCodes[0]}, ${argCodes[1]})`
        : '0.0',
      'fract', () => argCodes[0] ? `fract(${argCodes[0]})` : '0.0',
      'sign', () => argCodes[0] ? `sign(${argCodes[0]})` : '0.0',
      'length', () => argCodes.length === 2
        ? `length(vec2(${argCodes[0]}, ${argCodes[1]}))`
        : argCodes[0] ? `abs(${argCodes[0]})` : '0.0',
      'distance', () => argCodes.length === 4
        ? `distance(vec2(${argCodes[0]}, ${argCodes[1]}), vec2(${argCodes[2]}, ${argCodes[3]}))`
        : '0.0',
      'normalize', () => argCodes.length === 3
        ? `((${argCodes[0]} - ${argCodes[1]}) / max(${argCodes[2]} - ${argCodes[1]}, 0.000001))`
        : argCodes[0] || '0.0',
      'inverse', () => argCodes[0] ? `(1.0 - ${argCodes[0]})` : '1.0',
      'invert', () => argCodes[0] ? `(1.0 - ${argCodes[0]})` : '1.0',
      'threshold', () => argCodes.length >= 2
        ? `(${argCodes[0]} > ${argCodes[1]} ? 1.0 : 0.0)`
        : argCodes[0] ? `(${argCodes[0]} > 0.5 ? 1.0 : 0.0)` : '0.0',
      'saturate', () => argCodes[0] ? `clamp(${argCodes[0]}, 0.0, 1.0)` : '0.0',
      'reflect', () => argCodes.length >= 2
        ? `reflect(${argCodes[0]}, ${argCodes[1]})`
        : '0.0',
      'refract', () => argCodes.length >= 3
        ? `refract(${argCodes[0]}, ${argCodes[1]}, ${argCodes[2]})`
        : '0.0',
      'dot', () => argCodes.length >= 4
        ? `dot(vec2(${argCodes[0]}, ${argCodes[1]}), vec2(${argCodes[2]}, ${argCodes[3]}))`
        : argCodes.length >= 2 ? `(${argCodes[0]} * ${argCodes[1]})` : '0.0',
      'cross', () => argCodes.length >= 4
        ? `(${argCodes[0]} * ${argCodes[3]} - ${argCodes[1]} * ${argCodes[2]})`
        : '0.0',
      _, () => '0.0'
    );
  }

  getMathFunction(name) {
    const MAP = {
      sin: 'sin', cos: 'cos', tan: 'tan',
      sqrt: 'sqrt', abs: 'abs', exp: 'exp', log: 'log',
      min: 'min', max: 'max', floor: 'floor',
      ceil: 'ceil', round: 'floor',  // GLSL doesn't have round
      atan2: 'atan', pow: 'pow', mod: 'mod',
      degrees: 'degrees', radians: 'radians',
      asin: 'asin', acos: 'acos', atan: 'atan',
      sinh: 'sinh', cosh: 'cosh', tanh: 'tanh'
    };
    return MAP[name];
  }

  // ===== Spindle Compilation =====

  canCompileSpindleToGLSL(spindleDef) {
    if (!spindleDef || !spindleDef.body || !spindleDef.body.body) {
      return false;
    }

    // Check each statement in spindle body
    for (const stmt of spindleDef.body.body) {
      if (stmt.type !== 'Let' && stmt.type !== 'Assign') {
        return false;
      }

      if (!this.canCompileExpressionToGLSL(stmt.expr)) {
        return false;
      }
    }

    return true;
  }

  canCompileExpressionToGLSL(expr) {
    if (!expr) return false;

    switch (expr.type) {
      case 'Num':
      case 'Me':
      case 'Mouse':
      case 'Var':
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
          'mix', 'lerp', 'smoothstep', 'step', 'fract', 'sign', 'pow', 'mod'
        ];
        if (!supportedFunctions.includes(expr.name)) {
          return false;
        }
        return expr.args.every(arg => this.canCompileExpressionToGLSL(arg));

      case 'StrandAccess':
        return false; // Can't access strands in spindle functions

      default:
        return false;
    }
  }

  generateSpindleGLSL(spindleDef, paramMap = {}) {
    const functionName = `spindle_${spindleDef.name}`;
    let params = Array.isArray(spindleDef.params) ? spindleDef.params : [];
    const outputs = spindleDef.outs;

    // Flatten params if nested
    if (params.length === 1 && Array.isArray(params[0])) {
      params = params[0];
    }

    const glslParams = params.map(param => `float ${param}`).join(', ');

    // For single output
    if (outputs.length === 1) {
      const outputVar = outputs[0];
      let functionBody = '';
      let outputAssigned = false;

      const localParamMap = { ...paramMap };
      for (const param of params) {
        localParamMap[param] = param;
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
          }
        }
      }

      if (!outputAssigned) {
        functionBody += `    return 0.0;\n`;
      }

      return `float ${functionName}(${glslParams}) {\n${functionBody}}`;
    }

    // Multiple outputs - generate separate functions
    const functions = [];
    for (let i = 0; i < outputs.length; i++) {
      const outputVar = outputs[i];
      const outputFunctionName = `${functionName}_${outputVar}`;
      let functionBody = '';
      let outputAssigned = false;

      const localParamMap = { ...paramMap };
      for (const param of params) {
        localParamMap[param] = param;
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

  compileSpindleToGLSL(stmt, glslCode, instanceOutputs) {
    const spindleName = stmt.callee;
    const args = stmt.args;

    // Check if this is a user-defined spindle
    const spindleDef = this.env.spindles.get(spindleName);
    if (spindleDef && this.canCompileSpindleToGLSL(spindleDef)) {
      return this.compileUserSpindleToGLSL(stmt, spindleDef, glslCode, instanceOutputs);
    }

    // Handle built-in spindles
    if (spindleName === 'circle') {
      if (args.length >= 5) {
        const x = this.compileToGLSL(args[0], this.env, instanceOutputs, {});
        const y = this.compileToGLSL(args[1], this.env, instanceOutputs, {});
        const cx = this.compileToGLSL(args[2], this.env, instanceOutputs, {});
        const cy = this.compileToGLSL(args[3], this.env, instanceOutputs, {});
        const rad = this.compileToGLSL(args[4], this.env, instanceOutputs, {});

        for (const output of stmt.outs) {
          const outName = typeof output === 'string' ? output : output.name;
          const varName = `${stmt.inst}_${outName}`;
          glslCode.push(`        float dist_${varName} = distance(vec2(${x}, ${y}), vec2(${cx}, ${cy}));`);
          glslCode.push(`        float ${varName} = (dist_${varName} < ${rad}) ? 1.0 : 0.0;`);
          instanceOutputs[`${stmt.inst}@${outName}`] = varName;
        }
        return true;
      }
    }
    else if (spindleName === 'noise') {
      const x = args[0] ? this.compileToGLSL(args[0], this.env, instanceOutputs, {}) : 'uv.x';
      const y = args[1] ? this.compileToGLSL(args[1], this.env, instanceOutputs, {}) : 'uv.y';
      const t = args[2] ? this.compileToGLSL(args[2], this.env, instanceOutputs, {}) : 'u_time';

      for (const output of stmt.outs) {
        const outName = typeof output === 'string' ? output : output.name;
        const varName = `${stmt.inst}_${outName}`;
        glslCode.push(`        float ${varName} = noise3(${x} * 3.1, ${y} * 3.1, ${t} * 0.5);`);
        instanceOutputs[`${stmt.inst}@${outName}`] = varName;
      }
      return true;
    }

    this.warn(`Cannot compile spindle '${spindleName}' to GLSL`);
    return false;
  }

  compileUserSpindleToGLSL(stmt, spindleDef, glslCode, instanceOutputs) {
    const spindleName = stmt.callee;
    const args = stmt.args;
    const outputs = spindleDef.outs;

    const compiledArgs = args.map(arg => this.compileToGLSL(arg, this.env, instanceOutputs, {}));

    if (outputs.length === 1) {
      const functionName = `spindle_${spindleName}`;

      for (const output of stmt.outs) {
        const outName = typeof output === 'string' ? output : output.name;
        const varName = `${stmt.inst}_${outName}`;
        const functionCall = `${functionName}(${compiledArgs.join(', ')})`;

        glslCode.push(`        float ${varName} = ${functionCall};`);
        instanceOutputs[`${stmt.inst}@${outName}`] = varName;
      }
    } else {
      // Multiple outputs
      for (let i = 0; i < stmt.outs.length && i < outputs.length; i++) {
        const output = stmt.outs[i];
        const outName = typeof output === 'string' ? output : output.name;
        const spindleOutput = outputs[i];
        const varName = `${stmt.inst}_${outName}`;
        const functionName = `spindle_${spindleName}_${spindleOutput}`;
        const functionCall = `${functionName}(${compiledArgs.join(', ')})`;

        glslCode.push(`        float ${varName} = ${functionCall};`);
        instanceOutputs[`${stmt.inst}@${outName}`] = varName;
      }
    }

    return true;
  }

  // ===== StrandRemap Support =====

  normalizeTextureCoordinate(coord) {
    // v_texCoord components are already normalized [0,1]
    if (coord === 'v_texCoord.x' || coord === 'v_texCoord.y') {
      return coord;
    }

    // Time-based coordinates need wrapping
    if (coord.includes('u_time') || coord.includes('u_frame') ||
        coord.includes('u_abstime') || coord.includes('u_absframe')) {
      return `mod(${coord}, 1.0)`;
    }

    // Check if already normalized
    if (coord.includes('/') || coord.includes('mod(')) {
      return coord;
    }

    // For pixel coordinates, normalize by resolution
    if (coord.includes('u_resolution') || coord.match(/^\d+\.?\d*$/)) {
      return `(${coord} / u_resolution.x)`;
    }

    return coord;
  }

  compileStrandRemapDirect(stmt, glslCode, instanceOutputs, globalScope) {
    const remapExpr = stmt.expr;
    const baseName = remapExpr.base?.name || remapExpr.base;
    const strandName = remapExpr.strand?.name || remapExpr.strand;
    const baseKey = `${baseName}@${strandName}`;

    // Compile coordinate expressions
    const coords = remapExpr.coordinates.map(coord =>
      this.compileToGLSL(coord, this.env, instanceOutputs, globalScope)
    );

    for (let i = 0; i < stmt.outs.length; i++) {
      const outputName = stmt.outs[i];
      const varName = `${stmt.name}_${outputName}`;

      // Check if source is texture
      const textureInfo = this.textures.get(baseName);
      if (textureInfo) {
        const remappedX = this.normalizeTextureCoordinate(coords[0] || 'v_texCoord.x');
        const remappedY = this.normalizeTextureCoordinate(coords[1] || 'v_texCoord.y');

        let component = '.r';
        if (strandName === 'r' || strandName === 'red') component = '.r';
        else if (strandName === 'g' || strandName === 'green') component = '.g';
        else if (strandName === 'b' || strandName === 'blue') component = '.b';
        else if (strandName === 'a' || strandName === 'alpha') component = '.a';

        glslCode.push(`        float ${varName} = texture2D(${textureInfo.uniformName}, vec2(${remappedX}, ${remappedY}))${component};`);
      } else {
        const sourceVar = instanceOutputs[baseKey];
        if (sourceVar) {
          glslCode.push(`        float ${varName} = ${sourceVar};`);
        } else {
          glslCode.push(`        float ${varName} = 0.0;`);
        }
      }

      instanceOutputs[`${stmt.name}@${outputName}`] = varName;
      globalScope[varName] = varName;
      if (stmt.outs.length === 1) {
        instanceOutputs[stmt.name] = varName;
      }
    }
  }

  compileStrandRemapToGLSL(node, env, instanceOutputs, localScope) {
    const baseName = node.base?.name || node.base;
    const strandName = node.strand?.name || node.strand;
    const baseKey = `${baseName}@${strandName}`;

    // node.mappings is array of {source: expr, target: expr}
    // Syntax: source ~ target means "source expression gets mapped to target coordinate"
    // So img@r(me@y ~ me@x, test@t ~ me@y) means:
    //   - me@y gets mapped to me@x position → x-coordinate uses me@y value
    //   - test@t gets mapped to me@y position → y-coordinate uses test@t value

    // Compile each mapping
    let remappedX = 'v_texCoord.x';
    let remappedY = 'v_texCoord.y';

    for (const mapping of node.mappings) {
      const sourceCode = this.compileToGLSL(mapping.source, env, instanceOutputs, localScope);
      const targetCode = this.compileToGLSL(mapping.target, env, instanceOutputs, localScope);

      // If SOURCE is me@x (v_texCoord.x), replace x-coordinate with TARGET
      if (sourceCode === 'v_texCoord.x') {
        remappedX = targetCode;
      }
      // If SOURCE is me@y (v_texCoord.y), replace y-coordinate with TARGET
      else if (sourceCode === 'v_texCoord.y') {
        remappedY = targetCode;
      }
    }

    // Check if source is texture
    const textureInfo = this.textures.get(baseName);
    if (textureInfo) {
      let component = '.r';
      if (strandName === 'r' || strandName === 'red') component = '.r';
      else if (strandName === 'g' || strandName === 'green') component = '.g';
      else if (strandName === 'b' || strandName === 'blue') component = '.b';
      else if (strandName === 'a' || strandName === 'alpha') component = '.a';

      const normalizedX = this.normalizeTextureCoordinate(remappedX);
      const normalizedY = this.normalizeTextureCoordinate(remappedY);
      return `texture2D(${textureInfo.uniformName}, vec2(${normalizedX}, ${normalizedY}))${component}`;
    }

    // Check for computed source
    const sourceVar = instanceOutputs[baseKey];
    if (sourceVar) {
      return sourceVar;
    }

    this.warn(`Source strand not found for remapping: ${baseKey}`);
    return '0.0';
  }

  // ===== Texture Loading =====

  loadTexture(url, instName) {
    if (this.textures.has(instName)) {
      return this.textures.get(instName);
    }

    if (!this.gl) {
      this.error('Cannot load texture - WebGL context is null');
      return null;
    }

    const lower = url.toLowerCase();
    const isVideo = lower.endsWith('.mp4') || lower.endsWith('.webm') || lower.endsWith('.ogg') || lower.endsWith('.mov');

    if (isVideo) {
      return this.loadVideoTexture(url, instName);
    }

    const gl = this.gl;
    const texture = gl.createTexture();
    const textureUnit = this.textureCounter++;

    gl.activeTexture(gl.TEXTURE0 + textureUnit);
    gl.bindTexture(gl.TEXTURE_2D, texture);

    // Placeholder while loading
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
      this.log(`Loaded texture: ${url} on unit ${textureUnit}`);
    };
    image.onerror = () => {
      this.error(`Failed to load texture: ${url}`);
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

  loadVideoTexture(url, instName) {
    const gl = this.gl;
    const texture = gl.createTexture();
    const textureUnit = this.textureCounter++;

    gl.activeTexture(gl.TEXTURE0 + textureUnit);
    gl.bindTexture(gl.TEXTURE_2D, texture);

    // Placeholder while loading
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                  new Uint8Array([128, 128, 128, 255]));

    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.preload = 'auto';

    video.addEventListener('loadeddata', () => {
      gl.activeTexture(gl.TEXTURE0 + textureUnit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      this.log(`Video loaded: ${url}`);
      video.play().catch(() => {});
    });

    video.addEventListener('error', (e) => {
      this.error(`Failed to load video: ${url}`, e);
    });

    video.src = url;

    // Try to play on user interaction if autoplay blocked
    const playOnInteraction = () => {
      if (video.paused) {
        video.play().catch(() => {});
      }
    };
    document.addEventListener('click', playOnInteraction, { once: true });

    const textureInfo = {
      texture,
      unit: textureUnit,
      uniformName: `u_texture${textureUnit}`,
      loaded: false,
      isVideo: true,
      videoElement: video
    };

    this.textures.set(instName, textureInfo);
    return textureInfo;
  }

  // ===== Shader Utilities =====

  compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      const typeName = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
      this.error(`${typeName} shader compilation error: ${info}`);
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
      this.error(`Program link error: ${gl.getProgramInfoLog(program)}`);
      return null;
    }

    return program;
  }
}