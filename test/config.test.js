import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRetention, validateConfig } from '../src/config.js'
import { schema } from '../src/schema.js'
import { withIdentityLabels } from '../src/identity-labels.js'

const base = () => ({
  ingest: { enabled: true, labels: { job: 'signalk-victoriametrics', instance: 'boat-1' } },
  vmagent: { mode: 'host-binary', binaryPath: '/usr/bin/vmagent', queueLimitBytesPerDestination: 1024 },
  destinations: [{
    id: 'main', kind: 'victoriametrics', mode: 'remote',
    write: { enabled: true, url: 'http://localhost:8428/api/v1/write' },
    read: { enabled: true, url: 'http://localhost:8428' }
  }]
})

test('requires job and instance and preserves additional labels', () => {
  const options = base()
  options.ingest.labels.boat = 'tanagra'
  assert.deepEqual(validateConfig(options).ingest.labels, {
    job: 'signalk-victoriametrics', instance: 'boat-1', boat: 'tanagra'
  })
  delete options.ingest.labels.instance
  assert.throws(() => validateConfig(options), /Label instance is required/)
  options.ingest.labels.instance = ''
  assert.throws(() => validateConfig(options), /non-empty string/)
})

test('provisions only absent identity labels', () => {
  const original = { ingest: { labels: { job: 'my-fleet', boat: 'tanagra' } } }
  const first = withIdentityLabels(original)
  assert.equal(first.changed, true)
  assert.equal(first.configuration.ingest.labels.job, 'my-fleet')
  assert.equal(first.configuration.ingest.labels.boat, 'tanagra')
  assert.match(first.configuration.ingest.labels.instance, /^signalk-victoriametrics-[a-f0-9]{10}$/)
  assert.equal(original.ingest.labels.instance, undefined)
  const second = withIdentityLabels(first.configuration)
  assert.equal(second.changed, false)
  assert.strictEqual(second.configuration, first.configuration)
})

test('defaults to a five-second minimum period but preserves an explicit zero', () => {
  const options = base()
  assert.equal(validateConfig(options).ingest.minPeriodMs, 5000)
  assert.equal(schema.properties.ingest.properties.minPeriodMs.default, 5000)
  options.ingest.minPeriodMs = 0
  assert.equal(validateConfig(options).ingest.minPeriodMs, 0)
})

test('defaults to a one-second flush interval but preserves an explicit value', () => {
  const options = base()
  assert.equal(validateConfig(options).ingest.batch.flushMs, 1000)
  assert.equal(schema.properties.ingest.properties.batch.properties.flushMs.default, 1000)
  options.ingest.batch = { flushMs: 400 }
  assert.equal(validateConfig(options).ingest.batch.flushMs, 400)
})

test('cardinality warning defaults to 100 and validates advanced exclusions', () => {
  const options = base()
  assert.deepEqual(validateConfig(options).ingest.cardinalityAlert, {
    maxSeriesPerPathPerDay: 100, excludedPaths: []
  })
  options.ingest.cardinalityAlert = { maxSeriesPerPathPerDay: 150, excludedPaths: ['navigation.state'] }
  assert.deepEqual(validateConfig(options).ingest.cardinalityAlert, options.ingest.cardinalityAlert)
  options.ingest.cardinalityAlert.maxSeriesPerPathPerDay = 251
  assert.throws(() => validateConfig(options), /Invalid ingest.cardinalityAlert/)
  options.ingest.cardinalityAlert.maxSeriesPerPathPerDay = 100
  options.ingest.cardinalityAlert.excludedPaths = ['']
  assert.throws(() => validateConfig(options), /Invalid ingest.cardinalityAlert/)
})

test('rejects reserved labels', () => {
  const options = base()
  options.ingest.labels.preferred = 'false'
  assert.throws(() => validateConfig(options), /reserved label/)
  delete options.ingest.labels.preferred
  options.ingest.labels.signalk_value_type = 'boolean'
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

test('derives ingestion from write-enabled destinations', () => {
  const options = base()
  options.ingest.enabled = false
  assert.equal(validateConfig(options).ingest.enabled, true)
  options.destinations[0].write.enabled = false
  options.ingest.enabled = true
  assert.equal(validateConfig(options).ingest.enabled, false)
})

test('read-only configuration needs no vmagent settings', () => {
  const options = base()
  options.destinations[0].write.enabled = false
  options.vmagent = { mode: 'host-binary', binaryPath: '/does/not/exist' }
  assert.equal(validateConfig(options).ingest.enabled, false)
})

test('rejects destinations with neither read nor write enabled', () => {
  const options = base()
  options.destinations[0].write.enabled = false
  options.destinations[0].read.enabled = false
  assert.throws(() => validateConfig(options), /must be used for writing, History, or both/)
})

test('retention defaults, empty unlimited request, and invalid values', () => {
  const options = base()
  options.destinations[0].mode = 'managed-container'
  delete options.destinations[0].retention
  assert.equal(validateConfig(options).destinations[0].retention, '30d')
  options.destinations[0].retention = ''
  assert.equal(validateConfig(options).destinations[0].retention, '100y')
  assert.equal(options.destinations[0].retention, '')
  assert.equal(normalizeRetention(' 24h ', 'main'), '24h')
  assert.throws(() => normalizeRetention('12h', 'main'), /at least 1d/)
  assert.throws(() => normalizeRetention('tomorrow', 'main'), /invalid retention/)
})

test('configuration schema does not expose derived ingestion or image versions', () => {
  assert.equal(schema.properties.ingest.properties.enabled, undefined)
  assert.equal(schema.properties.vmagent.properties.imageTag, undefined)
  assert.equal(schema.properties.destinations.items.properties.imageTag, undefined)
})

test('rejects empty whitelist and unsafe URL credentials', () => {
  const options = base()
  options.ingest.filterMode = 'whitelist'
  assert.throws(() => validateConfig(options), /Whitelist cannot be empty/)
  options.ingest.paths = ['navigation']
  options.destinations[0].write.url = 'http://user:secret@localhost:8428/api/v1/write'
  assert.throws(() => validateConfig(options), /Remote Write URL/)
})

test('accepts one Basic Auth credential pair for a remote destination', () => {
  const options = base()
  options.destinations[0].auth = { type: 'basic', username: 'boat', password: 'secret:with:colons' }
  assert.deepEqual(validateConfig(options).destinations[0].auth, options.destinations[0].auth)
  assert.equal(schema.properties.destinations.items.properties.auth.properties.password.format, 'password')
})

test('rejects incomplete or inapplicable Basic Auth', () => {
  const options = base()
  options.destinations[0].auth = { type: 'basic', username: 'boat', password: '' }
  assert.throws(() => validateConfig(options), /invalid Basic Auth/)
  options.destinations[0].auth.password = 'secret'
  options.destinations[0].auth.username = 'bad:name'
  assert.throws(() => validateConfig(options), /invalid Basic Auth/)
  options.destinations[0].auth.username = 'boat'
  options.destinations[0].mode = 'managed-container'
  assert.throws(() => validateConfig(options), /invalid Basic Auth/)
})

test('web interfaces are opt-in and limited to managed services', () => {
  const options = base()
  assert.equal(validateConfig(options).vmagent.exposeWebUi, undefined)
  options.vmagent.exposeWebUi = true
  assert.equal(validateConfig(options).vmagent.exposeWebUi, true)
  options.destinations[0].exposeWebUi = true
  assert.throws(() => validateConfig(options), /Only managed VictoriaMetrics/)
  options.destinations[0].mode = 'managed-container'
  assert.equal(validateConfig(options).destinations[0].exposeWebUi, true)
  options.destinations[0].write.enabled = false
  assert.throws(() => validateConfig(options), /vmagent web UI requires/)
  options.vmagent.exposeWebUi = false
  assert.equal(validateConfig(options).destinations[0].exposeWebUi, true)
  options.destinations[0].exposeWebUi = 'yes'
  assert.throws(() => validateConfig(options), /exposeWebUi must be boolean/)
})
