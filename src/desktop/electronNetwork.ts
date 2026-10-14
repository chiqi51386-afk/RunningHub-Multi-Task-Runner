import { net, type Session } from "electron";
import { createApplicationFetch } from "./network.js";

export function sessionFetch(getSession: () => Session): typeof fetch {
  return createApplicationFetch(async (input, init) => {
    if (init?.redirect !== "manual") return getSession().fetch(input instanceof URL ? input.href : input, init);
    // Electron fetch cancels manual redirects rather than exposing their headers.
    // Use ClientRequest for GET/HEAD so downloads retain streaming and final URLs.
    const source = new Request(input, init);
    const signal = init?.signal ?? source.signal;
    signal.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      let failBody: ((error: unknown) => void) | undefined;
      const request = net.request({ url: source.url, method: source.method, session: getSession(), redirect: "manual", useSessionCookies: false });
      source.headers.forEach((value, key) => request.setHeader(key, value));
      const cleanup = () => signal.removeEventListener("abort", abort);
      const abort = () => { cleanup(); const error = signal.reason ?? new Error("请求已取消"); reject(error); failBody?.(error); request.abort(); };
      signal.addEventListener("abort", abort, { once: true });
      request.on("error", error => { cleanup(); reject(error); });
      request.on("login", (_info, callback) => callback());
      request.on("redirect", (status, _method, url, responseHeaders) => {
        cleanup();
        const headers = new Headers();
        for (const [key, values] of Object.entries(responseHeaders)) for (const value of values) headers.append(key, value);
        headers.set("location", url);
        resolve(new Response(null, { status, headers }));
        request.abort();
      });
      request.on("response", response => {
        response.on("end", cleanup);
        response.on("error", cleanup);
        response.on("aborted", cleanup);
        const headers = new Headers();
        for (const [key, values] of Object.entries(response.headers)) {
          for (const value of Array.isArray(values) ? values : [values]) if (value !== undefined) headers.append(key, String(value));
        }
        const noBody = source.method === "HEAD" || [204, 205, 304].includes(response.statusCode);
        let finished = false;
        const body = noBody ? null : new ReadableStream<Uint8Array>({
          start(controller) {
            const fail = (error: unknown) => { if (!finished) { finished = true; controller.error(error); } };
            failBody = fail;
            response.on("end", () => { if (!finished) { finished = true; controller.close(); } });
            response.on("error", fail);
            response.on("aborted", () => fail(signal.reason ?? new Error("下载连接已中断")));
            request.on("error", fail);
            request.on("abort", () => fail(signal.reason ?? new Error("请求已取消")));
            response.on("data", chunk => { if (!finished) controller.enqueue(chunk); });
          },
          cancel() { finished = true; cleanup(); request.abort(); },
        });
        if (noBody) response.on("data", () => undefined);
        resolve(new Response(body, { status: response.statusCode, statusText: response.statusMessage, headers }));
      });
      request.end();
    });
  });
}
