// Hover Detection System - Detects parameter names in editor and enables hover interactions
// Works with both textarea and future CodeMirror integration

class HoverDetector {
  constructor(editor, env, widgetManager) {
    this.editor = editor;
    this.env = env;
    this.widgetManager = widgetManager;
    this.hoverElements = new Map();
    this.hoverTimeout = null;
    this.isEnabled = true;
    this.overlay = null;

    this.init();
  }

  init() {
    // Create hover overlay for invisible hover zones
    this.createHoverOverlay();

    // Listen for parameter updates to refresh hover zones
    this.setupUpdateListeners();

    // Initial setup
    this.updateHoverZones();
  }

  createHoverOverlay() {
    // Create container for hover zones
    this.overlay = document.createElement('div');
    this.overlay.className = 'hover-overlay';
    this.overlay.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      pointer-events: none;
      z-index: 10;
    `;

    // Insert overlay in editor container
    const editorContainer = this.editor.parentElement;

    if (!editorContainer) {
      console.error('❌ No editor container found! Cannot create hover overlay.');
      return;
    }

    if (editorContainer.style.position !== 'relative') {
      editorContainer.style.position = 'relative';
    }

    editorContainer.appendChild(this.overlay);
  }

  setupUpdateListeners() {
    // Listen for text changes
    this.editor.addEventListener('input', () => {
      clearTimeout(this.updateTimeout);
      this.updateTimeout = setTimeout(() => {
        this.updateHoverZones();
      }, 300); // Debounce updates
    });

    // Listen for scroll
    this.editor.addEventListener('scroll', () => {
      this.syncOverlayScroll();
    });

    // Listen for resize
    window.addEventListener('resize', () => {
      this.updateHoverZones();
    });
  }

  syncOverlayScroll() {
    if (this.overlay) {
      this.overlay.scrollTop = this.editor.scrollTop;
      this.overlay.scrollLeft = this.editor.scrollLeft;
    }
  }

  updateHoverZones() {
    if (!this.isEnabled) {
      return;
    }

    // Clear existing hover elements
    this.clearHoverZones();

    const text = this.editor.value;
    const parameterNames = Array.from(this.env.parameters.keys());


    if (parameterNames.length === 0) {
      return;
    }

    // Find all parameter occurrences in text
    const parameterOccurrences = this.findParameterOccurrences(text, parameterNames);


    // Create hover zones for each occurrence
    this.createHoverZones(text, parameterOccurrences);

    // Sync scroll position
    this.syncOverlayScroll();

  }

  findParameterOccurrences(text, parameterNames) {
    const occurrences = [];
    const lines = text.split('\n');


    lines.forEach((line, lineIndex) => {
      parameterNames.forEach(paramName => {
        // Look for direct parameter references (e.g., 'l') but skip ones that are part of strand access
        const directRegex = new RegExp(`\\b${this.escapeRegex(paramName)}\\b`, 'g');
        let match;

        while ((match = directRegex.exec(line)) !== null) {
          // Check if this is NOT part of a strand access pattern (not preceded by @)
          // Also skip if it's inside parameter definition brackets < >
          const beforeChar = match.index > 0 ? line[match.index - 1] : '';
          const afterChar = match.index + paramName.length < line.length ? line[match.index + paramName.length] : '';

          // Find if we're inside < > brackets by looking for nearest < and >
          const beforeBracket = line.lastIndexOf('<', match.index);
          const afterBracket = line.indexOf('>', match.index);
          const insideBrackets = beforeBracket !== -1 && afterBracket !== -1 && beforeBracket < match.index && afterBracket > match.index;

          // If inside brackets, check if it's a parameter definition (like lvl<l>)
          let isParameterDefinition = false;
          if (insideBrackets) {
            // Look for instance name before the < bracket
            const beforeBracketText = line.substring(0, beforeBracket);
            const instanceMatch = beforeBracketText.match(/(\w+)$/);
            if (instanceMatch) {
              const instanceName = instanceMatch[1];
              // Check if this instance is a declared parameter
              isParameterDefinition = this.env.pragmas &&
                this.env.pragmas.some(pragma =>
                  ['slider', 'color', 'xy', 'toggle'].includes(pragma.type) &&
                  pragma.config &&
                  pragma.config.name === instanceName &&
                  pragma.config.strands.includes(paramName)
                );
            }
          }

          // Skip if inside parameter definition brackets or preceded by @
          if (!insideBrackets && beforeChar !== '@') {
            occurrences.push({
              line: lineIndex,
              column: match.index,
              length: paramName.length,
              paramName: paramName,
              type: 'direct_param',
              text: paramName
            });
          }
        }

        // Look for strand access patterns (e.g., 'instanceName@paramName')
        const strandRegex = new RegExp(`\\b(\\w+)@${this.escapeRegex(paramName)}\\b`, 'g');

        while ((match = strandRegex.exec(line)) !== null) {
          const instanceName = match[1];
          const fullMatch = match[0]; // e.g., "lvl@l"

          // Only highlight if the instance name matches a parameter pragma
          const matchesParameterPragma = this.env.pragmas &&
            this.env.pragmas.some(pragma =>
              ['slider', 'color', 'xy', 'toggle'].includes(pragma.type) &&
              pragma.config &&
              pragma.config.name === instanceName &&
              pragma.config.strands.includes(paramName)
            );

          if (matchesParameterPragma) {
            occurrences.push({
              line: lineIndex,
              column: match.index,
              length: fullMatch.length,
              paramName: paramName,
              type: 'strand_access',
              text: fullMatch,
              instanceName: instanceName
            });
          }
        }
      });
    });

    return occurrences;
  }

  escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
  }

  createHoverZones(text, occurrences) {

    // Clear previous hover zones
    this.overlay.innerHTML = '';

    // Get editor measurements for positioning
    const editorStyle = window.getComputedStyle(this.editor);
    const fontSize = parseFloat(editorStyle.fontSize);
    const lineHeight = parseFloat(editorStyle.lineHeight) || fontSize * 1.2;
    const paddingLeft = parseFloat(editorStyle.paddingLeft) || 0;
    const paddingTop = parseFloat(editorStyle.paddingTop) || 0;

    // Create positioned hover zones for each occurrence
    occurrences.forEach((occ, index) => {
      const hoverZone = this.createPositionedHoverZone(occ, {
        fontSize,
        lineHeight,
        paddingLeft,
        paddingTop
      });

      this.overlay.appendChild(hoverZone);
    });
  }

  createPositionedHoverZone(occurrence, measurements) {
    const { fontSize, lineHeight, paddingLeft, paddingTop } = measurements;

    // Calculate character width (approximate for monospace font)
    const charWidth = fontSize * 0.6; // Rough estimate for monospace

    // Calculate position
    const left = paddingLeft + (occurrence.column * charWidth);
    const top = paddingTop + (occurrence.line * lineHeight);
    const width = occurrence.length * charWidth;


    // Create hover element
    const hoverZone = document.createElement('div');
    let className = 'positioned-hover-zone';
    if (occurrence.type === 'strand_access') {
      className += ' strand-access';
    } else if (occurrence.type === 'parameter_definition') {
      className += ' param-definition';
    } else {
      className += ' direct-param';
    }
    hoverZone.className = className;
    hoverZone.dataset.paramName = occurrence.paramName;
    hoverZone.dataset.paramType = occurrence.type;

    hoverZone.style.cssText = `
      position: absolute;
      left: ${left}px;
      top: ${top}px;
      width: ${width}px;
      height: ${lineHeight}px;
      pointer-events: auto;
      cursor: pointer;
      background: rgba(0, 122, 255, 0.15);
      border: 1px solid rgba(0, 122, 255, 0.3);
      border-radius: 3px;
      z-index: 5;
      transition: all 0.15s ease;
    `;

    // Add hover event listeners
    hoverZone.addEventListener('mouseenter', (e) => {
      hoverZone.style.background = 'rgba(0, 122, 255, 0.25)';
      this.handleParameterHover(e, occurrence.paramName);
    });

    hoverZone.addEventListener('mouseleave', (e) => {
      hoverZone.style.background = 'rgba(0, 122, 255, 0.15)';
      this.handleParameterLeave(e);
    });

    return hoverZone;
  }

  processLineWithParameters(line, occurrences) {
    // Sort occurrences by column position
    const sortedOccurrences = occurrences.sort((a, b) => a.column - b.column);

    let result = '';
    let lastIndex = 0;

    sortedOccurrences.forEach(occ => {
      // Add transparent text before parameter
      if (occ.column > lastIndex) {
        const beforeText = line.substring(lastIndex, occ.column);
        result += this.createTransparentText(beforeText);
      }

      // Add hoverable parameter
      result += this.createHoverableParameter(occ);

      lastIndex = occ.column + occ.length;
    });

    // Add remaining transparent text
    if (lastIndex < line.length) {
      const remainingText = line.substring(lastIndex);
      result += this.createTransparentText(remainingText);
    }

    return result;
  }

  createHoverableParameter(occurrence) {
    const paramClass = occurrence.type === 'strand_access' ? 'hover-parameter strand-access' : 'hover-parameter direct-param';

    const hoverElement = `<span class="${paramClass}"
      data-param-name="${occurrence.paramName}"
      data-param-type="${occurrence.type}"
      style="
        opacity: 0.8;
        cursor: pointer;
        pointer-events: auto;
        color: transparent;
        background: rgba(0, 122, 255, 0.1);
        border-radius: 3px;
        padding: 1px 2px;
        margin: -1px -2px;
        position: relative;
        border: 1px solid rgba(0, 122, 255, 0.2);
      "
      onmouseenter="window.hoverDetector?.handleParameterHover(event, '${occurrence.paramName}')"
      onmouseleave="window.hoverDetector?.handleParameterLeave(event)"
    >${this.escapeHtml(occurrence.text)}</span>`;

    return hoverElement;
  }

  handleParameterHover(event, paramName) {
    clearTimeout(this.hoverTimeout);

    this.hoverTimeout = setTimeout(() => {
      const paramStrand = this.env.getParameterStrand(paramName);

      if (paramStrand) {
        // Calculate position for popover
        const rect = event.target.getBoundingClientRect();

        const popoverTarget = {
          getBoundingClientRect: () => rect
        };

        this.widgetManager.showPopover(paramName, popoverTarget);
      }
    }, 150); // Short delay to prevent accidental triggers
  }

  handleParameterLeave(event) {
    clearTimeout(this.hoverTimeout);

    // Hide popover after a longer delay to allow moving to popover
    this.hideTimeout = setTimeout(() => {
      // Only hide if mouse is not over the popover itself
      const popover = this.widgetManager.activePopover;
      if (popover && !popover.matches(':hover')) {
        this.widgetManager.hidePopover();
      }
    }, 200);
  }

  clearHoverZones() {
    if (this.overlay) {
      this.overlay.innerHTML = '';
    }
    this.hoverElements.clear();
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  enable() {
    this.isEnabled = true;
    this.updateHoverZones();
  }

  disable() {
    this.isEnabled = false;
    this.clearHoverZones();
  }

  destroy() {
    clearTimeout(this.hoverTimeout);
    clearTimeout(this.updateTimeout);

    if (this.overlay) {
      this.overlay.remove();
    }

    this.hoverElements.clear();

    // Remove global reference
    if (window.hoverDetector === this) {
      delete window.hoverDetector;
    }
  }
}

export { HoverDetector };