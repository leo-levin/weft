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

  filterStatements(ast, ...types) {
      return ast.statements.filter(s => types.includes(s.type));
  }

  log(msg, level = 'info') {
    console.log(`[${this.name}] ${msg}`);
  }

  warn(msg) {
      console.warn(`[${this.name}] ${msg}`);
  }

  error(msg, err) {
    console.error(`[${this.name}] ${msg}`,err);
  }
}