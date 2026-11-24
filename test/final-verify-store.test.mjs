import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RunStore, normalizeManifest } from '../src/store.mjs'

function init(db) {
  db.init({
    runId: 'run-1', repo: { root: '/work', commonDir: '/work/.git' },
    ref: 'refs/heads/integration/run-1', baseSha: 'start', parentId: 'captain', policyHash: 'checks',
    manifest: normalizeManifest({ spec_id: 'final', tickets: [{ id: 'A', title: 'A' }] }),
  })
}

test('final progress opts into the outbox and remains queryable by type and tip after restart', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-final-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'run.sqlite')
  const db = new RunStore(file)
  const tip = { tipSha: 'tip' }
  try {
    init(db)
    assert.equal(db.hasFinalEvent('final_verify_running', 'tip'), false)
    db.recordFinal('final_verify_started', 'Started', tip)
    db.recordFinal('bisect_step', 'Probed', { sha: 'merge' }, false)
    db.recordFinal('final_verify_failed', 'Failed', tip, { notify: false })
    assert.deepEqual(db.pendingNotifications(), [])

    db.recordFinal('final_verify_running', 'Still checking', tip, { notify: true })
    assert.equal(db.hasFinalEvent('final_verify_running', 'tip'), true)
    assert.equal(db.hasFinalEvent('final_verify_running', 'other'), false)
    assert.equal(db.hasFinalEvent('final_verify_bisecting', 'tip'), false)
    db.recordFinal('final_verify_bisecting', 'Bisecting', tip, true)
    assert.throws(() => db.recordFinal('final_verified', 'Invalid progress type', tip, true), TypeError)
    const events = db.events().slice(1)
    assert.deepEqual(events.map((e) => e.type), [
      'final_verify_started', 'bisect_step', 'final_verify_failed', 'final_verify_running', 'final_verify_bisecting',
    ])
    const notices = db.pendingNotifications()
    assert.deepEqual(notices.map((e) => e.id), events.slice(-2).map((e) => e.id))
    for (const event of notices) {
      assert.equal(event.ticketId, null)
      assert.equal(event.parentId, 'captain')
      assert.deepEqual(event.details, tip)
      assert.equal(db.ackNotification(event.id), true)
    }
  } finally {
    db.close()
  }

  const reopened = new RunStore(file)
  try {
    assert.deepEqual(reopened.pendingNotifications(), [])
    assert.equal(reopened.hasFinalEvent('final_verify_running', 'tip'), true)
    assert.equal(reopened.hasFinalEvent('final_verify_bisecting', 'tip'), true)
  } finally {
    reopened.close()
  }
})

test('final progress preserves the plan, repair count and completion checks', (t) => {
  const db = new RunStore(':memory:')
  t.after(() => db.close())
  init(db)
  const { lease } = db.claim('A', { baseSha: 'start', childId: 'worker', path: '/worktree/A', branch: 'ticket/A' })
  assert.equal(db.move('A', lease, 'RUNNING', 'SUBMITTED', { sourceSha: 'source' }), true)
  assert.equal(db.intent('A', lease, { oldTip: 'start', sourceSha: 'source', candidateSha: 'tip' }), true)
  assert.equal(db.finish('A', lease, 'tip', { complete: false }), true)
  const revision = db.revision()
  const integrity = db.integrity()

  for (const type of ['final_verify_running', 'final_verify_bisecting']) {
    db.recordFinal(type, 'Checking', { tipSha: 'tip' }, true)
  }
  assert.equal(db.revision(), revision)
  assert.deepEqual(db.integrity(), integrity)
  assert.equal(db.finalVerified('tip'), false)
  assert.equal(db.finalRepairs(), 0)
  assert.equal(db.completeRun('start'), false)
  assert.equal(db.completeRun('tip'), true)
  assert.equal(db.finalVerified('tip'), true)
  assert.deepEqual(db.pendingNotifications().map((e) => e.type), [
    'final_verify_running', 'final_verify_bisecting', 'run_completed',
  ])
})
