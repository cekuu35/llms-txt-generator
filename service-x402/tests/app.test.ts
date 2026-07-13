import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp, PROTECTED_PATH, type ServiceOutput } from "../src/app.js";
import {
  OKX_FACILITATOR_URL,
  X_LAYER_MAINNET,
  X_LAYER_USDT0_ASSET,
  type PaymentConfig,
} from "../src/config.js";
import { buildPaymentRoutes } from "../src/payment.js";

const validInput = {
  websiteUrl: "https://example.com/",
  maxPages: 2,
  includeFullText: false,
  maxContentCharsPerPage: 2_000,
};

const output: ServiceOutput = {
  site: "https://example.com",
  pagesProcessed: 1,
  files: ["llms.txt"],
  fileContents: { llmsTxt: "# Example\n" },
  pages: [{
    url: "https://example.com/",
    title: "Example",
    description: "Test",
    contentChars: 4,
  }],
  note: "Review generated files before publishing them at the domain root.",
};

describe("public routes", () => {
  it("publishes a bounded sales card and machine-readable API contract", async () => {
    const app = createApp({ env: {} });
    const root = await request(app).get("/");
    const openapi = await request(app).get("/openapi.json");

    expect(root.status).toBe(200);
    expect(root.body).toMatchObject({
      service: "site-context-forge",
      status: "awaiting-payment-configuration",
      pricing: { amount: "0.25", asset: "USDT0", network: "eip155:196" },
      endpoints: {
        generate: { method: "POST", path: PROTECTED_PATH, payment: "x402 exact" },
      },
    });
    expect(root.body.claims.doesNotGuarantee).toContain("revenue");

    expect(openapi.status).toBe(200);
    expect(openapi.body.openapi).toBe("3.1.0");
    expect(openapi.body.paths[PROTECTED_PATH].post.operationId).toBe("generateLlmsFiles");
    expect(openapi.body.paths[PROTECTED_PATH].post.responses["402"].headers).toHaveProperty("PAYMENT-REQUIRED");
    expect(openapi.body.paths[PROTECTED_PATH].post.responses["200"].headers).toHaveProperty("PAYMENT-RESPONSE");
    expect(openapi.body.paths[PROTECTED_PATH].post.responses).toMatchObject({
      "422": expect.any(Object),
      "500": expect.any(Object),
      "502": expect.any(Object),
      "504": expect.any(Object),
    });
    expect(openapi.body.components.schemas).toHaveProperty("GenerationResponse");
    expect(openapi.body.components.schemas).toHaveProperty("ErrorResponse");
  });

  it("reports fail-closed payment readiness without exposing values", async () => {
    const result = await request(createApp({ env: {} })).get("/health");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      service: "site-context-forge",
      status: "ok",
      paymentConfigured: false,
    });
    expect(JSON.stringify(result.body)).not.toContain("OKX");
  });

  it("stays unconfigured when the pay-to address is invalid", async () => {
    const result = await request(createApp({
      env: {
        OKX_API_KEY: "placeholder-key",
        OKX_SECRET_KEY: "placeholder-secret",
        OKX_PASSPHRASE: "placeholder-passphrase",
        PAY_TO_ADDRESS: "not-an-evm-address",
      },
    })).get("/health");
    expect(result.status).toBe(200);
    expect(result.body.paymentConfigured).toBe(false);
  });

  it("constructs the official payment gate only for complete credentials and recipient", async () => {
    const result = await request(createApp({
      env: {
        OKX_API_KEY: "test-key",
        OKX_SECRET_KEY: "test-secret",
        OKX_PASSPHRASE: "test-passphrase",
        PAY_TO_ADDRESS: "0x1111111111111111111111111111111111111111",
      },
    })).get("/health");
    expect(result.status).toBe(200);
    expect(result.body.paymentConfigured).toBe(true);
  });

  it("pins the facilitator, chain, attested asset, recipient and atomic price", () => {
    const config: PaymentConfig = {
      okxApiKey: "test-key",
      okxSecretKey: "test-secret",
      okxPassphrase: "test-passphrase",
      okxBaseUrl: OKX_FACILITATOR_URL,
      payTo: "0x1111111111111111111111111111111111111111",
      network: X_LAYER_MAINNET,
      amountAtomic: "250000",
      assetAddress: X_LAYER_USDT0_ASSET,
    };
    const routes = buildPaymentRoutes(config);
    expect(routes["POST /v1/generate-llms-files"].accepts).toEqual({
      scheme: "exact",
      network: X_LAYER_MAINNET,
      payTo: config.payTo,
      price: {
        asset: config.assetAddress,
        amount: "250000",
      },
    });
  });

  it("returns the exact same static preview and never calls generation", async () => {
    const generate = vi.fn();
    const app = createApp({ env: {}, generate });
    const first = await request(app).get("/api/preview");
    const second = await request(app).get("/api/preview");
    expect(first.status).toBe(200);
    expect(first.body).toEqual(second.body);
    expect(first.body.preview).toBe(true);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("paid route ordering", () => {
  it("validates malformed input before the payment middleware", async () => {
    let gateCalls = 0;
    const paymentGate: RequestHandler = (_req, _res, next) => {
      gateCalls += 1;
      next();
    };
    const app = createApp({
      env: {},
      paymentConfigured: true,
      paymentGate,
      generate: vi.fn(async () => output),
    });
    const result = await request(app).post(PROTECTED_PATH).send({ websiteUrl: "not-a-url" });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("INVALID_INPUT");
    expect(gateCalls).toBe(0);
  });

  it("blocks private URLs before the payment middleware", async () => {
    let gateCalls = 0;
    const app = createApp({
      env: {},
      paymentConfigured: true,
      paymentGate: (_req, _res, next) => {
        gateCalls += 1;
        next();
      },
      generate: vi.fn(async () => output),
    });
    const result = await request(app).post(PROTECTED_PATH).send({
      ...validInput,
      websiteUrl: "https://127.0.0.1/",
    });
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("URL_NOT_ALLOWED");
    expect(gateCalls).toBe(0);
  });

  it("returns 503 without a complete payment configuration and never generates", async () => {
    const generate = vi.fn(async () => output);
    const result = await request(createApp({ env: {}, generate })).post(PROTECTED_PATH).send(validInput);
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe("PAYMENT_NOT_CONFIGURED");
    expect(generate).not.toHaveBeenCalled();
  });

  it("runs generation only after an injected successful payment gate", async () => {
    const order: string[] = [];
    const paymentGate: RequestHandler = (_req, _res, next) => {
      order.push("payment");
      next();
    };
    const generate = vi.fn(async () => {
      order.push("generation");
      return output;
    });
    const app = createApp({ env: {}, paymentConfigured: true, paymentGate, generate });
    const result = await request(app).post(PROTECTED_PATH).send(validInput);
    expect(result.status).toBe(200);
    expect(result.body).toEqual(output);
    expect(order).toEqual(["payment", "generation"]);
  });
});
