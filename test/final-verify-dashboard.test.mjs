import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RunCatalog } from '../src/dashboard.mjs'
import { RunStore, normalizeManifest } from '../src/store.mjs'

const final = {
  stage: 'final',
  checkId: 'test',
  index: 2,
  total: 3,
  startedAt: 1000,
  checkTimeoutMs: 120_000,
  failed: ['lint'],
}
const bisect = {
  stage: 'bisect',
  checkId: 'lint',
  index: 1,
  total: 2,
  step: 3,
  startedAt: 2000,
  checkTimeoutMs: 120_000,
  failed: ['lint', 'test'],
}

function remember(catalog, root, runId, createdAt) {
  const file = join(root, runId + '.sqlite')
  const meta = {
    runId,
    parentId: 'captain',
    repo: { root, commonDir: join(root, '.git') },
    ref: 'refs/heads/integration/' + runId,
    baseSha: 'start',
    manifest: normalizeManifest({ spec_id: 'demo', max_workers: 3, tickets: [{ id: 'A', title: 'A' }] }),
    policyHash: 'test',
  }
  catalog.remember(file, meta, createdAt)
  return { file, meta }
}

function liveCoordinator(runs) {
  return {
    maxWorkers: 16,
    runs,
    peek: (file) => runs.get(file),
  }
}

const fixtureRepo = join('fixture', 'repo')
const active = { mode: 'active', complete: false, counts: { INTEGRATED: 1 }, tickets: [] }

test('an unselected attached summary tracks the live phase from final verification to bisection', () => {
  const catalog = new RunCatalog()
  const { file } = remember(catalog, fixtureRepo, 'checking', 1)
  const other = remember(catalog, fixtureRepo, 'selected', 2)
  const coordinator = liveCoordinator(new Map([
    [file, { ...active, finalPhase: final }],
    [other.file, active],
  ]))

  const before = catalog.read(coordinator, null)
  assert.equal(before.selected.runId, 'selected')
  const checking = before.runs.find((row) => row.runId === 'checking')
  assert.equal(checking.attached, true)
  assert.deepEqual(checking.finalPhase, final)

  coordinator.runs.set(file, { ...active, finalPhase: bisect })
  const after = catalog.read(coordinator, null)
  assert.deepEqual(after.runs.find((row) => row.runId === 'checking').finalPhase, bisect)
})

test('the selected run exposes the same final phase as its summary', () => {
  const catalog = new RunCatalog()
  const { file } = remember(catalog, fixtureRepo, 'checking', 1)
  const coordinator = liveCoordinator(new Map([[file, { ...active, finalPhase: bisect }]]))

  const { runs: [row], selected } = catalog.read(coordinator, null)
  assert.deepEqual(row.finalPhase, bisect)
  assert.deepEqual(selected.finalPhase, row.finalPhase)
})

test('an attached summary without an active final phase reports null', () => {
  const catalog = new RunCatalog()
  const { file } = remember(catalog, fixtureRepo, 'active', 1)
  const coordinator = liveCoordinator(new Map([[file, active]]))

  const { runs: [row] } = catalog.read(coordinator, null)
  assert.equal(row.attached, true)
  assert.equal(row.finalPhase, null)
})

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'dag-final-dashboard-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function openHistory(catalog, root) {
  const { file, meta } = remember(catalog, root, 'history', 1)
  const db = new RunStore(file)
  db.init(meta)
  db.setMode('cancelled')
  return { db, file }
}

test('a detached run with a readable ledger reports a null final phase', (t) => {
  const catalog = new RunCatalog()
  const { db, file } = openHistory(catalog, tempRoot(t))
  db.close()
  const coordinator = liveCoordinator(new Map([[file, { ...active, finalPhase: final }]]))
  assert.deepEqual(catalog.read(coordinator, null).runs[0].finalPhase, final)

  coordinator.runs.delete(file)
  const { runs: [row] } = catalog.read(coordinator, null)
  assert.equal(row.attached, false)
  assert.equal(row.available, true)
  assert.equal(row.finalPhase, null)
})

test('an unreadable run summary reports a null final phase', (t) => {
  const catalog = new RunCatalog()
  remember(catalog, tempRoot(t), 'missing', 1)

  const { runs: [row] } = catalog.read(liveCoordinator(new Map()), null)
  assert.equal(row.available, false)
  assert.equal(row.finalPhase, null)
})

test('the persisted history summary keeps its existing schema across catalog instances', (t) => {
  const root = tempRoot(t)
  const profile = join(root, 'profile')
  const catalog = new RunCatalog(profile)
  // Keep the WAL open so a read-only connection does not change the ledger signature.
  const { db } = openHistory(catalog, root)
  try {
    const { file } = remember(catalog, root, 'selected', 2)
    const coordinator = liveCoordinator(new Map([[file, { ...active, finalPhase: final }]]))
    catalog.read(coordinator, null)

    const restored = new RunCatalog(profile)
    const persisted = restored.entries().find((entry) => entry.runId === 'history')
    assert.deepEqual(JSON.parse(persisted.summary), {
      available: true,
      mode: 'cancelled',
      complete: false,
      counts: { CANCELLED: 1 },
      verifiedSha: 'start',
      integrationRef: 'refs/heads/integration/history',
      maxWorkers: 3,
      diagnostic: null,
    })
    const { runs } = restored.read(coordinator, null)
    const history = runs.find((row) => row.runId === 'history')
    assert.equal(history.finalPhase, null)
    assert.equal(restored.ledgerOpens, 0)
  } finally {
    db.close()
  }
})
