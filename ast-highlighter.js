// AST-based syntax highlighter using the existing Ohm parser
class ASTHighlighter {
  constructor() {
    this.colors = {
      comment: '#6A9955',        // Green
      string: '#CE9178',         // Orange/salmon  
      number: '#B5CEA8',         // Light green
      keyword: '#569CD6',        // Blue
      builtin: '#4EC9B0',        // Cyan
      function: '#DCDCAA',       // Yellow
      variable: '#9CDCFE',       // Light blue
      property: '#9CDCFE',       // Light blue
      operator: '#D4D4D4',       // Light gray
      punctuation: '#D4D4D4',    // Light gray
      specialId: '#4FC1FF',      // Bright blue
      instance: '#4FC1FF',       // Bright blue
      strand: '#C586C0'          // Magenta
    };
  }

  highlight(code) {
    try {
      // Try to parse with the existing grammar
      if (typeof g === 'undefined') {
        // Fall back to simple regex if parser not available
        return this.fallbackHighlight(code);
      }
      
      const match = g.match(code);
      if (match.failed()) {
        // If parsing fails, fall back to regex
        return this.fallbackHighlight(code);
      }

      // Create a syntax highlighting semantic operation
      if (!g._semantics || !g._semantics.operations.highlight) {
        this.createHighlightSemantics();
      }

      const semantics = g.createSemantics().addOperation('highlight', this.getHighlightActions());
      return semantics(match).highlight();
      
    } catch (e) {
      console.warn('AST highlighting failed, falling back to regex:', e);
      return this.fallbackHighlight(code);
    }
  }

  createHighlightSemantics() {
    // This will be called to set up the semantic actions
  }

  getHighlightActions() {
    return {
      Program_top(_sp1, stmts, _sp2) { 
        return stmts.children.map(s => s.highlight()).join('');
      },

      // Keywords
      kw(_word) {
        return `<span style="color: ${this.colors.keyword}; font-weight: 500;">${this.sourceString}</span>`;
      },

      // Numbers
      number(n) {
        return `<span style="color: ${this.colors.number};">${n.sourceString}</span>`;
      },

      // Strings
      string(s) {
        return `<span style="color: ${this.colors.string};">${this.escapeHtml(s.sourceString)}</span>`;
      },

      // Identifiers
      ident(i) {
        return `<span style="color: ${this.colors.variable};">${i.sourceString}</span>`;
      },

      // Comments
      lineComment(c) {
        return `<span style="color: ${this.colors.comment}; font-style: italic;">${this.escapeHtml(c.sourceString)}</span>`;
      },

      // Special cases
      kwMe(_me, _dot, field) {
        return `<span style="color: ${this.colors.specialId}; font-weight: 500;">me</span><span style="color: ${this.colors.operator};">.</span><span style="color: ${this.colors.property};">${field.sourceString}</span>`;
      },

      // Default fallback
      _terminal() {
        return this.escapeHtml(this.sourceString);
      },

      _iter(...children) {
        return children.map(c => c.highlight()).join('');
      }
    };
  }

  escapeHtml(text) {
    return text.replace(/[&<>"']/g, function(match) {
      const escape = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      };
      return escape[match];
    });
  }

  fallbackHighlight(code) {
    // Simple regex fallback
    let result = this.escapeHtml(code);
    
    // Comments - green
    result = result.replace(/(\/\/.*)/g, `<span style="color: ${this.colors.comment};">\$1</span>`);
    
    // Numbers - light green
    result = result.replace(/\b(\d+(?:\.\d+)?)\b/g, `<span style="color: ${this.colors.number};">\$1</span>`);
    
    // Keywords - blue
    result = result.replace(/\b(display|me|if|then|else|spindle|let|for|in|to|not|and|or|mouse)\b/g, `<span style="color: ${this.colors.keyword};">\$1</span>`);
    
    // Built-in functions - cyan
    result = result.replace(/\b(sin|cos|tan|sqrt|abs|circle|threshold|compose|clamp)\b/g, `<span style="color: ${this.colors.builtin};">\$1</span>`);
    
    return result;
  }
}