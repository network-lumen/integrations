import type { EncodeObject } from "@cosmjs/proto-signing";

import { BaseModule } from "./base.js";
import { joinRest } from "../rest.js";
import {
  MsgUpdateParams,
  MsgUpdateSlashingDowntimeParams,
} from "../types/lumen/tokenomics/v1/tx.js";
import type { Params } from "../types/lumen/tokenomics/v1/params.js";

export class TokenomicsModule extends BaseModule {
  constructor(restEndpoint?: string) {
    const base = restEndpoint ? joinRest(restEndpoint, "/lumen/tokenomics/v1") : undefined;
    super(base);
  }

  params() {
    return this.get("/params");
  }

  msgUpdateParams(authority: string, params: Params): EncodeObject {
    return {
      typeUrl: "/lumen.tokenomics.v1.MsgUpdateParams",
      value: MsgUpdateParams.fromPartial({ authority, params }),
    };
  }

  msgUpdateSlashingDowntimeParams(
    authority: string,
    slashFractionDowntime: string,
    downtimeJailDuration: string,
  ): EncodeObject {
    return {
      typeUrl: "/lumen.tokenomics.v1.MsgUpdateSlashingDowntimeParams",
      value: MsgUpdateSlashingDowntimeParams.fromPartial({
        authority,
        slashFractionDowntime,
        downtimeJailDuration,
      }),
    };
  }
}
