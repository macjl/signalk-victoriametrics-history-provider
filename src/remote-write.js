import protobuf from 'protobufjs'
import snappy from 'snappyjs'

const root = protobuf.parse(`syntax = "proto3";
message Label { string name = 1; string value = 2; }
message Sample { double value = 1; int64 timestamp = 2; }
message TimeSeries { repeated Label labels = 1; repeated Sample samples = 2; }
message WriteRequest { repeated TimeSeries timeseries = 1; }
`).root
const WriteRequest = root.lookupType('WriteRequest')

export function encodeWriteRequest(samples) {
  const series = new Map()
  for (const sample of samples) {
    const labels = Object.entries(sample.labels).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => ({ name, value }))
    const key = JSON.stringify(labels)
    if (!series.has(key)) series.set(key, { labels, samples: [] })
    series.get(key).samples.push({ value: sample.value, timestamp: sample.timestamp })
  }
  for (const entry of series.values()) entry.samples.sort((a, b) => a.timestamp - b.timestamp)
  const error = WriteRequest.verify({ timeseries: [...series.values()] })
  if (error) throw new Error(error)
  return snappy.compress(WriteRequest.encode({ timeseries: [...series.values()] }).finish())
}

export async function postSamples(url, samples, fetchImpl = fetch) {
  const body = encodeWriteRequest(samples)
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'snappy',
      'Content-Type': 'application/x-protobuf',
      'X-Prometheus-Remote-Write-Version': '0.1.0',
      'User-Agent': 'signalk-victoriametrics-history-provider/0.0.0'
    },
    body,
    signal: AbortSignal.timeout(10000)
  })
  if (!response.ok) throw new Error(`vmagent rejected Remote Write: HTTP ${response.status}`)
}
