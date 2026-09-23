import { validateConfig } from './src/config.js'
import { deltaToSamples } from './src/metrics.js'
import { postSamples } from './src/remote-write.js'
import { SampleBatcher } from './src/batch.js'
import { startHostVmagent } from './src/host-vmagent.js'

const id = 'signalk-victoriametrics-history-provider'

export default function createPlugin(app) {
  let generation = 0
  let runtime = null
  let batcher = null
  let healthTimer = null
  let unsubscribes = []
  let unhealthy = false

  function setError(message) {
    unhealthy = true
    app.setPluginError(message)
  }

  function stop() {
    generation++
    for (const unsubscribe of unsubscribes) unsubscribe()
    unsubscribes = []
    if (healthTimer) clearInterval(healthTimer)
    healthTimer = null
    batcher?.stop()
    batcher = null
    runtime?.stop()
    runtime = null
    unhealthy = false
    app.setPluginStatus('Stopped')
  }

  function start(raw = {}) {
    stop()
    const options = validateConfig(raw)
    if (options.destinations.some(destination => destination.read?.enabled)) {
      throw new Error('History reading is not implemented in this first increment')
    }
    if (options.destinations.some(destination => destination.mode !== 'remote')) {
      throw new Error('Only remote destinations are implemented in this first increment')
    }
    if (options.vmagent.mode === 'managed-container') {
      throw new Error('Managed containers are not implemented in this first increment')
    }
    if (!options.ingest.enabled) {
      app.setPluginStatus('Ingestion disabled')
      return
    }
    const current = ++generation
    app.setPluginStatus('Starting vmagent')
    void startHostVmagent(options, app.getDataDirPath(), error => {
      if (current === generation) setError(error.message)
    }).then(started => {
      if (current !== generation) {
        started.stop()
        return
      }
      runtime = started
      batcher = new SampleBatcher({
        limits: options.ingest.batch,
        send: async samples => {
          await postSamples(started.url, samples)
          if (unhealthy && current === generation) {
            unhealthy = false
            app.setPluginStatus('Ingesting preferred Signal K deltas')
          }
        },
        onError: error => setError(error.message)
      })
      const selfContext = app.selfId.startsWith('vessels.') ? app.selfId : `vessels.${app.selfId}`
      let bootstrapping = true
      app.subscriptionmanager.subscribe({
        context: options.ingest.contexts === 'self' ? 'vessels.self' : '*',
        subscribe: [{ path: '*', policy: 'instant', minPeriod: options.ingest.minPeriodMs }],
        sourcePolicy: 'preferred'
      }, unsubscribes, error => setError(String(error)), delta => {
        if (bootstrapping || current !== generation) return
        batcher.add(deltaToSamples(delta, options.ingest, selfContext))
      })
      bootstrapping = false
      healthTimer = setInterval(async () => {
        try {
          const response = await fetch(started.healthUrl, { signal: AbortSignal.timeout(2000) })
          if (!response.ok) throw new Error('vmagent health check failed')
          if (unhealthy && current === generation) {
            unhealthy = false
            app.setPluginStatus('Ingesting preferred Signal K deltas')
          }
        } catch {
          if (current === generation) setError('vmagent is unavailable')
        }
      }, 5000)
      app.setPluginStatus('Ingesting preferred Signal K deltas')
    }).catch(error => {
      if (current === generation) setError(error.message)
    })
  }

  return {
    id,
    name: 'VictoriaMetrics History Provider (experimental)',
    description: 'First increment: preferred deltas to host vmagent Remote Write',
    schema: {
      type: 'object',
      required: ['ingest', 'vmagent', 'destinations'],
      properties: {
        ingest: { type: 'object', properties: {
          enabled: { type: 'boolean', default: false },
          contexts: { type: 'string', enum: ['self', 'all'], default: 'self' },
          filterMode: { type: 'string', enum: ['blacklist', 'whitelist'], default: 'blacklist' },
          paths: { type: 'array', items: { type: 'string' }, default: [] },
          minPeriodMs: { type: 'integer', minimum: 0, default: 0 },
          labels: { type: 'object', additionalProperties: { type: 'string' }, default: {} },
          batch: { type: 'object', properties: {
            maxSamples: { type: 'integer', minimum: 1, default: 500 },
            flushMs: { type: 'integer', minimum: 1, default: 200 },
            maxPendingSamples: { type: 'integer', minimum: 1, default: 10000 }
          } }
        } },
        vmagent: { type: 'object', properties: {
          mode: { type: 'string', enum: ['host-binary'], default: 'host-binary' },
          binaryPath: { type: 'string' },
          queueLimitBytesPerDestination: { type: 'integer', minimum: 1, default: 1073741824 }
        } },
        destinations: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['victoriametrics', 'prometheus-compatible'] },
          mode: { type: 'string', enum: ['remote'], default: 'remote' },
          write: { type: 'object', properties: {
            enabled: { type: 'boolean', default: true },
            url: { type: 'string' }
          } }
        } } }
      }
    },
    start,
    stop
  }
}
