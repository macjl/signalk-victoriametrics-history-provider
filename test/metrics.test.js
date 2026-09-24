import test from 'node:test'
import assert from 'node:assert/strict'
import { deltaToSamples, metricName } from '../src/metrics.js'

const config = { contexts: 'self', filterMode: 'blacklist', paths: [], labels: { boat: 'tanagra' } }
const self = 'vessels.urn:mrn:signalk:uuid:boat'

test('metric name normalization preserves original path in labels', () => {
  assert.equal(metricName('navigation.speedOverGround'), 'navigation_speedOverGround')
  const samples = deltaToSamples({
    context: 'vessels.self',
    updates: [{ $source: 'can0.device', timestamp: '2026-01-01T00:00:00Z', values: [
      { path: 'navigation.speedOverGround', value: 3.14 }
    ] }]
  }, config, self)
  assert.equal(samples.length, 1)
  assert.deepEqual(samples[0], {
    labels: {
      __name__: 'navigation_speedOverGround', context: self, source: 'can0.device',
      signalk_path: 'navigation.speedOverGround', preferred: 'true', boat: 'tanagra'
    }, value: 3.14, timestamp: Date.parse('2026-01-01T00:00:00Z')
  })
})

test('position is written only as a complete pair', () => {
  const delta = { context: self, updates: [{ $source: 'gps', values: [
    { path: 'navigation.position', value: { latitude: 48.1, longitude: -4.1 } }
  ] }] }
  const samples = deltaToSamples(delta, config, self, 1234)
  assert.deepEqual(samples.map(item => item.labels.signalk_leaf).sort(), [
    'navigation.position.latitude', 'navigation.position.longitude'
  ])
  assert.ok(samples.every(item => item.timestamp === 1234))
  delta.updates[0].values[0].value.longitude = null
  assert.deepEqual(deltaToSamples(delta, config, self), [])
})

test('position is not written partially when one coordinate is filtered', () => {
  const delta = { context: self, updates: [{ $source: 'gps', values: [
    { path: 'navigation.position', value: { longitude: 1, latitude: 2 } }
  ] }] }
  const selected = { ...config, paths: ['navigation.position.latitude'] }
  assert.deepEqual(deltaToSamples(delta, selected, self), [])
})

test('filters original leaves and drops invalid sources and values', () => {
  const delta = { context: self, updates: [{ $source: 'sensor', values: [
    { path: 'environment.wind', value: { speed: 5, angle: 1 } },
    { path: 'navigation.depth', value: Infinity }
  ] }] }
  const selected = { ...config, paths: ['environment.wind.angle'] }
  assert.deepEqual(deltaToSamples(delta, selected, self).map(item => item.labels.signalk_leaf), [
    'environment.wind.speed'
  ])
  delta.updates[0].$source = undefined
  assert.deepEqual(deltaToSamples(delta, selected, self), [])
})

test('encodes string and JSON types without turning booleans into untyped numbers', () => {
  const samples = deltaToSamples({ context: self, updates: [{ $source: 'sensor', values: [
    { path: 'navigation.state', value: 'moored' },
    { path: 'navigation.flags', value: { active: true, names: ['a', null], empty: [] } }
  ] }] }, config, self, 1234)
  assert.equal(samples.find(sample => sample.labels.signalk_path === 'navigation.state').labels.value_str, 'moored')
  assert.equal(samples.find(sample => sample.labels.signalk_leaf === 'navigation.flags.active').labels.signalk_value_type, 'boolean')
  assert.equal(samples.find(sample => sample.labels.signalk_leaf === 'navigation.flags.names.0').labels.signalk_leaf_parts, '["names",0]')
  assert.equal(samples.find(sample => sample.labels.signalk_leaf === 'navigation.flags.names.1').labels.signalk_value_type, 'null')
  assert.equal(samples.find(sample => sample.labels.signalk_leaf === 'navigation.flags.empty').labels.signalk_value_type, 'array')
})
