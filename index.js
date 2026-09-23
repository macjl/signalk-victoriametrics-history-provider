import { validateConfig } from './src/config.js'
import { deltaToSamples } from './src/metrics.js'
import { postSamples } from './src/remote-write.js'
import { SampleBatcher } from './src/batch.js'
import { startHostVmagent } from './src/host-vmagent.js'
import { startManagedServices } from './src/managed.js'
import { VictoriaMetricsHistory } from './src/history.js'
import { schema } from './src/schema.js'
import { parseVmagentStatus } from './src/vmagent-status.js'

const id = 'signalk-victoriametrics-history-provider'

export default function createPlugin(app) {
  let generation = 0
  let abortController = null
  let agent = null
  let managed = null
  let batcher = null
  let healthTimer = null
  let unsubscribes = []
  let historyRegistered = false
  let agentFailed = false
  let historyFailed = false
  let lossError = false
  let lastStatus = ''

  function setStatus(message) {
    if (message !== lastStatus) {
      lastStatus = message
      app.setPluginStatus(message)
    }
  }

  function setError(message) {
    lastStatus = ''
    app.setPluginError(message)
  }

  function setAgentError(message) {
    agentFailed = true
    setError(message)
  }

  async function cleanup(reportStopped) {
    generation++
    abortController?.abort()
    abortController = null
    for (const unsubscribe of unsubscribes) unsubscribe()
    unsubscribes = []
    if (healthTimer) clearInterval(healthTimer)
    healthTimer = null
    batcher?.stop()
    batcher = null
    if (historyRegistered) app.unregisterHistoryApiProvider()
    historyRegistered = false
    agent?.stop()
    agent = null
    const previous = managed
    managed = null
    if (previous) await previous.stop()
    agentFailed = false
    historyFailed = false
    lossError = false
    if (reportStopped) setStatus('Stopped')
  }

  function start(raw = {}) {
    const previous = cleanup(false)
    const options = validateConfig(raw)
    const reader = options.destinations.find(destination => destination.read?.enabled)
    if (options.destinations.some(destination => destination.mode === 'host-binary')) {
      throw new Error('VictoriaMetrics host-binary mode is not implemented yet')
    }
    if (reader && typeof app.registerHistoryApiProvider !== 'function') {
      throw new Error('This Signal K server does not support History provider plugins')
    }
    const current = ++generation
    const controller = new AbortController()
    abortController = controller
    const selfContext = app.selfId.startsWith('vessels.') ? app.selfId : `vessels.${app.selfId}`

    void (async () => {
      await previous
      if (current !== generation) return
      const needManaged = options.destinations.some(destination => destination.mode === 'managed-container') ||
        (options.ingest.enabled && options.vmagent.mode === 'managed-container')
      if (needManaged) {
        setStatus('Starting managed VictoriaMetrics services')
        const started = await startManagedServices(app, options, controller.signal)
        if (current !== generation) {
          await started.stop()
          return
        }
        managed = started
      }

      if (reader) {
        const readUrl = reader.mode === 'managed-container' ? managed.urls.get(reader.id) : reader.read.url
        const history = new VictoriaMetricsHistory({
          baseUrl: readUrl,
          labels: options.ingest.labels,
          limits: reader.read.limits,
          selfContext
        })
        const guarded = Object.fromEntries(['getValues', 'getContexts', 'getPaths'].map(method => [method, async query => {
          try {
            const result = await history[method](query)
            if (historyFailed && current === generation) {
              historyFailed = false
              if (!agentFailed && !lossError) setStatus(options.ingest.enabled ? 'Ingesting preferred Signal K deltas' : 'History provider ready')
            }
            return result
          } catch (error) {
            if (current === generation) {
              historyFailed = true
              setError(`History: ${error.message}`)
            }
            throw error
          }
        }]))
        app.registerHistoryApiProvider(guarded)
        historyRegistered = true
      }

      if (options.ingest.enabled) {
        if (options.vmagent.mode === 'host-binary') {
          const resolved = {
            ...options,
            destinations: options.destinations.map(destination => destination.write?.enabled && destination.mode === 'managed-container'
              ? { ...destination, write: { ...destination.write, url: managed.writeUrls.get(destination.id) } }
              : destination)
          }
          agent = await startHostVmagent(resolved, app.getDataDirPath(), error => {
            if (current === generation) setAgentError(error.message)
          })
          if (current !== generation) {
            agent.stop()
            agent = null
            return
          }
        }
        const address = agent?.url ?? `${managed.urls.get('vmagent')}/api/v1/write`
        const healthUrl = agent?.healthUrl ?? `${managed.urls.get('vmagent')}/metrics`
        batcher = new SampleBatcher({
          limits: options.ingest.batch,
          send: async samples => {
            await postSamples(address, samples)
            if (agentFailed && !lossError && current === generation) {
              agentFailed = false
              if (!historyFailed) setStatus('Ingesting preferred Signal K deltas')
            }
          },
          onError: error => { if (current === generation) setAgentError(error.message) }
        })
        let bootstrapping = true
        app.subscriptionmanager.subscribe({
          context: options.ingest.contexts === 'self' ? 'vessels.self' : '*',
          subscribe: [{ path: '*', policy: 'instant', minPeriod: options.ingest.minPeriodMs }],
          sourcePolicy: 'preferred'
        }, unsubscribes, error => { if (current === generation) setAgentError(String(error)) }, delta => {
          if (bootstrapping || current !== generation) return
          batcher.add(deltaToSamples(delta, options.ingest, selfContext))
        })
        bootstrapping = false
        healthTimer = setInterval(async () => {
          try {
            const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) })
            if (!response.ok) throw new Error('unhealthy')
            const vm = parseVmagentStatus(await response.text())
            if (vm.droppedSamples > 0 || batcher.dropped > 0) {
              lossError = true
              setError(`Data loss: plugin ${batcher.dropped} samples, vmagent ${vm.droppedSamples} samples`)
              return
            }
            if (current === generation) {
              agentFailed = false
              if (!historyFailed && !lossError) setStatus(`Ingesting; vmagent queue ${vm.pendingBytes} bytes; push failures ${vm.pushFailures}`)
            }
          } catch {
            if (current === generation) setAgentError('vmagent is unavailable')
          }
        }, 5000)
      }
      setStatus(options.ingest.enabled ? 'Ingesting preferred Signal K deltas' : 'History provider ready')
    })().catch(async error => {
      if (current === generation) {
        setError(error.message)
        await cleanup(false)
        setError(error.message)
      }
    })
  }

  return {
    id,
    name: 'VictoriaMetrics History Provider (experimental)',
    description: 'Store preferred Signal K deltas in VictoriaMetrics and serve History',
    schema,
    start,
    stop: () => cleanup(true)
  }
}
