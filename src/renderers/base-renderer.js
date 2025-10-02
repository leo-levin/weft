import { Sampler } from '../utils/sampler.js'

export class BaseRenderer {
  constructor(env,name) {
    this.env = env;
    this.name = name;
    this.isRunning = false;
    this.statements = [];
    this.media = new Map();
  }

  async init() {
    throw new Error("init() not implemented");
  }

  async compile() {
    throw new Error("compile() not implemented");
  }

  render() {
    throw new Error("render() not implemented");
  }

  cleanup(){
    this.media.clear();
    this.statements = [];
    this.isRunning = false;
  }
}