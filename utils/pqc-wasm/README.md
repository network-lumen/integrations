# PQC WASM builder

Shared Go->WASM toolchain used by the JavaScript SDK (and future integrations) to expose Dilithium3 signing helpers without requiring Go at runtime.

## Layout

- `main.go` – thin wrapper around Cloudflare Circl Dilithium3 implementation exposed to JS (keygen, pub-from-priv, sign).
- `build.sh` – compiles `main.go` with `GOOS=js GOARCH=wasm` and copies the matching `wasm_exec.js` into `dist/`.
- `sync.sh` – copies the freshly built `dilithium3.wasm` into `integrations/npm/sdk/src/pqc/` (or another path you pass as an argument).

## Usage

```bash
cd integrations/utils/pqc-wasm
./build.sh          # requires Go 1.22+
./sync.sh           # copies dist/dilithium3.wasm into ../npm/sdk/src/pqc/
```

You can provide an alternate destination to `sync.sh`:

```bash
./sync.sh ../../npm/another-package/src/pqc
```

After syncing, rebuild the SDK (`npm run build`) so the packaged `dist/pqc/dilithium3.wasm` stays in sync. The `wasm_exec.js` shim remains inside each consumer because it is slightly customized for ESM environments.
