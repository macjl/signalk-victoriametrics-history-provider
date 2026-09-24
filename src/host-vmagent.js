import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { remoteWriteAuthArgs } from './remote-write-auth.js'
import { writeSelfScrapeConfig } from './vmagent-self-scrape.js'
import { webUiPrefix } from './web-ui-paths.js'

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

export async function startHostVmagent(options, dataDir, selfContext, onExit, fetchImpl = fetch, runtime = { freePort, spawn }) {
  const queuePath = join(dataDir, 'vmagent-queue')
  await mkdir(queuePath, { recursive: true, mode: 0o700 })
  const port = await runtime.freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const prefix = webUiPrefix('vmagent', options.vmagent.exposeWebUi)
  const authArgs = await remoteWriteAuthArgs(options.destinations, dataDir, dataDir)
  const scrapeConfig = await writeSelfScrapeConfig(options, dataDir, dataDir, port, selfContext, prefix)
  const args = [
    `-httpListenAddr=127.0.0.1:${port}`,
    ...(prefix ? [`-http.pathPrefix=${prefix}`] : []),
    `-remoteWrite.tmpDataPath=${queuePath}`,
    '-remoteWrite.keepDanglingQueues',
    `-promscrape.config=${scrapeConfig}`,
    `-remoteWrite.maxDiskUsagePerURL=${options.vmagent.queueLimitBytesPerDestination}`,
    ...options.destinations.filter(destination => destination.write?.enabled)
      .map(destination => `-remoteWrite.url=${destination.write.url}`),
    ...authArgs
  ]
  const child = runtime.spawn(options.vmagent.binaryPath, args, {
    stdio: 'ignore',
    windowsHide: true
  })
  let stopped = false
  let exitError
  let closed = false
  const closePromise = new Promise(resolve => child.once('close', () => {
    closed = true
    resolve()
  }))
  child.once('error', error => { exitError = error })
  child.once('exit', (code, signal) => {
    if (!stopped) onExit(new Error(`vmagent exited (${code ?? signal ?? 'unknown'})`))
  })

  async function waitForClose(timeoutMs) {
    if (closed) return true
    let timer
    const result = await Promise.race([
      closePromise.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) })
    ])
    clearTimeout(timer)
    return result
  }

  let stopPromise
  function stop() {
    stopPromise ??= (async () => {
      stopped = true
      if (closed) return
      child.kill('SIGTERM')
      if (await waitForClose(3000)) return
      child.kill('SIGKILL')
      if (!(await waitForClose(3000))) throw new Error('vmagent did not stop')
    })()
    return stopPromise
  }

  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (exitError || child.exitCode !== null) break
    try {
      const response = await fetchImpl(`${baseUrl}${prefix}/metrics`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) {
        return {
          url: `${baseUrl}${prefix}/api/v1/write`,
          healthUrl: `${baseUrl}${prefix}/metrics`,
          uiTarget: prefix ? { title: 'vmagent', path: `${prefix}/`, origin: baseUrl } : null,
          stop
        }
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await stop()
  throw new Error(`vmagent failed to start: ${exitError?.code ?? child.exitCode ?? 'health timeout'}`)
}
