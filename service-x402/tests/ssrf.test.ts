import { describe, expect, it } from "vitest";
import { assertAddressAllowed, assertUrlAllowedStatic, parseIpv6, SsrfError } from "../src/ssrf.js";

describe("SSRF address policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    "198.51.100.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])("blocks %s", (address) => {
    expect(() => assertAddressAllowed(address)).toThrow(SsrfError);
  });

  it.each(["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"])("allows public %s", (address) => {
    expect(() => assertAddressAllowed(address)).not.toThrow();
  });

  it("parses compressed IPv6", () => {
    expect(parseIpv6("2606:4700:4700::1111")).toHaveLength(8);
  });
});

describe("SSRF URL policy", () => {
  it.each([
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com:8443",
    "https://localhost",
    "https://api.localhost",
    "https://127.0.0.1",
    "https://[::1]/",
  ])("blocks %s", (value) => {
    expect(() => assertUrlAllowedStatic(new URL(value))).toThrow(SsrfError);
  });

  it("allows a normal public HTTPS URL shape", () => {
    expect(() => assertUrlAllowedStatic(new URL("https://example.com/docs"))).not.toThrow();
  });
});
