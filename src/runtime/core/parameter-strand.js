// parameter-strand.js — Parameter strand for UI-controlled values

export class ParameterStrand {
  constructor(name, initialValue = 0, config = {}) {
    this.kind = 'strand';
    this.name = name;
    this.value = initialValue;
    this.config = config;
    this.isDirty = true;
    this.lastValue = undefined;
    this.subscribers = new Set();
    this.widgetType = config.type || 'slider';

    // Create unique ID for this parameter
    this.id = `param_${name}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  evalAt(_me, _env) {
    return this.value;
  }

  setValue(newValue) {
    if (this.value !== newValue) {
      this.value = newValue;
      this.isDirty = true;
      this.notifySubscribers();

      // Trigger a re-render by dispatching a custom event
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('parameterChanged', {
          detail: { paramName: this.name, newValue, strand: this }
        }));
      }
    }
  }

  subscribe(callback) {
    this.subscribers.add(callback);
  }

  unsubscribe(callback) {
    this.subscribers.delete(callback);
  }

  notifySubscribers() {
    this.subscribers.forEach(callback => callback(this.value, this));
  }
}