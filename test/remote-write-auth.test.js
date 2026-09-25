import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { remoteWriteAuthArgs } from '../src/remote-write-auth.js'

test('vmagent auth files follow writer order without exposing passwords in arguments', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vmagent-auth-'))
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(dataDir, { recursive: true, force: true }) })
  const destinations = [
    { id: 'local', write: { enabled: true } },
    { id: 'remote', auth: { type: 'basic', username: 'writer', password: 'secret,with:punctuation' }, write: { enabled: true } },
    { id: 'unused', auth: { type: 'basic', username: 'unused', password: 'not-used' }, write: { enabled: false } }
  ]
  const args = await remoteWriteAuthArgs(destinations, dataDir, '/data', true)
  assert.deepEqual(args, [
    '-remoteWrite.basicAuth.usernameFile=',
    '-remoteWrite.basicAuth.usernameFile=/data/vmagent-credentials/remote-username',
    '-remoteWrite.basicAuth.passwordFile=',
    '-remoteWrite.basicAuth.passwordFile=/data/vmagent-credentials/remote-password'
  ])
  assert.ok(!args.join(' ').includes('secret'))
  assert.equal(await readFile(join(dataDir, 'vmagent-credentials', 'remote-username'), 'utf8'), 'writer')
  assert.equal(await readFile(join(dataDir, 'vmagent-credentials', 'remote-password'), 'utf8'), 'secret,with:punctuation')
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(dataDir, 'vmagent-credentials', 'remote-password'))).mode & 0o777, 0o600)
  }
})

test('vmagent aligns bearer and Basic Auth files with mixed write destinations', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vmagent-auth-'))
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(dataDir, { recursive: true, force: true }) })
  const destinations = [
    { id: 'local', write: { enabled: true } },
    { id: 'basic', auth: { type: 'basic', username: 'writer', password: 'secret' }, write: { enabled: true } },
    { id: 'bearer', auth: { type: 'bearer', token: 'opaque.token' }, write: { enabled: true } },
    { id: 'unused', auth: { type: 'bearer', token: 'unused' }, write: { enabled: false } }
  ]
  const args = await remoteWriteAuthArgs(destinations, dataDir, '/data', true)
  assert.deepEqual(args, [
    '-remoteWrite.basicAuth.usernameFile=',
    '-remoteWrite.basicAuth.usernameFile=/data/vmagent-credentials/basic-username',
    '-remoteWrite.basicAuth.usernameFile=',
    '-remoteWrite.basicAuth.passwordFile=',
    '-remoteWrite.basicAuth.passwordFile=/data/vmagent-credentials/basic-password',
    '-remoteWrite.basicAuth.passwordFile=',
    '-remoteWrite.bearerTokenFile=',
    '-remoteWrite.bearerTokenFile=',
    '-remoteWrite.bearerTokenFile=/data/vmagent-credentials/bearer-token'
  ])
  assert.ok(!args.join(' ').includes('opaque.token'))
  assert.equal(await readFile(join(dataDir, 'vmagent-credentials', 'bearer-token'), 'utf8'), 'opaque.token')
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(dataDir, 'vmagent-credentials', 'bearer-token'))).mode & 0o777, 0o600)
  }
})

test('bearer-only destinations do not create Basic Auth flags', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vmagent-auth-'))
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(dataDir, { recursive: true, force: true }) })
  const args = await remoteWriteAuthArgs([
    { id: 'local', write: { enabled: true } },
    { id: 'remote', auth: { type: 'bearer', token: 'opaque.token' }, write: { enabled: true } }
  ], dataDir, dataDir)
  assert.deepEqual(args, [
    '-remoteWrite.bearerTokenFile=',
    `-remoteWrite.bearerTokenFile=${join(dataDir, 'vmagent-credentials', 'remote-token')}`
  ])
})
