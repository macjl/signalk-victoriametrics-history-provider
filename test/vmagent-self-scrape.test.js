import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { writeSelfScrapeConfig } from '../src/vmagent-self-scrape.js'

test('self-scrape is local, identified, and readable by the vmagent user', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vmagent-scrape-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const options = { ingest: { labels: { job: 'signalk', instance: 'boat-1', fleet: 'test' } } }
  const path = await writeSelfScrapeConfig(options, dataDir, '/data', 8429, 'vessels.boat')
  assert.equal(path, '/data/vmagent-self-scrape.json')
  const source = join(dataDir, 'vmagent-self-scrape.json')
  const config = JSON.parse(await readFile(source, 'utf8'))
  assert.deepEqual(config, { scrape_configs: [{
    job_name: 'signalk-vmagent', scrape_interval: '15s',
    static_configs: [{ targets: ['127.0.0.1:8429'], labels: {
      instance: 'boat-1', fleet: 'test', signalk_context: 'vessels.boat'
    } }]
  }] })
  assert.equal((await stat(source)).mode & 0o777, 0o600)
  assert.equal((await stat(source)).uid, (await stat(dataDir)).uid)
})

test('self-scrape uses the Signal K context when no instance label is configured', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vmagent-scrape-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  await writeSelfScrapeConfig({ ingest: { labels: {} } }, dataDir, dataDir, 12345, 'vessels.self-uuid')
  const config = JSON.parse(await readFile(join(dataDir, 'vmagent-self-scrape.json'), 'utf8'))
  assert.deepEqual(config.scrape_configs[0].static_configs[0], {
    targets: ['127.0.0.1:12345'],
    labels: { instance: 'vessels.self-uuid', signalk_context: 'vessels.self-uuid' }
  })
})

test('self-scrape follows the web UI prefix when vmagent is exposed', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vmagent-scrape-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  await writeSelfScrapeConfig({ ingest: { labels: {} } }, dataDir, dataDir, 8429, 'vessels.boat', '/plugins/provider/ui/vmagent')
  const config = JSON.parse(await readFile(join(dataDir, 'vmagent-self-scrape.json'), 'utf8'))
  assert.equal(config.scrape_configs[0].metrics_path, '/plugins/provider/ui/vmagent/metrics')
})
