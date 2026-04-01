#!/usr/bin/env node
import assert from "node:assert/strict";
import process from "node:process";

import { LumenSDK, utils } from "../sdk/dist/index.js";
import { setupTestEnv, expectSuccess, sleep, uniqueSuffix } from "./lib/test_env.mjs";

function normalizeReleaseStatus(status) {
  if (status === 0 || status === "PENDING") return "PENDING";
  if (status === 1 || status === "VALIDATED") return "VALIDATED";
  if (status === 2 || status === "REJECTED") return "REJECTED";
  if (status === 3 || status === "EXPIRED") return "EXPIRED";
  return String(status ?? "UNRECOGNIZED");
}

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
  const domain = `sdk${uniqueSuffix()}`;
  const ext = "lmn";
  const fqdn = `${domain}.${ext}`;
  const initialRecords = [{ key: "ip4", value: "1.2.3.4" }];
  const seededAuctionDomain = "sdk-functional-auction";
  const seededAuctionFqdn = `${seededAuctionDomain}.${ext}`;
  const seededSettleDomain = "sdk-functional-settle";
  const seededSettleFqdn = `${seededSettleDomain}.${ext}`;
  const seededBidAmount = "600000000";

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

  // Auction scenario seeded in docker_localnet.sh for the 1.6.x public Msg surface.
  const seededAuctionInfo = await env.client.dns().domain(seededAuctionFqdn);
  assert.ok(seededAuctionInfo?.domain?.index === seededAuctionFqdn, "seeded auction domain missing");

  await expectSuccess(
    sdk.bidOnDomain(env.validator.address, {
      domain: seededAuctionDomain,
      ext,
      amount: seededBidAmount,
    }),
    "dns bid on domain",
  );

  await sleep(500);
  const seededAuctionState = await env.client.dns().auction(seededAuctionFqdn);
  assert.equal(
    seededAuctionState?.auction?.highestBid ?? seededAuctionState?.auction?.highest_bid,
    seededBidAmount,
    "seeded auction bid amount mismatch",
  );
  assert.equal(
    seededAuctionState?.auction?.bidder,
    env.validator.address,
    "seeded auction bidder mismatch",
  );

  await expectSuccess(
    sdk.settleDomain(env.validator.address, { domain: seededSettleDomain, ext }),
    "dns settle domain",
  );

  const settled = await env.client.dns().domain(seededSettleFqdn);
  assert.equal(settled?.domain?.owner, env.validator.address, "settled domain owner mismatch");

  let settleAuctionRemoved = false;
  try {
    await env.client.dns().auction(seededSettleFqdn);
  } catch {
    settleAuctionRemoved = true;
  }
  assert.ok(settleAuctionRemoved, "settled auction should be removed");

  return {
    fqdn,
    newOwner: newOwner.address,
    seededAuctionFqdn,
    seededSettleFqdn,
  };
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
  assert.equal(published.publisher, env.validator.address, "release publisher mismatch");
  assert.equal(
    normalizeReleaseStatus(published.status),
    "PENDING",
    "published release should remain pending until authority validation",
  );
  assert.equal(published.yanked, false, "published release should not be yanked");

  const fetched = await env.client.releases().release(releaseId);
  assert.equal(fetched?.release?.id, releaseId, "release lookup by id mismatch");
  assert.equal(fetched?.release?.version, version, "release version mismatch");

  const releaseList = await env.client.releases().releases({ page: 1, limit: 200 });
  const listedReleases = Array.isArray(releaseList?.releases) ? releaseList.releases : [];
  assert.ok(
    listedReleases.some(
      (entry) =>
        String(entry?.id ?? "") === String(releaseId) ||
        String(entry?.version ?? "") === String(version),
    ),
    "release list missing published release",
  );

  let latestPendingHidden = false;
  try {
    await env.client.releases().latestCanon({
      channel: release.channel,
      platform: release.artifacts[0].platform,
      kind: release.artifacts[0].kind,
    });
  } catch (err) {
    latestPendingHidden = String(err?.message || err).includes("404");
  }
  assert.ok(latestPendingHidden, "pending release should not appear in latest query");

  return {
    releaseId,
    version,
    channel: release.channel,
    status: normalizeReleaseStatus(published.status),
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
