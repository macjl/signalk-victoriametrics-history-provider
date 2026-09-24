import assert from 'node:assert/strict'
import test from 'node:test'
import { bytesToGiB, destinationUsage, giBToBytes, initialConfig, nextDestinationId, prepareSave, selectKind, selectMode, setDestinationUsage } from '../src/configpanel/model.js'

test('queue size is shown in GiB but stored as bytes', () => {
  assert.equal(bytesToGiB(1073741824), 1)
  assert.equal(giBToBytes(1), 1073741824)
  assert.equal(giBToBytes(0.5), 536870912)
  assert.equal(bytesToGiB(giBToBytes(0.1)), 0.1)
  assert.equal(bytesToGiB(123456789), 0.114978)
})

test('initial configuration retains existing settings and fills missing defaults', () => {
  const original = { ingest: { batch: { flushMs: 400 }, labels: { boat: 'alpha' } } }
  const result = initialConfig(original)
  assert.equal(result.ingest.batch.flushMs, 400)
  assert.equal(initialConfig(null).ingest.batch.flushMs, 1000)
  assert.equal(result.ingest.batch.maxSamples, 500)
  assert.equal(result.ingest.labels.boat, 'alpha')
  assert.equal(result.ingest.labels.job, 'signalk-victoriametrics')
  assert.match(result.ingest.labels.instance, /^signalk-victoriametrics-[a-f0-9]{10}$/)
  assert.equal(result.vmagent.mode, 'managed-container')
  result.ingest.labels.boat = 'beta'
  assert.equal(original.ingest.labels.boat, 'alpha')
  assert.equal(initialConfig(null).ingest.enabled, undefined)
  assert.equal(initialConfig(null).ingest.minPeriodMs, 5000)
  assert.equal(initialConfig({ ingest: { minPeriodMs: 0 } }).ingest.minPeriodMs, 0)
  assert.deepEqual(result.ingest.cardinalityAlert, { maxSeriesPerPathPerDay: 100, excludedPaths: [] })
})

test('destination usage cannot be empty and History remains exclusive', () => {
  const destinations = [
    { id: 'one', url: 'http://one', read: { enabled: true } },
    { id: 'two', url: 'http://two', write: { enabled: true }, read: { enabled: false } }
  ]
  assert.equal(destinationUsage(destinations[0]), 'read')
  assert.throws(() => setDestinationUsage(destinations, 1, 'both'), /Only one destination/)
  assert.throws(() => setDestinationUsage(destinations, 0, 'none'), /Invalid destination usage/)
  const changed = setDestinationUsage(destinations, 0, 'write')
  assert.equal(destinationUsage(changed[0]), 'write')
  const selected = setDestinationUsage(changed, 1, 'both')
  assert.equal(destinationUsage(selected[1]), 'both')
  assert.equal(selected[1].url, 'http://two')
  assert.equal(destinations[0].read.enabled, true)
})

test('Prometheus-compatible destinations are remote and cannot serve History', () => {
  const result = selectKind({ kind: 'victoriametrics', mode: 'managed-container', read: { enabled: true } }, 'prometheus-compatible')
  assert.equal(result.mode, 'remote')
  assert.equal(result.read.enabled, false)
  assert.equal(result.write.enabled, true)
})

test('new destination IDs avoid collisions', () => {
  assert.equal(nextDestinationId([{ id: 'destination-1' }, { id: 'destination-3' }]), 'destination-2')
})

test('saving validates labels and strips obsolete runtime options', () => {
  const config = initialConfig({ destinations: [{
    id: 'local', kind: 'victoriametrics', mode: 'managed-container', imageTag: 'old-tag',
    write: { enabled: true }, read: { enabled: true }
  }], ingest: { enabled: false }, vmagent: { imageTag: 'old-tag' } })
  config.ingest.labels.job = 'signalk'
  config.ingest.labels.instance = 'boat-1'
  const result = prepareSave(config, [])
  assert.deepEqual(result.ingest.labels, { job: 'signalk', instance: 'boat-1' })
  assert.equal(result.ingest.enabled, undefined)
  assert.equal(result.vmagent.imageTag, undefined)
  assert.equal(result.destinations[0].imageTag, undefined)
  assert.deepEqual(config.ingest.labels, { job: 'signalk', instance: 'boat-1' })
  assert.throws(() => prepareSave(config, [{ name: 'job', value: 'one' }, { name: 'job', value: 'two' }]), /unique/)
  assert.throws(() => prepareSave(config, [{ name: 'source', value: 'wrong' }]), /reserved/)
  config.ingest.labels.instance = ''
  assert.throws(() => prepareSave(config, []), /non-empty string/)
  config.ingest.labels.instance = 'boat-1'
  config.vmagent.mode = 'host-binary'
  assert.throws(() => prepareSave(config, []), /binaryPath must be absolute/)
  config.destinations[0].write.enabled = false
  assert.doesNotThrow(() => prepareSave(config, []))
})

test('saving preserves empty retention as the unlimited request', () => {
  const config = initialConfig({ destinations: [{
    id: 'local', kind: 'victoriametrics', mode: 'managed-container',
    retention: '', write: { enabled: true }, read: { enabled: false }
  }] })
  assert.equal(prepareSave(config, []).destinations[0].retention, '')
})

test('saving preserves paths exempt only from cardinality alerts', () => {
  const config = initialConfig({ destinations: [{
    id: 'local', kind: 'victoriametrics', mode: 'managed-container', write: { enabled: true }
  }] })
  config.ingest.cardinalityAlert.excludedPaths = ['navigation.state']
  const saved = prepareSave(config, [])
  assert.deepEqual(saved.ingest.cardinalityAlert.excludedPaths, ['navigation.state'])
  assert.deepEqual(saved.ingest.paths, [])
})

test('credentials follow the remote destination regardless of read/write usage', () => {
  const destination = {
    id: 'remote', kind: 'victoriametrics', mode: 'remote',
    auth: { type: 'basic', username: 'boat', password: 'secret' },
    write: { enabled: true }, read: { enabled: true }
  }
  const readOnly = setDestinationUsage([destination], 0, 'read')[0]
  assert.equal(readOnly.auth.username, 'boat')
  const managed = selectMode(destination, 'managed-container')
  assert.equal(managed.auth, undefined)
  assert.equal(selectMode(destination, 'remote').auth.username, 'boat')
})

test('switching a managed destination to remote clears its web UI exposure', () => {
  const destination = { mode: 'managed-container', exposeWebUi: true }
  assert.equal(selectMode(destination, 'remote').exposeWebUi, false)
  assert.equal(selectKind(destination, 'prometheus-compatible').exposeWebUi, false)
  const readOnly = initialConfig({ destinations: [{
    id: 'remote', kind: 'victoriametrics', mode: 'remote', url: 'http://localhost:8428', read: { enabled: true }
  }], vmagent: { exposeWebUi: true } })
  assert.equal(prepareSave(readOnly, []).vmagent.exposeWebUi, false)
})

test('saving a remote VictoriaMetrics destination keeps only its base URL', () => {
  const config = initialConfig({ destinations: [{
    id: 'remote', kind: 'victoriametrics', mode: 'remote', url: 'https://vm.example',
    write: { enabled: true }, read: { enabled: true }
  }] })
  const saved = prepareSave(config, [])
  assert.equal(saved.destinations[0].url, 'https://vm.example')
  assert.deepEqual(saved.destinations[0].write, { enabled: true })
  assert.deepEqual(saved.destinations[0].read, { enabled: true })
})
