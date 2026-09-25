import { validateConfig } from './src/config.js'
import { deltaToSamples } from './src/metrics.js'
import { postSamples } from './src/remote-write.js'
import { SampleBatcher } from './src/batch.js'
import { startHostVmagent } from './src/host-vmagent.js'
import { startManagedServices } from './src/managed.js'
import { VictoriaMetricsHistory } from './src/history.js'
import { schema } from './src/schema.js'
import { parseVmagentStatus } from './src/vmagent-status.js'
import { proxyManagedUi } from './src/web-ui-proxy.js'
import { withIdentityLabels } from './src/identity-labels.js'
import { CardinalityAlert } from './src/cardinality-alert.js'

const id = 'signalk-victoriametrics-history-provider'

export function subscriptionRequest(ingest) {
  return {
    context: ingest.contexts === 'self' ? 'vessels.self' : '*',
    subscribe: [{ path: '*', policy: 'fixed', period: ingest.periodMs }],
    sourcePolicy: ingest.sourcePolicy
  }
}

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
  let healthFailed = false
  let historyFailed = false
  let lossError = false
  let lastStatus = ''
  let lastError = ''
  let uiTargets = new Map()
  let cardinality = null
  let cardinalityWarning = ''

  function setStatus(message) {
    if (message !== lastStatus || lastError) {
      lastStatus = message
      lastError = ''
      app.setPluginStatus(message)
    }
  }

  function setError(message) {
    if (message !== lastError) {
      lastStatus = ''
      lastError = message
      app.setPluginError(message)
    }
  }

  function reportOperational(message) {
    if (agentFailed || healthFailed || historyFailed || lossError) return
    if (cardinalityWarning) setError(cardinalityWarning)
    else setStatus(message)
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
    cardinality = null
    cardinalityWarning = ''
    if (historyRegistered) app.unregisterHistoryApiProvider()
    historyRegistered = false
    const previousAgent = agent
    agent = null
    const previous = managed
    managed = null
    uiTargets = new Map()
    try {
      if (previousAgent) await previousAgent.stop()
    } finally {
      if (previous) await previous.stop()
    }
    agentFailed = false
    healthFailed = false
    historyFailed = false
    lossError = false
    if (reportStopped) setStatus('Stopped')
  }

  function start(raw = {}) {
    const previous = cleanup(false)
    const identity = withIdentityLabels(raw)
    const options = validateConfig(identity.configuration)
    const ingestStatus = `Ingesting ${options.ingest.sourcePolicy} Signal K deltas`
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
      if (identity.changed) {
        await new Promise((resolve, reject) => app.savePluginOptions(identity.configuration, error =>
          error ? reject(error) : resolve()))
        if (current !== generation) return
      }
      const needManaged = options.destinations.some(destination => destination.mode === 'managed-container' &&
        (destination.write?.enabled || destination.read?.enabled)) ||
        (options.ingest.enabled && options.vmagent.mode === 'managed-container')
      if (needManaged) {
        setStatus('Starting managed VictoriaMetrics services')
        const started = await startManagedServices(app, options, controller.signal, selfContext)
        if (current !== generation) {
          await started.stop()
          return
        }
        managed = started
        uiTargets = new Map(started.uiTargets)
      }

      if (reader) {
        const readUrl = reader.mode === 'managed-container' ? managed.urls.get(reader.id) : reader.read.url
        const history = new VictoriaMetricsHistory({
          baseUrl: readUrl,
          auth: reader.auth,
          labels: options.ingest.labels,
          limits: reader.read.limits,
          selfContext
        })
        const guarded = Object.fromEntries(['getValues', 'getContexts', 'getPaths'].map(method => [method, async query => {
          try {
            const result = await history[method](query)
            if (historyFailed && current === generation) {
              historyFailed = false
              reportOperational(options.ingest.enabled ? ingestStatus : 'History provider ready')
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
        cardinality = new CardinalityAlert(options.ingest.cardinalityAlert)
        if (options.vmagent.mode === 'host-binary') {
          const resolved = {
            ...options,
            destinations: options.destinations.map(destination => destination.write?.enabled && destination.mode === 'managed-container'
              ? { ...destination, write: { ...destination.write, url: managed.writeUrls.get(destination.id) } }
              : destination)
          }
          agent = await startHostVmagent(resolved, app.getDataDirPath(), selfContext, error => {
            if (current === generation) setAgentError(error.message)
          })
          if (current !== generation) {
            agent.stop()
            agent = null
            return
          }
          if (agent.uiTarget) uiTargets.set('vmagent', agent.uiTarget)
        }
        const address = agent?.url ?? `${managed.urls.get('vmagent')}/api/v1/write`
        const healthUrl = agent?.healthUrl ?? `${managed.urls.get('vmagent')}/metrics`
        batcher = new SampleBatcher({
          limits: options.ingest.batch,
          send: async samples => {
            await postSamples(address, samples)
            if (agentFailed && !lossError && current === generation) {
              agentFailed = false
              reportOperational(ingestStatus)
            }
          },
          onError: error => { if (current === generation) setAgentError(error.message) }
        })
        let bootstrapping = true
        app.subscriptionmanager.subscribe(subscriptionRequest(options.ingest), unsubscribes, error => { if (current === generation) setAgentError(String(error)) }, delta => {
          if (bootstrapping || current !== generation) return
          const samples = deltaToSamples(delta, options.ingest, selfContext)
          batcher.add(samples)
          if (cardinality.observe(samples)) {
            cardinalityWarning = cardinality.message()
            reportOperational(ingestStatus)
          }
        })
        bootstrapping = false
        healthTimer = setInterval(async () => {
          try {
            const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) })
            if (!response.ok) throw new Error('unhealthy')
            const vm = parseVmagentStatus(await response.text())
            if (current !== generation) return
            if (cardinality.rollover()) cardinalityWarning = cardinality.message()
            if (vm.droppedSamples > 0 || batcher.dropped > 0) {
              lossError = true
              setError(`Data loss: plugin ${batcher.dropped} samples, vmagent ${vm.droppedSamples} samples`)
              return
            }
            healthFailed = false
            reportOperational(`Ingesting; vmagent queue ${vm.pendingBytes} bytes; push failures ${vm.pushFailures}`)
          } catch {
            if (current === generation) {
              healthFailed = true
              setError('vmagent is unavailable')
            }
          }
        }, 5000)
      }
      reportOperational(options.ingest.enabled ? ingestStatus : 'History provider ready')
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
    description: 'Store Signal K deltas in VictoriaMetrics and serve History',
    schema,
    registerWithRouter(router) {
      router.get('/ui/manifest', (_req, res) => {
        res.setHeader('Cache-Control', 'no-store')
        res.json([...uiTargets].map(([id, target]) => ({ id, title: target.title, path: target.path })))
      })
      router.use('/ui/:serviceId', (req, res) => {
        const target = uiTargets.get(req.params.serviceId)
        if (!target) {
          res.status(404).end()
          return
        }
        void proxyManagedUi(req, res, target)
      })
    },
    start,
    stop: () => cleanup(true)
  }
}
