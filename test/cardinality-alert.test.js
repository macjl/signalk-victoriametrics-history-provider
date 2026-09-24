import test from 'node:test'
import assert from 'node:assert/strict'
import { CardinalityAlert } from '../src/cardinality-alert.js'

const day = Date.parse('2026-09-24T12:00:00Z')

function sample(path, value) {
  return { labels: { __name__: path.replaceAll('.', '_'), signalk_path: path, context: 'vessels.boat', source: 'sensor', value_str: value }, value: 1, timestamp: day }
}

test('warns on distinct series while leaving samples untouched', () => {
  const monitor = new CardinalityAlert({ maxSeriesPerPathPerDay: 3 })
  const first = sample('navigation.state', 'sailing')
  assert.equal(monitor.observe([first], day), true)
  assert.equal(monitor.message(), '')
  assert.equal(monitor.observe([first], day), false)
  assert.equal(monitor.observe([sample('navigation.state', 'moored')], day), false)
  assert.equal(monitor.observe([sample('navigation.state', 'anchored')], day), true)
  assert.match(monitor.message(), /navigation\.state/)
  assert.match(monitor.message(), /Ingestion continues/)
  assert.equal(monitor.observe([sample('navigation.state', 'unknown')], day), false)
  assert.equal(first.labels.value_str, 'sailing')
})

test('exempt paths affect only monitoring and reset at the next UTC day', () => {
  const monitor = new CardinalityAlert({ maxSeriesPerPathPerDay: 2, excludedPaths: ['steering.autopilot'] })
  assert.equal(monitor.observe([sample('steering.autopilot.mode', 'auto'), sample('steering.autopilot.mode', 'standby')], day), true)
  assert.equal(monitor.message(), '')
  monitor.observe([sample('navigation.state', 'sailing'), sample('navigation.state', 'moored')], day)
  assert.match(monitor.message(), /navigation\.state/)
  assert.equal(monitor.rollover(Date.parse('2026-09-25T00:00:00Z')), true)
  assert.equal(monitor.message(), '')
})

test('bounds the number of monitored paths and reports incomplete coverage', () => {
  const monitor = new CardinalityAlert()
  const samples = Array.from({ length: 501 }, (_, index) => sample(`custom.path${index}`, 'value'))
  assert.equal(monitor.observe(samples, day), true)
  assert.match(monitor.message(), /500 distinct paths/)
  assert.equal(monitor.paths.size, 500)
})
