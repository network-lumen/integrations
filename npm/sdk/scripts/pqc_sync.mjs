#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const here = path.dirname(fileURLToPath(new URL(import.meta.url)));
const pqcRoot = path.resolve(here, "..", "..", "..", "utils", "pqc-wasm");

const result = spawnSync("bash", [path.join(pqcRoot, "sync.sh")], { stdio: "inherit" });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
