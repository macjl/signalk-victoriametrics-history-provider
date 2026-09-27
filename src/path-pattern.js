export function pathPatternMatches(path, pattern) {
  if (!pattern.includes('*')) return path === pattern || path.startsWith(`${pattern}.`)

  let pathIndex = 0
  let patternIndex = 0
  let starIndex = -1
  let retryIndex = 0
  while (pathIndex < path.length) {
    if (pattern[patternIndex] === path[pathIndex]) {
      pathIndex++
      patternIndex++
    } else if (pattern[patternIndex] === '*') {
      starIndex = patternIndex++
      retryIndex = pathIndex
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1
      pathIndex = ++retryIndex
    } else {
      return false
    }
  }
  while (pattern[patternIndex] === '*') patternIndex++
  return patternIndex === pattern.length
}
