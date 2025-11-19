## `@lumen-chain/sdk`

TypeScript SDK for the Lumen Cosmos chain. The package exposes:

- Read-only `LumenClient` (RPC + REST helpers per custom module).
- `LumenSigningClient` with gasless detection, PQC dual-signing (Dilithium3), and optional fee helpers.
- High-level `LumenSDK` shortcuts that bundle tx composers + `signAndBroadcast`.
- Utility namespaces for wallets, coins, domains, and PQC keystore helpers.

The SDK targets Node.js 18+/Electron environments. Browser builds are supported for read-only flows, but PQC helpers rely on Node APIs (`fs`, `os`) because the official keystore lives under `~/.lumen/pqc_keys`.

### Install

```bash
npm install @lumen-chain/sdk
```

### Quick start

```ts
import { LumenClient, LumenSigningClient, utils } from "@lumen-chain/sdk";

// Read-only client
// Override these if you connect to older nodes that still expose 26657/1317.
const endpoints = { rpc: "http://127.0.0.1:27657", rest: "http://127.0.0.1:2327" };
const client = await LumenClient.connect(endpoints);
console.log(await client.getHeight());
console.log(await client.dns().resolve("example", "lumen"));

// Signing client + PQC
const signer = await utils.walletFromMnemonic(process.env.MNEMONIC!, "lmn");
const signing = await LumenSigningClient.connectWithSigner(signer, endpoints);
const address = (await signer.getAccounts())[0].address;
const msg = client.dns().msgRegister(address, { domain: "example", ext: "lumen", durationDays: 30 });
const res = await signing.signAndBroadcast(address, [msg], utils.gas.zeroFee());
console.log("Tx hash:", res.transactionHash);
```

### PQC helpers

Lumen requires Dilithium signatures on every EOA transaction. The SDK mirrors the Go CLI:

```ts
import { pqc } from "@lumen-chain/sdk";

const { publicKey, privateKey } = pqc.createKeyPair();    // Dilithium3
const store = await pqc.PqcKeyStore.open();               // defaults to ~/.lumen/pqc_keys
await store.saveKey({ name: "my-key", scheme: "dilithium3", publicKey, privateKey, createdAt: new Date() });
await store.linkAddress("lmn1...", "my-key");
```

`MsgLinkAccountPQC` enforces both a minimum spendable balance and a proof-of-work challenge (`sha256(pubKey || nonce)` must have `pow_difficulty_bits` leading zeros). Use `pqc.computePowNonce(pubKey, bits)` to mine the nonce before broadcasting and include it via the `powNonce` field on `MsgLinkAccountPQC`.

During `signAndBroadcast`, the client reads the local keystore, checks on-chain PQC params/accounts through the REST API, produces a `lumen.pqc.v1.PQCSignatures` extension, and re-signs the TxBody so the Ed25519 signature stays valid.

#### Back up / restore a dual signer (mnemonic + PQC key)

```ts
const store = await pqc.PqcKeyStore.open();
const pqcKey = store.getKey("my-key");
if (!pqcKey) throw new Error("missing PQC key");

const backup = pqc.exportDualSigner({
  mnemonic,
  pqcKey,
  address: "lmn1...",           // optional; links address when importing
});
await fs.promises.writeFile("dual-key.json", JSON.stringify(backup, null, 2));

// ...later, on another workstation
const payload = await fs.promises.readFile("dual-key.json", "utf8");
await pqc.importDualSigner(payload, {
  homeDir: "/tmp/lumen",        // defaults to ~/.lumen
  overwrite: true,              // allow replacing existing key names
});
```

#### Updating the Dilithium WASM (maintainers)

The `dilithium3.wasm` blob is generated from `integrations/utils/pqc-wasm` so every integration can share the same Go->WASM build. To regenerate it (e.g. after bumping Go or Circl):

```bash
cd integrations/npm/sdk
npm run pqc:build   # runs ../utils/pqc-wasm/{build,sync}.sh
```

This compiles the WASM into `integrations/utils/pqc-wasm/dist/` and syncs it back into `src/pqc/`. Run `npm run build` afterward to refresh `dist/pqc/dilithium3.wasm`.

### Modules & APIs

- `client.{dns,gateways,releases,tokenomics,gov,pqc}()` expose REST queries plus tx composers (EncodeObjects ready for cosmjs).
- `utils` namespace: wallet derivation, mnemonic/address helpers, domain splitters, `coin` helpers, gasless detection.
- `pqc` namespace: keystore, Dilithium key generation, sign-bytes helpers, constants, proto builders.
- `LumenSDK`: opinionated shortcuts (register domain, create contract, publish release, etc.) that call `signAndBroadcast` for you.

#### Governance actions

| Helper | Msg type | Payload summary |
|--------|----------|-----------------|
| `sdk.submitProposal(proposer, payload)` | `/cosmos.gov.v1.MsgSubmitProposal` | `payload.messages` is an array of `Any`; `initialDeposit` is `Coin[]`; `title`, `summary`, `metadata`, and `expedited` are optional strings/boolean. |
| `sdk.depositToProposal(depositor, { proposalId, amount })` | `/cosmos.gov.v1.MsgDeposit` | `proposalId` accepts `number|string|Long`; `amount` is `Coin[]`. |
| `sdk.voteOnProposal(voter, { proposalId, option })` | `/cosmos.gov.v1.MsgVote` | `option` is one of the `VoteOption` enum values (YES/NO/ABSTAIN/NO_WITH_VETO). |
| `sdk.voteWeightedOnProposal(voter, { proposalId, options })` | `/cosmos.gov.v1.MsgVoteWeighted` | `options` is an array of `WeightedVoteOption` entries (`{ option, weight }`). |

> Governance scope: only DNS, gateways, release, and the soft tokenomics knobs (`tx_tax_rate`, `min_send_ulmn`, `distribution_interval_blocks`) accept `MsgUpdateParams`. All Cosmos SDK keepers (`x/auth`, `x/bank`, `x/staking`, `x/distribution`, `x/consensus`, `x/gov`, `x/pqc`) are wired to an internal `gov-immutable` authority, so proposals that try to mutate them (including quorum/threshold defaults) are rejected on-chain.

Use `client.gov().msg*` if you need the raw EncodeObjects, or the REST helpers (`client.gov().params()`, `client.gov().proposals({ status, pageKey, ... })`, etc.) for dashboards.

### Protobuf sync & codegen

The repo pulls `.proto` files directly from the canonical chain repo. To refresh:

```bash
cd integrations/npm/sdk
npm run sync:proto   # clones https://github.com/network-lumen/blockchain proto/
npm run gen:proto    # buf generate --template buf.gen.ts.yaml
```

`buf.lock` keeps exact dependency SHAs; check it in when protos change.

### Scripts

- `npm run build` – tsup build (ESM + d.ts)
- `npm run dev` – watch build for development
- `npm run test` – vitest unit tests (logic-level; PQC keystore tests are Node-only)
- `npm run lint` – `tsc --noEmit`
- `npm run sync:proto` / `npm run gen:proto`
- `npm run docker:node` – build a Docker image + single-node localnet (RPC/REST/gRPC exposed on localhost)
- `npm run test:docker` – spin up the Docker node, run the SDK smoke test end-to-end, then shut the node down (set `KEEP_CONTAINER=1` to keep it running afterward)
- `npm run sdk:smoke` – run an end-to-end script that links a PQC key and sends a bank transaction through the running node

### Dockerized smoke test

You can exercise the SDK against a local Dockerized node:

1. `npm run docker:node` (requires Docker, `jq`, `python3`, `curl`). This downloads the published `lumend` binary from [v1.0.1](https://github.com/network-lumen/blockchain/releases/tag/v1.0.1) (override via `LUMEN_RELEASE_URL`), packs it into a slim runtime image, initializes a single-node network under `artifacts/docker-node/`, and exposes RPC/REST/gRPC on `127.0.0.1:{27657,2327,9190}`. The validator mnemonic is stored in `artifacts/docker-node/validator.json`.
   - `npm run test:docker` automates steps 1–3 below and shuts the container down afterward (use `KEEP_CONTAINER=1 npm run test:docker` if you want to keep it running). To test another release tag, set `LUMEN_RELEASE_URL=https://github.com/network-lumen/blockchain/releases/download/<tag>/lumend-<tag>-linux-amd64.tar.gz`.
2. `npm run sdk:smoke` builds the SDK and executes `scripts/sdk_smoke.mjs`, which:
   - derives the validator signer from the mnemonic,
   - creates/imports a Dilithium key in `~/.lumen/pqc_keys` (or `$LUMEN_PQC_HOME`),
   - links the PQC key on-chain if needed,
   - sends `1,000,000 ulmn` to a freshly generated wallet via `utils.msg.bankSend`,
   - prints the resulting balances.
3. When finished, stop the node with `docker rm -f lumen-local-node` (or reuse it for manual testing).

Override endpoints via `LUMEN_RPC`, `LUMEN_REST`, `LUMEN_GRPC`, and customize the PQC store via `LUMEN_PQC_HOME`.

#### Using a tagged chain release

The script caches the archive under `artifacts/bin-cache/` and reuses it until you set `FORCE_LUMEN_DOWNLOAD=1`. By default we pin to `v1.0.1`; for future releases, set `LUMEN_RELEASE_URL` to the new asset (e.g. `https://github.com/network-lumen/blockchain/releases/download/v1.0.1/linux-amd64-v1.0.1.tar.gz`). Both `.zip` and `.tar.gz` archives are supported—set the env var to whichever format the release publishes and the helper will auto-detect it.

### Future integrations

This SDK lives under `integrations/npm/`. Additional directories (mobile bindings, gateway agents, etc.) will join the folder as they graduate; see `integrations/README.md` for the roadmap placeholder.
