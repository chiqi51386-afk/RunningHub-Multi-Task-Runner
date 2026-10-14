import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeProxySettings, electronProxyConfig } from "../src/desktop/proxy.js";

test("proxy defaults to explicit direct mode, never system", () => {
  assert.deepEqual(electronProxyConfig(normalizeProxySettings(undefined)), { mode: "direct" });
  assert.deepEqual(electronProxyConfig({ enabled: false, url: "http://localhost:7890" }), { mode: "direct" });
});
test("accepts single HTTP HTTPS SOCKS5 proxy including IPv6", () => {
  for (const url of ["http://127.0.0.1:7890", "https://proxy.example:8443", "socks5://localhost:1080", "http://[::1]:7890"]) {
    const settings = normalizeProxySettings({ enabled: true, url: ` ${url} ` });
    assert.deepEqual(settings, { enabled: true, url });
    assert.deepEqual(electronProxyConfig(settings), { mode: "fixed_servers", proxyRules: url });
  }
});
test("rejects malformed proxy, credentials, PAC and fallback rules", () => {
  for (const url of ["", "127.0.0.1:7890", "ftp://localhost:21", "http://a:0", "http://a:99999", "http://a/path", "http://a?x=1", "http://a#x", "http://user:pass@a", "http://a:80;direct://", "http://a:80,http://b:80"]) {
    assert.throws(() => normalizeProxySettings({ enabled: true, url }));
  }
  assert.throws(() => normalizeProxySettings({ enabled: "true", url: "http://a" }));
});
