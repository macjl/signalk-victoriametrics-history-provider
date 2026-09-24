import assert from 'node:assert/strict'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { proxyManagedUi } from '../src/web-ui-proxy.js'
import { webUiPrefix } from '../src/web-ui-paths.js'

function responseStream() {
  const stream = new PassThrough()
  stream.headers = {}
  stream.status = code => { stream.statusCode = code; return stream }
  stream.setHeader = (name, value) => { stream.headers[name] = value }
  return stream
}

test('proxy preserves the scoped path and strips Signal K credentials', async () => {
  const prefix = webUiPrefix('vmagent', true)
  const req = {
    method: 'GET', originalUrl: `${prefix}/targets?state=active`,
    params: { serviceId: 'vmagent' },
    headers: { cookie: 'token=secret', authorization: 'Bearer secret', accept: 'text/html' }
  }
  const res = responseStream()
  let body = ''
  res.on('data', chunk => { body += chunk })
  const done = once(res, 'end')
  let requested
  await proxyManagedUi(req, res, { origin: 'http://127.0.0.1:8429' }, async (url, options) => {
    requested = { url: url.toString(), headers: options.headers }
    return new Response('vmagent page', { headers: { 'content-type': 'text/plain' } })
  })
  await done
  assert.equal(res.statusCode, 200)
  assert.equal(body, 'vmagent page')
  assert.deepEqual(requested, {
    url: `http://127.0.0.1:8429${prefix}/targets?state=active`,
    headers: { accept: 'text/html' }
  })
})

test('proxy refuses a path outside the selected service', async () => {
  const prefix = webUiPrefix('vmagent', true)
  const req = { method: 'GET', originalUrl: `${prefix}/../vm-other/metrics`, params: { serviceId: 'vmagent' }, headers: {} }
  const res = responseStream()
  let called = false
  await proxyManagedUi(req, res, { origin: 'http://127.0.0.1:8429' }, async () => {
    called = true
    return new Response('wrong')
  })
  assert.equal(res.statusCode, 400)
  assert.equal(called, false)
})
