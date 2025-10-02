// Logger system extracted from runtime.js
export class Logger {
  constructor() {
    this.logs = [];
    this.maxLogs = 1000;
    this.filters = { debug: true, info: true, warn: true, error: true };
    this.componentFilters = {}; // Empty means show all components
    this.autoScroll = true;
    this.pendingUpdate = false;
    this.updatePending = false;
  }

  log(level, component, message, data = null) {
    const timestamp = new Date().toLocaleTimeString();
    const entry = { level, component, message, data, timestamp, id: Date.now() + Math.random() };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    this.scheduleUpdate();
  }

  scheduleUpdate() {
    if (this.updatePending) return;
    this.updatePending = true;

    requestAnimationFrame(() => {
      this.updateUI();
      this.updatePending = false;
    });
  }

  debug(component, message, data = null) { this.log('debug', component, message, data); }
  info(component, message, data = null) { this.log('info', component, message, data); }
  warn(component, message, data = null) { this.log('warn', component, message, data); }
  error(component, message, data = null) { this.log('error', component, message, data); }

  clear() {
    this.logs = [];
    this.scheduleUpdate();
  }

  setFilters(filters) {
    this.filters = { ...this.filters, ...filters };
    this.scheduleUpdate();
  }

  setComponentFilters(componentFilters) {
    this.componentFilters = { ...componentFilters };
    this.scheduleUpdate();
  }

  getActiveComponents() {
    // Get unique list of components from current logs
    const components = [...new Set(this.logs.map(log => log.component))];
    return components.sort();
  }

  // Convenience methods for component filtering
  showOnlyComponent(component) {
    this.componentFilters = { [component]: true };
    this.scheduleUpdate();
  }

  showOnlyComponents(components) {
    this.componentFilters = {};
    components.forEach(component => {
      this.componentFilters[component] = true;
    });
    this.scheduleUpdate();
  }

  hideComponent(component) {
    delete this.componentFilters[component];
    this.scheduleUpdate();
  }

  showAllComponents() {
    this.componentFilters = {};
    this.scheduleUpdate();
  }

  updateUI() {
    this.updateComponentFilterUI();

    const logOutput = document.getElementById('logOutput');
    if (!logOutput) return;

    const filteredLogs = this.logs.filter(log => {
      if (!this.filters[log.level]) return false;

      if (Object.keys(this.componentFilters).length > 0) {
        return this.componentFilters[log.component] === true;
      }

      return true;
    });

    logOutput.innerHTML = filteredLogs.map(log => {
      let dataStr = '';
      if (log.data) {
        if (typeof log.data === 'object') {
          dataStr = `<div class="log-data">${JSON.stringify(log.data, null, 2)}</div>`;
        } else {
          dataStr = ` <span class="log-data-inline">${log.data}</span>`;
        }
      }

      return `<div class="log-entry ${log.level}">
        <div class="log-header">
          <span class="log-timestamp">${log.timestamp}</span>
          <span class="log-component">${log.component}</span>
        </div>
        <div class="log-message">${this.escapeHtml(log.message)}</div>
        ${dataStr}
      </div>`;
    }).join('');

    if (this.autoScroll) {
      logOutput.scrollTop = logOutput.scrollHeight;
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  updateComponentFilterUI() {
    const componentFilterList = document.getElementById('componentFilterList');
    if (!componentFilterList) return;

    const components = this.getActiveComponents();

    // Clear existing filters
    componentFilterList.innerHTML = '';

    // Create checkbox for each component
    components.forEach(component => {
      const label = document.createElement('label');
      label.style.fontSize = '10px';
      label.style.display = 'flex';
      label.style.alignItems = 'center';
      label.style.gap = '4px';
      label.style.color = '#9aa4b2';
      label.style.cursor = 'pointer';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.style.width = '12px';
      checkbox.style.height = '12px';
      checkbox.style.accentColor = '#7aa2ff';

      // Check if this component should be shown
      const isChecked = Object.keys(this.componentFilters).length === 0 ||
                       this.componentFilters[component] === true;
      checkbox.checked = isChecked;

      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          this.componentFilters[component] = true;
        } else {
          delete this.componentFilters[component];
        }
        this.scheduleUpdate();
      });

      const text = document.createTextNode(component);

      label.appendChild(checkbox);
      label.appendChild(text);
      componentFilterList.appendChild(label);
    });

    // Setup All/None buttons
    this.setupComponentFilterButtons();
  }

  setupComponentFilterButtons() {
    const showAllBtn = document.getElementById('showAllComponents');
    const hideAllBtn = document.getElementById('hideAllComponents');

    if (showAllBtn && !showAllBtn.dataset.listenerAdded) {
      showAllBtn.addEventListener('click', () => {
        this.componentFilters = {};
        this.scheduleUpdate();
      });
      showAllBtn.dataset.listenerAdded = 'true';
    }

    if (hideAllBtn && !hideAllBtn.dataset.listenerAdded) {
      hideAllBtn.addEventListener('click', () => {
        const components = this.getActiveComponents();
        this.componentFilters = {};
        // Set all to false by not including them (empty object shows all)
        // But we need at least one component to be shown, so show only first
        if (components.length > 0) {
          this.componentFilters[components[0]] = true;
        }
        this.scheduleUpdate();
      });
      hideAllBtn.dataset.listenerAdded = 'true';
    }
  }

  updateScopeViewer(scopeStack) {
    const scopeViewer = document.getElementById('scopeViewer');
    if (!scopeViewer) return;

    if (!scopeStack || scopeStack.length === 0) {
      scopeViewer.innerHTML = '<div class="empty-state">No active scopes</div>';
      return;
    }

    const scopeInfo = scopeStack.map((scope, index) => {
      const vars = Object.keys(scope).filter(k => k !== '__scopeStack').map(key => {
        let value = scope[key];
        let valueClass = 'scope-value';

        if (typeof value === 'function') {
          value = '[Function]';
          valueClass += ' scope-function';
        } else if (value && value.__kind === 'strand') {
          value = '[Strand]';
          valueClass += ' scope-strand';
        } else if (typeof value === 'object' && value !== null) {
          value = '[Object]';
          valueClass += ' scope-object';
        } else if (typeof value === 'number') {
          value = value.toFixed(3);
          valueClass += ' scope-number';
        } else if (typeof value === 'string') {
          value = `"${value}"`;
          valueClass += ' scope-string';
        }

        return `<div class="scope-var">
          <span class="scope-key">${key}:</span>
          <span class="${valueClass}">${value}</span>
        </div>`;
      }).join('');

      return `<div class="scope-level">
        <div class="scope-header">Scope ${index}</div>
        <div class="scope-vars">${vars || '<div class="scope-empty">No variables</div>'}</div>
      </div>`;
    }).join('');

    scopeViewer.innerHTML = scopeInfo;
  }

  updateInstanceViewer(instances) {
    const instanceViewer = document.getElementById('instanceViewer');
    if (!instanceViewer) return;

    if (!instances || instances.size === 0) {
      instanceViewer.innerHTML = '<div class="empty-state">No instances</div>';
      return;
    }

    const instanceInfo = Array.from(instances.entries()).map(([name, inst]) => {
      const outputs = Object.keys(inst.outs || {});
      const outputList = outputs.map(out =>
        `<span class="instance-output">${out}</span>`
      ).join(' ');

      return `<div class="instance-item">
        <div class="instance-header">
          <span class="instance-name">${name}</span>
          <span class="instance-count">${outputs.length} outputs</span>
        </div>
        <div class="instance-outputs">${outputList || 'No outputs'}</div>
      </div>`;
    }).join('');

    instanceViewer.innerHTML = instanceInfo;
  }
}

// Create singleton instance
export const logger = new Logger();