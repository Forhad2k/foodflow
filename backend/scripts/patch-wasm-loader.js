// Node cannot `import()` .wasm the way edge runtimes do; load the engine module from disk instead.
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '../node_modules/.ff-wasm-client/wasm.js');
let s = fs.readFileSync(file, 'utf8');
const start = s.indexOf('getQueryEngineWasmModule');
const end = s.indexOf('}', s.indexOf('return engine', start)) + 1;
s = s.slice(0, start) +
  "getQueryEngineWasmModule: async () => new WebAssembly.Module(require('fs').readFileSync(require('path').join(__dirname, 'query_engine_bg.wasm')))" +
  s.slice(end);
fs.writeFileSync(file, s);
