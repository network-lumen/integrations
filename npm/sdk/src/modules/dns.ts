import type { EncodeObject } from "@cosmjs/proto-signing";

import { BaseModule } from "./base.js";
import { joinRest } from "../rest.js";
import {
  MsgBid,
  MsgCreateAuction,
  MsgCreateDomain,
  MsgDeleteAuction,
  MsgDeleteDomain,
  MsgRegister,
  MsgRenew,
  MsgSettle,
  MsgTransfer,
  MsgUpdate,
  MsgUpdateAuction,
  MsgUpdateDomain,
  MsgUpdateParams,
} from "../types/lumen/dns/v1/tx.js";
import type { Record as DnsRecord } from "../types/lumen/dns/v1/domain.js";

type Maybe<T> = T | undefined;

export type RegisterParams = {
  domain: string;
  ext: string;
  records?: DnsRecord[];
  durationDays?: number;
  owner?: string;
};

export type UpdateParams = {
  domain: string;
  ext: string;
  records?: DnsRecord[];
  powNonce?: number;
};

export type BidParams = {
  domain: string;
  ext: string;
  amount: string | number;
};

export type AuctionFilters = {
  pageKey?: string;
  limit?: number;
};

export class DnsModule extends BaseModule {
  private readonly base: string | undefined;

  constructor(restEndpoint?: string) {
    const base = restEndpoint ? joinRest(restEndpoint, "/lumen/dns/v1") : undefined;
    super(base);
    this.base = base;
  }

  // ---- Queries -------------------------------------------------------------

  async params() {
    return this.get("/params");
  }

  async resolve(domain: string, ext: string, opts?: { records?: string; expireAt?: number; status?: string }) {
    const segments = [
      encodeURIComponent(domain),
      encodeURIComponent(ext),
      encodeURIComponent(opts?.records ?? "-"),
      String(opts?.expireAt ?? 0),
      encodeURIComponent(opts?.status ?? "-"),
    ];
    return this.get(`/resolve/${segments.join("/")}`);
  }

  async domainsByOwner(owner: string) {
    return this.get(`/domains_by_owner/${encodeURIComponent(owner)}`);
  }

  async auctionStatus(domain: string, ext: string) {
    const segments = [
      encodeURIComponent(domain),
      encodeURIComponent(ext),
      "0",
      "-",
      "-",
    ];
    return this.get(`/auction_status/${segments.join("/")}`);
  }

  async baseFeeDns(overrides?: { t?: number; alpha?: string; floor?: string; ceiling?: string }) {
    const segments = [
      String(overrides?.t ?? 0),
      encodeURIComponent(overrides?.alpha ?? "-"),
      encodeURIComponent(overrides?.floor ?? "-"),
      encodeURIComponent(overrides?.ceiling ?? "-"),
    ];
    return this.get(`/base_fee_dns/${segments.join("/")}`);
  }

  async domain(index: string) {
    return this.get(`/domain/${encodeURIComponent(index)}`);
  }

  async domains(options: { pageKey?: string; limit?: number } = {}) {
    return this.get("/domain", paginationParams(options.pageKey, options.limit));
  }

  async auction(index: string) {
    return this.get(`/auction/${encodeURIComponent(index)}`);
  }

  async auctions(options: AuctionFilters = {}) {
    return this.get("/auction", paginationParams(options.pageKey, options.limit));
  }

  // ---- Tx composers --------------------------------------------------------

  msgUpdateParams(authority: string, params: any): EncodeObject {
    return {
      typeUrl: "/lumen.dns.v1.MsgUpdateParams",
      value: MsgUpdateParams.fromPartial({ authority, params }),
    };
  }

  msgRegister(sender: string, payload: RegisterParams): EncodeObject {
    return {
      typeUrl: "/lumen.dns.v1.MsgRegister",
      value: MsgRegister.fromPartial({
        creator: sender,
        domain: payload.domain,
        ext: payload.ext,
        records: payload.records ?? [],
        durationDays: payload.durationDays ?? 0,
        owner: payload.owner ?? "",
      }),
    };
  }

  msgUpdate(sender: string, payload: UpdateParams): EncodeObject {
    return {
      typeUrl: "/lumen.dns.v1.MsgUpdate",
      value: MsgUpdate.fromPartial({
        creator: sender,
        domain: payload.domain,
        ext: payload.ext,
        records: payload.records ?? [],
        powNonce: payload.powNonce ?? 0,
      }),
    };
  }

  msgRenew(sender: string, payload: { domain: string; ext: string; durationDays?: number }): EncodeObject {
    return {
      typeUrl: "/lumen.dns.v1.MsgRenew",
      value: MsgRenew.fromPartial({
        creator: sender,
        domain: payload.domain,
        ext: payload.ext,
        durationDays: payload.durationDays ?? 0,
      }),
    };
  }

  msgTransfer(sender: string, payload: { domain: string; ext: string; newOwner: string }): EncodeObject {
    return {
      typeUrl: "/lumen.dns.v1.MsgTransfer",
      value: MsgTransfer.fromPartial({
        creator: sender,
        domain: payload.domain,
        ext: payload.ext,
        newOwner: payload.newOwner,
      }),
    };
  }

  msgBid(sender: string, payload: BidParams): EncodeObject {
    return {
      typeUrl: "/lumen.dns.v1.MsgBid",
      value: MsgBid.fromPartial({
        creator: sender,
        domain: payload.domain,
        ext: payload.ext,
        amount: String(payload.amount),
      }),
    };
  }

  msgSettle(sender: string, payload: { domain: string; ext: string }): EncodeObject {
    return {
      typeUrl: "/lumen.dns.v1.MsgSettle",
      value: MsgSettle.fromPartial({
        creator: sender,
        domain: payload.domain,
        ext: payload.ext,
      }),
    };
  }

  msgCreateDomain(sender: string, payload: {
    index: string;
    name: string;
    owner: string;
    records?: DnsRecord[];
    expireAt?: number;
  }): EncodeObject {
    return {
      typeUrl: "/lumen.dns.v1.MsgCreateDomain",
      value: MsgCreateDomain.fromPartial({
        creator: sender,
        index: payload.index,
        name: payload.name,
        owner: payload.owner,
        records: payload.records ?? [],
        expireAt: payload.expireAt ?? 0,
      }),
    };
  }

  msgUpdateDomain(sender: string, payload: {
    index: string;
    name: string;
    owner: string;
    records?: DnsRecord[];
    expireAt?: number;
    powNonce?: number;
  }): EncodeObject {
    return {
      typeUrl: "/lumen.dns.v1.MsgUpdateDomain",
      value: MsgUpdateDomain.fromPartial({
        creator: sender,
        index: payload.index,
        name: payload.name,
        owner: payload.owner,
        records: payload.records ?? [],
        expireAt: payload.expireAt ?? 0,
        powNonce: payload.powNonce ?? 0,
      }),
    };
  }

  msgDeleteDomain(sender: string, payload: { index: string }): EncodeObject {
    return {
      typeUrl: "/lumen.dns.v1.MsgDeleteDomain",
      value: MsgDeleteDomain.fromPartial({
        creator: sender,
        index: payload.index,
      }),
    };
  }

  msgCreateAuction(sender: string, payload: {
    index: string;
    name: string;
    start: number | string;
    end: number | string;
    highestBid?: string;
    bidder?: string;
  }): EncodeObject {
    return {
      typeUrl: "/lumen.dns.v1.MsgCreateAuction",
      value: MsgCreateAuction.fromPartial({
        creator: sender,
        index: payload.index,
        name: payload.name,
        start: Number(payload.start),
        end: Number(payload.end),
        highestBid: payload.highestBid ?? "",
        bidder: payload.bidder ?? "",
      }),
    };
  }

  msgUpdateAuction(sender: string, payload: {
    index: string;
    name: string;
    start?: number | string;
    end?: number | string;
    highestBid?: string;
    bidder?: string;
  }): EncodeObject {
    return {
      typeUrl: "/lumen.dns.v1.MsgUpdateAuction",
      value: MsgUpdateAuction.fromPartial({
        creator: sender,
        index: payload.index,
        name: payload.name,
        start: payload.start != null ? Number(payload.start) : undefined,
        end: payload.end != null ? Number(payload.end) : undefined,
        highestBid: payload.highestBid ?? "",
        bidder: payload.bidder ?? "",
      }),
    };
  }

  msgDeleteAuction(sender: string, payload: { index: string }): EncodeObject {
    return {
      typeUrl: "/lumen.dns.v1.MsgDeleteAuction",
      value: MsgDeleteAuction.fromPartial({
        creator: sender,
        index: payload.index,
      }),
    };
  }
}

function paginationParams(pageKey?: Maybe<string>, limit?: Maybe<number>) {
  const params: Record<string, string> = {};
  if (pageKey) params["pagination.key"] = pageKey;
  if (limit != null) params["pagination.limit"] = String(limit);
  return params;
}
