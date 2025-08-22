// Build script to compile standard.weft into JavaScript
const fs = require('fs');

// This would run in Node.js to pre-compile your stdlib
// For now, let's just set up the structure

const buildStdLib = () => {
  try {
    const stdlibCode = fs.readFileSync('./standard.weft', 'utf8');
    console.log('Found standard.weft with', stdlibCode.length, 'characters');
    
    // TODO: Parse with WEFT parser and convert to AST objects
    // For now, just copy the raw code
    const output = `// Auto-generated from standard.weft
const StandardLibraryCode = \`${stdlibCode}\`;
window.StandardLibraryCode = StandardLibraryCode;`;
    
    fs.writeFileSync('./stdlib-compiled.js', output);
    console.log('Built stdlib-compiled.js');
  } catch (e) {
    console.error('Error building stdlib:', e.message);
  }
};

if (require.main === module) {
  buildStdLib();
}

module.exports = { buildStdLib };