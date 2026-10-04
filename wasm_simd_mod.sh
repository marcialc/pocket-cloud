emcc -msimd128 -O3 -o binjgb.wasm binjgb.cpp

emcc binjgb.cpp \
  -msimd128 \
  -O3 \
  -sWASM=1 \
  -sMODULARIZE=1 \
  -sEXPORT_NAME='createBinjgb' \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=16MB \
  -o binjgb.wasm.js

wasm-objdump -d binjgb.wasm | grep -c "i8x16\|i32x4\|i16x8"
