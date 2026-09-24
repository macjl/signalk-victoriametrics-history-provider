export function metricName(path) {
  const name = path.replace(/[^a-zA-Z0-9_:]/g, '_')
  return /^[a-zA-Z_:]/.test(name) ? name : `_${name}`
}

function pathMatches(path, selected) {
  return selected.some(root => path === root || path.startsWith(`${root}.`))
}

function allowed(path, config) {
  const matches = pathMatches(path, config.paths)
  return config.filterMode === 'whitelist' ? matches : !matches
}

function leafSamples(path, value, parts = []) {
  const isLeaf = parts.length > 0
  const sample = (number, extra = {}) => [{ path, value: number, isLeaf, parts, ...extra }]
  if (value === undefined) return []
  if (value === null) return sample(1, { valueType: 'null' })
  if (typeof value === 'number') return Number.isFinite(value) ? sample(value) : []
  if (typeof value === 'boolean') return sample(value ? 1 : 0, { valueType: 'boolean' })
  if (typeof value === 'string') {
    const date = /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN
    return Number.isFinite(date) ? sample(date, { valueType: 'datetime' }) : sample(1, { valueStr: value })
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? sample(1, { valueType: 'array' }) :
      value.flatMap((child, index) => leafSamples(`${path}.${index}`, child, [...parts, index]))
  }
  if (!value || typeof value !== 'object') return []
  const entries = Object.entries(value)
  return entries.length === 0 ? sample(1, { valueType: 'object' }) :
    entries.flatMap(([key, child]) => leafSamples(`${path}.${key}`, child, [...parts, key]))
}

export function deltaToSamples(delta, config, selfContext, now = Date.now()) {
  const context = delta?.context === 'vessels.self' ? selfContext : delta?.context
  if (!context || (config.contexts === 'self' && context !== selfContext)) return []
  const output = []
  for (const update of delta.updates ?? []) {
    if (typeof update.$source !== 'string' || !update.$source) continue
    const parsed = update.timestamp ? Date.parse(update.timestamp) : NaN
    const timestamp = Number.isFinite(parsed) ? parsed : now
    for (const entry of update.values ?? []) {
      const root = entry.path
      if (typeof root !== 'string' || !root) continue
      const position = root === 'navigation.position'
      if (position && (!entry.value || !Number.isFinite(entry.value.longitude) || !Number.isFinite(entry.value.latitude))) continue
      const leaves = position
        ? leafSamples(root, {
            longitude: entry.value.longitude,
            latitude: entry.value.latitude
          })
        : leafSamples(root, entry.value)
      if (position && leaves.filter(leaf => allowed(leaf.path, config)).length !== 2) continue
      for (const leaf of leaves) {
        if (!allowed(leaf.path, config)) continue
        const labels = {
          __name__: metricName(leaf.path),
          context,
          source: update.$source,
          signalk_path: root,
          preferred: 'true',
          ...config.labels
        }
        if (leaf.isLeaf) labels.signalk_leaf = leaf.path
        if (leaf.parts.some(part => typeof part === 'number' || part === '' || part.includes('.') || /^\d+$/.test(part))) {
          labels.signalk_leaf_parts = JSON.stringify(leaf.parts)
        }
        if (leaf.valueStr !== undefined) labels.value_str = leaf.valueStr
        if (leaf.valueType !== undefined) labels.signalk_value_type = leaf.valueType
        output.push({ labels, value: leaf.value, timestamp })
      }
    }
  }
  return output
}
