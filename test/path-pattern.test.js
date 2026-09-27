import test from 'node:test'
import assert from 'node:assert/strict'
import { pathPatternMatches } from '../src/path-pattern.js'

test('plain paths continue to include descendants but not similarly named paths', () => {
  assert.equal(pathPatternMatches('navigation.position', 'navigation.position'), true)
  assert.equal(pathPatternMatches('navigation.position.latitude', 'navigation.position'), true)
  assert.equal(pathPatternMatches('navigation.positionQuality', 'navigation.position'), false)
})

test('star matches any characters including dots and is anchored', () => {
  assert.equal(pathPatternMatches('resources.regions.abc', 'resources.regions.*'), true)
  assert.equal(pathPatternMatches('resources.regions.abc.name', 'resources.regions.*'), true)
  assert.equal(pathPatternMatches('resources.regionStatus.abc', 'resources.regions.*'), false)
  assert.equal(pathPatternMatches('other.resources.regions.abc', 'resources.regions.*'), false)
  assert.equal(pathPatternMatches('navigation.headingTrue', 'navigation.*True'), true)
  assert.equal(pathPatternMatches('navigation.headingMagnetic', 'navigation.*True'), false)
  assert.equal(pathPatternMatches('resources.regions.abc.state', 'resources.*.state'), true)
  assert.equal(pathPatternMatches('resources.regions.abc.state.old', 'resources.*.state'), false)
})
