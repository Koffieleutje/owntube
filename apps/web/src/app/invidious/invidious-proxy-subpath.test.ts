import { describe, expect, it } from "vitest";
import {
  LEGACY_PROXY_PREFIX,
  STREAM_PROXY_PREFIX,
  subpathFromProxyRequest,
} from "@/server/media/upstream-proxy";

describe("subpathFromProxyRequest", () => {
  it("preserves commas in signed live HLS paths", () => {
    const url =
      "http://localhost:3000/invidious/api/manifest/hls_playlist/id/x/met/123,/mh/PJ/rms/su,su/playlist/index.m3u8?local=true";
    expect(subpathFromProxyRequest(url, LEGACY_PROXY_PREFIX)).toBe(
      "api/manifest/hls_playlist/id/x/met/123,/mh/PJ/rms/su,su/playlist/index.m3u8",
    );
  });

  it("reads the same subpath under the /stream prefix", () => {
    const url =
      "http://localhost:3000/stream/api/manifest/hls_playlist/id/x/met/123,/playlist/index.m3u8?local=true";
    expect(subpathFromProxyRequest(url, STREAM_PROXY_PREFIX)).toBe(
      "api/manifest/hls_playlist/id/x/met/123,/playlist/index.m3u8",
    );
  });

  it("returns null when the prefix does not match", () => {
    const url = "http://localhost:3000/image/vi/abc/hqdefault.jpg";
    expect(subpathFromProxyRequest(url, STREAM_PROXY_PREFIX)).toBeNull();
  });
});
