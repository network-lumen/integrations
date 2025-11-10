import type { EncodeObject } from "@cosmjs/proto-signing";

import { BaseModule } from "./base.js";
import { joinRest } from "../rest.js";
import {
  MsgCancelContract,
  MsgClaimPayment,
  MsgCreateContract,
  MsgFinalizeContract,
  MsgRegisterGateway,
  MsgUpdateGateway,
  MsgUpdateParams,
} from "../types/lumen/gateway/v1/tx.js";
import type { Params } from "../types/lumen/gateway/v1/params.js";

export type ContractFilters = {
  status?: string;
  client?: string;
  gatewayId?: string | number;
  offset?: number;
  limit?: number;
};

export class GatewaysModule extends BaseModule {
  constructor(restEndpoint?: string) {
    const base = restEndpoint ? joinRest(restEndpoint, "/lumen/gateway/v1") : undefined;
    super(base);
  }

  // ---- Queries -------------------------------------------------------------

  params() {
    return this.get("/params");
  }

  authority() {
    return this.get("/authority");
  }

  moduleAccounts() {
    return this.get("/module_accounts");
  }

  gateways(filters: { offset?: number; limit?: number } = {}) {
    return this.get("/gateways", pagination(filters.offset, filters.limit));
  }

  gateway(id: string | number) {
    return this.get(`/gateways/${encodeURIComponent(String(id))}`);
  }

  contracts(filters: ContractFilters = {}) {
    const query: Record<string, string> = {};
    if (filters.status) query.status = String(filters.status);
    if (filters.client) query.client = String(filters.client);
    if (filters.gatewayId != null) query.gateway_id = String(filters.gatewayId);
    if (filters.offset != null) query.offset = String(filters.offset);
    if (filters.limit != null) query.limit = String(filters.limit);
    return this.get("/contracts", query);
  }

  contract(id: string | number) {
    return this.get(`/contracts/${encodeURIComponent(String(id))}`);
  }

  // ---- Tx composers --------------------------------------------------------

  msgUpdateParams(authority: string, params: Params): EncodeObject {
    return {
      typeUrl: "/lumen.gateway.v1.MsgUpdateParams",
      value: MsgUpdateParams.fromPartial({ authority, params }),
    };
  }

  msgRegisterGateway(operator: string, payload: { payout: string; metadata?: string }): EncodeObject {
    return {
      typeUrl: "/lumen.gateway.v1.MsgRegisterGateway",
      value: MsgRegisterGateway.fromPartial({
        operator,
        payout: payload.payout,
        metadata: payload.metadata ?? "",
      }),
    };
  }

  msgUpdateGateway(operator: string, payload: {
    gatewayId: string | number;
    payout?: string | null;
    metadata?: string | null;
    active?: boolean | null;
  }): EncodeObject {
    return {
      typeUrl: "/lumen.gateway.v1.MsgUpdateGateway",
      value: MsgUpdateGateway.fromPartial({
        operator,
        gatewayId: Number(payload.gatewayId),
        payout: payload.payout ?? undefined,
        metadata: payload.metadata ?? undefined,
        active: payload.active ?? undefined,
      }),
    };
  }

  msgCreateContract(client: string, payload: {
    gatewayId: string | number;
    priceUlmn: string | number;
    storageGbPerMonth: string | number;
    networkGbPerMonth: string | number;
    monthsTotal: string | number;
    metadata?: string;
  }): EncodeObject {
    return {
      typeUrl: "/lumen.gateway.v1.MsgCreateContract",
      value: MsgCreateContract.fromPartial({
        client,
        gatewayId: Number(payload.gatewayId),
        priceUlmn: Number(payload.priceUlmn),
        storageGbPerMonth: Number(payload.storageGbPerMonth),
        networkGbPerMonth: Number(payload.networkGbPerMonth),
        monthsTotal: Number(payload.monthsTotal),
        metadata: payload.metadata ?? "",
      }),
    };
  }

  msgClaimPayment(operator: string, contractId: string | number): EncodeObject {
    return {
      typeUrl: "/lumen.gateway.v1.MsgClaimPayment",
      value: MsgClaimPayment.fromPartial({
        operator,
        contractId: Number(contractId),
      }),
    };
  }

  msgCancelContract(client: string, contractId: string | number): EncodeObject {
    return {
      typeUrl: "/lumen.gateway.v1.MsgCancelContract",
      value: MsgCancelContract.fromPartial({
        client,
        contractId: Number(contractId),
      }),
    };
  }

  msgFinalizeContract(finalizer: string, contractId: string | number): EncodeObject {
    return {
      typeUrl: "/lumen.gateway.v1.MsgFinalizeContract",
      value: MsgFinalizeContract.fromPartial({
        finalizer,
        contractId: Number(contractId),
      }),
    };
  }
}

function pagination(offset?: number, limit?: number) {
  const params: Record<string, string> = {};
  if (offset != null) params.offset = String(offset);
  if (limit != null) params.limit = String(limit);
  return params;
}
