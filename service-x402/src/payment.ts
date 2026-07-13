import type { RequestHandler } from "express";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { x402ResourceServer } from "@okxweb3/x402-core/server";
import type { Network } from "@okxweb3/x402-core/types";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { paymentMiddleware } from "@okxweb3/x402-express";
import { PROTECTED_ROUTE, type PaymentConfig } from "./config.js";

export function buildPaymentRoutes(config: PaymentConfig) {
  const network = config.network as Network;
  return {
    [PROTECTED_ROUTE]: {
      accepts: {
        scheme: "exact",
        network,
        payTo: config.payTo,
        price: {
          asset: config.assetAddress,
          amount: config.amountAtomic,
        },
      },
      description: "Generate review-ready llms.txt site context files.",
      mimeType: "application/json",
    },
  };
}

export function createOkxPaymentGate(config: PaymentConfig): RequestHandler {
  const network = config.network as Network;
  const facilitator = new OKXFacilitatorClient({
    apiKey: config.okxApiKey,
    secretKey: config.okxSecretKey,
    passphrase: config.okxPassphrase,
    baseUrl: config.okxBaseUrl,
    syncSettle: true,
  });
  const server = new x402ResourceServer(facilitator)
    .register(network, new ExactEvmScheme());
  const routes = buildPaymentRoutes(config);

  return paymentMiddleware(routes, server, undefined, undefined, false) as RequestHandler;
}
