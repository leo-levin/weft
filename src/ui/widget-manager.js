// Widget Manager - Refined UI controls for WEFT parameters
// Implements Apple-like aesthetic with smooth animations and popovers

class WidgetManager {
  constructor(env, container) {
    this.env = env;
    this.container = container;
    this.widgets = new Map();
    this.popovers = new Map();
    this.hoverTimeout = null;
    this.activePopover = null;
    this.isEnabled = true;

    this.init();
  }

  init() {
    this.setupParameterListeners();
  }

  createToolbarToggle() {
    return;
  }

  toggle() {
    this.isEnabled = !this.isEnabled;
    this.panel.classList.toggle('hidden', !this.isEnabled);
    this.toggleBtn.classList.toggle('active', this.isEnabled);
  }

  setupParameterListeners() {
    this.updateInterval = setInterval(() => {
      this.updateWidgets();
    }, 100);
  }

  updateWidgets() {
    // For popover system, we don't create widgets upfront
    // Popovers are created on-demand when hovering over parameter names
    // The hover detector handles this automatically
  }

  createWidget(name, paramStrand) {
    const widget = document.createElement('div');
    widget.className = 'parameter-widget-container';
    widget.dataset.paramName = name;

    if (paramStrand.widgetType === 'slider') {
      this.createSliderWidget(widget, name, paramStrand);
    } else if (paramStrand.widgetType === 'color') {
      this.createColorWidget(widget, name, paramStrand);
    }

    this.panel.appendChild(widget);
    this.widgets.set(name, widget);
  }

  createSliderWidget(container, name, paramStrand) {
    const { config } = paramStrand;
    const { range = [0, 1], label = name } = config;

    const sliderGroup = document.createElement('div');
    sliderGroup.className = 'slider-group';

    const labelEl = document.createElement('div');
    labelEl.className = 'parameter-label';
    labelEl.textContent = label;

    const controlRow = document.createElement('div');
    controlRow.className = 'control-row';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = range[0];
    slider.max = range[1];
    slider.step = (range[1] - range[0]) / 1000;
    slider.value = paramStrand.value;
    slider.className = 'refined-slider';

    const valueDisplay = document.createElement('div');
    valueDisplay.className = 'value-display';
    valueDisplay.textContent = paramStrand.value.toFixed(3);

    const valueInput = document.createElement('input');
    valueInput.type = 'number';
    valueInput.min = range[0];
    valueInput.max = range[1];
    valueInput.step = 'any';
    valueInput.value = paramStrand.value;
    valueInput.className = 'value-input';

    // Event handlers with smooth updates
    const updateValue = (newValue) => {
      const clamped = Math.max(range[0], Math.min(range[1], parseFloat(newValue)));
      paramStrand.setValue(clamped);
      slider.value = clamped;
      valueDisplay.textContent = clamped.toFixed(3);
      valueInput.value = clamped;
    };

    slider.addEventListener('input', (e) => updateValue(e.target.value));
    valueInput.addEventListener('change', (e) => updateValue(e.target.value));

    // Refined layout
    controlRow.appendChild(slider);
    controlRow.appendChild(valueDisplay);
    controlRow.appendChild(valueInput);

    sliderGroup.appendChild(labelEl);
    sliderGroup.appendChild(controlRow);
    container.appendChild(sliderGroup);
  }

  createColorWidget(container, name, paramStrand) {
    const { config } = paramStrand;
    const { label = name } = config;

    const colorGroup = document.createElement('div');
    colorGroup.className = 'color-group';

    const labelEl = document.createElement('div');
    labelEl.className = 'parameter-label';
    labelEl.textContent = label;

    const colorRow = document.createElement('div');
    colorRow.className = 'control-row';

    const colorSwatch = document.createElement('div');
    colorSwatch.className = 'color-swatch';
    colorSwatch.style.backgroundColor = paramStrand.value;

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = paramStrand.value;
    colorInput.className = 'refined-color-input';

    const hexInput = document.createElement('input');
    hexInput.type = 'text';
    hexInput.value = paramStrand.value;
    hexInput.className = 'hex-input';
    hexInput.placeholder = '#ffffff';

    // Event handlers
    const updateColor = (newColor) => {
      paramStrand.setValue(newColor);
      colorSwatch.style.backgroundColor = newColor;
      colorInput.value = newColor;
      hexInput.value = newColor;
    };

    colorInput.addEventListener('input', (e) => updateColor(e.target.value));
    hexInput.addEventListener('change', (e) => updateColor(e.target.value));

    colorRow.appendChild(colorSwatch);
    colorRow.appendChild(colorInput);
    colorRow.appendChild(hexInput);

    colorGroup.appendChild(labelEl);
    colorGroup.appendChild(colorRow);
    container.appendChild(colorGroup);
  }

  // Popover system for hover interactions
  createPopover(paramName, paramStrand, targetElement) {
    const popover = document.createElement('div');
    popover.className = 'parameter-popover';
    popover.dataset.paramName = paramName;

    // Position relative to target
    const rect = targetElement.getBoundingClientRect();
    popover.style.left = `${rect.left}px`;
    popover.style.top = `${rect.bottom + 8}px`;

    // Create mini widget inside popover based on parameter type
    const paramType = paramStrand.config.type;

    if (paramType === 'slider') {
      this.createPopoverSlider(popover, paramName, paramStrand);
    } else if (paramType === 'color_component') {
      this.createPopoverColorComponent(popover, paramName, paramStrand);
    } else if (paramType === 'xy_component') {
      this.createPopoverXYComponent(popover, paramName, paramStrand);
    } else if (paramType === 'toggle') {
      this.createPopoverToggle(popover, paramName, paramStrand);
    } else {
      // Fallback to slider for unknown types
      this.createPopoverSlider(popover, paramName, paramStrand);
    }

    document.body.appendChild(popover);

    // Add mouse event listeners to keep popover open during interaction
    popover.addEventListener('mouseenter', () => {
      console.log('🎯 Mouse entered popover - canceling hide');
      clearTimeout(window.hoverDetector?.hideTimeout);
    });

    popover.addEventListener('mouseleave', () => {
      console.log('👋 Mouse left popover - will hide after delay');
      setTimeout(() => {
        console.log('🫥 Hiding popover after leaving');
        this.hidePopover();
      }, 100);
    });

    // Smooth entrance animation
    requestAnimationFrame(() => {
      popover.classList.add('visible');
    });

    return popover;
  }

  createPopoverSlider(container, name, paramStrand) {
    const { config } = paramStrand;
    const { range = [0, 1] } = config;

    const value = document.createElement('div');
    value.className = 'popover-value';
    value.textContent = paramStrand.value.toFixed(3);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = range[0];
    slider.max = range[1];
    slider.step = (range[1] - range[0]) / 1000;
    slider.value = paramStrand.value;
    slider.className = 'popover-slider';

    slider.addEventListener('input', (e) => {
      const newValue = parseFloat(e.target.value);
      paramStrand.setValue(newValue);
      value.textContent = newValue.toFixed(3);
    });

    container.appendChild(value);
    container.appendChild(slider);
  }

  createPopoverColorComponent(container, name, paramStrand) {
    const { config } = paramStrand;
    const { label = name, component, parentColor } = config;

    const header = document.createElement('div');
    header.className = 'popover-header';
    header.textContent = `${label} (${component.toUpperCase()})`;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = 0;
    slider.max = 1;
    slider.step = 0.01;
    slider.value = paramStrand.value;
    slider.className = 'popover-slider color-component';
    slider.style.accentColor = component === 'r' ? '#ff0000' : component === 'g' ? '#00ff00' : '#0000ff';

    const value = document.createElement('div');
    value.className = 'popover-value';
    value.textContent = paramStrand.value.toFixed(3);

    slider.addEventListener('input', (e) => {
      const newValue = parseFloat(e.target.value);
      paramStrand.setValue(newValue);
      value.textContent = newValue.toFixed(3);
    });

    container.appendChild(header);
    container.appendChild(slider);
    container.appendChild(value);
  }

  createPopoverXYComponent(container, name, paramStrand) {
    const { config } = paramStrand;
    const { label = name, component, range, parentXY } = config;

    const header = document.createElement('div');
    header.className = 'popover-header';
    header.textContent = `${label} (${component.toUpperCase()})`;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = range[0];
    slider.max = range[1];
    slider.step = (range[1] - range[0]) / 1000;
    slider.value = paramStrand.value;
    slider.className = 'popover-slider xy-component';
    slider.style.accentColor = component === 'x' ? '#ff6600' : '#0066ff';

    const value = document.createElement('div');
    value.className = 'popover-value';
    value.textContent = paramStrand.value.toFixed(1);

    slider.addEventListener('input', (e) => {
      const newValue = parseFloat(e.target.value);
      paramStrand.setValue(newValue);
      value.textContent = newValue.toFixed(1);
    });

    container.appendChild(header);
    container.appendChild(slider);
    container.appendChild(value);
  }

  createPopoverToggle(container, name, paramStrand) {
    const { config } = paramStrand;

    const toggleContainer = document.createElement('div');
    toggleContainer.className = 'toggle-container';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = paramStrand.value > 0.5;
    toggle.className = 'popover-toggle';

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'toggle-label';
    toggleLabel.textContent = toggle.checked ? 'ON' : 'OFF';

    toggle.addEventListener('change', (e) => {
      const newValue = e.target.checked ? 1.0 : 0.0;
      paramStrand.setValue(newValue);
      toggleLabel.textContent = e.target.checked ? 'ON' : 'OFF';
    });

    toggleContainer.appendChild(toggle);
    toggleContainer.appendChild(toggleLabel);

    container.appendChild(toggleContainer);
  }

  showPopover(paramName, targetElement) {
    console.log(`🎪 WidgetManager.showPopover called for '${paramName}'`);

    this.hidePopover(); // Hide any existing popover

    const paramStrand = this.env.getParameterStrand(paramName);
    console.log(`🔗 Parameter strand from env:`, paramStrand);

    if (!paramStrand) {
      console.log(`❌ Cannot show popover - no parameter strand found for '${paramName}'`);
      return;
    }

    console.log(`✨ Creating popover for '${paramName}'`);
    this.activePopover = this.createPopover(paramName, paramStrand, targetElement);
    this.popovers.set(paramName, this.activePopover);
    console.log(`✅ Popover created and stored`);
  }

  hidePopover() {
    if (this.activePopover) {
      this.activePopover.classList.remove('visible');
      setTimeout(() => {
        if (this.activePopover && this.activePopover.parentNode) {
          this.activePopover.remove();
        }
        this.activePopover = null;
      }, 200);
    }
  }

  setupHoverDetection(editor) {
    // TODO: Integrate with CodeMirror or editor to detect parameter hovers
    // This would analyze the text content and create hover zones for declared parameters
  }

  destroy() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    this.widgets.clear();
    this.popovers.clear();
    if (this.panel) {
      this.panel.remove();
    }
  }
}

export { WidgetManager };