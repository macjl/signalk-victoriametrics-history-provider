import test from 'node:test'
import assert from 'node:assert/strict'
import { VictoriaMetricsHistory } from '../src/history.js'
import { deltaToSamples } from '../src/metrics.js'

const from = '2026-09-23T12:00:00.000Z'
const to = '2026-09-23T12:00:03.000Z'
const t = Date.parse(from)

function provider(rows, onUrl = () => {}, getMetadata = () => undefined) {
  return new VictoriaMetricsHistory({
    baseUrl: 'http://localhost:8428',
    selfContext: 'vessels.boat',
    labels: { instance: 'boat-1' },
    getMetadata,
    fetchImpl: async url => {
      onUrl(new URL(url))
      const label = new URL(url).pathname.match(/\/label\/(context|signalk_path)\/values$/)?.[1]
      if (label) return new Response(JSON.stringify({ status: 'success', data: [...new Set(rows.map(row => row.metric[label]).filter(Boolean))] }))
      return new Response(rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    }
  })
}

function exportRows(samples) {
  const rows = new Map()
  for (const sample of samples) {
    const key = JSON.stringify(sample.labels)
    if (!rows.has(key)) rows.set(key, { metric: sample.labels, values: [], timestamps: [] })
    rows.get(key).values.push(sample.value)
    rows.get(key).timestamps.push(sample.timestamp)
  }
  return [...rows.values()]
}

test('uses destination Basic Auth on History requests', async () => {
  let headers
  const history = new VictoriaMetricsHistory({
    baseUrl: 'https://example.test', selfContext: 'vessels.boat',
    auth: { type: 'basic', username: 'reader', password: 's:ecret' },
    fetchImpl: async (_url, options) => {
      headers = options.headers
      return new Response(JSON.stringify({ status: 'success', data: [] }), { status: 200 })
    }
  })
  await history.getPaths({ from, to })
  assert.equal(headers.Authorization, `Basic ${Buffer.from('reader:s:ecret').toString('base64')}`)
})

test('uses destination bearer token on History export and discovery requests', async () => {
  const requests = []
  const history = new VictoriaMetricsHistory({
    baseUrl: 'https://example.test', selfContext: 'vessels.boat',
    auth: { type: 'bearer', token: 'opaque.token' },
    fetchImpl: async (url, options) => {
      requests.push({ url, headers: options.headers })
      return new Response(new URL(url).pathname.includes('/label/')
        ? JSON.stringify({ status: 'success', data: [] })
        : JSON.stringify({ metric: { source: 'sensor' }, values: [1], timestamps: [t] }))
    }
  })
  await history.getValues({ from, to, pathSpecs: [{ path: 'navigation.headingTrue' }] })
  await history.getPaths({ from, to })
  assert.equal(requests.length, 2)
  assert.ok(requests.every(request => request.headers.Authorization === 'Bearer opaque.token'))
})

test('reads raw values across source changes and filters by historical source', async () => {
  const rows = [
    { metric: { source: 'a' }, values: [1], timestamps: [t] },
    { metric: { source: 'b' }, values: [2], timestamps: [t + 1000] }
  ]
  let selector
  const history = provider(rows, url => { selector = url.searchParams.get('match[]') })
  const result = await history.getValues({ from, to, pathSpecs: [{ path: 'navigation.speedOverGround', aggregate: 'average' }] })
  assert.deepEqual(result.data, [
    [from, 1], ['2026-09-23T12:00:01.000Z', 2]
  ])
  assert.equal(result.values[0].method, 'average')
  assert.match(selector, /preferred=~"true\|"/)
  assert.match(selector, /instance="boat-1"/)
  await history.getValues({ from, to, pathSpecs: [{ path: 'navigation.speedOverGround', sourceRef: 'a' }] })
  assert.match(selector, /source="a"/)
})

test('resolves vessels.self to the canonical context in History queries', async () => {
  let selector
  const history = provider([{ metric: { source: 'gps' }, values: [2], timestamps: [t] }], url => {
    selector = url.searchParams.get('match[]')
  })
  const result = await history.getValues({ context: 'vessels.self', from, to,
    pathSpecs: [{ path: 'navigation.speedOverGround' }] })
  assert.equal(result.context, 'vessels.boat')
  assert.match(selector, /context="vessels.boat"/)
})

test('position pairs only same timestamp and source', async () => {
  const history = provider([
    { metric: { source: 'a', signalk_leaf: 'navigation.position.longitude' }, values: [-4], timestamps: [t] },
    { metric: { source: 'a', signalk_leaf: 'navigation.position.latitude' }, values: [48], timestamps: [t] },
    { metric: { source: 'b', signalk_leaf: 'navigation.position.latitude' }, values: [50], timestamps: [t + 1000] }
  ])
  const result = await history.getValues({ from, to, pathSpecs: [{ path: 'navigation.position', aggregate: 'first' }] })
  assert.deepEqual(result.data, [[from, [-4, 48]], ['2026-09-23T12:00:01.000Z', null]])
})

test('resolution buckets samples in the default merged column', async () => {
  const history = provider([{ metric: { source: 'a' }, values: [2, 4], timestamps: [t, t + 1000] }])
  const result = await history.getValues({ from, to, resolution: 2, pathSpecs: [{ path: 'navigation.speedOverGround', aggregate: 'average' }] })
  assert.deepEqual(result.data, [[from, 3]])
})

test('includes samples exactly at to, even when VM export uses an exclusive end', async () => {
  const samples = [
    { timestamp: t - 1, value: 0 },
    { timestamp: t, value: 1 },
    { timestamp: t + 1000, value: 2 },
    { timestamp: Date.parse(to), value: 3 },
    { timestamp: Date.parse(to) + 1, value: 4 }
  ]
  const history = new VictoriaMetricsHistory({
    baseUrl: 'http://localhost:8428', selfContext: 'vessels.boat',
    fetchImpl: async url => {
      const end = Number(new URL(url).searchParams.get('end')) * 1000
      assert.ok(end > Date.parse(to))
      const exported = samples.filter(sample => sample.timestamp < end)
      return new Response(JSON.stringify({
        metric: { source: 'gps' },
        values: exported.map(sample => sample.value),
        timestamps: exported.map(sample => sample.timestamp)
      }))
    }
  })
  const query = { from, to, pathSpecs: [{ path: 'navigation.speedOverGround' }] }
  assert.deepEqual((await history.getValues(query)).data, [
    [from, 1], ['2026-09-23T12:00:01.000Z', 2], [to, 3]
  ])
  assert.deepEqual((await history.getValues({ ...query, resolution: 2, sourcePolicy: 'all' })).data, [
    [from, 1.5], ['2026-09-23T12:00:02.000Z', 3]
  ])
})

test('sourcePolicy=all splits stored sources into aligned columns', async () => {
  const rows = [
    { metric: { source: 'b' }, values: [10, 20], timestamps: [t, t + 1000] },
    { metric: { source: 'a' }, values: [2, 4], timestamps: [t, t + 2000] }
  ]
  let selector
  const history = provider(rows, url => { selector = url.searchParams.get('match[]') })
  const query = { from, to, sourcePolicy: 'all', pathSpecs: [{ path: 'navigation.speedOverGround' }] }
  const result = await history.getValues(query)
  assert.deepEqual(result.values, [
    { path: 'navigation.speedOverGround', method: 'average', $source: 'a' },
    { path: 'navigation.speedOverGround', method: 'average', $source: 'b' }
  ])
  assert.deepEqual(result.data, [
    [from, 2, 10], ['2026-09-23T12:00:01.000Z', null, 20], ['2026-09-23T12:00:02.000Z', 4, null]
  ])
  assert.match(selector, /preferred=~"true\|"/)
  assert.doesNotMatch(selector, /source=/)

  const bucketed = await history.getValues({ ...query, resolution: 2 })
  assert.deepEqual(bucketed.data, [[from, 2, 15], ['2026-09-23T12:00:02.000Z', 4, null]])

  const filtered = await history.getValues({ ...query, pathSpecs: [{ path: 'navigation.speedOverGround', sourceRef: 'b' }] })
  assert.deepEqual(filtered.values, [{ path: 'navigation.speedOverGround', method: 'average', $source: 'b' }])
  assert.deepEqual(filtered.data, [[from, 10], ['2026-09-23T12:00:01.000Z', 20]])
  assert.match(selector, /source="b"/)
})

test('sourcePolicy=all preserves path order and per-source aggregate methods', async () => {
  const history = new VictoriaMetricsHistory({
    baseUrl: 'http://localhost:8428', selfContext: 'vessels.boat',
    fetchImpl: async url => {
      const path = new URL(url).searchParams.get('match[]').includes('signalk_path="navigation.state"')
      const rows = path
        ? [
            { metric: { source: 'a' }, values: [2, 4], timestamps: [t, t + 1000] },
            { metric: { source: 'b', value_str: 'sailing' }, values: [1], timestamps: [t + 1000] }
          ]
        : [{ metric: { source: 'gps' }, values: [3], timestamps: [t] }]
      return new Response(rows.map(row => JSON.stringify(row)).join('\n'))
    }
  })
  const result = await history.getValues({ from, to, resolution: 2, sourcePolicy: 'all', pathSpecs: [
    { path: 'navigation.state' }, { path: 'navigation.speedOverGround' }
  ] })
  assert.deepEqual(result.values, [
    { path: 'navigation.state', method: 'average', $source: 'a' },
    { path: 'navigation.state', method: 'last', $source: 'b' },
    { path: 'navigation.speedOverGround', method: 'average', $source: 'gps' }
  ])
  assert.deepEqual(result.data, [[from, 3, 'sailing', 3]])
})

test('sourcePolicy=all pairs positions only within each stored source', async () => {
  const history = provider([
    { metric: { source: 'a', signalk_leaf: 'navigation.position.longitude' }, values: [-4], timestamps: [t] },
    { metric: { source: 'a', signalk_leaf: 'navigation.position.latitude' }, values: [48], timestamps: [t] },
    { metric: { source: 'b', signalk_leaf: 'navigation.position.longitude' }, values: [-5, -6], timestamps: [t, t + 1000] },
    { metric: { source: 'b', signalk_leaf: 'navigation.position.latitude' }, values: [49], timestamps: [t] }
  ])
  const result = await history.getValues({ from, to, sourcePolicy: 'all', pathSpecs: [{ path: 'navigation.position' }] })
  assert.deepEqual(result.values, [
    { path: 'navigation.position', method: 'first', $source: 'a' },
    { path: 'navigation.position', method: 'first', $source: 'b' }
  ])
  assert.deepEqual(result.data, [[from, [-4, 48], [-5, 49]], ['2026-09-23T12:00:01.000Z', null, null]])
})

test('sourcePolicy=all keeps source-less samples without treating them as an error', async () => {
  const query = { from, to, sourcePolicy: 'all', pathSpecs: [{ path: 'navigation.headingTrue' }] }
  assert.deepEqual((await provider([]).getValues(query)).values, [])
  const result = await provider([
    { metric: { source: 'compass' }, values: [2], timestamps: [t] },
    { metric: {}, values: [1], timestamps: [t] }
  ]).getValues(query)
  assert.deepEqual(result.values, [
    { path: 'navigation.headingTrue', method: 'average' },
    { path: 'navigation.headingTrue', method: 'average', $source: 'compass' }
  ])
  assert.deepEqual(result.data, [[from, 1, 2]])
})

test('averages common Signal K angle paths across zero', async () => {
  const history = provider([{ metric: { source: 'compass' }, values: [6.2, 0.08], timestamps: [t, t + 1000] }],
    () => {}, () => ({ units: 'rad' }))
  for (const path of ['navigation.headingMagnetic', 'navigation.headingTrue', 'navigation.courseOverGroundTrue']) {
    const result = await history.getValues({ from, to, resolution: 2, pathSpecs: [{ path, aggregate: 'average' }] })
    const angle = result.data[0][1]
    assert.ok(Math.min(angle, 2 * Math.PI - angle) < 0.1, `${path}: ${angle}`)
  }
})

test('only metadata with units rad enables circular aggregation', async () => {
  const rows = [{ metric: { source: 'compass' }, values: [6.2, 0.08], timestamps: [t, t + 1000] }]
  const path = 'custom.orientation'
  const requested = []
  const radians = provider(rows, () => {}, fullPath => {
    requested.push(fullPath)
    return { units: 'rad' }
  })
  const circular = await radians.getValues({ from, to, resolution: 2, pathSpecs: [{ path }] })
  assert.deepEqual(requested, ['vessels.boat.custom.orientation'])
  assert.ok(Math.min(circular.data[0][1], 2 * Math.PI - circular.data[0][1]) < 0.1)

  const namedAngle = 'navigation.headingTrue'
  const linear = await provider(rows, () => {}, () => ({ units: 'deg' }))
    .getValues({ from, to, resolution: 2, pathSpecs: [{ path: namedAngle }] })
  assert.deepEqual(linear.data, [[from, 3.14]])
  const missing = await provider(rows).getValues({ from, to, resolution: 2, pathSpecs: [{ path: namedAngle }] })
  assert.deepEqual(missing.data, [[from, 3.14]])

  const signed = await provider([{ metric: { source: 'wind' }, values: [-0.2, -0.1], timestamps: [t, t + 1000] }],
    () => {}, () => ({ units: 'rad' }))
    .getValues({ from, to, resolution: 2, pathSpecs: [{ path: 'environment.wind.angleApparent' }] })
  assert.ok(signed.data[0][1] >= 0 && signed.data[0][1] < 2 * Math.PI)
  assert.ok(Math.abs(signed.data[0][1] - (2 * Math.PI - 0.15)) < 1e-10)
})

test('sma uses a sample-count window, including partial windows at the requested start', async () => {
  const history = provider([{ metric: { source: 'gps' }, values: [2, 4, 10, 8], timestamps: [t, t + 1000, t + 4000, t + 5000] }])
  const query = { from, to: '2026-09-23T12:00:06.000Z', pathSpecs: [
    { path: 'navigation.speedOverGround', aggregate: 'sma', parameter: ['3'] }
  ] }
  const raw = await history.getValues(query)
  assert.deepEqual(raw.values, [{ path: 'navigation.speedOverGround', method: 'sma' }])
  assert.deepEqual(raw.data, [
    [from, 2], ['2026-09-23T12:00:01.000Z', 3],
    ['2026-09-23T12:00:04.000Z', 16 / 3], ['2026-09-23T12:00:05.000Z', 22 / 3]
  ])
  assert.deepEqual((await history.getValues({ ...query, resolution: 2 })).data, [
    [from, 3], ['2026-09-23T12:00:04.000Z', 22 / 3]
  ])
  assert.deepEqual((await history.getValues({ ...query, from: '2026-09-23T12:00:04.000Z' })).data, [
    ['2026-09-23T12:00:04.000Z', 10], ['2026-09-23T12:00:05.000Z', 9]
  ])
})

test('ema uses the first sample as its seed and the requested alpha', async () => {
  const history = provider([{ metric: { source: 'gps' }, values: [10, 20, 30], timestamps: [t, t + 1000, t + 2000] }])
  const path = 'navigation.speedOverGround'
  const query = { from, to, pathSpecs: [{ path, aggregate: 'ema', parameter: ['0.5'] }] }
  assert.deepEqual((await history.getValues(query)).data, [
    [from, 10], ['2026-09-23T12:00:01.000Z', 15], ['2026-09-23T12:00:02.000Z', 22.5]
  ])
  assert.deepEqual((await history.getValues({ ...query, resolution: 2 })).data, [
    [from, 15], ['2026-09-23T12:00:02.000Z', 22.5]
  ])
  assert.deepEqual((await history.getValues({ ...query, from: '2026-09-23T12:00:01.000Z' })).data, [
    ['2026-09-23T12:00:01.000Z', 20], ['2026-09-23T12:00:02.000Z', 25]
  ])
})

test('smoothing defaults and parameters are validated', async () => {
  const history = provider([{ metric: { source: 'gps' }, values: [10, 20], timestamps: [t, t + 1000] }])
  const query = (aggregate, parameter) => ({ from, to, pathSpecs: [{ path: 'navigation.speedOverGround', aggregate, parameter }] })
  assert.deepEqual((await history.getValues(query('sma'))).data, [
    [from, 10], ['2026-09-23T12:00:01.000Z', 15]
  ])
  assert.deepEqual((await history.getValues(query('ema'))).data, [
    [from, 10], ['2026-09-23T12:00:01.000Z', 12]
  ])
  for (const parameter of [['0'], ['2.5'], ['abc'], ['2', '3']]) {
    await assert.rejects(history.getValues(query('sma', parameter)), /Invalid History sma parameter/)
  }
  for (const parameter of [['0'], ['1.1'], ['abc'], ['0.2', '0.3']]) {
    await assert.rejects(history.getValues(query('ema', parameter)), /Invalid History ema parameter/)
  }
  await assert.rejects(history.getValues({ from, to, pathSpecs: [{ path: 'navigation.position', aggregate: 'sma' }] }),
    /Unsupported History aggregate for navigation.position: sma/)
})

test('smoothing separates stored sources when requested and merges them otherwise', async () => {
  const history = provider([
    { metric: { source: 'b' }, values: [10, 20], timestamps: [t, t + 2000] },
    { metric: { source: 'a' }, values: [2, 4, 6], timestamps: [t, t + 1000, t + 2000] }
  ])
  const pathSpecs = [{ path: 'navigation.speedOverGround', aggregate: 'sma', parameter: ['2'] }]
  const split = await history.getValues({ from, to, sourcePolicy: 'all', pathSpecs })
  assert.deepEqual(split.values, [
    { path: 'navigation.speedOverGround', method: 'sma', $source: 'a' },
    { path: 'navigation.speedOverGround', method: 'sma', $source: 'b' }
  ])
  assert.deepEqual(split.data, [
    [from, 2, 10], ['2026-09-23T12:00:01.000Z', 3, null], ['2026-09-23T12:00:02.000Z', 5, 15]
  ])
  assert.deepEqual((await history.getValues({ from, to, pathSpecs })).data, [
    [from, 6], ['2026-09-23T12:00:01.000Z', 7], ['2026-09-23T12:00:02.000Z', 13]
  ])
  assert.deepEqual((await history.getValues({ from, to, pathSpecs: [{ ...pathSpecs[0], sourceRef: 'b' }] })).data, [
    [from, 10], ['2026-09-23T12:00:02.000Z', 15]
  ])
})

test('sma and ema smooth angles circularly and reject nonnumeric values', async () => {
  const angles = provider([{ metric: { source: 'compass' }, values: [6.2, 0.08], timestamps: [t, t + 1000] }],
    () => {}, () => ({ units: 'rad' }))
  for (const [aggregate, parameter] of [['sma', ['2']], ['ema', ['0.5']]]) {
    const result = await angles.getValues({ from, to, pathSpecs: [{ path: 'navigation.headingTrue', aggregate, parameter }] })
    const angle = result.data[1][1]
    assert.ok(Math.min(angle, 2 * Math.PI - angle) < 0.1, `${aggregate}: ${angle}`)
  }
  const cancelled = provider([{ metric: { source: 'compass' }, values: [0, Math.PI], timestamps: [t, t + 1000] }],
    () => {}, () => ({ units: 'rad' }))
  assert.equal((await cancelled.getValues({ from, to, pathSpecs: [
    { path: 'navigation.headingTrue', aggregate: 'sma', parameter: ['2'] }
  ] })).data[1][1], null)
  const strings = provider([{ metric: { source: 'sensor', value_str: 'sailing' }, values: [1], timestamps: [t] }])
  await assert.rejects(strings.getValues({ from, to, pathSpecs: [{ path: 'navigation.state', aggregate: 'ema' }] }),
    /ema requires numeric values/)
})

test('same-timestamp sources are both included in numeric aggregates', async () => {
  const history = provider([
    { metric: { source: 'z' }, values: [100], timestamps: [t] },
    { metric: { source: 'a' }, values: [2], timestamps: [t] }
  ])
  const result = await history.getValues({ from, to, pathSpecs: [{ path: 'navigation.speedOverGround', aggregate: 'average' }] })
  assert.deepEqual(result.data, [[from, 51]])
  const first = await history.getValues({ from, to, pathSpecs: [{ path: 'navigation.speedOverGround', aggregate: 'first' }] })
  assert.deepEqual(first.data, [[from, 2]])
})

test('ignores identical History samples from the same series and timestamp', async () => {
  const history = provider([
    { metric: { __name__: 'navigation_headingTrue', source: 'compass' }, values: [1, 1], timestamps: [t, t] },
    { metric: { source: 'compass', __name__: 'navigation_headingTrue' }, values: [1], timestamps: [t] }
  ])
  const result = await history.getValues({ from, to, pathSpecs: [{ path: 'navigation.headingTrue' }] })
  assert.deepEqual(result.data, [[from, 1]])
})

test('uses the last exported value from the same series and timestamp', async () => {
  const history = provider([
    { metric: { __name__: 'navigation_headingTrue', source: 'compass' }, values: [1, 2], timestamps: [t, t] },
    { metric: { source: 'compass', __name__: 'navigation_headingTrue' }, values: [3], timestamps: [t] }
  ])
  const result = await history.getValues({ from, to, pathSpecs: [{ path: 'navigation.headingTrue' }] })
  assert.deepEqual(result.data, [[from, 3]])
})

test('uses the last exported position leaves for duplicate timestamps', async () => {
  const history = provider([
    { metric: { source: 'gps', signalk_leaf: 'navigation.position.longitude' }, values: [-4, -5], timestamps: [t, t] },
    { metric: { source: 'gps', signalk_leaf: 'navigation.position.latitude' }, values: [48, 49], timestamps: [t, t] }
  ])
  const result = await history.getValues({ from, to, pathSpecs: [{ path: 'navigation.position' }] })
  assert.deepEqual(result.data, [[from, [-5, 49]]])
})

test('still rejects scalar and object series sharing a timestamp and source', async () => {
  const history = provider([
    { metric: { __name__: 'navigation_headingTrue', source: 'compass' }, values: [1], timestamps: [t] },
    { metric: { __name__: 'navigation_headingTrue_value', source: 'compass', signalk_leaf: 'navigation.headingTrue.value' }, values: [1], timestamps: [t] }
  ])
  await assert.rejects(history.getValues({ from, to, pathSpecs: [{ path: 'navigation.headingTrue' }] }),
    /Mixed scalar and object History values for navigation.headingTrue/)
})

test('reads existing string states and resolves default average to last', async () => {
  const history = provider([
    { metric: { source: 'autostate', value_str: 'moored' }, values: [1], timestamps: [t] },
    { metric: { source: 'autostate', value_str: 'sailing' }, values: [1], timestamps: [t + 1000] }
  ])
  const path = 'navigation.state'
  const raw = await history.getValues({ from, to, pathSpecs: [{ path, aggregate: 'average' }] })
  assert.deepEqual(raw.data, [[from, 'moored'], ['2026-09-23T12:00:01.000Z', 'sailing']])
  assert.equal(raw.values[0].method, 'last')
  const last = await history.getValues({ from, to, resolution: 2, pathSpecs: [{ path, aggregate: 'last' }] })
  assert.deepEqual(last.data, [[from, 'sailing']])
  const grouped = await history.getValues({ from, to, resolution: 2, pathSpecs: [{ path, aggregate: 'average' }] })
  assert.deepEqual(grouped.data, [[from, 'sailing']])
  assert.equal(grouped.values[0].method, 'last')
  await assert.rejects(history.getValues({ from, to, pathSpecs: [{ path, aggregate: 'min' }] }), /min requires numeric values/)
})

test('reconstructs existing JSON leaves by timestamp and source', async () => {
  const path = 'navigation.shore.closestPoint'
  const history = provider([
    { metric: { source: 'shore', signalk_leaf: `${path}.latitude` }, values: [48, 49], timestamps: [t, t + 1000] },
    { metric: { source: 'shore', signalk_leaf: `${path}.longitude` }, values: [-4, -5], timestamps: [t, t + 1000] },
    { metric: { source: 'z-other', signalk_leaf: `${path}.latitude` }, values: [50], timestamps: [t] }
  ])
  const raw = await history.getValues({ from, to, pathSpecs: [{ path, aggregate: 'average' }] })
  assert.deepEqual(raw.data, [
    [from, { latitude: 48, longitude: -4 }],
    ['2026-09-23T12:00:01.000Z', { latitude: 49, longitude: -5 }]
  ])
  const last = await history.getValues({ from, to, resolution: 2, pathSpecs: [{ path, aggregate: 'last' }] })
  assert.deepEqual(last.data, [[from, { latitude: 49, longitude: -5 }]])
  const grouped = await history.getValues({ from, to, resolution: 2, pathSpecs: [{ path, aggregate: 'average' }] })
  assert.deepEqual(grouped.data, [[from, { latitude: 49, longitude: -5 }]])
  assert.equal(grouped.values[0].method, 'last')
})

test('round-trips nested JSON, arrays, booleans, dates and null leaves', async () => {
  const path = 'navigation.details'
  const value = { 'part.name': { active: true, tags: ['sailing', null, ''] }, empty: {}, emptyList: [], since: '2026-09-23T12:00:00.000Z' }
  const samples = deltaToSamples({ context: 'vessels.self', updates: [{ $source: 'sensor', timestamp: from, values: [{ path, value }] }] },
    { contexts: 'self', filterMode: 'blacklist', paths: [], labels: {} }, 'vessels.boat')
  assert.ok(samples.some(sample => sample.labels.signalk_leaf_parts))
  const history = provider(exportRows(samples))
  const result = await history.getValues({ from, to, pathSpecs: [{ path }] })
  assert.deepEqual(result.data, [[from, value]])
})

test('aligns numeric and object columns without mixing their leaves', async () => {
  const path = 'navigation.shore.closestPoint'
  const objectRows = [
    { metric: { source: 'shore', signalk_leaf: `${path}.longitude` }, values: [-4], timestamps: [t] },
    { metric: { source: 'shore', signalk_leaf: `${path}.latitude` }, values: [48], timestamps: [t] }
  ]
  const numericRows = [
    { metric: { source: 'gps' }, values: [3], timestamps: [t + 1000] }
  ]
  const history = new VictoriaMetricsHistory({
    baseUrl: 'http://localhost:8428', selfContext: 'vessels.boat',
    fetchImpl: async url => {
      const selectedPath = new URL(url).searchParams.get('match[]').includes(`signalk_path="${path}"`)
      const rows = selectedPath ? objectRows : numericRows
      return new Response(rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    }
  })
  const result = await history.getValues({ from, to, pathSpecs: [
    { path, aggregate: 'first' }, { path: 'navigation.speedOverGround', aggregate: 'average' }
  ] })
  assert.deepEqual(result.data, [
    [from, { longitude: -4, latitude: 48 }, null],
    ['2026-09-23T12:00:01.000Z', null, 3]
  ])
})

test('lists contexts and paths within requested period', async () => {
  const requested = []
  const history = provider([{ metric: { context: 'vessels.boat', signalk_path: 'navigation.position' }, values: [1], timestamps: [t] }], url => requested.push(url))
  assert.deepEqual(await history.getContexts({ from, to }), ['vessels.boat'])
  assert.deepEqual(await history.getPaths({ from, to }), ['navigation.position'])
  assert.ok(requested.every(url => url.pathname.includes('/label/') && url.searchParams.get('limit') === '501'))
  assert.ok(requested.every(url => url.searchParams.get('match[]').includes('instance="boat-1"')))
})

test('rejects truncated History label discovery', async () => {
  const history = new VictoriaMetricsHistory({
    baseUrl: 'http://localhost:8428', selfContext: 'vessels.boat', limits: { maxSeries: 1 },
    fetchImpl: async () => new Response(JSON.stringify({ status: 'success', data: ['one', 'two'] }))
  })
  await assert.rejects(history.getPaths({ from, to }), /signalk_path discovery limit exceeded: 2 > 1/)
})

test('identifies the History limit exceeded for a path', async () => {
  const path = 'navigation.speedOverGround'
  const query = { from, to, pathSpecs: [{ path }] }
  for (const [rows, limits, expected] of [
    [[
      { metric: { source: 'a' }, values: [1], timestamps: [t] },
      { metric: { source: 'b' }, values: [2], timestamps: [t] }
    ], { maxSeries: 1 }, `History series limit exceeded for ${path}: 2 > 1`],
    [[
      { metric: { source: 'a' }, values: [1, 2], timestamps: [t, t + 1000] }
    ], { maxSamples: 1 }, `History sample limit exceeded for ${path}: 2 > 1`]
  ]) {
    const history = new VictoriaMetricsHistory({
      baseUrl: 'http://localhost:8428', selfContext: 'vessels.boat', limits,
      fetchImpl: async () => new Response(rows.map(row => JSON.stringify(row)).join('\n'))
    })
    await assert.rejects(history.getValues(query), { message: expected })
  }
})
