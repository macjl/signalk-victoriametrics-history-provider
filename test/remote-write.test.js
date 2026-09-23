import test from 'node:test'
import assert from 'node:assert/strict'
import protobuf from 'protobufjs'
import snappy from 'snappyjs'
import { encodeWriteRequest, postSamples } from '../src/remote-write.js'
import { SampleBatcher } from '../src/batch.js'
import { parseVmagentStatus } from '../src/vmagent-status.js'

const schema = protobuf.parse(`syntax = "proto3";
message Label { string name = 1; string value = 2; }
message Sample { double value = 1; int64 timestamp = 2; }
message TimeSeries { repeated Label labels = 1; repeated Sample samples = 2; }
message WriteRequest { repeated TimeSeries timeseries = 1; }`).root.lookupType('WriteRequest')

test('encodes grouped ordered Prometheus Remote Write v1 samples', () => {
  const body = encodeWriteRequest([
    { labels: { source: 'a', __name__: 'speed' }, value: 2, timestamp: 2000 },
    { labels: { __name__: 'speed', source: 'a' }, value: 1, timestamp: 1000 },
    { labels: { __name__: 'speed', source: 'b' }, value: 3, timestamp: 3000 }
  ])
  const decoded = schema.decode(snappy.uncompress(body))
  assert.equal(decoded.timeseries.length, 2)
  assert.deepEqual(decoded.timeseries[0].labels.map(label => label.name), ['__name__', 'source'])
  assert.deepEqual(decoded.timeseries[0].samples.map(sample => sample.value), [1, 2])
})

test('sends required Remote Write headers', async () => {
  let request
  await postSamples('http://localhost:8429/api/v1/write', [], async (_url, options) => {
    request = options
    return { ok: true }
  })
  assert.equal(request.headers['Content-Encoding'], 'snappy')
  assert.equal(request.headers['X-Prometheus-Remote-Write-Version'], '0.1.0')
})

test('batcher bounds pending samples and counts failed sends', async () => {
  const errors = []
  const batcher = new SampleBatcher({
    limits: { maxSamples: 3, flushMs: 100000, maxPendingSamples: 3 },
    send: async () => { throw new Error('down') },
    onError: error => errors.push(error.message)
  })
  batcher.add([{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(batcher.dropped, 4)
  assert.deepEqual(errors, ['down'])
  batcher.stop()
})

test('aggregates vmagent queue and loss metrics', () => {
  const status = parseVmagentStatus(`vmagent_remotewrite_pending_data_bytes{url="1:x"} 64
vmagent_remotewrite_pending_data_bytes{url="2:y"} 32
vmagent_remotewrite_samples_dropped_total{url="1:x"} 2
vmagent_remotewrite_push_failures_total{url="2:y"} 3`)
  assert.deepEqual(status, { pendingBytes: 96, droppedSamples: 2, pushFailures: 3, blockedQueues: 0 })
})
