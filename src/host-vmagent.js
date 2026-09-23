import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

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

export async function startHostVmagent(options, dataDir, onExit, fetchImpl = fetch) {
  const queuePath = join(dataDir, 'vmagent-queue')
  await mkdir(queuePath, { recursive: true, mode: 0o700 })
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const args = [
    `-httpListenAddr=127.0.0.1:${port}`,
    `-remoteWrite.tmpDataPath=${queuePath}`,
    `-remoteWrite.maxDiskUsagePerURL=${options.vmagent.queueLimitBytesPerDestination}`,
    ...options.destinations.filter(destination => destination.write?.enabled)
      .map(destination => `-remoteWrite.url=${destination.write.url}`)
  ]
  const child = spawn(options.vmagent.binaryPath, args, {
    stdio: 'ignore',
    windowsHide: true
  })
  let stopped = false
  let exitError
  child.once('error', error => { exitError = error })
  child.once('exit', (code, signal) => {
    if (!stopped) onExit(new Error(`vmagent exited (${code ?? signal ?? 'unknown'})`))
  })

  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (exitError || child.exitCode !== null) break
    try {
      const response = await fetchImpl(`${baseUrl}/metrics`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) {
        return {
          url: `${baseUrl}/api/v1/write`,
          healthUrl: `${baseUrl}/metrics`,
          stop: () => { stopped = true; child.kill('SIGTERM') }
        }
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  stopped = true
  child.kill('SIGTERM')
  throw new Error(`vmagent failed to start: ${exitError?.code ?? child.exitCode ?? 'health timeout'}`)
}
