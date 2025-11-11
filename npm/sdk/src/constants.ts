export const LUMEN = {
  chainId: "lumen",
  bech32Prefix: "lmn",
  defaultRpc: "http://127.0.0.1:27657",
  defaultRest: "http://127.0.0.1:2327",
  defaultGrpc: "http://127.0.0.1:9190",
  gaslessTypeUrls: [
    "/lumen.gateway.v1.MsgCreateContract",
    "/lumen.gateway.v1.MsgRegisterGateway",
    "/lumen.gateway.v1.MsgUpdateGateway",
    "/lumen.gateway.v1.MsgClaimPayment",
    "/lumen.gateway.v1.MsgCancelContract",
    "/lumen.gateway.v1.MsgFinalizeContract",
    "/lumen.dns.v1.MsgRegister",
    "/lumen.dns.v1.MsgRenew",
    "/lumen.dns.v1.MsgTransfer",
    "/lumen.dns.v1.MsgUpdate",
    "/lumen.dns.v1.MsgBid",
    "/lumen.dns.v1.MsgSettle",
  ],
} as const;

export type LumenEndpoints = {
  rpc?: string;
  rest?: string;
  grpc?: string;
};
