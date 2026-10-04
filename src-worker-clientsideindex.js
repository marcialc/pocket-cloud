// **Client-side (browser):**
// index.html — same .wasm file
const module = await createBinjgb({
  canvas: document.getElementById('screen'),
  wasmBinary: await fetch('/binjgb.wasm').then(r => r.arrayBuffer()),
});
module.run(); // 60fps interactive loop
