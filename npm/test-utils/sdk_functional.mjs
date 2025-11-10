#!/usr/bin/env node
import assert from "node:assert/strict";
import process from "node:process";

import { LumenSDK, utils } from "../sdk/dist/index.js";
import { setupTestEnv, expectSuccess, sleep, uniqueSuffix } from "./lib/test_env.mjs";

async function main() {
  const env = await setupTestEnv();
  const sdk = new LumenSDK(env.client);
  const summary = {
    dns: await runDnsFlow(env, sdk),
    gateways: await runGatewaysFlow(env, sdk),
    releases: await runReleaseFlow(env),
    queries: await runQueryCoverage(env),
  };

  console.log(JSON.stringify(summary, null, 2));
}

async function runDnsFlow(env, sdk) {
  const dnsParams = await env.client.dns().params().catch(() => ({}));
  const graceDays = Number(dnsParams?.params?.graceDays ?? dnsParams?.params?.grace_days ?? 7);
  const auctionDays = Number(dnsParams?.params?.auctionDays ?? dnsParams?.params?.auction_days ?? 7);
  const domain = `sdk${uniqueSuffix()}`;
  const ext = "lmn";
  const fqdn = `${domain}.${ext}`;
  const initialRecords = [{ key: "ip4", value: "1.2.3.4" }];

  await expectSuccess(
    sdk.registerDomain(env.validator.address, { domain, ext, records: initialRecords, durationDays: 30 }),
    "dns register",
  );

  await sleep(500);

  const domainInfo = await env.client.dns().domain(fqdn);
  assert.ok(domainInfo?.domain?.owner === env.validator.address, "domain owner mismatch after register");

  await sleep(1200);

  await expectSuccess(
    sdk.updateDomain(env.validator.address, { domain, ext, records: [{ key: "txt", value: "updated" }], powNonce: 0 }),
    "dns update",
  );

  await expectSuccess(
    sdk.renewDomain(env.validator.address, { domain, ext, durationDays: 30 }),
    "dns renew",
  );

  const newOwner = await utils.createWallet(128);
  await expectSuccess(
    sdk.transferDomain(env.validator.address, { domain, ext, newOwner: newOwner.address }),
    "dns transfer",
  );

  const transferred = await env.client.dns().domain(fqdn);
  assert.ok(transferred?.domain?.owner === newOwner.address, "transferee does not own domain");

  // Auction scenario
  const auctionDomain = `auction${uniqueSuffix()}`;
  const auctionFqdn = `${auctionDomain}.${ext}`;
  const now = Math.floor(Date.now() / 1000);
  const graceSeconds = graceDays * 24 * 3600;
  const auctionSeconds = auctionDays * 24 * 3600;
  const activeAuctionExpire = now - graceSeconds - Math.max(1, Math.floor(auctionSeconds / 2));
  const expiredAuctionExpire = now - graceSeconds - auctionSeconds - 100;

  await expectSuccess(
    env.client.signAndBroadcast(
      env.validator.address,
      [env.client.dns().msgCreateDomain(env.validator.address, {
        index: auctionFqdn,
        name: auctionFqdn,
        owner: env.validator.address,
        records: [],
        expireAt: activeAuctionExpire,
      })],
      env.zeroFee,
    ),
    "dns create domain (auction seed)",
  );

  await expectSuccess(
    sdk.bidOnDomain(env.validator.address, { domain: auctionDomain, ext, amount: "600000000" }),
    "dns bid on domain",
  );

  await sleep(500);
  await expectSuccess(
    env.client.signAndBroadcast(
      env.validator.address,
      [env.client.dns().msgUpdateDomain(env.validator.address, {
        index: auctionFqdn,
        name: auctionFqdn,
        owner: env.validator.address,
        records: [],
        expireAt: expiredAuctionExpire,
        powNonce: 0,
      })],
      env.zeroFee,
    ),
    "dns force expire domain for settlement",
  );

  await expectSuccess(
    sdk.settleDomain(env.validator.address, { domain: auctionDomain, ext }),
    "dns settle domain",
  );

  return { fqdn, newOwner: newOwner.address };
}

async function runGatewaysFlow(env, sdk) {
  const metadata = `functional-${uniqueSuffix()}`;
  await expectSuccess(
    sdk.registerGateway(env.validator.address, { payout: env.validator.address, metadata }),
    "gateway register",
  );

  await sleep(500);
  const gatewayList = await env.client.gateways().gateways({ limit: 100 });
  const gateway = gatewayList?.gateways?.find(
    (entry) => entry?.metadata === metadata && entry?.operator === env.validator.address,
  );
  assert.ok(gateway, "gateway not found after register");
  const gatewayId = Number(gateway.id);
  assert.ok(Number.isFinite(gatewayId), "gateway id missing from query");

  await expectSuccess(
    sdk.updateGateway(env.validator.address, { gatewayId, metadata: `${metadata}-updated`, active: true }),
    "gateway update",
  );

  const contractMetadata = `functional-contract-${uniqueSuffix()}`;
  await expectSuccess(
    sdk.createContract(env.validator.address, {
      gatewayId,
      priceUlmn: 200_000,
      storageGbPerMonth: 10,
      networkGbPerMonth: 5,
      monthsTotal: 1,
      metadata: contractMetadata,
    }),
    "gateway contract create",
  );

  await sleep(500);
  const contracts = await env.client.gateways().contracts({ client: env.validator.address, limit: 50 });
  const contract = contracts?.contracts?.find(
    (entry) => Number(entry?.gateway_id ?? entry?.gatewayId) === gatewayId && entry?.metadata === contractMetadata,
  );
  assert.ok(contract, "contract not found after creation");
  const contractId = Number(contract.id);
  assert.ok(Number.isFinite(contractId), "contract id missing from query");

  await sleep(1500);

  await expectSuccess(
    sdk.claimGatewayPayment(env.validator.address, contractId),
    "gateway claim payment",
  );

  await expectSuccess(
    sdk.finalizeContract(env.validator.address, contractId),
    "gateway finalize contract",
  );

  const finalContract = await env.client.gateways().contract(contractId);
  assert.ok(
    finalContract?.contract?.status === "CONTRACT_STATUS_FINALIZED",
    "contract not finalized",
  );

  // Cancellation path
  const cancelMetadata = `cancel-${uniqueSuffix()}`;
  await expectSuccess(
    sdk.createContract(env.validator.address, {
      gatewayId,
      priceUlmn: 150_000,
      storageGbPerMonth: 5,
      networkGbPerMonth: 2,
      monthsTotal: 2,
      metadata: cancelMetadata,
    }),
    "gateway contract create (cancel)",
  );

  await sleep(500);
  const cancelContracts = await env.client.gateways().contracts({ client: env.validator.address, limit: 50 });
  const cancelTarget = cancelContracts?.contracts?.find(
    (entry) => Number(entry?.gateway_id ?? entry?.gatewayId) === gatewayId && entry?.metadata === cancelMetadata,
  );
  assert.ok(cancelTarget, "cancel target not found");

  await expectSuccess(
    sdk.cancelContract(env.validator.address, Number(cancelTarget.id)),
    "gateway cancel contract",
  );

  return {
    gatewayId,
    contractId,
    contractStatus: finalContract.contract.status,
  };
}

async function runReleaseFlow(env) {
  const numericSuffix = Math.floor(Date.now() / 1000);
  const version = `0.0.${numericSuffix}`;
  const release = {
    version,
    channel: "stable",
    notes: "functional test release",
    artifacts: [
      {
        platform: "linux",
        kind: "tar.gz",
        sha256Hex: "a".repeat(64),
        urls: ["https://example.com/artifact.tar.gz"],
        signatures: [],
      },
    ],
  };

  await expectSuccess(
    env.client.signAndBroadcast(
      env.validator.address,
      [env.client.releases().msgPublishRelease(env.validator.address, release)],
      env.zeroFee,
    ),
    "release publish",
  );

  const byVersion = await env.client.releases().byVersion(version);
  const published = byVersion?.release;
  assert.ok(published?.id, "published release not found");
  const releaseId = published.id;

  await expectSuccess(
    env.client.signAndBroadcast(
      env.validator.address,
      [env.client.releases().msgMirrorRelease(env.validator.address, {
        id: releaseId,
        artifactIndex: 0,
        newUrls: ["https://mirror.example.com/artifact.tar.gz"],
      })],
      env.zeroFee,
    ),
    "release mirror",
  );

  await expectSuccess(
    env.client.signAndBroadcast(
      env.validator.address,
      [env.client.releases().msgYankRelease(env.validator.address, releaseId)],
      env.zeroFee,
    ),
    "release yank",
  );

  const latest = await env.client.releases().release(releaseId);
  assert.ok(latest?.release?.yanked, "release not yanked");

  return {
    releaseId,
    version,
    channel: release.channel,
    yanked: latest.release.yanked,
  };
}

async function runQueryCoverage(env) {
  const dnsParams = await env.client.dns().params();
  const gatewayParams = await env.client.gateways().params();
  const releaseParams = await env.client.releases().params();
  const tokenomicsParams = await env.client.tokenomics().params();
  const pqcParams = await env.client.pqc().params();

  return {
    dnsParams: Boolean(dnsParams?.params),
    gatewayParams: Boolean(gatewayParams?.params),
    releaseParams: Boolean(releaseParams?.params),
    tokenomicsParams: Boolean(tokenomicsParams?.params),
    pqcPolicy: pqcParams?.params?.policy,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
