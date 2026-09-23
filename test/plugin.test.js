import test from 'node:test'
import assert from 'node:assert/strict'
import createPlugin from '../index.js'

function fakeApp() {
  const status = []
  return {
    app: {
      setPluginStatus: value => status.push(value),
      setPluginError: value => status.push(`error: ${value}`)
    },
    status
  }
}

test('inactive plugin starts without launching vmagent', () => {
  const { app, status } = fakeApp()
  const plugin = createPlugin(app)
  plugin.start({ ingest: { enabled: false }, destinations: [] })
  assert.equal(status.at(-1), 'Ingestion disabled')
  plugin.stop()
  assert.equal(status.at(-1), 'Stopped')
})

test('unfinished History and container modes fail explicitly', () => {
  const { app } = fakeApp()
  const plugin = createPlugin(app)
  assert.throws(() => plugin.start({
    destinations: [{
      id: 'vm', kind: 'victoriametrics', mode: 'remote',
      read: { enabled: true, url: 'http://localhost:8428' }
    }]
  }), /History reading is not implemented/)
})
