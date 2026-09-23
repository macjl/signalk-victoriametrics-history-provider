const reservedLabels = new Set([
  '__name__', 'context', 'source', 'signalk_path', 'signalk_leaf',
  'preferred', 'value_str'
])

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function validateConfig(raw) {
  if (!isObject(raw)) throw new Error('Configuration must be an object')
  const ingest = raw.ingest ?? {}
  const vmagent = raw.vmagent ?? {}
  const destinations = raw.destinations ?? []
  if (!isObject(ingest) || !isObject(vmagent) || !Array.isArray(destinations)) {
    throw new Error('Invalid ingest, vmagent or destinations configuration')
  }

  const labels = ingest.labels ?? {}
  if (!isObject(labels)) throw new Error('ingest.labels must be an object')
  for (const [name, value] of Object.entries(labels)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || name.startsWith('__') || reservedLabels.has(name)) {
      throw new Error(`Invalid or reserved label: ${name}`)
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Label ${name} must be a non-empty string`)
    }
  }

  const contexts = ingest.contexts ?? 'self'
  const filterMode = ingest.filterMode ?? 'blacklist'
  const paths = ingest.paths ?? []
  if (!['self', 'all'].includes(contexts)) throw new Error('ingest.contexts must be self or all')
  if (!['blacklist', 'whitelist'].includes(filterMode)) throw new Error('Invalid ingest.filterMode')
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !path)) {
    throw new Error('ingest.paths must be an array of paths')
  }
  if (filterMode === 'whitelist' && paths.length === 0) throw new Error('Whitelist cannot be empty')

  const enabled = ingest.enabled ?? false
  if (typeof enabled !== 'boolean') throw new Error('ingest.enabled must be boolean')
  const minPeriodMs = ingest.minPeriodMs ?? 0
  if (!Number.isSafeInteger(minPeriodMs) || minPeriodMs < 0) throw new Error('Invalid ingest.minPeriodMs')

  const batch = {
    maxSamples: ingest.batch?.maxSamples ?? 500,
    flushMs: ingest.batch?.flushMs ?? 200,
    maxPendingSamples: ingest.batch?.maxPendingSamples ?? 10000
  }
  if (Object.values(batch).some(value => !Number.isSafeInteger(value) || value <= 0) ||
      batch.maxPendingSamples < batch.maxSamples) throw new Error('Invalid ingest.batch limits')

  const ids = new Set()
  let readers = 0
  let writers = 0
  for (const destination of destinations) {
    if (!isObject(destination) || typeof destination.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(destination.id) || ids.has(destination.id)) {
      throw new Error('Destination ids must be unique lowercase slugs')
    }
    ids.add(destination.id)
    if (!['victoriametrics', 'prometheus-compatible'].includes(destination.kind)) {
      throw new Error(`Invalid destination kind: ${destination.id}`)
    }
    if (!['managed-container', 'host-binary', 'remote'].includes(destination.mode) ||
        (destination.kind === 'prometheus-compatible' && destination.mode !== 'remote')) {
      throw new Error(`Invalid destination mode: ${destination.id}`)
    }
    if (destination.mode === 'host-binary' && !isAbsolutePath(destination.binaryPath)) {
      throw new Error(`Destination ${destination.id} requires an absolute binaryPath`)
    }
    if (destination.write?.auth || destination.read?.auth) {
      throw new Error(`Destination ${destination.id} authentication is not implemented yet`)
    }
    if ((destination.write?.enabled !== undefined && typeof destination.write.enabled !== 'boolean') ||
        (destination.read?.enabled !== undefined && typeof destination.read.enabled !== 'boolean')) {
      throw new Error(`Destination ${destination.id} read/write enabled flags must be boolean`)
    }
    if (destination.read?.limits !== undefined) {
      if (!isObject(destination.read.limits) || Object.values(destination.read.limits).some(value => !Number.isSafeInteger(value) || value <= 0)) {
        throw new Error(`Destination ${destination.id} has invalid History limits`)
      }
    }
    if (destination.write?.enabled === true) {
      writers++
      if (destination.mode === 'remote' && !isHttpUrl(destination.write.url, true)) {
        throw new Error(`Destination ${destination.id} requires a Remote Write URL`)
      }
    }
    if (destination.read?.enabled === true) {
      readers++
      if (destination.kind !== 'victoriametrics') throw new Error('Only VictoriaMetrics can serve History')
      if (destination.mode === 'remote' && !isHttpUrl(destination.read.url)) {
        throw new Error(`Destination ${destination.id} requires a read URL`)
      }
    }
  }
  if (readers > 1) throw new Error('Only one VictoriaMetrics destination may serve History')
  if (enabled && writers === 0) throw new Error('Ingestion requires a write-enabled destination')
  if (enabled) {
    vmagent.mode ??= 'managed-container'
    vmagent.queueLimitBytesPerDestination ??= 1073741824
    if (!['host-binary', 'managed-container'].includes(vmagent.mode)) throw new Error('Invalid vmagent mode')
    if (vmagent.mode === 'host-binary' && !isAbsolutePath(vmagent.binaryPath)) {
      throw new Error('vmagent.binaryPath must be absolute')
    }
    if (!Number.isSafeInteger(vmagent.queueLimitBytesPerDestination) || vmagent.queueLimitBytesPerDestination <= 0) {
      throw new Error('vmagent.queueLimitBytesPerDestination must be positive')
    }
  }
  return {
    ingest: { enabled, contexts, filterMode, paths, minPeriodMs, labels, batch },
    vmagent,
    destinations
  }
}

function isAbsolutePath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0')
}

function isHttpUrl(value, requirePath = false) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      (!requirePath || url.pathname !== '/')
  } catch {
    return false
  }
}
