import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SESSION_METRIC_INTERVAL_MS,
  SESSION_METRIC_NAME,
  sessionMetricSample,
  startSessionMetric
} from '../src/session-metric.js'

test('session marker identifies the writer without becoming a Signal K path', () => {
  const sample = sessionMetricSample({ job: 'signalk', instance: 'boat-1', site: 'harbor' }, 1727450000123, 1727450015000)
  assert.deepEqual(sample, {
    labels: {
      __name__: SESSION_METRIC_NAME,
      job: 'signalk',
      instance: 'boat-1',
      site: 'harbor',
      source: 'signalk-victoriametrics-history-provider'
    },
    value: 1727450000.123,
    timestamp: 1727450015000
  })
  assert.equal(sample.labels.signalk_path, undefined)
  assert.equal(sample.labels.context, undefined)
})

test('session marker is repeated every 15 seconds and stops with the plugin', () => {
  const samples = []
  let flushes = 0
  let interval
  let cancelled = false
  let now = 1727450001000
  const stop = startSessionMetric({
    add: batch => samples.push(...batch),
    flush: () => { flushes++ }
  }, { job: 'signalk', instance: 'boat-1' }, 1727450000123, {
    now: () => now,
    setInterval: (callback, period) => {
      assert.equal(period, SESSION_METRIC_INTERVAL_MS)
      interval = callback
      return 1
    },
    clearInterval: id => {
      assert.equal(id, 1)
      cancelled = true
    }
  })

  assert.equal(samples.length, 1)
  now += SESSION_METRIC_INTERVAL_MS
  interval()
  assert.equal(samples.length, 2)
  assert.equal(samples[0].value, samples[1].value)
  assert.equal(samples[1].timestamp - samples[0].timestamp, SESSION_METRIC_INTERVAL_MS)
  assert.equal(flushes, 2)
  stop()
  assert.equal(cancelled, true)
})
