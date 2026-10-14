// Keep Node-compatible fetch injection while using the explicitly configured
// Electron session. Track GET redirects ourselves: Electron documents that the
// response URL is not reliable, but the updater must inspect the final URL.
export function createApplicationFetch(transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    let request = new Request(input, { credentials: "omit", cache: "no-store", ...init });
    let redirected = false;
    for (let hops = 0; ; hops++) {
      if (!["http:", "https:"].includes(new URL(request.url).protocol)) throw new Error("仅支持 HTTP / HTTPS 网络请求");
      const trackRedirects = request.redirect === "follow" && ["GET", "HEAD"].includes(request.method);
      const response = await transport(request, { signal, ...(trackRedirects ? { redirect: "manual" as const } : {}) });
      const location = response.headers.get("location");
      if (trackRedirects && [301, 302, 303, 307, 308].includes(response.status) && location) {
        await response.body?.cancel();
        if (hops >= 20) throw new Error("重定向次数过多");
        const next = new URL(location, request.url);
        const headers = new Headers(request.headers);
        if (next.origin !== new URL(request.url).origin) {
          for (const name of ["authorization", "cookie", "proxy-authorization", "x-goog-api-key"]) headers.delete(name);
        }
        request = new Request(next, { method: request.method, headers, signal: request.signal, credentials: "omit", cache: "no-store" });
        redirected = true;
        continue;
      }
      if (trackRedirects) Object.defineProperties(response, { url: { value: request.url }, redirected: { value: redirected } });
      return response;
    }
  };
}
