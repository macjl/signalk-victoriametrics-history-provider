import test from 'node:test'
import assert from 'node:assert/strict'
import { VictoriaMetricsHistory } from '../src/history.js'

const from = '2026-09-23T12:00:00.000Z'
const to = '2026-09-23T12:00:03.000Z'
const t = Date.parse(from)

function provider(rows, onUrl = () => {}) {
  return new VictoriaMetricsHistory({
    baseUrl: 'http://localhost:8428',
    selfContext: 'vessels.boat',
    labels: { instance: 'boat-1' },
    fetchImpl: async url => {
      onUrl(new URL(url))
      return new Response(rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    }
  })
}

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
  assert.match(selector, /preferred="true"/)
  assert.match(selector, /instance="boat-1"/)
  await history.getValues({ from, to, pathSpecs: [{ path: 'navigation.speedOverGround', sourceRef: 'a' }] })
  assert.match(selector, /source="a"/)
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

test('resolution buckets samples and rejects all-sources request', async () => {
  const history = provider([{ metric: { source: 'a' }, values: [2, 4], timestamps: [t, t + 1000] }])
  const result = await history.getValues({ from, to, resolution: 2, pathSpecs: [{ path: 'navigation.speedOverGround', aggregate: 'average' }] })
  assert.deepEqual(result.data, [[from, 3]])
  await assert.rejects(history.getValues({ from, to, sourcePolicy: 'all', pathSpecs: [{ path: 'navigation.speedOverGround' }] }), /unavailable/)
})

test('same-timestamp sources use the lexically first source', async () => {
  const history = provider([
    { metric: { source: 'z' }, values: [100], timestamps: [t] },
    { metric: { source: 'a' }, values: [2], timestamps: [t] }
  ])
  const result = await history.getValues({ from, to, pathSpecs: [{ path: 'navigation.speedOverGround', aggregate: 'average' }] })
  assert.deepEqual(result.data, [[from, 2]])
})

test('lists contexts and paths within requested period', async () => {
  const history = provider([{ metric: { context: 'vessels.boat', signalk_path: 'navigation.position' }, values: [1], timestamps: [t] }])
  assert.deepEqual(await history.getContexts({ from, to }), ['vessels.boat'])
  assert.deepEqual(await history.getPaths({ from, to }), ['navigation.position'])
})
