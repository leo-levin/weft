import { logger } from '../utils/logger.js';

export class BaseBackend{
  constructor(env, name, context){
    this.env = env;
    this.name = name;
    this.context = context;
    this.coordinator = null;
  }

  async init() {
    throw new Error(`${this.name}: init() not implemented`);
  }
  async compile(ast) {
    throw new Error(`${this.name}: compile() not implemented`);
  }
  render() {
    throw new Error(`${this.name}: render() not implemented`);
  }

  cleanup() {}

  canGetValue() { return false; }

  getValue(inst, out, me) {
    return this.coordinator?.getValue(inst,out, me) ?? 0;
  }

  // Override this in subclasses to provide compiled code for viewing
  getCompiledCode() {
    return `// No compiled code available for ${this.name} backend`;
  }

  filterStatements(ast, ...types) {
      return ast.statements.filter(s => types.includes(s.type));
  }

  log(msg, level = 'info') {
    logger.log(level, this.name, msg);
  }

  warn(msg) {
    logger.warn(this.name, msg);
  }

  error(msg, err) {
    logger.error(this.name, msg, err ? { error: err.message || err } : null);
  }
}