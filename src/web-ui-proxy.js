import { Readable } from 'node:stream'
import { webUiPrefix } from './web-ui-paths.js'

const REQUEST_HEADERS = ['accept', 'content-type', 'range', 'if-match', 'if-none-match', 'if-modified-since']

function requestBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body) || typeof req.body === 'string') return req.body
    if (req.headers['content-type']?.startsWith('application/json')) return JSON.stringify(req.body)
    if (req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
      return new URLSearchParams(req.body).toString()
    }
  }
  return req.readableEnded ? undefined : req
}

export async function proxyManagedUi(req, res, target, fetchImpl = fetch) {
  const prefix = webUiPrefix(req.params.serviceId, true)
  const upstreamUrl = new URL(req.originalUrl, target.origin)
  if (upstreamUrl.origin !== target.origin ||
      (upstreamUrl.pathname !== prefix && !upstreamUrl.pathname.startsWith(`${prefix}/`))) {
    res.status(400).end()
    return
  }

  const headers = Object.fromEntries(REQUEST_HEADERS
    .filter(name => typeof req.headers[name] === 'string')
    .map(name => [name, req.headers[name]]))
  const body = requestBody(req)
  try {
    const upstream = await fetchImpl(upstreamUrl, {
      method: req.method,
      headers,
      body,
      ...(body && typeof body.pipe === 'function' ? { duplex: 'half' } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(60000)
    })
    res.status(upstream.status)
    const location = upstream.headers.get('location')
    if (location) {
      const redirected = new URL(location, upstreamUrl)
      if (redirected.origin !== target.origin ||
          (redirected.pathname !== prefix && !redirected.pathname.startsWith(`${prefix}/`))) {
        res.status(502).end()
        return
      }
      res.setHeader('Location', `${redirected.pathname}${redirected.search}${redirected.hash}`)
    }
    const type = upstream.headers.get('content-type')
    if (type) res.setHeader('Content-Type', type)
    res.setHeader('Cache-Control', 'no-store')
    if (!upstream.body || req.method === 'HEAD') {
      res.end()
      return
    }
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res)
  } catch {
    if (!res.headersSent) res.status(502).end('Managed interface unavailable')
    else res.destroy()
  }
}
