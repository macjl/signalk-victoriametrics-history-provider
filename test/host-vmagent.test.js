import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startHostVmagent } from '../src/host-vmagent.js'

test('host vmagent stop waits for process closure', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'signalk-vmagent-test-'))
  try {
    const child = new EventEmitter()
    child.exitCode = null
    child.kill = signal => {
      setTimeout(() => {
        child.exitCode = 0
        child.emit('exit', 0, signal)
        child.emit('close', 0, signal)
      }, 20)
      return true
    }
    const options = {
      ingest: { labels: { job: 'signalk-victoriametrics', instance: 'test-boat' } },
      vmagent: { binaryPath: '/usr/bin/vmagent', queueLimitBytesPerDestination: 1024 },
      destinations: [{ id: 'remote', write: { enabled: true, url: 'http://example.test/api/v1/write' } }]
    }
    const agent = await startHostVmagent(options, dataDir, 'vessels.test', () => {
      throw new Error('Unexpected process exit')
    }, async () => new Response('ok'), { freePort: async () => 8429, spawn: () => child })
    let completed = false
    const stopping = agent.stop().then(() => { completed = true })
    assert.equal(completed, false)
    await stopping
    assert.equal(completed, true)
    await agent.stop()
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
