import { afterEach, describe, expect, it, vi } from "vitest";
import { crawlWebsite } from "../src/crawler.js";
import { generateFiles } from "../src/generator.js";
import { SsrfError } from "../src/ssrf.js";
import type { SafeTransport, TransportResponse } from "../src/transport.js";

function response(status: number, body: string, headers: Record<string, string> = {}): TransportResponse {
  return { status, body, headers: new Headers(headers) };
}

function fakeTransport(routes: Record<string, TransportResponse>, addresses: readonly string[] = ["93.184.216.34"]): SafeTransport {
  return {
    async resolve() {
      return addresses;
    },
    async request(url) {
      const found = routes[url.toString()];
      return found ?? response(404, "", { "content-type": "text/plain" });
    },
  };
}

const input = {
  websiteUrl: "https://example.com/",
  maxPages: 2,
  includeFullText: true,
  maxContentCharsPerPage: 12_000,
};

describe("bounded crawler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("crawls same-origin pages deterministically with injected transport", async () => {
    const transport = fakeTransport({
      "https://example.com/robots.txt": response(404, "", { "content-type": "text/plain" }),
      "https://example.com/": response(200,
        '<html><head><title>Home</title><meta name="description" content="Root page"></head><body>Hello <a href="/about">About</a></body></html>',
        { "content-type": "text/html" },
      ),
      "https://example.com/about": response(200,
        "<html><head><title>About</title></head><body>About us</body></html>",
        { "content-type": "text/html" },
      ),
    });
    const pages = await crawlWebsite(input, { transport });
    expect(pages.map((page) => page.url)).toEqual(["https://example.com/", "https://example.com/about"]);
    const first = generateFiles(input.websiteUrl, pages, true);
    const second = generateFiles(input.websiteUrl, [...pages].reverse(), true);
    expect(first).toEqual(second);
    expect(first.llmsTxt).toContain("[About](https://example.com/about)");
  });

  it("revalidates DNS and rejects a private redirect target", async () => {
    let resolveCalls = 0;
    let requests = 0;
    const transport: SafeTransport = {
      async resolve() {
        resolveCalls += 1;
        return resolveCalls < 3 ? ["93.184.216.34"] : ["127.0.0.1"];
      },
      async request(url) {
        requests += 1;
        if (url.pathname === "/robots.txt") return response(404, "", { "content-type": "text/plain" });
        return response(302, "", { location: "/private" });
      },
    };
    await expect(crawlWebsite(input, { transport })).rejects.toBeInstanceOf(SsrfError);
    expect(resolveCalls).toBe(3);
    expect(requests).toBe(2);
  });

  it("rejects DNS rebinding or mixed public/private answers before fetch", async () => {
    let requests = 0;
    const transport: SafeTransport = {
      async resolve() {
        return ["93.184.216.34", "10.0.0.9"];
      },
      async request() {
        requests += 1;
        return response(200, "never");
      },
    };
    await expect(crawlWebsite(input, { transport })).rejects.toBeInstanceOf(SsrfError);
    expect(requests).toBe(0);
  });

  it("applies the page timeout to DNS resolution", async () => {
    vi.useFakeTimers();
    const transport: SafeTransport = {
      resolve(_hostname, signal) {
        return new Promise((_resolve, reject) => {
          const rejectAborted = () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (signal.aborted) rejectAborted();
          else signal.addEventListener("abort", rejectAborted, { once: true });
        });
      },
      async request() {
        return response(200, "never");
      },
    };

    const crawl = expect(crawlWebsite(input, { transport })).rejects.toMatchObject({
      name: "CrawlTimeoutError",
    });
    await vi.advanceTimersByTimeAsync(16_001);
    await crawl;
  });
});
