export interface AppProxySettings { enabled: boolean; url: string }

export function normalizeProxySettings(input: unknown): AppProxySettings {
  if (input === undefined) return { enabled: false, url: "" };
  if (!input || typeof input !== "object") throw new Error("代理设置无效");
  const { enabled, url } = input as AppProxySettings;
  if (typeof enabled !== "boolean" || typeof url !== "string" || url.length > 2048) throw new Error("代理设置无效");
  const value = url.trim();
  if (!value && !enabled) return { enabled, url: "" };
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("请输入完整代理地址，例如 http://127.0.0.1:7890"); }
  if (!["http:", "https:", "socks5:"].includes(parsed.protocol) || !parsed.hostname ||
      (parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash || /[\s;,]/.test(value)) {
    throw new Error("仅支持 HTTP、HTTPS 或 SOCKS5 代理地址，不要填写路径或多个地址");
  }
  if (parsed.username || parsed.password) throw new Error("暂不支持带用户名密码的代理，请使用本地代理端口");
  if (parsed.port === "0") throw new Error("代理端口必须大于 0");
  return { enabled, url: `${parsed.protocol}//${parsed.host}` };
}

export function electronProxyConfig(settings: AppProxySettings) {
  return settings.enabled
    ? { mode: "fixed_servers" as const, proxyRules: settings.url }
    : { mode: "direct" as const };
}
