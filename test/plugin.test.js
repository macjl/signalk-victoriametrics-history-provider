import test from 'node:test'
import assert from 'node:assert/strict'
import createPlugin from '../index.js'

function fakeApp() {
  const status = []
  return {
    app: {
      selfId: 'urn:mrn:signalk:uuid:boat',
      setPluginStatus: value => status.push(value),
      setPluginError: value => status.push(`error: ${value}`),
      registerHistoryApiProvider: () => {},
      unregisterHistoryApiProvider: () => {}
    },
    status
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
