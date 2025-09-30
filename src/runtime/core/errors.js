// errors.js — Runtime error classes

export class RuntimeError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "RuntimeError";
  }
}