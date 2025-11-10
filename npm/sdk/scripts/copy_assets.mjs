import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const distRoot = path.join(root, "dist");
const distPqc = path.join(distRoot, "pqc");
const srcDir = path.join(root, "src", "pqc");

await mkdir(distPqc, { recursive: true });
await Promise.all([
  copyFile(path.join(srcDir, "dilithium3.wasm"), path.join(distPqc, "dilithium3.wasm")),
  copyFile(path.join(srcDir, "wasm_exec.js"), path.join(distPqc, "wasm_exec.js")),
  copyFile(path.join(srcDir, "dilithium3.wasm"), path.join(distRoot, "dilithium3.wasm")),
  copyFile(path.join(srcDir, "wasm_exec.js"), path.join(distRoot, "wasm_exec.js")),
]);
