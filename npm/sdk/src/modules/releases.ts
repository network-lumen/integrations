import type { EncodeObject } from "@cosmjs/proto-signing";

import { BaseModule } from "./base.js";
import { joinRest } from "../rest.js";
import {
  MsgPublishRelease,
  MsgRejectRelease,
  MsgSetEmergency,
  MsgUpdateParams,
  MsgValidateRelease,
} from "../types/lumen/release/v1/tx.js";
import type { Release } from "../types/lumen/release/v1/types.js";
import type { Params } from "../types/lumen/release/v1/params.js";

export class ReleasesModule extends BaseModule {
  constructor(restEndpoint?: string) {
    const base = restEndpoint ? joinRest(restEndpoint, "/lumen/release") : undefined;
    super(base);
  }

  // ---- Queries -------------------------------------------------------------

  params() {
    return this.get("/params");
  }

  release(id: string | number) {
    return this.get(`/id/${encodeURIComponent(String(id))}`);
  }

  releaseById(id: string | number) {
    return this.get(`/release/${encodeURIComponent(String(id))}`);
  }

  releases(filters: { page?: number; limit?: number } = {}) {
    const query: Record<string, string> = {};
    if (filters.page != null) query.page = String(filters.page);
    if (filters.limit != null) query.limit = String(Math.min(200, Math.max(1, filters.limit)));
    return this.get("/releases", query);
  }

  latest() {
    return this.get("/latest");
  }

  latestCanon(filters: { channel: string; platform: string; kind: string }) {
    if (!filters.channel || !filters.platform || !filters.kind) {
      throw new Error("channel, platform, and kind are required");
    }
    const segments = [
      encodeURIComponent(filters.channel),
      encodeURIComponent(filters.platform),
      encodeURIComponent(filters.kind),
    ];
    return this.get(`/latest/${segments.join("/")}`);
  }

  byVersion(version: string) {
    return this.get(`/by_version/${encodeURIComponent(version)}`);
  }

  // ---- Tx composers --------------------------------------------------------

  msgPublishRelease(creator: string, release: Release): EncodeObject {
    return {
      typeUrl: "/lumen.release.v1.MsgPublishRelease",
      value: MsgPublishRelease.fromPartial({ creator, release }),
    };
  }
  msgSetEmergency(creator: string, payload: { id: number; emergencyOk: boolean; emergencyTtl?: number }): EncodeObject {
    return {
      typeUrl: "/lumen.release.v1.MsgSetEmergency",
      value: MsgSetEmergency.fromPartial({
        creator,
        id: payload.id,
        emergencyOk: payload.emergencyOk,
        emergencyTtl: payload.emergencyTtl ?? 0,
      }),
    };
  }

  msgValidateRelease(authority: string, id: number): EncodeObject {
    return {
      typeUrl: "/lumen.release.v1.MsgValidateRelease",
      value: MsgValidateRelease.fromPartial({ authority, id }),
    };
  }

  msgRejectRelease(authority: string, id: number): EncodeObject {
    return {
      typeUrl: "/lumen.release.v1.MsgRejectRelease",
      value: MsgRejectRelease.fromPartial({ authority, id }),
    };
  }

  msgUpdateParams(authority: string, params: Params): EncodeObject {
    return {
      typeUrl: "/lumen.release.v1.MsgUpdateParams",
      value: MsgUpdateParams.fromPartial({ authority, params }),
    };
  }
}
