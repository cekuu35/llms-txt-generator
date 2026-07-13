import { describe, expect, it } from "vitest";
import type { LookupAddress, LookupOptions } from "node:dns";
import { createPinnedLookup } from "../src/transport.js";

function runLookup(addresses: readonly string[], options: LookupOptions) {
  return new Promise<{ address: string | LookupAddress[]; family?: number }>((resolve, reject) => {
    createPinnedLookup(addresses)("example.com", options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

describe("pinned DNS lookup", () => {
  it("returns address records when the caller requests all results", async () => {
    const result = await runLookup(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"], { all: true });
    expect(result.address).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    expect(result.family).toBeUndefined();
  });

  it("returns one address and family for the legacy single-result mode", async () => {
    const result = await runLookup(["93.184.216.34"], {});
    expect(result).toEqual({ address: "93.184.216.34", family: 4 });
  });
});
