// Coordinate Probe System - Interactive spatial exploration tool
// Shows transparent overlay with crosshairs directly on main canvas

import { WebGLRenderer } from '../renderers/webgl-renderer.js';

class CoordinateProbe {
  constructor(canvas, env, renderer, executor) {
    this.canvas = canvas;
    this.env = env;
    this.renderer = renderer;
    this.executor = executor;
    this.isEnabled = false;
    this.overlay = null;
    this.crosshairX = 0.5;
    this.crosshairY = 0.5;
    this.isDragging = false;
    this.infoPanel = null;
    
    this.init();
  }
  
  init() {
    this.createOverlay();
    this.setupEventListeners();
  }
  
  createOverlay() {
    // Find canvas wrapper to position overlay relative to it
    const canvasWrap = document.getElementById('canvasWrap');
    if (!canvasWrap) return;
    
    // Make sure canvasWrap is positioned relative
    if (getComputedStyle(canvasWrap).position === 'static') {
      canvasWrap.style.position = 'relative';
    }
    
    // Create transparent overlay that sits on top of canvas
    this.overlay = document.createElement('div');
    this.overlay.className = 'probe-overlay';
    this.overlay.innerHTML = `
      <div class="probe-crosshair">
        <div class="crosshair-vertical"></div>
        <div class="crosshair-horizontal"></div>
      </div>
    `;
    
    // Insert overlay into canvas wrapper
    canvasWrap.appendChild(this.overlay);
    
    // Get references to crosshair elements
    this.crosshair = this.overlay.querySelector('.probe-crosshair');
    
    // Create separate information panel
    this.createInfoPanel();
  }
  
  createInfoPanel() {
    // Create information panel
    this.infoPanel = document.createElement('div');
    this.infoPanel.className = 'probe-info-panel';
    this.infoPanel.innerHTML = `
      <div class="probe-panel-header">
        <div class="probe-panel-title">Coordinate Probe</div>
        <button class="probe-panel-close" aria-label="Close probe">×</button>
      </div>
      <div class="probe-panel-content">
        <div class="coordinate-info">
          <div class="coord-label">Position:</div>
          <div class="coord-value">
            <span class="coord-x">0.500</span>, <span class="coord-y">0.500</span>
          </div>
        </div>
        <div class="transformation-pipeline">
          <div class="pipeline-title">Transformation Pipeline:</div>
          <div class="pipeline-stages"></div>
        </div>
      </div>
    `;
    
    // Insert panel into page
    document.body.appendChild(this.infoPanel);
    
    // Get references to panel elements
    this.coordX = this.infoPanel.querySelector('.coord-x');
    this.coordY = this.infoPanel.querySelector('.coord-y');
    this.pipelineStages = this.infoPanel.querySelector('.pipeline-stages');
    this.panelCloseBtn = this.infoPanel.querySelector('.probe-panel-close');
    
    // Setup close button
    this.panelCloseBtn.addEventListener('click', () => {
      this.disable();
    });
    
    // Setup panel dragging
    this.setupPanelDragging();
  }
  
  setupPanelDragging() {
    const header = this.infoPanel.querySelector('.probe-panel-header');
    let isDragging = false;
    let startX, startY, initialX, initialY;
    
    header.addEventListener('mousedown', (e) => {
      // Don't drag if clicking the close button
      if (e.target.closest('.probe-panel-close')) return;
      
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      
      // Get current position
      const rect = this.infoPanel.getBoundingClientRect();
      initialX = rect.left;
      initialY = rect.top;
      
      // Change cursor
      header.style.cursor = 'grabbing';
      this.infoPanel.style.transition = 'none';
      
      document.addEventListener('mousemove', handleDrag);
      document.addEventListener('mouseup', stopDrag);
      
      e.preventDefault();
    });
    
    const handleDrag = (e) => {
      if (!isDragging) return;
      
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      
      const newX = initialX + deltaX;
      const newY = initialY + deltaY;
      
      // Keep panel within viewport bounds
      const maxX = window.innerWidth - this.infoPanel.offsetWidth;
      const maxY = window.innerHeight - this.infoPanel.offsetHeight;
      
      const clampedX = Math.max(0, Math.min(maxX, newX));
      const clampedY = Math.max(0, Math.min(maxY, newY));
      
      this.infoPanel.style.left = clampedX + 'px';
      this.infoPanel.style.top = clampedY + 'px';
      this.infoPanel.style.right = 'auto';
    };
    
    const stopDrag = () => {
      isDragging = false;
      header.style.cursor = 'grab';
      this.infoPanel.style.transition = 'all var(--transition-normal)';
      
      document.removeEventListener('mousemove', handleDrag);
      document.removeEventListener('mouseup', stopDrag);
    };
  }
  
  setupEventListeners() {
    // Canvas clicking for crosshair positioning
    this.canvas.addEventListener('click', (e) => {
      if (!this.isEnabled) return;
      
      const rect = this.canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      
      this.setCrosshairPosition(x, y);
    });
    
    // Crosshair dragging within the overlay
    this.crosshair.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      e.preventDefault();
      e.stopPropagation();
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!this.isDragging || !this.isEnabled) return;
      
      const rect = this.canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      
      this.setCrosshairPosition(
        Math.max(0, Math.min(1, x)),
        Math.max(0, Math.min(1, y))
      );
    });
    
    document.addEventListener('mouseup', () => {
      this.isDragging = false;
    });
  }
  
  
  setCrosshairPosition(x, y) {
    this.crosshairX = x;
    this.crosshairY = y;
    
    // Update crosshair visual position (center the crosshair at the click point)
    this.crosshair.style.left = (x * 100) + '%';
    this.crosshair.style.top = (y * 100) + '%';
    
    // Update coordinate display in panel
    this.coordX.textContent = x.toFixed(3);
    this.coordY.textContent = y.toFixed(3);
    
    // Evaluate transformation pipeline
    this.evaluateTransformationPipeline(x, y);
  }
  
  evaluateTransformationPipeline(x, y) {
    if (!this.env.displayAst) {
      this.pipelineStages.innerHTML = '<div class="pipeline-empty">No display statement found</div>';
      return;
    }
    
    try {
      // Create coordinate context for evaluation
      const me = {
        x: x,
        y: y,
        t: this.env.t || 0,
        dt: this.env.dt || 0.016,
        resW: this.env.resW,
        resH: this.env.resH
      };
      
      // Evaluate the display expression
      const result = this.evaluateExpression(this.env.displayAst.args[0], me);
      
      // Build and display the pipeline
      this.buildPipelineDisplay(me, result);
      
    } catch (e) {
      this.pipelineStages.innerHTML = `<div class="pipeline-error">Evaluation error: ${e.message}</div>`;
    }
  }
  
  buildPipelineDisplay(me, finalResult) {
    // Get pixel color from canvas if possible
    let pixelColor = 'N/A';
    setTimeout(() => {
      try {
        const canvasX = Math.floor(me.x * this.canvas.width);
        const canvasY = Math.floor(me.y * this.canvas.height);
        
        // Clamp to canvas bounds
        const x = Math.max(0, Math.min(this.canvas.width - 1, canvasX));
        const y = Math.max(0, Math.min(this.canvas.height - 1, canvasY));
        
        if (this.renderer && this.renderer instanceof WebGLRenderer) {
          // For WebGL, read from GL context
          const gl = this.renderer.gl;
          if (gl) {
            const pixels = new Uint8Array(4);
            gl.readPixels(x, this.canvas.height - y - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            pixelColor = `rgba(${(pixels[0]/255).toFixed(3)}, ${(pixels[1]/255).toFixed(3)}, ${(pixels[2]/255).toFixed(3)}, ${(pixels[3]/255).toFixed(3)})`;
          }
        } else {
          // For CPU renderer, use 2D context
          const ctx = this.canvas.getContext('2d');
          if (ctx) {
            const imageData = ctx.getImageData(x, y, 1, 1);
            const data = imageData.data;
            pixelColor = `rgba(${(data[0]/255).toFixed(3)}, ${(data[1]/255).toFixed(3)}, ${(data[2]/255).toFixed(3)}, ${(data[3]/255).toFixed(3)})`;
          }
        }
        
        // Update the rendered pixel stage with actual color
        const renderedStage = this.pipelineStages.querySelector('.rendered-pixel-value');
        if (renderedStage) {
          renderedStage.textContent = pixelColor;
        }
      } catch (e) {
        console.warn('Could not read pixel color:', e);
      }
    }, 50); // Small delay to ensure rendering is complete
    
    const stages = [
      {
        label: 'Input Coordinates',
        value: `(${me.x.toFixed(3)}, ${me.y.toFixed(3)})`,
        description: 'Normalized canvas position'
      },
      {
        label: 'Canvas Pixel',
        value: `(${Math.floor(me.x * this.canvas.width)}, ${Math.floor(me.y * this.canvas.height)})`,
        description: `Canvas size: ${this.canvas.width}×${this.canvas.height}`
      },
      {
        label: 'Time Context',
        value: `t: ${me.t.toFixed(3)}`,
        description: 'Animation time'
      },
      {
        label: 'Expression Result',
        value: this.formatResult(finalResult),
        description: 'WEFT expression output'
      },
      {
        label: 'Rendered Pixel',
        value: pixelColor,
        description: 'Actual canvas color',
        class: 'rendered-pixel-value'
      }
    ];
    
    let html = '';
    stages.forEach((stage, index) => {
      const valueClass = stage.class ? `stage-value ${stage.class}` : 'stage-value';
      html += `
        <div class="pipeline-stage">
          <div class="stage-label">${stage.label}</div>
          <div class="${valueClass}">${stage.value}</div>
          <div class="stage-description">${stage.description}</div>
        </div>
      `;
      
      if (index < stages.length - 1) {
        html += '<div class="pipeline-arrow">↓</div>';
      }
    });
    
    this.pipelineStages.innerHTML = html;
  }
  
  formatResult(result) {
    if (typeof result === 'number') {
      return result.toFixed(3);
    } else if (Array.isArray(result)) {
      return `[${result.map(v => v.toFixed(3)).join(', ')}]`;
    } else if (result && typeof result === 'object') {
      return JSON.stringify(result);
    }
    return String(result);
  }
  
  
  evaluateExpression(expr, me) {
    if (!expr) return 0;
    
    try {
      // Use the executor to properly evaluate the expression
      if (this.executor) {
        return this.executor.evaluate(expr, me, this.env);
      }
      
      // Fallback: try to evaluate directly through environment strands
      if (expr.type === 'Num') {
        return expr.v;
      } else if (expr.type === 'Me') {
        return me[expr.field] || 0;
      } else if (expr.type === 'Var') {
        const strand = this.env.get(expr.name);
        if (strand && typeof strand.evalAt === 'function') {
          return strand.evalAt(me, this.env);
        }
        return 0;
      } else if (expr.type === 'Call') {
        // For function calls, try to find the function in the environment
        const strand = this.env.get(expr.name);
        if (strand && typeof strand.evalAt === 'function') {
          return strand.evalAt(me, this.env);
        }
        return 0;
      } else if (expr.type === 'Bin') {
        const left = this.evaluateExpression(expr.left, me);
        const right = this.evaluateExpression(expr.right, me);
        
        switch (expr.op) {
          case '+': return left + right;
          case '-': return left - right;
          case '*': return left * right;
          case '/': return right !== 0 ? left / right : 0;
          default: return 0;
        }
      }
      
      return 0;
    } catch (e) {
      console.warn('Expression evaluation error:', e);
      return 0;
    }
  }
  
  enable() {
    this.isEnabled = true;
    if (this.overlay) {
      this.overlay.classList.add('visible');
    }
    if (this.infoPanel) {
      this.infoPanel.classList.add('visible');
    }
    this.setCrosshairPosition(this.crosshairX, this.crosshairY);
  }
  
  disable() {
    this.isEnabled = false;
    if (this.overlay) {
      this.overlay.classList.remove('visible');
    }
    if (this.infoPanel) {
      this.infoPanel.classList.remove('visible');
    }
  }
  
  toggle() {
    if (this.isEnabled) {
      this.disable();
    } else {
      this.enable();
    }
    return this.isEnabled;
  }
  
  refresh() {
    if (this.isEnabled) {
      this.setCrosshairPosition(this.crosshairX, this.crosshairY);
    }
  }
  
  destroy() {
    if (this.overlay) {
      this.overlay.remove();
    }
    if (this.infoPanel) {
      this.infoPanel.remove();
    }
  }
}

export { CoordinateProbe };