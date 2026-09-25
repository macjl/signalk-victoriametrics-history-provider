const reservedLabels = new Set([
  '__name__', 'context', 'source', 'signalk_path', 'signalk_leaf',
  'signalk_leaf_parts', 'signalk_value_type', 'preferred', 'value_str'
])

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function validateAuth(auth, destination) {
  if (auth === undefined) return
  if (destination.mode !== 'remote' ||
      !isObject(auth) || auth.type !== 'basic' ||
      typeof auth.username !== 'string' || !auth.username || /[:\r\n\0]/.test(auth.username) ||
      typeof auth.password !== 'string' || !auth.password || /[\r\n\0]/.test(auth.password)) {
    throw new Error(`Destination ${destination.id} has invalid Basic Auth credentials`)
  }
}

export function normalizeRetention(value, id) {
  if (value == null) return '30d'
  if (typeof value === 'string' && value.trim() === '') return '100y'
  if (typeof value !== 'string') throw new Error(`Destination ${id} has invalid retention period`)
  const match = /^(\d+(?:\.\d+)?)(h|d|w|M|y)?$/.exec(value.trim())
  if (!match) throw new Error(`Destination ${id} has invalid retention period`)
  const daysPerUnit = { h: 1 / 24, d: 1, w: 7, M: 31, y: 365 }
  const days = Number(match[1]) * daysPerUnit[match[2] ?? 'M']
  if (!Number.isFinite(days) || days < 1) throw new Error(`Destination ${id} retention must be at least 1d`)
  return value.trim()
}

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
  for (const name of ['job', 'instance']) {
    if (!Object.hasOwn(labels, name)) throw new Error(`Label ${name} is required`)
  }

  const contexts = ingest.contexts ?? 'self'
  const filterMode = ingest.filterMode ?? 'none'
  const paths = ingest.paths ?? []
  if (!['self', 'all'].includes(contexts)) throw new Error('ingest.contexts must be self or all')
  if (!['none', 'blacklist', 'whitelist'].includes(filterMode)) throw new Error('Invalid ingest.filterMode')
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !path)) {
    throw new Error('ingest.paths must be an array of paths')
  }
  if (filterMode === 'whitelist' && paths.length === 0) throw new Error('Whitelist cannot be empty')

  const sourcePolicy = ingest.sourcePolicy ?? 'preferred'
  if (!['preferred', 'all'].includes(sourcePolicy)) throw new Error('ingest.sourcePolicy must be preferred or all')
  const periodMs = ingest.periodMs ?? ingest.minPeriodMs ?? 5000
  if (!Number.isSafeInteger(periodMs) || periodMs <= 0) throw new Error('ingest.periodMs must be positive')

  const batch = {
    maxSamples: ingest.batch?.maxSamples ?? 500,
    flushMs: ingest.batch?.flushMs ?? 1000,
    maxPendingSamples: ingest.batch?.maxPendingSamples ?? 10000
  }
  if (Object.values(batch).some(value => !Number.isSafeInteger(value) || value <= 0) ||
      batch.maxPendingSamples < batch.maxSamples) throw new Error('Invalid ingest.batch limits')

  const cardinalityAlert = {
    maxSeriesPerPathPerDay: ingest.cardinalityAlert?.maxSeriesPerPathPerDay ?? 100,
    excludedPaths: ingest.cardinalityAlert?.excludedPaths ?? []
  }
  if (ingest.cardinalityAlert !== undefined && !isObject(ingest.cardinalityAlert)) {
    throw new Error('ingest.cardinalityAlert must be an object')
  }
  if (!Number.isSafeInteger(cardinalityAlert.maxSeriesPerPathPerDay) ||
      cardinalityAlert.maxSeriesPerPathPerDay < 2 ||
      cardinalityAlert.maxSeriesPerPathPerDay > 250 ||
      !Array.isArray(cardinalityAlert.excludedPaths) ||
      cardinalityAlert.excludedPaths.some(path => typeof path !== 'string' || !path.trim())) {
    throw new Error('Invalid ingest.cardinalityAlert configuration')
  }

  const ids = new Set()
  const normalizedDestinations = []
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
    if (destination.exposeWebUi !== undefined && typeof destination.exposeWebUi !== 'boolean') {
      throw new Error(`Destination ${destination.id} exposeWebUi must be boolean`)
    }
    if (destination.exposeWebUi && destination.mode !== 'managed-container') {
      throw new Error(`Only managed VictoriaMetrics destinations can expose a web UI: ${destination.id}`)
    }
    validateAuth(destination.auth, destination)
    if ((destination.write?.enabled !== undefined && typeof destination.write.enabled !== 'boolean') ||
        (destination.read?.enabled !== undefined && typeof destination.read.enabled !== 'boolean')) {
      throw new Error(`Destination ${destination.id} read/write enabled flags must be boolean`)
    }
    if (destination.read?.limits !== undefined) {
      if (!isObject(destination.read.limits) || Object.values(destination.read.limits).some(value => !Number.isSafeInteger(value) || value <= 0)) {
        throw new Error(`Destination ${destination.id} has invalid History limits`)
      }
    }
    const remoteVm = destination.kind === 'victoriametrics' && destination.mode === 'remote'
    const baseUrl = remoteVm ? victoriaMetricsBaseUrl(destination.url) : null
    if (remoteVm && !baseUrl) {
      throw new Error(`Destination ${destination.id} requires a VictoriaMetrics base URL without a path`)
    }
    if (remoteVm && (destination.write?.url !== undefined || destination.read?.url !== undefined)) {
      throw new Error(`Destination ${destination.id} must use url instead of read.url or write.url`)
    }
    if (destination.write?.enabled === true) {
      writers++
      if (destination.kind === 'prometheus-compatible' && !isHttpUrl(destination.write.url, true)) {
        throw new Error(`Destination ${destination.id} requires a Remote Write URL`)
      }
    }
    if (destination.read?.enabled === true) {
      readers++
      if (destination.kind !== 'victoriametrics') throw new Error('Only VictoriaMetrics can serve History')
    }
    if (destination.write?.enabled !== true && destination.read?.enabled !== true) {
      throw new Error(`Destination ${destination.id} must be used for writing, History, or both`)
    }
    normalizedDestinations.push(remoteVm
      ? {
          ...destination, url: baseUrl,
          write: { ...destination.write, url: `${baseUrl}/api/v1/write` },
          read: { ...destination.read, url: baseUrl }
        }
      : destination.mode === 'managed-container'
        ? { ...destination, retention: normalizeRetention(destination.retention, destination.id) }
        : destination)
  }
  if (readers > 1) throw new Error('Only one VictoriaMetrics destination may serve History')
  const enabled = writers > 0
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
  if (vmagent.exposeWebUi !== undefined && typeof vmagent.exposeWebUi !== 'boolean') {
    throw new Error('vmagent.exposeWebUi must be boolean')
  }
  if (vmagent.exposeWebUi && !enabled) {
    throw new Error('vmagent web UI requires an active write destination')
  }
  return {
    ingest: { enabled, contexts, filterMode, paths, sourcePolicy, periodMs, labels, batch, cardinalityAlert },
    vmagent,
    destinations: normalizedDestinations
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

function victoriaMetricsBaseUrl(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}
