import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { Agent, fetch, type Dispatcher } from "undici";
import { assertAddressAllowed, assertUrlAllowedStatic, SsrfError } from "./ssrf.js";

export interface TransportResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: string;
}

export interface SafeTransport {
  resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]>;
  request(url: URL, addresses: readonly string[], signal: AbortSignal): Promise<TransportResponse>;
}

export class ResponseTooLargeError extends Error {
  constructor() {
    super("Response exceeded the one megabyte limit.");
    this.name = "ResponseTooLargeError";
  }
}

async function readBoundedBody(response: Response, limitBytes = 1_048_576): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let output = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > limitBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError();
    }
    output += decoder.decode(result.value, { stream: true });
  }
  output += decoder.decode();
  return output;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

export function createPinnedLookup(addresses: readonly string[]) {
  let cursor = 0;
  return (_hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    const records = addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
    const offset = cursor % records.length;
    cursor += 1;
    const rotated = [...records.slice(offset), ...records.slice(0, offset)];
    if (options.all) {
      callback(null, rotated);
      return;
    }
    const selected = rotated[0];
    callback(null, selected.address, selected.family);
  };
}

function createPinnedAgent(addresses: readonly string[]): Dispatcher {
  return new Agent({
    connect: {
      lookup: createPinnedLookup(addresses),
    },
  });
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export const defaultTransport: SafeTransport = {
  async resolve(hostname, signal) {
    const records: LookupAddress[] = await withAbort(
      dnsLookup(hostname, { all: true, verbatim: true }),
      signal,
    );
    if (records.length === 0) throw new SsrfError("DNS returned no addresses.");
    const addresses = [...new Set(records.map((record) => record.address))];
    for (const address of addresses) assertAddressAllowed(address);
    return addresses;
  },

  async request(url, addresses, signal) {
    assertUrlAllowedStatic(url);
    if (addresses.length === 0) throw new SsrfError("No validated address is available.");
    for (const address of addresses) assertAddressAllowed(address);
    const dispatcher = createPinnedAgent(addresses);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal,
        dispatcher,
        headers: {
          accept: "text/html,text/plain;q=0.9",
          "user-agent": "SiteContextForge/0.1 (+https://example.invalid/security)",
        },
      });
      return {
        status: response.status,
        headers: response.headers,
        body: await readBoundedBody(response as unknown as Response),
      };
    } finally {
      await dispatcher.close();
    }
  },
};
