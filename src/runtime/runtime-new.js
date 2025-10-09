import { Sampler } from './media/sampler.js';
import { parse } from '../lang/parser-new.js';
import { match, _ } from '../utils/match.js';
import { RenderGraph } from '../backends/render-graph.js';
import { Coordinator } from '../backends/coordinator.js';

import { WebGLBackend } from '../backends/webgl-backend-full.js';
//import { AudioBackend } from '../backends/audio-backend.js';

export class Runtime {
  constructor(canvas) {
    this.env = new Env(canvas);
    this.coordinator = null;
  }

  async compile(sourceCode){
    const ast = parse(sourceCode);
    if(!ast) {
      throw new Error("Failed to parse source code");
    }

    const graph = new RenderGraph(ast, this.env);
    graph.build();
    const contextsNeeded = graph.getContextsNeeded();

    const backends = {
      webgl: new WebGLBackend(this.env, 'webgl', 'visual'),
      //audio: new AudioBackend(this.env, 'audio', 'audio'),
    };

    this.coordinator = new Coordinator(ast, this.env);
    this.env.coordinator = this.coordinator;
    this.coordinator.setBackends(backends);

    await this.coordinator.compile()
  }

  start(){
    if (this.coordinator){
      this.coordinator.start();
    }
  }

  stop() {
    if (this.coordinator){
      this.coordinator.stop();
    }
  }

  setVar(name, value) {
    this.env.setVar(name,value);
  }

  cleanup() {
    if (this.coordinator){
      this.coordinator.cleanup();
      this.coordinator = null;
    }
  }
}

export class Env {
  constructor(canvas){
    this.canvas = canvas;
    this.spindles = new Map();
    this.instances = new Map();
    this.vars = new Map();

    this.resW = canvas?.width || 1080;
    this.resH = canvas?.height || 1080;
    this.frame = 0;
    this.startTime = Date.now();
    this.targetFps = 30;

    this.mouse = {x: 0.5, y: 0.5};

    this.audio = {element: null, intensity: 0};

    this.loop = 600;
    this.bpm = 120;
    this.timesig_num = 4;
    this.timesig_denom = 4;

    this.media = new Map();

    this.coordinator = null;

    this.setupMouseTracking();
  }

  getVar(name) {
    return this.vars.get(name) ?? 0;
  }

  setVar(name, value) {
    this.vars.set(name, value);
  }

  setupMouseTracking() {
    if (!this.canvas) return;

    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = (e.clientX - rect.left) / rect.width;
      this.mouse.y = (e.clientY - rect.top) / rect.height;
    });
  }

  async loadMedia(path, instanceName) {
    const sampler = new Sampler();
    await sampler.load(path);
    this.media.set(instanceName, sampler);
    return sampler;
  }

  async loadCamera(instanceName) {
    const sampler = new Sampler();
    await sampler.loadCamera();
    this.media.set(instanceName, sampler);
    return sampler;
  }

  getMedia(instanceName) {
    return this.media.get(instanceName);
  }
}
