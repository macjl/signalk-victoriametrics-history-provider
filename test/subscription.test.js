import test from 'node:test'
import assert from 'node:assert/strict'
import { subscriptionRequest } from '../index.js'

test('fixed sampling applies to preferred and all-source subscriptions', () => {
  for (const sourcePolicy of ['preferred', 'all']) {
    assert.deepEqual(subscriptionRequest({ contexts: 'self', sourcePolicy, periodMs: 5000 }), {
      context: 'vessels.self',
      subscribe: [{ path: '*', policy: 'fixed', period: 5000 }],
      sourcePolicy
    })
  }
  assert.equal(subscriptionRequest({ contexts: 'all', sourcePolicy: 'all', periodMs: 1000 }).context, '*')
})
