#!/usr/bin/env node
import process from "node:process";

import { utils } from "../sdk/dist/index.js";
import { setupTestEnv, expectSuccess } from "./lib/test_env.mjs";

async function main() {
  const env = await setupTestEnv();
  const { client, validator, zeroFee, endpoints } = env;

  const recipient = await utils.createWallet(128);
  const sendMsg = utils.msg.bankSend(
    validator.address,
    recipient.address,
    [utils.coin.ulmn(1_000_000)],
  );
  await expectSuccess(
    client.signAndBroadcast(validator.address, [sendMsg], zeroFee),
    "bank send",
  );

  const balance = await client.getBalance(recipient.address);
  console.log("✓ Bank send confirmed");
  console.log(JSON.stringify({
    rpc: endpoints.rpc,
    rest: endpoints.rest,
    grpc: endpoints.grpc,
    validator: validator.address,
    recipient: recipient.address,
    recipientBalance: balance,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
