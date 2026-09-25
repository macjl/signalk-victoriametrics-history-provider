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
  return `{preferred=~"true|",${Object.entries(labels).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(',')}}`
}

function orderedSamples(samples, method) {
  const ordered = [...samples].sort((a, b) => a.timestamp - b.timestamp || a.source.localeCompare(b.source))
  return ['first', 'last', 'middle_index'].includes(method)
    ? ordered.filter((sample, index) => index === 0 || sample.timestamp !== ordered[index - 1].timestamp)
    : ordered
}

function aggregate(samples, method, angular) {
  if (!samples.length) return null
  const values = samples.map(sample => sample.value)
  if (method === 'first') return values[0]
  if (method === 'last') return values.at(-1)
  if (method === 'middle_index') return values[Math.floor((values.length - 1) / 2)]
  if (method === 'min' || method === 'max' || method === 'mid') {
    let min = values[0]
    let max = values[0]
    for (const value of values) {
      if (value < min) min = value
      if (value > max) max = value
    }
    return method === 'min' ? min : method === 'max' ? max : (min + max) / 2
  }
  if (method === 'average') {
    if (!angular) return values.reduce((sum, value) => sum + value, 0) / values.length
    const sine = values.reduce((sum, value) => sum + Math.sin(value), 0)
    const cosine = values.reduce((sum, value) => sum + Math.cos(value), 0)
    return Math.hypot(sine, cosine) < 1e-10 ? null : (Math.atan2(sine, cosine) + 2 * Math.PI) % (2 * Math.PI)
  }
  throw new Error(`Unsupported History aggregate: ${method}`)
}

function aggregateValues(samples, method, angular, path) {
  const ordered = orderedSamples(samples, method)
  if (!ordered.length) return null
  if (method === 'first') return ordered[0].value
  if (method === 'last') return ordered.at(-1).value
  if (method === 'middle_index') return ordered[Math.floor((ordered.length - 1) / 2)].value
  if (ordered.some(sample => typeof sample.value !== 'number')) {
    throw new Error(`Unsupported History aggregate for ${path}: ${method} requires numeric values; use :first, :last or :middle_index`)
  }
  return aggregate(ordered, method, angular)
}

function decodeValue(metric, value) {
  const type = metric.signalk_value_type
  if (type === 'null') return null
  if (type === 'object') return {}
  if (type === 'array') return []
  if (type === 'boolean') {
    if (value !== 0 && value !== 1) throw new Error('Invalid boolean History sample')
    return value === 1
  }
  if (type === 'datetime') return new Date(value).toISOString()
  if (type !== undefined) throw new Error(`Unsupported History value type: ${type}`)
  return metric.value_str !== undefined ? metric.value_str : value
}

function leafParts(metric, path) {
  if (metric.signalk_leaf_parts !== undefined) {
    let parts
    try {
      parts = JSON.parse(metric.signalk_leaf_parts)
    } catch {
      throw new Error('Invalid History leaf parts')
    }
    if (!Array.isArray(parts) || parts.length === 0 || parts.some(part =>
      typeof part !== 'string' && (!Number.isSafeInteger(part) || part < 0))) {
      throw new Error('Invalid History leaf parts')
    }
    return parts
  }
  const leaf = metric.signalk_leaf
  if (typeof leaf !== 'string' || !leaf.startsWith(`${path}.`)) throw new Error(`Invalid History leaf for ${path}`)
  return leaf.slice(path.length + 1).split('.')
}

function putLeaf(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

function reconstructValue(entries, path) {
  const rootEntries = entries.filter(entry => entry.parts === null)
  if (rootEntries.length) {
    if (entries.length !== 1) throw new Error(`Mixed scalar and object History values for ${path}`)
    return rootEntries[0].value
  }
  const root = typeof entries[0].parts[0] === 'number' ? [] : {}
  for (const entry of entries) {
    let target = root
    for (let i = 0; i < entry.parts.length; i++) {
      const part = entry.parts[i]
      if (i === entry.parts.length - 1) {
        putLeaf(target, part, entry.value)
      } else {
        if (!Object.hasOwn(target, part)) {
          putLeaf(target, part, typeof entry.parts[i + 1] === 'number' ? [] : {})
        }
        target = target[part]
        if (target === null || typeof target !== 'object') throw new Error(`Conflicting History leaves for ${path}`)
      }
    }
  }
  return root
}

function isAngular(path) {
  const leaf = path.split('.').at(-1)
  return /(?:angle|heading|course|direction|variation|bearing|azimuth)/i.test(leaf)
}

export class VictoriaMetricsHistory {
  constructor({ baseUrl, labels = {}, limits = {}, selfContext, auth, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.labels = labels
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    this.selfContext = selfContext
    this.fetchImpl = fetchImpl
    this.authHeader = auth?.type === 'basic'
      ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
      : undefined
  }

  async exportSeries(extraLabels, range) {
    if (range.to - range.from > this.limits.maxRangeDays * 86400000) {
      throw new Error('History range limit exceeded')
    }
    const params = new URLSearchParams({
      'match[]': selector({ ...this.labels, ...extraLabels }),
      start: String(range.from / 1000),
      end: String(range.to / 1000)
    })
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/export?${params}`, {
      signal: AbortSignal.timeout(this.limits.timeoutMs),
      ...(this.authHeader ? { headers: { Authorization: this.authHeader } } : {})
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
          if (series.length > this.limits.maxSeries) {
            throw new Error(`History series limit exceeded for ${extraLabels.signalk_path}: ${series.length} > ${this.limits.maxSeries}`)
          }
          if (samples > this.limits.maxSamples) {
            throw new Error(`History sample limit exceeded for ${extraLabels.signalk_path}: ${samples} > ${this.limits.maxSamples}`)
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
        if (series.length > this.limits.maxSeries) {
          throw new Error(`History series limit exceeded for ${extraLabels.signalk_path}: ${series.length} > ${this.limits.maxSeries}`)
        }
        if (samples > this.limits.maxSamples) {
          throw new Error(`History sample limit exceeded for ${extraLabels.signalk_path}: ${samples} > ${this.limits.maxSamples}`)
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

  async labelValues(name, range) {
    if (range.to - range.from > this.limits.maxRangeDays * 86400000) {
      throw new Error('History range limit exceeded')
    }
    const params = new URLSearchParams({
      'match[]': selector(this.labels),
      start: String(range.from / 1000),
      end: String(range.to / 1000),
      limit: String(this.limits.maxSeries + 1)
    })
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/label/${name}/values?${params}`, {
      signal: AbortSignal.timeout(this.limits.timeoutMs),
      ...(this.authHeader ? { headers: { Authorization: this.authHeader } } : {})
    })
    if (!response.ok) throw new Error(`VictoriaMetrics label query failed: HTTP ${response.status}`)
    const reader = response.body.getReader()
    const chunks = []
    let bytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > this.limits.maxResponseBytes) throw new Error('History response size limit exceeded')
        chunks.push(value)
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    } finally {
      reader.releaseLock()
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (result.status !== 'success' || !Array.isArray(result.data) ||
        result.data.some(value => typeof value !== 'string')) {
      throw new Error('Invalid VictoriaMetrics label response')
    }
    if (result.data.length > this.limits.maxSeries) {
      throw new Error(`History ${name} discovery limit exceeded: ${result.data.length} > ${this.limits.maxSeries}`)
    }
    return result.data.sort()
  }

  async getValues(query) {
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
        const parts = item.metric.signalk_leaf === undefined ? null : leafParts(item.metric, spec.path)
        const seriesKey = JSON.stringify(Object.keys(item.metric).sort().map(name => [name, item.metric[name]]))
        for (let i = 0; i < item.values.length; i++) {
          const timestamp = Number(item.timestamps[i])
          const value = Number(item.values[i])
          if (!Number.isFinite(timestamp) || !Number.isFinite(value) || timestamp < range.from || timestamp >= range.to) continue
          const bucket = resolutionMs === undefined ? timestamp : range.from + Math.floor((timestamp - range.from) / resolutionMs) * resolutionMs
          if (!byTime.has(bucket)) byTime.set(bucket, new Map())
          const groups = byTime.get(bucket)
          const source = typeof item.metric.source === 'string' ? item.metric.source : ''
          const key = JSON.stringify([timestamp, source])
          if (!groups.has(key)) groups.set(key, { timestamp, source, entries: [], seen: new Map() })
          const group = groups.get(key)
          if (group.seen.has(seriesKey)) {
            if (group.seen.get(seriesKey) !== value) {
              throw new Error(`Conflicting History samples for ${spec.path} at ${new Date(timestamp).toISOString()} from ${source}`)
            }
            continue
          }
          group.seen.set(seriesKey, value)
          group.entries.push({ leaf: item.metric.signalk_leaf, parts, value: decodeValue(item.metric, value) })
        }
      }
      const snapshots = new Map()
      for (const [timestamp, groups] of byTime) {
        const samples = [...groups.values()].map(group => {
          if (!position) return { timestamp: group.timestamp, source: group.source, value: reconstructValue(group.entries, spec.path) }
          const longitude = group.entries.find(entry => entry.leaf === 'navigation.position.longitude')?.value
          const latitude = group.entries.find(entry => entry.leaf === 'navigation.position.latitude')?.value
          return {
            timestamp: group.timestamp,
            source: group.source,
            value: Number.isFinite(longitude) && Number.isFinite(latitude) ? [longitude, latitude] : null
          }
        })
        snapshots.set(timestamp, samples)
      }
      const bySource = new Map()
      if (query.sourcePolicy === 'all' || spec.sourceRef) {
        for (const [timestamp, samples] of snapshots) {
          for (const sample of samples) {
            if (spec.sourceRef && sample.source !== spec.sourceRef) continue
            if (!bySource.has(sample.source)) bySource.set(sample.source, new Map())
            const sourceSnapshots = bySource.get(sample.source)
            if (!sourceSnapshots.has(timestamp)) sourceSnapshots.set(timestamp, [])
            sourceSnapshots.get(timestamp).push(sample)
          }
        }
      }
      const sourceRefs = query.sourcePolicy === 'all' && !spec.sourceRef
        ? [...bySource.keys()].sort()
        : [spec.sourceRef]
      for (const sourceRef of sourceRefs) {
        const selectedSnapshots = sourceRef === undefined ? snapshots : bySource.get(sourceRef) ?? new Map()
        const hasTypedValues = !position && [...selectedSnapshots.values()].some(samples =>
          samples.some(sample => typeof sample.value !== 'number'))
        const effectiveMethod = method === 'average' && hasTypedValues ? 'last' : method
        const result = new Map()
        for (const [timestamp, samples] of selectedSnapshots) {
          if (!position) {
            result.set(timestamp, aggregateValues(samples, effectiveMethod, isAngular(spec.path), spec.path))
            continue
          }
          const complete = samples.filter(sample => sample.value !== null)
            .sort((a, b) => a.timestamp - b.timestamp || a.source.localeCompare(b.source))
          if (complete.length) {
            const index = effectiveMethod === 'last' ? complete.length - 1 : effectiveMethod === 'middle_index' ? Math.floor((complete.length - 1) / 2) : 0
            result.set(timestamp, complete[index].value)
          } else {
            result.set(timestamp, null)
          }
        }
        columns.push({ spec, sourceRef, method: effectiveMethod, result })
      }
    }
    const timestamps = new Set(columns.flatMap(column => [...column.result.keys()]))
    return {
      context,
      range: { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() },
      values: columns.map(({ spec, sourceRef, method }) => ({ path: spec.path, method, ...(sourceRef ? { $source: sourceRef } : {}) })),
      data: [...timestamps].sort((a, b) => a - b).map(timestamp => [
        new Date(timestamp).toISOString(), ...columns.map(column => column.result.get(timestamp) ?? null)
      ])
    }
  }

  async getContexts(query) {
    return this.labelValues('context', rangeFor(query))
  }

  async getPaths(query) {
    return this.labelValues('signalk_path', rangeFor(query))
  }
}
