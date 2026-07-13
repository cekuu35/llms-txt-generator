import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { crawlWebsite, CrawlTimeoutError, NoPagesCrawledError } from "./crawler.js";
import { getPaymentConfig } from "./config.js";
import { generateFiles, type PageRecord } from "./generator.js";
import { createOkxPaymentGate } from "./payment.js";
import { ResponseTooLargeError } from "./transport.js";
import { validateGenerationInput, type GenerationInput } from "./validation.js";
import { SsrfError } from "./ssrf.js";

export const PROTECTED_PATH = "/v1/generate-llms-files";
const REVIEW_NOTE = "Review generated files before publishing them at the domain root.";

export interface ServiceOutput {
  readonly site: string;
  readonly pagesProcessed: number;
  readonly files: readonly string[];
  readonly fileContents: {
    readonly llmsTxt: string;
    readonly llmsFullTxt?: string;
  };
  readonly pages: readonly {
    readonly url: string;
    readonly title: string;
    readonly description: string;
    readonly contentChars: number;
  }[];
  readonly note: string;
}

export type GenerateOperation = (input: GenerationInput) => Promise<ServiceOutput>;

export interface AppOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly paymentGate?: RequestHandler;
  readonly paymentConfigured?: boolean;
  readonly generate?: GenerateOperation;
}

function toOutput(input: GenerationInput, pages: readonly PageRecord[]): ServiceOutput {
  const generated = generateFiles(input.websiteUrl, pages, input.includeFullText);
  const files = generated.llmsFullTxt ? ["llms.txt", "llms-full.txt"] : ["llms.txt"];
  return {
    site: new URL(input.websiteUrl).origin,
    pagesProcessed: pages.length,
    files,
    fileContents: {
      llmsTxt: generated.llmsTxt,
      ...(generated.llmsFullTxt ? { llmsFullTxt: generated.llmsFullTxt } : {}),
    },
    pages: pages.map((page) => ({
      url: page.url,
      title: page.title,
      description: page.description,
      contentChars: page.content.length,
    })),
    note: REVIEW_NOTE,
  };
}

const defaultGenerate: GenerateOperation = async (input) => {
  const pages = await crawlWebsite(input);
  return toOutput(input, pages);
};

function validateRequest(req: Request, res: Response, next: NextFunction): void {
  const result = validateGenerationInput(req.body);
  if (!result.success) {
    const status = result.code === "URL_NOT_ALLOWED" ? 403 : 400;
    res.status(status).json({ error: { code: result.code, message: result.message } });
    return;
  }
  res.locals.generationInput = result.data;
  next();
}

function errorResponse(error: unknown, res: Response): void {
  if (error instanceof SsrfError || error instanceof ResponseTooLargeError) {
    res.status(403).json({ error: { code: "URL_NOT_ALLOWED", message: "The target or redirect is not allowed." } });
    return;
  }
  if (error instanceof NoPagesCrawledError) {
    res.status(422).json({ error: { code: "NO_PAGES_CRAWLED", message: "No eligible public pages were crawled." } });
    return;
  }
  if (error instanceof CrawlTimeoutError) {
    res.status(504).json({ error: { code: "CRAWL_TIMEOUT", message: "The bounded crawl timed out." } });
    return;
  }
  res.status(500).json({ error: { code: "GENERATION_FAILED", message: "Generation failed safely." } });
}

export function createApp(options: AppOptions = {}): express.Express {
  const env = options.env ?? process.env;
  const paymentConfig = getPaymentConfig(env);
  const paymentConfigured = options.paymentConfigured ?? paymentConfig !== null;
  let paymentGate = options.paymentGate;
  if (!paymentGate && paymentConfig) {
    try {
      paymentGate = createOkxPaymentGate(paymentConfig);
    } catch {
      paymentGate = undefined;
    }
  }
  const generate = options.generate ?? defaultGenerate;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8kb", strict: true }));

  app.get("/health", (_req, res) => {
    res.json({
      service: "site-context-forge",
      status: "ok",
      paymentConfigured: paymentConfigured && Boolean(paymentGate),
    });
  });

  app.get("/api/preview", (_req, res) => {
    res.json({
      site: "https://example.com",
      pagesProcessed: 1,
      files: ["llms.txt"],
      fileContents: {
        llmsTxt: "# https://example.com\n\n> Generated site context. Review before publishing.\n\n## Pages\n- [Example](https://example.com/): Static preview only.\n",
      },
      pages: [{
        url: "https://example.com/",
        title: "Example",
        description: "Static preview only.",
        contentChars: 20,
      }],
      note: REVIEW_NOTE,
      preview: true,
    });
  });

  const readinessGate: RequestHandler = (_req, res, next) => {
    if (!paymentConfigured || !paymentGate) {
      res.status(503).json({
        error: {
          code: "PAYMENT_NOT_CONFIGURED",
          message: "Paid generation is unavailable until payment configuration is verified.",
        },
      });
      return;
    }
    next();
  };

  const paidHandler: RequestHandler = async (_req, res) => {
    try {
      const input = res.locals.generationInput as GenerationInput;
      res.json(await generate(input));
    } catch (error) {
      errorResponse(error, res);
    }
  };

  app.post(PROTECTED_PATH, validateRequest, readinessGate, paymentGate ?? ((_req, _res, next) => next()), paidHandler);

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number })?.status;
    if (status === 400 || status === 413 || error instanceof SyntaxError) {
      res.status(400).json({ error: { code: "INVALID_INPUT", message: "Request body is invalid or too large." } });
      return;
    }
    errorResponse(error, res);
  });
  return app;
}

// Vercel's Express detector treats src/app.ts as the serverless entrypoint.
// Keep a default Express export here while retaining createApp for tests.
const app = createApp();
export default app;
