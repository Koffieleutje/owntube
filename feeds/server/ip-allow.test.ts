import assert from "node:assert/strict";
import { test } from "node:test";
import { ipToBytes, isIpAllowed } from "./ip-allow.ts";

test("ipToBytes parses v4/v6 and normalizes v4-mapped", () => {
  assert.deepEqual([...(ipToBytes("77.171.108.25") ?? [])], [77, 171, 108, 25]);
  assert.equal(ipToBytes("::ffff:77.171.108.25")?.length, 4); // mapped -> v4
  assert.equal(ipToBytes("2a02:a45d:15fe:10::11")?.length, 16);
  assert.equal(ipToBytes("not-an-ip"), null);
  assert.equal(ipToBytes("256.0.0.1"), null);
});

test("exact IPv4 allow", () => {
  assert.equal(isIpAllowed("77.171.108.25", ["77.171.108.25"]), true);
  assert.equal(isIpAllowed("77.171.108.26", ["77.171.108.25"]), false);
});

test("IPv4-mapped client matches a plain IPv4 rule (behind Caddy)", () => {
  assert.equal(isIpAllowed("::ffff:77.171.108.25", ["77.171.108.25"]), true);
});

test("IPv4 CIDR", () => {
  assert.equal(isIpAllowed("77.171.108.25", ["77.171.108.0/24"]), true);
  assert.equal(isIpAllowed("77.171.109.1", ["77.171.108.0/24"]), false);
});

test("IPv6 prefix (home /48)", () => {
  assert.equal(
    isIpAllowed("2a02:a45d:15fe:10::11", ["2a02:a45d:15fe::/48"]),
    true,
  );
  assert.equal(
    isIpAllowed("2a02:a45d:15ff:10::11", ["2a02:a45d:15fe::/48"]),
    false,
  );
});

test("cross-family rules never falsely match", () => {
  assert.equal(isIpAllowed("2a02:a45d:15fe:10::11", ["77.171.108.25"]), false);
  assert.equal(isIpAllowed("77.171.108.25", ["2a02:a45d:15fe::/48"]), false);
});

test("empty rules => deny", () => {
  assert.equal(isIpAllowed("77.171.108.25", []), false);
});
