// Token-based syntax highlighter using the parser's grammar knowledge
class SimpleColorizer {
  constructor() {
    // VS Code Dark+ colors
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

  highlight(code) {
    try {
      // Try AST-based highlighting if parser is available
      if (typeof g !== 'undefined') {
        return this.astHighlight(code);
      }
    } catch (e) {
      // Fall back to simple highlighting
    }
    
    return this.simpleHighlight(code);
  }

  astHighlight(code) {
    try {
      const match = g.match(code);
      if (match.failed()) {
        return this.simpleHighlight(code);
      }
      
      // Create a semantic action for syntax highlighting
      const highlightSem = g.createSemantics().addOperation('highlight', {
        // Program
        Program_top(_sp1, stmts, _sp2) {
          return _sp1.highlight() + stmts.highlight() + _sp2.highlight();
        },
        
        // Statements
        SpindleDef(_kw, name, _lp, params, _rp, _dc, outs, body) {
          return `${this.colorKeyword(_kw.sourceString)} ${this.colorInstance(name.sourceString)}${_lp.highlight()}${params.highlight()}${_rp.highlight()} ${this.colorOperator(_dc.sourceString)} ${outs.highlight()} ${body.highlight()}`;
        },
        
        DisplayStmt(_kw, _lp, args, _rp) {
          return `${this.colorKeyword(_kw.sourceString)}${_lp.highlight()}${args.highlight()}${_rp.highlight()}`;
        },
        
        Direct(name, _sp, outs, _sp2, _eq, _sp3, exp) {
          return `${this.colorInstance(name.sourceString)}${_sp.highlight()}${outs.highlight()}${_sp2.highlight()} ${this.colorOperator(_eq.sourceString)} ${_sp3.highlight()}${exp.highlight()}`;
        },
        
        CallInstance(name, _lp, args, _rp, _dc, inst, outs) {
          return `${name.highlight()}${_lp.highlight()}${args.highlight()}${_rp.highlight()} ${this.colorOperator(_dc.sourceString)} ${this.colorInstance(inst.sourceString)} ${outs.highlight()}`;
        },
        
        // Expressions
        Primary_me(_me, _dot, field) {
          return this.colorSpecial(`me.${field.sourceString}`);
        },
        
        Primary_mouse(_mouse, _at, field) {
          return this.colorSpecial(`mouse@${field.sourceString}`);
        },
        
        Primary_strand(inst, _at, strand) {
          return this.colorStrand(`${inst.sourceString}@${strand.sourceString}`);
        },
        
        Primary_call(name, _lp, args, _rp) {
          return `${this.colorFunction(name.sourceString)}${_lp.highlight()}${args.highlight()}${_rp.highlight()}`;
        },
        
        Primary_var(name) {
          return name.sourceString; // Keep variables default color
        },
        
        // Outputs
        Outputs(_lt, ids, _gt) {
          return `${this.colorOperator('<')}${ids.highlight()}${this.colorOperator('>')}`;
        },
        
        AliasedOutputs(_lt, ids, _gt) {
          return `${this.colorOperator('<')}${ids.highlight()}${this.colorOperator('>')}`;
        },
        
        IdentList(first, _sep, rest) {
          return `${this.colorOutput(first.sourceString)}${_sep.highlight()}${rest.highlight()}`;
        },
        
        // Literals
        number(n) {
          return this.colorNumber(n.sourceString);
        },
        
        string(s) {
          return this.colorString(s.sourceString);
        },
        
        // Comments
        lineComment(c) {
          return this.colorComment(c.sourceString);
        },
        
        // Keywords
        kw(word) {
          return this.colorKeyword(word.sourceString);
        },
        
        // Operators
        sym(op) {
          return this.colorOperator(op.sourceString);
        },
        
        // Default: pass through spaces and other text
        _terminal() {
          return this.sourceString;
        },
        
        _iter(...children) {
          return children.map(c => c.highlight()).join('');
        }
      });
      
      // Add color methods to the semantic operation
      highlightSem.addOperation('colorKeyword', function(text) {
        return `<span style="color: #569CD6; font-weight: 500;">${text}</span>`;
      });
      
      highlightSem.addOperation('colorFunction', function(text) {
        const builtins = ['sin', 'cos', 'tan', 'sqrt', 'abs', 'circle', 'threshold', 'compose'];
        const color = builtins.includes(text) ? '#4EC9B0' : '#DCDCAA';
        return `<span style="color: ${color};">${text}</span>`;
      });
      
      highlightSem.addOperation('colorSpecial', function(text) {
        return `<span style="color: #4FC1FF;">${text}</span>`;
      });
      
      highlightSem.addOperation('colorStrand', function(text) {
        return `<span style="color: #87CEEB;">${text}</span>`;
      });
      
      highlightSem.addOperation('colorInstance', function(text) {
        return `<span style="color: #4169E1;">${text}</span>`;
      });
      
      highlightSem.addOperation('colorOutput', function(text) {
        return `<span style="color: #87CEEB;">${text}</span>`;
      });
      
      highlightSem.addOperation('colorNumber', function(text) {
        return `<span style="color: #B5CEA8;">${text}</span>`;
      });
      
      highlightSem.addOperation('colorString', function(text) {
        return `<span style="color: #CE9178;">${text}</span>`;
      });
      
      highlightSem.addOperation('colorComment', function(text) {
        return `<span style="color: #6A9955; font-style: italic;">${text}</span>`;
      });
      
      highlightSem.addOperation('colorOperator', function(text) {
        return `<span style="color: #D4D4D4;">${text}</span>`;
      });
      
      return highlightSem(match).highlight();
      
    } catch (e) {
      console.warn('AST highlighting failed:', e);
      return this.simpleHighlight(code);
    }
  }

  simpleHighlight(code) {
    let result = code;
    
    // String literals FIRST (before anything else can interfere)
    result = result.replace(/"[^"]*"/g, '<span style="color: #CE9178;">$&</span>');
    
    // Comments 
    result = result.replace(/(\/\/.*)/g, '<span style="color: #6A9955; font-style: italic;">$1</span>');
    
    // Numbers
    result = result.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span style="color: #B5CEA8;">$1</span>');
    
    // Special identifiers (me.x, mouse.y)
    result = result.replace(/\b(me|mouse)\.[a-zA-Z_]\w*/g, '<span style="color: #4FC1FF;">$&</span>');
    
    // Core WEFT keywords
    result = result.replace(/\b(display|spindle)\b/g, '<span style="color: #569CD6; font-weight: 500;">$1</span>');
    
    // WEFT functions  
    result = result.replace(/\b(circle|threshold|compose)\b/g, '<span style="color: #DCDCAA;">$1</span>');
    
    // Math functions
    result = result.replace(/\b(sin|cos|tan|sqrt|abs|min|max|floor|ceil)\b/g, '<span style="color: #4EC9B0;">$1</span>');
    
    // Control keywords
    result = result.replace(/\b(if|then|else|let|for|in|to|not|and|or)\b/g, '<span style="color: #C586C0;">$1</span>');
    
    // Instance names (before ::) - dark blue
    result = result.replace(/\b([a-zA-Z_]\w*)(?=\s*::)/g, '<span style="color: #1e3a8a; font-weight: 600;">$1</span>');
    
    // Strand access (myCircle@result) - keep simple
    result = result.replace(/\b([a-zA-Z_]\w*)@([a-zA-Z_]\w*)\b/g, '<span style="color: #1e3a8a;">$1</span><span style="color: #94A3B8;">@</span><span style="color: #60A5FA;">$2</span>');
    
    return result;
  }
}