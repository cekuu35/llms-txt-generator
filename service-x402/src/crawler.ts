import { load } from "cheerio";
import { assertAddressAllowed, assertUrlAllowedStatic, sameOrigin, SsrfError } from "./ssrf.js";
import { defaultTransport, ResponseTooLargeError, type SafeTransport, type TransportResponse } from "./transport.js";
import type { GenerationInput } from "./validation.js";
import type { PageRecord } from "./generator.js";

const PAGE_TIMEOUT_MS = 8_000;
const OVERALL_TIMEOUT_MS = 25_000;
const MAX_REDIRECTS = 3;

export class CrawlTimeoutError extends Error {
  constructor() {
    super("The crawl exceeded its time limit.");
    this.name = "CrawlTimeoutError";
  }
}

export class NoPagesCrawledError extends Error {
  constructor() {
    super("No eligible pages were crawled.");
    this.name = "NoPagesCrawledError";
  }
}

export interface CrawlerDependencies {
  readonly transport?: SafeTransport;
  readonly now?: () => number;
}

interface FetchedPage {
  readonly finalUrl: URL;
  readonly response: TransportResponse;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function combineSignals(first: AbortSignal, second: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any([first, second]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  first.addEventListener("abort", abort, { once: true });
  second.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

async function fetchSafe(
  initialUrl: URL,
  rootOrigin: string,
  transport: SafeTransport,
  overallSignal: AbortSignal,
): Promise<FetchedPage> {
  let current = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const pageController = new AbortController();
    const timer = setTimeout(() => pageController.abort(), PAGE_TIMEOUT_MS);
    try {
      assertUrlAllowedStatic(current);
      if (current.origin !== rootOrigin) throw new SsrfError("Cross-origin request is not allowed.");
      const signal = combineSignals(pageController.signal, overallSignal);
      const addresses = await transport.resolve(current.hostname, signal);
      if (addresses.length === 0) throw new SsrfError("DNS returned no addresses.");
      for (const address of addresses) assertAddressAllowed(address);

      const response = await transport.request(current, addresses, signal);
      if (!isRedirect(response.status)) return { finalUrl: current, response };
      if (redirects === MAX_REDIRECTS) throw new SsrfError("Too many redirects.");
      const location = response.headers.get("location");
      if (!location) throw new SsrfError("Redirect has no Location header.");
      const next = new URL(location, current);
      assertUrlAllowedStatic(next);
      if (!sameOrigin(initialUrl, next) || next.origin !== rootOrigin) {
        throw new SsrfError("Cross-origin redirect is not allowed.");
      }
      current = next;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SsrfError("Redirect limit exceeded.");
}

function parseRobots(body: string): readonly string[] {
  const disallowed: string[] = [];
  let applies = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") applies = value === "*";
    if (key === "disallow" && applies && value.startsWith("/") && value !== "") disallowed.push(value);
  }
  return disallowed;
}

function isDisallowed(pathname: string, rules: readonly string[]): boolean {
  return rules.some((rule) => pathname.startsWith(rule));
}

function normalizeCandidate(value: string, base: URL, rootOrigin: string): URL | null {
  try {
    const candidate = new URL(value, base);
    candidate.hash = "";
    if (candidate.origin !== rootOrigin) return null;
    assertUrlAllowedStatic(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function extractPage(url: URL, body: string, maxChars: number): { page: PageRecord; links: readonly string[] } {
  const $ = load(body);
  $("script,style,noscript,svg,template").remove();
  const title = $("title").first().text().replace(/\s+/g, " ").trim() || url.hostname;
  const description = $('meta[name="description"]').attr("content")?.replace(/\s+/g, " ").trim() ?? "";
  const content = $("body").text().replace(/\s+/g, " ").trim().slice(0, maxChars);
  const links = $("a[href]").map((_index, element) => $(element).attr("href") ?? "").get();
  return {
    page: { url: url.toString(), title, description, content },
    links,
  };
}

export async function crawlWebsite(
  input: GenerationInput,
  dependencies: CrawlerDependencies = {},
): Promise<readonly PageRecord[]> {
  const transport = dependencies.transport ?? defaultTransport;
  const now = dependencies.now ?? Date.now;
  const start = now();
  const root = new URL(input.websiteUrl);
  assertUrlAllowedStatic(root);
  const rootOrigin = root.origin;
  const overallController = new AbortController();
  const overallTimer = setTimeout(() => overallController.abort(), OVERALL_TIMEOUT_MS);

  try {
    let robotsRules: readonly string[] = [];
    try {
      const robotsUrl = new URL("/robots.txt", root);
      const robots = await fetchSafe(robotsUrl, rootOrigin, transport, overallController.signal);
      if (robots.response.status >= 200 && robots.response.status < 300) {
        robotsRules = parseRobots(robots.response.body);
      }
    } catch {
      robotsRules = [];
    }

    const queue: URL[] = [root];
    const queued = new Set<string>([root.toString()]);
    const pages: PageRecord[] = [];

    while (queue.length > 0 && pages.length < input.maxPages) {
      if (overallController.signal.aborted || now() - start > OVERALL_TIMEOUT_MS) throw new CrawlTimeoutError();
      const next = queue.shift();
      if (!next || isDisallowed(next.pathname, robotsRules)) continue;

      let fetched: FetchedPage;
      try {
        fetched = await fetchSafe(next, rootOrigin, transport, overallController.signal);
      } catch (error) {
        if (overallController.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw new CrawlTimeoutError();
        }
        if (error instanceof SsrfError || error instanceof ResponseTooLargeError) throw error;
        continue;
      }

      if (fetched.response.status < 200 || fetched.response.status >= 300) continue;
      const contentType = (fetched.response.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.includes("text/html") && !contentType.includes("text/plain")) continue;

      const extracted = extractPage(fetched.finalUrl, fetched.response.body, input.maxContentCharsPerPage);
      if (extracted.page.content.length > 0) pages.push(extracted.page);

      for (const href of extracted.links) {
        if (pages.length + queue.length >= input.maxPages) break;
        const candidate = normalizeCandidate(href, fetched.finalUrl, rootOrigin);
        if (!candidate || queued.has(candidate.toString()) || isDisallowed(candidate.pathname, robotsRules)) continue;
        queued.add(candidate.toString());
        queue.push(candidate);
      }
    }

    if (pages.length === 0) throw new NoPagesCrawledError();
    return pages;
  } finally {
    clearTimeout(overallTimer);
  }
}
