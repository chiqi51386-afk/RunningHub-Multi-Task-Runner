// Isolated Electron networking regression. No user database or external API calls.
const { app, session } = require('electron');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
app.setPath('userData', require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'rh-proxy-test-')));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
app.whenReady().then(async () => {
  setTimeout(() => { console.error('PROXY_NETWORK_TIMEOUT'); app.exit(1); }, 25000).unref();
  const { sessionFetch } = await import(pathToFileURL(path.resolve('dist/src/desktop/electronNetwork.js')));
  const { electronProxyConfig } = await import(pathToFileURL(path.resolve('dist/src/desktop/proxy.js')));
  let proxyHits = 0;
  const origin = http.createServer(async (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/final' }); return res.end(); }
    if (req.url === '/slow') return;
    if (req.url === '/stream') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.write(Buffer.alloc(65536)); return; }
    let body = ''; for await (const chunk of req) body += chunk.toString();
    res.end(JSON.stringify({ url: req.url, body, range: req.headers.range, type: req.headers['content-type'] }));
  });
  const originPort = await listen(origin);
  const proxy = http.createServer((req, res) => {
    proxyHits++;
    const target = new URL(req.url);
    const upstream = http.request({ hostname: '127.0.0.1', port: originPort, path: target.pathname, method: req.method, headers: req.headers }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  const proxyPort = await listen(proxy);
  const ses = session.fromPartition('proxy-regression', { cache: false });
  const fetcher = sessionFetch(() => ses);
  try {
    await ses.setProxy(electronProxyConfig({ enabled: false, url: '' }));
    assert.equal(await ses.resolveProxy('https://example.com'), 'DIRECT');
    assert.equal((await (await fetcher(`http://127.0.0.1:${originPort}/direct`)).json()).url, '/direct');
    assert.equal(proxyHits, 0);
    console.log('DIRECT_PASS');
    await ses.setProxy(electronProxyConfig({ enabled: true, url: `http://127.0.0.1:${proxyPort}` }));
    // Unresolvable target proves the proxy is used, not direct DNS/system config.
    const base = 'http://proxy-test.invalid';
    assert.match(await ses.resolveProxy(base), /PROXY 127.0.0.1/);
    const form = new FormData(); form.append('file', new Blob(['image-bytes']), 'reference.png');
    const upload = await (await fetcher(`${base}/upload`, { method: 'POST', body: form, redirect: 'error' })).json();
    assert.match(upload.body, /image-bytes/); assert.match(upload.type, /multipart\/form-data/);
    console.log('UPLOAD_PASS');
    const response = await fetcher(`${base}/redirect`, { headers: { Range: 'bytes=5-' } });
    assert.equal(response.url, `${base}/final`); assert.equal(response.redirected, true);
    assert.equal((await response.json()).range, 'bytes=5-');
    console.log('REDIRECT_PASS');
    await assert.rejects(fetcher(`${base}/redirect`, { redirect: 'error' }));
    console.log('REJECT_REDIRECT_PASS');
    const midstream = new AbortController();
    const streaming = await fetcher(`${base}/stream`, { signal: midstream.signal });
    console.log('STREAM_HEADERS_PASS');
    const reading = streaming.text(); midstream.abort(new Error('stop download'));
    await assert.rejects(reading);
    console.log('STREAM_CANCEL_PASS');
    const cancel = new AbortController(); setTimeout(() => cancel.abort(new Error('cancel test')), 100);
    await assert.rejects(fetcher(`${base}/slow`, { signal: cancel.signal }));
    console.log('ABORT_PASS');
    await assert.rejects(fetcher('file:///C:/Windows/win.ini'));
    const unused = net.createServer(); const closedPort = await listen(unused); await new Promise(resolve => unused.close(resolve));
    await ses.closeAllConnections();
    await ses.setProxy(electronProxyConfig({ enabled: true, url: `http://127.0.0.1:${closedPort}` }));
    await assert.rejects(fetcher(`${base}/unreachable`, { signal: AbortSignal.timeout(2000) }));
    // Saving disabled proxy must recover immediately, without restarting Electron.
    const directSession = session.fromPartition('proxy-disabled-live', { cache: false });
    await directSession.setProxy(electronProxyConfig({ enabled: false, url: `http://127.0.0.1:${closedPort}` }));
    const directFetcher = sessionFetch(() => directSession);
    const hitsBeforeDisable = proxyHits;
    assert.equal(await directSession.resolveProxy(base), 'DIRECT');
    const submitted = await (await directFetcher(`http://127.0.0.1:${originPort}/submit`, {
      method: 'POST', body: JSON.stringify({ task: 'test' }), redirect: 'error',
    })).json();
    assert.equal(submitted.body, JSON.stringify({ task: 'test' }));
    assert.equal(proxyHits, hitsBeforeDisable);
    await directSession.closeAllConnections();
    console.log('DISABLE_PROXY_LIVE_SUBMIT_PASS');
    console.log('PROXY_NETWORK_PASS: direct, explicit proxy, multipart, redirects, range, cancellation, no fallback');
  } finally {
    await ses.closeAllConnections(); origin.closeAllConnections(); proxy.closeAllConnections(); origin.close(); proxy.close();
  }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
