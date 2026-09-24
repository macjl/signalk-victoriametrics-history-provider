import test from 'node:test'
import assert from 'node:assert/strict'
import createPlugin from '../index.js'

function fakeApp() {
  const status = []
  const saved = []
  return {
    app: {
      selfId: 'urn:mrn:signalk:uuid:boat',
      setPluginStatus: value => status.push(value),
      setPluginError: value => status.push(`error: ${value}`),
      savePluginOptions: (configuration, callback) => { saved.push(configuration); callback(null) },
      registerHistoryApiProvider: () => {},
      unregisterHistoryApiProvider: () => {}
    },
    status,
    saved
  }
}

test('inactive plugin starts without launching vmagent', async () => {
  const { app, status } = fakeApp()
  const plugin = createPlugin(app)
  plugin.start({ ingest: { enabled: false }, destinations: [] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(status.at(-1), 'History provider ready')
  await plugin.stop()
  assert.equal(status.at(-1), 'Stopped')
})

test('first start persists unique identity labels and later starts keep them', async () => {
  const { app, saved } = fakeApp()
  const plugin = createPlugin(app)
  plugin.start({ destinations: [] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(saved.length, 1)
  assert.equal(saved[0].ingest.labels.job, 'signalk-victoriametrics')
  assert.match(saved[0].ingest.labels.instance, /^signalk-victoriametrics-[a-f0-9]{10}$/)
  plugin.start(saved[0])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(saved.length, 1)
  await plugin.stop()
})

test('remote read-only provider starts without vmagent or subscriptions', async () => {
  const { app, status } = fakeApp()
  let registered = false
  app.registerHistoryApiProvider = () => { registered = true }
  const plugin = createPlugin(app)
  plugin.start({
    ingest: { enabled: true },
    destinations: [{
      id: 'remote', kind: 'victoriametrics', mode: 'remote',
      read: { enabled: true, url: 'http://localhost:8428' }
    }]
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(registered, true)
  assert.equal(status.at(-1), 'History provider ready')
  await plugin.stop()
})

test('unfinished host-binary VictoriaMetrics mode fails explicitly', () => {
  const { app } = fakeApp()
  const plugin = createPlugin(app)
  assert.throws(() => plugin.start({
    destinations: [{
      id: 'vm', kind: 'victoriametrics', mode: 'host-binary', binaryPath: '/usr/bin/victoria-metrics',
      read: { enabled: true }
    }]
  }), /host-binary mode is not implemented/)
})
