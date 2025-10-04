import { BaseBackend } from './base-backend.js';
import { match, inst, _ } from '../utils/match.js';
import {
  NumExpr, StrExpr, MeExpr, MouseExpr,
  BinaryExpr, UnaryExpr, IfExpr, CallExpr,
  StrandAccessExpr, StrandRemapExpr, VarExpr,
  TupleExpr, IndexExpr
} from '../ast/ast-node.js';
import { MediaManager } from './shared-utils.js';

export class WebGLBackend extends BaseBackend {
  constructor(env, name, context) {
    super(env, name, context);

    this.canvas = env.canvas;
    this.gl = null;
    this.program = null;
    this.uniforms = {};
    this.textures = new Map();
    this.vertexBuffer = null;
    this.displayStmt = null;
    this.currentAST = null;
  }

  async compile(ast) {
    try {
      // Initialize WebGL if not done
      if (!this.gl) {
        if (!this.initWebGL()) {
          throw new Error('Failed to initialize WebGL');
        }
        this.setupQuadGeometry();
      }

      // Find display/render statements
      const displayStmts = this.filterStatements(ast, 'DisplayStmt', 'RenderStmt');
      if (displayStmts.length === 0) {
        this.log('No display statements found');
        return false;
      }

      this.displayStmt = displayStmts[0];
      this.currentAST = ast;

      // Generate and compile shaders
      const fragmentShader = this.generateFragmentShader();
      if (!fragmentShader) {
        this.error('Failed to generate fragment shader');
        return false;
      }

      const vertexShader = this.generateVertexShader();
      this.program = this.createProgram(vertexShader, fragmentShader);

      if (!this.program) {
        return false;
      }

      this.setupProgram();
      this.log('Compilation successful');
      return true;

    } catch (error) {
      this.error('Compilation failed', error);
      return false;
    }
  }

  render() {
    if (!this.program || !this.gl) return;

    const gl = this.gl;
    const env = this.env;

    // Update canvas size if needed
    this.updateCanvasSize();

    // Update uniforms
    this.updateUniforms();

    // Clear and draw
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  cleanup() {
    const gl = this.gl;
    if (!gl) return;

    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }

    if (this.vertexBuffer) {
      gl.deleteBuffer(this.vertexBuffer);
      this.vertexBuffer = null;
    }

    for (const [, textureInfo] of this.textures) {
      if (textureInfo.texture) {
        gl.deleteTexture(textureInfo.texture);
      }
    }
    this.textures.clear();
  }

  canGetValue() {
    return false; // WebGL can't efficiently read pixels for strand access
  }

  // ===== WebGL Setup =====

  initWebGL() {
    this.gl = this.canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ||
              this.canvas.getContext('webgl', { preserveDrawingBuffer: true });

    if (!this.gl) {
      this.error('WebGL not supported');
      return false;
    }

    this.log('WebGL context initialized');
    return true;
  }

  setupQuadGeometry() {
    const vertices = new Float32Array([
      -1, -1,  // bottom-left
       1, -1,  // bottom-right
      -1,  1,  // top-left
      -1,  1,  // top-left
       1, -1,  // bottom-right
       1,  1   // top-right
    ]);

    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    this.vertexBuffer = buffer;
  }

  setupProgram() {
    const gl = this.gl;
    gl.useProgram(this.program);

    // Setup vertex attribute
    const positionLoc = gl.getAttribLocation(this.program, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    // Cache uniform locations
    this.cacheUniformLocations();
  }

  cacheUniformLocations() {
    const gl = this.gl;
    const uniformNames = [
      'u_resolution', 'u_time', 'u_frame', 'u_abstime', 'u_absframe',
      'u_fps', 'u_loop', 'u_bpm', 'u_beat', 'u_measure', 'u_mouse'
    ];

    for (const name of uniformNames) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }

    // Cache texture uniforms
    for (const [, textureInfo] of this.textures) {
      const loc = gl.getUniformLocation(this.program, textureInfo.uniformName);
      if (loc) {
        this.uniforms[textureInfo.uniformName] = loc;
        gl.uniform1i(loc, textureInfo.unit);
      }
    }
  }

  updateCanvasSize() {
    const width = this.env.resW;
    const height = this.env.resH;

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    this.gl.viewport(0, 0, width, height);
  }

  updateUniforms() {
    const gl = this.gl;
    const env = this.env;

    gl.uniform2f(this.uniforms.u_resolution, env.resW, env.resH);

    // Time uniforms
    const absTime = (Date.now() - env.startTime) / 1000;
    const beatsPerSecond = env.bpm / 60;

    gl.uniform1f(this.uniforms.u_time, (env.frame % env.loop) / env.targetFps);
    gl.uniform1f(this.uniforms.u_frame, env.frame % env.loop);
    gl.uniform1f(this.uniforms.u_abstime, absTime);
    gl.uniform1f(this.uniforms.u_absframe, env.frame);
    gl.uniform1f(this.uniforms.u_fps, env.targetFps);
    gl.uniform1f(this.uniforms.u_loop, env.loop);
    gl.uniform1f(this.uniforms.u_bpm, env.bpm);
    gl.uniform1f(this.uniforms.u_beat, Math.floor(absTime * beatsPerSecond) % env.timesig_num);
    gl.uniform1f(this.uniforms.u_measure, Math.floor(absTime * beatsPerSecond / env.timesig_num));

    gl.uniform2f(this.uniforms.u_mouse, env.mouse.x, env.mouse.y);
  }

  // ===== Shader Compilation =====

  generateVertexShader() {
    return `
      attribute vec2 a_position;
      varying vec2 v_texCoord;

      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = (a_position + 1.0) * 0.5;
        v_texCoord.y = 1.0 - v_texCoord.y;
      }
    `;
  }

  generateFragmentShader() {
    if (!this.displayStmt || !this.currentAST) {
      this.error('No display statement or AST available');
      return null;
    }

    const program = this.currentAST;
    const instanceOutputs = {};
    const glslCode = [];

    // Process all statements to build up instance outputs
    for (const stmt of program.statements) {
      this.processStatement(stmt, glslCode, instanceOutputs);
    }

    // Compile display/render statement arguments
    let rCode = '0.0', gCode = '0.0', bCode = '0.0';

    if (this.displayStmt.args && this.displayStmt.args.length >= 3) {
      rCode = this.compileToGLSL(this.displayStmt.args[0], instanceOutputs, {});
      gCode = this.compileToGLSL(this.displayStmt.args[1], instanceOutputs, {});
      bCode = this.compileToGLSL(this.displayStmt.args[2], instanceOutputs, {});
    } else if (this.displayStmt.args && this.displayStmt.args.length === 1) {
      // Grayscale from single argument
      const code = this.compileToGLSL(this.displayStmt.args[0], instanceOutputs, {});
      rCode = gCode = bCode = code;
    }

    // Generate texture uniform declarations
    const textureUniforms = Array.from(this.textures.values())
      .map(info => `uniform sampler2D ${info.uniformName};`)
      .join('\n      ');

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
      uniform float u_beat;
      uniform float u_measure;
      uniform vec2 u_mouse;
      ${textureUniforms}

      varying vec2 v_texCoord;

      // Noise function
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

      void main() {
        // Instance computations
${glslCode.join('\n')}

        // Final color
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

  processStatement(stmt, glslCode, instanceOutputs) {
    // First, import statement node types if we haven't already
    // For now, handle both class instances and plain objects
    if (stmt && typeof stmt === 'object') {
      // If it has a type property, it's likely a plain object from the parser
      if (stmt.type) {
        return this.processStatementObject(stmt, glslCode, instanceOutputs);
      }
    }

    // Otherwise try to match on instance type
    return match(stmt,
      // Add inst() patterns here when statement classes are imported
      _, () => {
        // Skip unknown statement types
      }
    );
  }

  processStatementObject(stmt, glslCode, instanceOutputs) {
    match(stmt.type,
      'Direct', () => {
        const name = stmt.name || stmt.inst;
        const outs = stmt.outs || [];

        // For each output, compile the expression
        for (let i = 0; i < outs.length; i++) {
          const outName = outs[i];
          const varName = `${name}_${outName}`;
          const expr = this.compileToGLSL(stmt.expr, instanceOutputs, {});

          glslCode.push(`        float ${varName} = ${expr};`);
          instanceOutputs[`${name}@${outName}`] = varName;

          // Single output can be accessed directly
          if (outs.length === 1) {
            instanceOutputs[name] = varName;
          }
        }
      },

      'CallInstance', () => {
        if (stmt.callee === 'load' && stmt.args && stmt.args[0]) {
          // Handle texture loading
          const path = stmt.args[0].v;
          const textureInfo = this.loadTexture(path, stmt.inst);

          if (textureInfo) {
            for (const out of stmt.outs) {
              const varName = `${stmt.inst}_${out}`;
              const component = match(out,
                'r', () => '.r',
                'g', () => '.g',
                'b', () => '.b',
                'a', () => '.a',
                _, () => '.r'
              );

              glslCode.push(`        float ${varName} = texture2D(${textureInfo.uniformName}, v_texCoord)${component};`);
              instanceOutputs[`${stmt.inst}@${out}`] = varName;
            }
          }
        }
      },

      'LetBinding', () => {
        const varName = stmt.name;
        const expr = this.compileToGLSL(stmt.expr, instanceOutputs, {});
        glslCode.push(`        float ${varName} = ${expr};`);
        instanceOutputs[varName] = varName;
      },

      'Assignment', () => {
        const varName = stmt.name;
        const expr = this.compileToGLSL(stmt.expr, instanceOutputs, {});

        if (!instanceOutputs[varName]) {
          glslCode.push(`        float ${varName} = ${expr};`);
        } else {
          glslCode.push(`        ${varName} = ${expr};`);
        }
        instanceOutputs[varName] = varName;
      },

      _, () => {
        // Skip other statement types
      }
    );
  }

  // ===== GLSL Compilation with match/inst =====

  compileToGLSL(node, instanceOutputs = {}, localScope = {}) {
    if (Array.isArray(node)) {
      return node.length === 1 ? this.compileToGLSL(node[0], instanceOutputs, localScope) : '0.0';
    }

    if (!node) return '0.0';

    return match(node,
      inst(NumExpr, _), (v) => {
        return v.toString() + (Number.isInteger(v) ? '.0' : '');
      },

      inst(StrExpr, _), (v) => '0.0', // Strings not supported in GLSL

      inst(MeExpr, _), (field) => match(field,
        'x', () => 'v_texCoord.x',
        'y', () => 'v_texCoord.y',
        'time', () => 'u_time',
        'frame', () => 'u_frame',
        'width', () => 'u_resolution.x',
        'height', () => 'u_resolution.y',
        'fps', () => 'u_fps',
        'loop', () => 'u_loop',
        'bpm', () => 'u_bpm',
        'beat', () => 'u_beat',
        'measure', () => 'u_measure',
        'abstime', () => 'u_abstime',
        'absframe', () => 'u_absframe',
        _, (n) => '0.0'
      ),

      inst(MouseExpr, _), (field) => match(field,
        'x', () => 'u_mouse.x',
        'y', () => 'u_mouse.y',
        _, (n) => '0.0'
      ),

      inst(BinaryExpr, _, _, _), (op, left, right) => {
        const l = this.compileToGLSL(left, instanceOutputs, localScope);
        const r = this.compileToGLSL(right, instanceOutputs, localScope);

        return match(op,
          '+', () => `(${l} + ${r})`,
          '-', () => `(${l} - ${r})`,
          '*', () => `(${l} * ${r})`,
          '/', () => `(${l} / max(${r}, 0.000001))`,
          '^', () => `pow(${l}, ${r})`,
          '%', () => `mod(${l}, ${r})`,
          '==', () => `(${l} == ${r} ? 1.0 : 0.0)`,
          '!=', () => `(${l} != ${r} ? 1.0 : 0.0)`,
          '<<', () => `(${l} < ${r} ? 1.0 : 0.0)`,
          '>>', () => `(${l} > ${r} ? 1.0 : 0.0)`,
          '<=', () => `(${l} <= ${r} ? 1.0 : 0.0)`,
          '>=', () => `(${l} >= ${r} ? 1.0 : 0.0)`,
          'AND', () => `(${l} > 0.0 && ${r} > 0.0 ? 1.0 : 0.0)`,
          'OR', () => `(${l} > 0.0 || ${r} > 0.0 ? 1.0 : 0.0)`,
          _, (n) => '0.0'
        );
      },

      inst(UnaryExpr, _, _), (op, expr) => {
        const arg = this.compileToGLSL(expr, instanceOutputs, localScope);

        return match(op,
          '-', () => `(-${arg})`,
          'NOT', () => `(${arg} > 0.0 ? 0.0 : 1.0)`,
          _, (n) => {
            const fn = this.getMathFunction(op);
            return fn ? `${fn}(${arg})` : '0.0';
          }
        );
      },

      inst(IfExpr, _, _, _), (condition, thenExpr, elseExpr) => {
        const cond = this.compileToGLSL(condition, instanceOutputs, localScope);
        const thenCode = this.compileToGLSL(thenExpr, instanceOutputs, localScope);
        const elseCode = this.compileToGLSL(elseExpr, instanceOutputs, localScope);
        return `(${cond} > 0.0 ? ${thenCode} : ${elseCode})`;
      },

      inst(CallExpr, _, _), (name, args) => {
        const argCodes = args.map(arg => this.compileToGLSL(arg, instanceOutputs, localScope));
        return this.compileCallToGLSL(name, argCodes);
      },

      inst(StrandAccessExpr, _, _), (base, out) => {
        const baseName = base.name;
        const key = `${baseName}@${out}`;

        // Special case for me@
        if (baseName === 'me') {
          return match(out,
            'x', () => 'v_texCoord.x',
            'y', () => 'v_texCoord.y',
            'time', () => 'u_time',
            'frame', () => 'u_frame',
            _, (n) => '0.0'
          );
        }

        return instanceOutputs[key] || '0.0';
      },

      inst(StrandRemapExpr, _, _, _), (base, strand, mappings) => {
        // Simplified strand remap for now
        const baseName = base.name;
        const key = `${baseName}@${strand}`;

        // Check if it's a texture
        const textureInfo = this.textures.get(baseName);
        if (textureInfo) {
          const xCoord = mappings[0] ? this.compileToGLSL(mappings[0].expr, instanceOutputs, localScope) : 'v_texCoord.x';
          const yCoord = mappings[1] ? this.compileToGLSL(mappings[1].expr, instanceOutputs, localScope) : 'v_texCoord.y';

          const component = match(strand,
            'r', () => '.r',
            'g', () => '.g',
            'b', () => '.b',
            'a', () => '.a',
            _, (n) => '.r'
          );

          return `texture2D(${textureInfo.uniformName}, vec2(${xCoord}, ${yCoord}))${component}`;
        }

        return instanceOutputs[key] || '0.0';
      },

      inst(VarExpr, _), (name) => {
        return localScope[name] || instanceOutputs[name] || '0.0';
      },

      _, (n) => {
        // Handle plain objects for backwards compatibility
        if (typeof node === 'object' && node.type) {
          return this.compileObjectToGLSL(node, instanceOutputs, localScope);
        }
        this.warn(`Unhandled node: ${JSON.stringify(node)}`);
        return '0.0';
      }
    );
  }

  // Fallback for plain objects (backwards compatibility)
  compileObjectToGLSL(node, instanceOutputs, localScope) {
    const type = node.type;

    return match(type,
      'Num', () => {
        const v = node.v;
        return v.toString() + (Number.isInteger(v) ? '.0' : '');
      },

      'Me', () => match(node.field,
        'x', () => 'v_texCoord.x',
        'y', () => 'v_texCoord.y',
        'time', () => 'u_time',
        'frame', () => 'u_frame',
        _, (n) => '0.0'
      ),

      'Bin', () => {
        const l = this.compileToGLSL(node.left, instanceOutputs, localScope);
        const r = this.compileToGLSL(node.right, instanceOutputs, localScope);

        return match(node.op,
          '+', () => `(${l} + ${r})`,
          '-', () => `(${l} - ${r})`,
          '*', () => `(${l} * ${r})`,
          '/', () => `(${l} / max(${r}, 0.000001))`,
          _, (n) => '0.0'
        );
      },

      'Call', () => {
        const args = node.args.map(arg => this.compileToGLSL(arg, instanceOutputs, localScope));
        return this.compileCallToGLSL(node.name, args);
      },

      'Var', () => instanceOutputs[node.name] || '0.0',

      'StrandAccess', () => {
        const baseName = typeof node.base === 'string' ? node.base : node.base.name;
        const outName = typeof node.out === 'string' ? node.out : node.out.name;
        const key = `${baseName}@${outName}`;
        return instanceOutputs[key] || '0.0';
      },

      _, (n) => '0.0'
    );
  }

  compileCallToGLSL(name, argCodes) {
    const fn = this.getMathFunction(name);
    if (fn) {
      return `${fn}(${argCodes.join(', ')})`;
    }

    return match(name,
      'clamp', () => {
        if (argCodes.length === 3) {
          return `clamp(${argCodes[0]}, ${argCodes[1]}, ${argCodes[2]})`;
        }
        return `clamp(${argCodes[0]}, 0.0, 1.0)`;
      },

      'noise', () => {
        if (argCodes.length >= 3) {
          return `noise3(${argCodes[0]} * 3.1, ${argCodes[1]} * 3.1, ${argCodes[2]} * 0.5)`;
        }
        return '0.0';
      },

      'mix', () => {
        if (argCodes.length >= 3) {
          return `mix(${argCodes[0]}, ${argCodes[1]}, ${argCodes[2]})`;
        }
        return argCodes.length === 2 ? `mix(${argCodes[0]}, ${argCodes[1]}, 0.5)` : '0.0';
      },

      'smoothstep', () => {
        if (argCodes.length >= 3) {
          return `smoothstep(${argCodes[0]}, ${argCodes[1]}, ${argCodes[2]})`;
        }
        return '0.0';
      },

      'step', () => {
        if (argCodes.length >= 2) {
          return `step(${argCodes[0]}, ${argCodes[1]})`;
        }
        return '0.0';
      },

      'fract', () => argCodes[0] ? `fract(${argCodes[0]})` : '0.0',
      'sign', () => argCodes[0] ? `sign(${argCodes[0]})` : '0.0',
      'length', () => {
        if (argCodes.length === 2) {
          return `length(vec2(${argCodes[0]}, ${argCodes[1]}))`;
        }
        return argCodes[0] ? `abs(${argCodes[0]})` : '0.0';
      },

      'distance', () => {
        if (argCodes.length === 4) {
          return `distance(vec2(${argCodes[0]}, ${argCodes[1]}), vec2(${argCodes[2]}, ${argCodes[3]}))`;
        }
        return '0.0';
      },

      'normalize', () => {
        if (argCodes.length === 3) {
          return `((${argCodes[0]} - ${argCodes[1]}) / max(${argCodes[2]} - ${argCodes[1]}, 0.000001))`;
        }
        return argCodes[0] || '0.0';
      },

      _, (n) => '0.0'
    );
  }

  getMathFunction(name) {
    return match(name,
      'sin', () => 'sin',
      'cos', () => 'cos',
      'tan', () => 'tan',
      'sqrt', () => 'sqrt',
      'abs', () => 'abs',
      'exp', () => 'exp',
      'log', () => 'log',
      'min', () => 'min',
      'max', () => 'max',
      'floor', () => 'floor',
      'ceil', () => 'ceil',
      'round', () => 'floor',  // GLSL doesn't have round, use floor(x + 0.5)
      'atan2', () => 'atan',
      'pow', () => 'pow',
      'mod', () => 'mod',
      'asin', () => 'asin',
      'acos', () => 'acos',
      'atan', () => 'atan',
      _, (n) => null
    );
  }

  // ===== Texture Handling =====

  loadTexture(url, instName) {
    if (this.textures.has(instName)) {
      return this.textures.get(instName);
    }

    const gl = this.gl;
    const texture = gl.createTexture();
    const textureUnit = this.textures.size;

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
      this.log(`Loaded texture: ${url}`);
    };

    image.onerror = () => {
      this.error(`Failed to load texture: ${url}`);
    };

    image.src = url;

    const textureInfo = {
      texture,
      unit: textureUnit,
      uniformName: `u_texture${textureUnit}`
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
      this.error(`${typeName} shader compilation failed: ${info}`);
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