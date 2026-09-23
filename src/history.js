const DEFAULT_LIMITS = {
  maxRangeDays: 30,
  maxSeries: 500,
  maxSamples: 200000,
  maxResponseBytes: 33554432,
  timeoutMs: 15000
}

function instantMs(value) {
  if (typeof value === 'number') return value
  if (value && typeof value.epochMilliseconds === 'number') return value.epochMilliseconds
  const parsed = Date.parse(String(value))
  if (!Number.isFinite(parsed)) throw new Error('Invalid History timestamp')
  return parsed
}

function rangeFor(query, now = Date.now()) {
  const duration = query.duration === undefined ? undefined :
    typeof query.duration === 'number' ? query.duration * 1000 : query.duration.total({ unit: 'milliseconds' })
  const from = query.from === undefined ? (query.to === undefined ? now : instantMs(query.to)) - duration : instantMs(query.from)
  const to = query.to === undefined ? (duration === undefined || query.from === undefined ? now : from + duration) : instantMs(query.to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('Invalid History range')
  return { from, to }
}

function selector(labels) {
  return `{${Object.entries(labels).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(',')}}`
}

function aggregate(samples, method, angular) {
  if (!samples.length) return null
  const ordered = samples.sort((a, b) => a.timestamp - b.timestamp || a.source.localeCompare(b.source))
    .filter((sample, index, all) => index === 0 || sample.timestamp !== all[index - 1].timestamp)
  const values = ordered.map(sample => sample.value)
  if (method === 'first') return values[0]
  if (method === 'last') return values.at(-1)
  if (method === 'middle_index') return values[Math.floor((values.length - 1) / 2)]
  if (method === 'min') return Math.min(...values)
  if (method === 'max') return Math.max(...values)
  if (method === 'mid') return (Math.min(...values) + Math.max(...values)) / 2
  if (method === 'average') {
    if (!angular) return values.reduce((sum, value) => sum + value, 0) / values.length
    const sine = values.reduce((sum, value) => sum + Math.sin(value), 0)
    const cosine = values.reduce((sum, value) => sum + Math.cos(value), 0)
    return Math.hypot(sine, cosine) < 1e-10 ? null : (Math.atan2(sine, cosine) + 2 * Math.PI) % (2 * Math.PI)
  }
  throw new Error(`Unsupported History aggregate: ${method}`)
}

function isAngular(path) {
  return /(?:Angle|angle|Heading|heading|Course|course|Direction|direction|Variation|variation)$/.test(path)
}

export class VictoriaMetricsHistory {
  constructor({ baseUrl, labels = {}, limits = {}, selfContext, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.labels = labels
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    this.selfContext = selfContext
    this.fetchImpl = fetchImpl
  }

  async exportSeries(extraLabels, range) {
    if (range.to - range.from > this.limits.maxRangeDays * 86400000) {
      throw new Error('History range limit exceeded')
    }
    const params = new URLSearchParams({
      'match[]': selector({ preferred: 'true', ...this.labels, ...extraLabels }),
      start: String(range.from / 1000),
      end: String(range.to / 1000)
    })
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/export?${params}`, {
      signal: AbortSignal.timeout(this.limits.timeoutMs)
    })
    if (!response.ok) throw new Error(`VictoriaMetrics export failed: HTTP ${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const series = []
    let text = ''
    let bytes = 0
    let samples = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > this.limits.maxResponseBytes) throw new Error('History response size limit exceeded')
        text += decoder.decode(value, { stream: true })
        let newline
        while ((newline = text.indexOf('\n')) >= 0) {
          const line = text.slice(0, newline)
          text = text.slice(newline + 1)
          if (!line.trim()) continue
          const item = JSON.parse(line)
          if (!item.metric || !Array.isArray(item.values) || !Array.isArray(item.timestamps) || item.values.length !== item.timestamps.length) {
            throw new Error('Invalid VictoriaMetrics export row')
          }
          series.push(item)
          samples += item.values.length
          if (series.length > this.limits.maxSeries || samples > this.limits.maxSamples) {
            throw new Error('History series/sample limit exceeded')
          }
        }
      }
      text += decoder.decode()
      if (text.trim()) {
        const item = JSON.parse(text)
        if (!item.metric || !Array.isArray(item.values) || !Array.isArray(item.timestamps) || item.values.length !== item.timestamps.length) {
          throw new Error('Invalid VictoriaMetrics export row')
        }
        series.push(item)
        samples += item.values.length
        if (series.length > this.limits.maxSeries || samples > this.limits.maxSamples) {
          throw new Error('History series/sample limit exceeded')
        }
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    } finally {
      reader.releaseLock()
    }
    return series
  }

  async getValues(query) {
    if (query.sourcePolicy === 'all') throw new Error('sourcePolicy=all is unavailable: only preferred-stream samples are stored')
    if (!Array.isArray(query.pathSpecs) || !query.pathSpecs.length) throw new Error('History paths are required')
    const range = rangeFor(query)
    const context = query.context === undefined || query.context === 'vessels.self' ? this.selfContext : query.context
    const resolutionMs = query.resolution === undefined ? undefined : query.resolution * 1000
    if (resolutionMs !== undefined && (!Number.isFinite(resolutionMs) || resolutionMs <= 0)) {
      throw new Error('Invalid History resolution')
    }
    const columns = []
    for (const spec of query.pathSpecs) {
      const position = spec.path === 'navigation.position'
      const method = spec.aggregate ?? (position ? 'first' : 'average')
      const supported = position ? ['first', 'last', 'middle_index'] :
        ['average', 'min', 'max', 'first', 'last', 'mid', 'middle_index']
      if (!supported.includes(method)) throw new Error(`Unsupported History aggregate for ${spec.path}: ${method}`)
      const labels = { context, signalk_path: spec.path }
      if (spec.sourceRef) labels.source = spec.sourceRef
      const series = await this.exportSeries(labels, range)
      const byTime = new Map()
      for (const item of series) {
        if (item.metric.value_str !== undefined) throw new Error(`Typed History value is unsupported for ${spec.path}`)
        for (let i = 0; i < item.values.length; i++) {
          const timestamp = Number(item.timestamps[i])
          const value = Number(item.values[i])
          if (!Number.isFinite(timestamp) || !Number.isFinite(value) || timestamp < range.from || timestamp >= range.to) continue
          const bucket = resolutionMs === undefined ? timestamp : range.from + Math.floor((timestamp - range.from) / resolutionMs) * resolutionMs
          if (!byTime.has(bucket)) byTime.set(bucket, [])
          byTime.get(bucket).push({ timestamp, source: item.metric.source ?? '', leaf: item.metric.signalk_leaf, value })
        }
      }
      const result = new Map()
      for (const [timestamp, samples] of byTime) {
        if (!position) {
          result.set(timestamp, aggregate(samples, method, isAngular(spec.path)))
          continue
        }
        const pairs = new Map()
        for (const sample of samples) {
          const key = `${sample.timestamp}\0${sample.source}`
          if (!pairs.has(key)) pairs.set(key, { timestamp: sample.timestamp, source: sample.source })
          if (sample.leaf === 'navigation.position.longitude') pairs.get(key).longitude = sample.value
          if (sample.leaf === 'navigation.position.latitude') pairs.get(key).latitude = sample.value
        }
        const complete = [...pairs.values()].filter(pair => Number.isFinite(pair.longitude) && Number.isFinite(pair.latitude))
          .sort((a, b) => a.timestamp - b.timestamp || a.source.localeCompare(b.source))
        if (complete.length) {
          const index = method === 'last' ? complete.length - 1 : method === 'middle_index' ? Math.floor((complete.length - 1) / 2) : 0
          result.set(timestamp, [complete[index].longitude, complete[index].latitude])
        } else {
          result.set(timestamp, null)
        }
      }
      columns.push({ spec, method, result })
    }
    const timestamps = new Set(columns.flatMap(column => [...column.result.keys()]))
    return {
      context,
      range: { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() },
      values: columns.map(({ spec, method }) => ({ path: spec.path, method, ...(spec.sourceRef ? { $source: spec.sourceRef } : {}) })),
      data: [...timestamps].sort((a, b) => a - b).map(timestamp => [
        new Date(timestamp).toISOString(), ...columns.map(column => column.result.get(timestamp) ?? null)
      ])
    }
  }

  async getContexts(query) {
    const series = await this.exportSeries({}, rangeFor(query))
    return [...new Set(series.map(item => item.metric.context).filter(Boolean))].sort()
  }

  async getPaths(query) {
    const series = await this.exportSeries({}, rangeFor(query))
    return [...new Set(series.map(item => item.metric.signalk_path).filter(Boolean))].sort()
  }
}
