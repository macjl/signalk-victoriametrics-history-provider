import test from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from '../src/config.js'

const base = () => ({
  ingest: { enabled: true, labels: {} },
  vmagent: { mode: 'host-binary', binaryPath: '/usr/bin/vmagent', queueLimitBytesPerDestination: 1024 },
  destinations: [{
    id: 'main', kind: 'victoriametrics', mode: 'remote',
    write: { enabled: true, url: 'http://localhost:8428/api/v1/write' },
    read: { enabled: true, url: 'http://localhost:8428' }
  }]
})

test('accepts user labels without injecting job or instance', () => {
  const options = base()
  options.ingest.labels.boat = 'tanagra'
  assert.deepEqual(validateConfig(options).ingest.labels, { boat: 'tanagra' })
})

test('rejects reserved labels', () => {
  const options = base()
  options.ingest.labels.preferred = 'false'
  assert.throws(() => validateConfig(options), /reserved label/)
})

test('allows only one History reader', () => {
  const options = base()
  options.destinations.push({
    id: 'second', kind: 'victoriametrics', mode: 'remote',
    read: { enabled: true, url: 'http://localhost:8428' }
  })
  assert.throws(() => validateConfig(options), /Only one VictoriaMetrics/)
})

test('rejects ingestion without a destination', () => {
  const options = base()
  options.destinations[0].write.enabled = false
  assert.throws(() => validateConfig(options), /requires a write-enabled/)
})

test('rejects empty whitelist and unsafe URL credentials', () => {
  const options = base()
  options.ingest.filterMode = 'whitelist'
  assert.throws(() => validateConfig(options), /Whitelist cannot be empty/)
  options.ingest.paths = ['navigation']
  options.destinations[0].write.url = 'http://user:secret@localhost:8428/api/v1/write'
  assert.throws(() => validateConfig(options), /Remote Write URL/)
})
