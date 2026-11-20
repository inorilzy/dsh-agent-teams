import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

// Reads the spec and tickets that /to-spec and /to-tickets publish, and turns
// them into a dag_run manifest draft. GitHub: the spec is a parent issue, the
// tickets are its sub-issues (or issues whose body starts with "Part of #N"),
// blocking edges are native issue dependencies or a "Blocked by" section.
// Local: .scratch/<slug>/spec.md and .scratch/<slug>/issues/NN-<slug>.md with a
// "Blocked by:" line. Nothing here writes, except writeback() on request.

const exec = promisify(execFile)
const maxOutput = 16 * 1024 * 1024
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/
// Local statuses that mean the ticket needs no more work.
const doneStatus = /^(?:done|closed|resolved|merged|completed|wontfix)$/i

/** Run gh without a shell and parse its JSON output. */
export async function runGh(cwd, args) {
  let stdout
  try {
    ;({ stdout } = await exec('gh', args, {
      cwd,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      maxBuffer: maxOutput,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    }))
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('The GitHub CLI (gh) is not installed or not on PATH')
    const detail = String(err.stderr || err.stdout || err.message).trim().slice(0, 600)
    const error = new Error('gh ' + args.slice(0, 2).join(' ') + ' failed: ' + detail)
    error.notFound = /HTTP 404|Not Found/.test(detail)
    throw error
  }
  return stdout.trim() ? JSON.parse(stdout) : null
}

/**
 * Where the spec lives: "#12", "12" or an issue URL is GitHub, anything else a
 * local path (the .scratch/<slug> folder, its spec.md or its issues folder).
 */
export function parseSpecRef(spec, repo) {
  if (typeof spec !== 'string' || !spec.trim()) throw new TypeError('spec must name an issue or a local path')
  const value = spec.trim()
  if (repo !== undefined && (typeof repo !== 'string' || !repoPattern.test(repo)))
    throw new TypeError('repo must look like owner/name')
  const url = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)\/?(?:[?#].*)?$/.exec(value)
  if (url) return { kind: 'github', repo: url[1], number: Number(url[2]) }
  const number = /^#?(\d+)$/.exec(value)
  if (number) return { kind: 'github', repo, number: Number(number[1]) }
  return { kind: 'local', path: value }
}

// The text under a "## <name>" heading, up to the next heading of that level or higher.
function section(body, name) {
  const lines = String(body ?? '').split(/\r?\n/)
  const at = lines.findIndex((l) => new RegExp('^#{1,3}\\s*' + name + '\\s*$', 'i').test(l.trim()))
  if (at < 0) return null
  const rest = []
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,3}\s/.test(line.trim())) break
    rest.push(line)
  }
  return rest.join('\n')
}

/** Acceptance criteria: every Markdown checkbox, preferring the Acceptance criteria section. */
export function acceptanceOf(body) {
  const scope = section(body, 'Acceptance criteria') ?? String(body ?? '')
  return [
    ...new Set(
      scope
        .split(/\r?\n/)
        .map((l) => /^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/.exec(l)?.[1])
        .filter(Boolean),
    ),
  ]
}

// "Blocked by: #3, #4", "**Blocked by:** 01, 02" or a "## Blocked by" section.
// Returns the raw text, or null when the ticket declares nothing.
function blockedByText(body) {
  const text = String(body ?? '')
  const inline = /^\s*(?:\*\*)?Blocked by:?(?:\*\*)?:?\s*(.*)$/im.exec(text)
  if (inline && inline[1].trim()) return inline[1]
  const block = section(text, 'Blocked by')
  if (block !== null && block.trim()) return block
  return null
}
const saysNone = (text) => /^\W*none\b/i.test(text.trim())

/** Issue numbers referenced by a GitHub "Blocked by" declaration in the body. */
export function bodyBlockers(body) {
  const text = blockedByText(body)
  if (text === null || saysNone(text)) return []
  return [...new Set([...text.matchAll(/(?:^|[^\w/])#(\d+)\b/g)].map((m) => Number(m[1])))]
}

// [T01] Title -> T01; titles without a usable tag fall back to the caller's ID.
function tagOf(title) {
  const tag = /^\s*\[([A-Za-z0-9][A-Za-z0-9_.-]{0,40})\]\s*(.*)$/.exec(title)
  return tag && idPattern.test(tag[1]) ? { id: tag[1], title: tag[2].trim() || title } : null
}

// Ticket IDs from tags when they are unique, otherwise from the fallback for every ticket.
function assignIds(items, fallback) {
  const tags = items.map((it) => tagOf(it.title))
  const ids = tags.map((t) => t?.id.toLowerCase())
  const unique = tags.every(Boolean) && new Set(ids).size === ids.length
  return items.map((it, i) =>
    unique ? { id: tags[i].id, title: tags[i].title } : { id: fallback(it), title: it.title },
  )
}

function promptFor(header, body) {
  return [...header, '', String(body ?? '').trim() || '(empty ticket body)'].join('\n')
}

function result({ source, spec, tickets, edges, skipped, warnings }) {
  const dependencyMode = !tickets.length ? 'no-tickets' : edges ? 'declared' : 'none'
  // Omit the full spec body when tickets were already parsed: each ticket prompt
  // points to spec.ref, and keeping the payload small avoids tool-output truncation.
  const specOut =
    dependencyMode === 'no-tickets'
      ? spec
      : { id: spec.id, title: spec.title, ref: spec.ref }
  return {
    source,
    spec: specOut,
    dependencyMode,
    guidance:
      dependencyMode === 'declared'
        ? 'Blocking edges come from the tracker. Prefer passing {"import_from": "<spec>", "tickets": [{"id": "...", "agent": "...", "verify": [...], "files": [...]}], ...} to dag_run so every ticket title, prompt, acceptance, depends_on and source is inherited verbatim; or submit these tickets with depends_on unchanged.'
        : dependencyMode === 'none'
          ? 'The tracker declares no blocking edges. Infer depends_on from the code and the spec, and state the reason for each inferred edge in prompt_append (with import_from) or the dependent ticket prompt.'
          : 'No open tickets were found. Split the spec into tickets yourself, infer depends_on, and state the reason for each inferred edge in the dependent ticket prompt.',
    skipped,
    warnings,
    manifest: { spec_id: spec.id, tickets },
  }
}

/**
 * Merge lightweight captain overrides (agent, verify, files, prompt_append,
 * checks, max_workers, etc.) onto an imported manifest draft so full ticket
 * bodies, acceptance lists, sources and declared edges are never dropped or
 * truncated when calling dag_run.
 */
export function mergeImportedManifest(imported, overrides = {}) {
  const baseTickets = imported?.manifest?.tickets ?? []
  if (!baseTickets.length) {
    throw new Error(
      'Imported spec has no open tickets (dependencyMode: no-tickets); split the spec into tickets and pass them directly without import_from',
    )
  }
  const byId = new Map(baseTickets.map((t) => [t.id, t]))
  const overrideMap = new Map()
  if (overrides.tickets !== undefined) {
    if (!Array.isArray(overrides.tickets)) throw new TypeError('tickets must be an array when used with import_from')
    for (const item of overrides.tickets) {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        throw new TypeError('each ticket override must be an object')
      if (typeof item.id !== 'string' || !byId.has(item.id))
        throw new Error('ticket override names unknown imported ticket id: ' + String(item.id))
      if (overrideMap.has(item.id)) throw new Error('duplicate ticket override id: ' + item.id)
      overrideMap.set(item.id, item)
    }
  }
  const tickets = baseTickets.map((base) => {
    const ov = overrideMap.get(base.id)
    if (!ov) return { ...base }
    const nextDeps = ov.depends_on ?? ov.dependsOn
    if (nextDeps !== undefined && imported.dependencyMode === 'declared') {
      const same =
        Array.isArray(nextDeps) &&
        nextDeps.length === base.depends_on.length &&
        nextDeps.every((d) => base.depends_on.includes(d))
      if (!same) {
        throw new Error(
          'Cannot override declared depends_on for ticket ' +
            base.id +
            ' (declared: ' +
            JSON.stringify(base.depends_on) +
            ')',
        )
      }
    }
    const append = ov.prompt_append ?? ov.promptAppend
    const prompt =
      typeof ov.prompt === 'string' && ov.prompt.trim()
        ? ov.prompt
        : typeof append === 'string' && append.trim()
          ? base.prompt + '\n\n' + append.trim()
          : base.prompt
    return {
      ...base,
      ...(typeof ov.title === 'string' && ov.title.trim() ? { title: ov.title } : {}),
      prompt,
      ...(Array.isArray(ov.acceptance) && ov.acceptance.length ? { acceptance: ov.acceptance } : {}),
      ...(nextDeps !== undefined ? { depends_on: nextDeps } : {}),
      ...(ov.verify !== undefined ? { verify: ov.verify } : {}),
      ...(ov.agent !== undefined ? { agent: ov.agent } : {}),
      ...(ov.files !== undefined ? { files: ov.files } : {}),
    }
  })
  const merged = { ...overrides }
  delete merged.import_from
  delete merged.importFrom
  delete merged.import_repo
  delete merged.importRepo
  if (merged.spec_id === undefined && merged.specId === undefined) {
    merged.spec_id = imported.manifest.spec_id
  }
  merged.tickets = tickets
  return merged
}

async function githubImport(ref, { cwd, gh }) {
  const repo =
    ref.repo ?? (await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner']))?.nameWithOwner
  if (typeof repo !== 'string' || !repoPattern.test(repo)) throw new Error('Cannot tell which GitHub repository to read; pass repo')
  const parent = await gh(cwd, ['api', 'repos/' + repo + '/issues/' + ref.number])
  const key = (repoUrl, number) => repoUrl.replace(/^https:\/\/api\.github\.com\/repos\//, '') + '#' + number
  const warnings = []
  let children = []
  try {
    const pages = await gh(cwd, ['api', '--paginate', '--slurp', 'repos/' + repo + '/issues/' + ref.number + '/sub_issues?per_page=100'])
    children = (pages ?? []).flat()
  } catch (err) {
    if (!err.notFound) throw err
    warnings.push('Sub-issues are not available on this repository; searched for "Part of #' + ref.number + '" instead.')
  }
  if (!children.length) {
    // The /to-tickets fallback: "Part of #<parent>" at the top of the child body.
    const pages = await gh(cwd, [
      'api', '-X', 'GET', '--paginate', '--slurp', 'search/issues',
      '-f', 'q=repo:' + repo + ' is:issue in:body "Part of #' + ref.number + '"', '-f', 'per_page=100',
    ])
    const marker = new RegExp('^\\s*Part of #' + ref.number + '\\b', 'im')
    children = (pages ?? []).flatMap((p) => p.items ?? []).filter((it) => marker.test(it.body ?? ''))
    children.sort((a, b) => a.number - b.number)
  }
  const open = children.filter((c) => c.state === 'open')
  const skipped = children
    .filter((c) => c.state !== 'open')
    .map((c) => ({ ref: '#' + c.number, title: c.title, reason: 'issue is closed' }))
  const named = assignIds(open, (c) => 'gh-' + c.number)
  const idOf = new Map(open.map((c, i) => [key(c.repository_url ?? 'https://api.github.com/repos/' + repo, c.number), named[i].id]))
  let edges = false
  const tickets = []
  for (const [i, issue] of open.entries()) {
    const self = key(issue.repository_url ?? 'https://api.github.com/repos/' + repo, issue.number)
    const blockers = new Map()
    try {
      const native = await gh(cwd, ['api', 'repos/' + repo + '/issues/' + issue.number + '/dependencies/blocked_by?per_page=100'])
      for (const b of native ?? []) blockers.set(key(b.repository_url, b.number), { state: b.state, ref: b.html_url })
    } catch (err) {
      if (!err.notFound) throw err
    }
    for (const number of bodyBlockers(issue.body)) {
      const k = repo + '#' + number
      if (!blockers.has(k)) blockers.set(k, { state: null, ref: '#' + number })
    }
    if (blockers.size) edges = true
    const dependsOn = []
    for (const [k, b] of blockers) {
      if (k === self) continue
      if (idOf.has(k)) {
        dependsOn.push(idOf.get(k))
        continue
      }
      // A blocker outside this spec gates the ticket only while it is open.
      const state = b.state ?? (await gh(cwd, ['api', 'repos/' + k.replace('#', '/issues/')]))?.state
      if (state === 'open')
        throw new Error('#' + issue.number + ' is blocked by ' + b.ref + ', which is open and not a ticket of #' + ref.number)
    }
    const url = issue.html_url ?? 'https://github.com/' + repo + '/issues/' + issue.number
    tickets.push({
      id: named[i].id,
      title: named[i].title,
      prompt: promptFor(
        [
          'Ticket: GitHub issue ' + url,
          'Parent spec: ' + (parent.html_url ?? '#' + ref.number) + ' (read it with: gh issue view ' + ref.number + ' --repo ' + repo + ')',
        ],
        issue.body,
      ),
      acceptance: acceptanceOf(issue.body),
      depends_on: dependsOn,
      source: { kind: 'github', repo, number: issue.number, url },
    })
  }
  return result({
    source: { kind: 'github', repo, number: ref.number, url: parent.html_url },
    spec: { id: 'gh-' + ref.number, title: parent.title, ref: parent.html_url, body: parent.body ?? '' },
    tickets,
    edges,
    skipped,
    warnings,
  })
}

async function exists(path) {
  try {
    return await stat(path)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// A field line such as "**Status:** ready-for-agent" or "Status: claimed".
function field(body, name) {
  return new RegExp('^\\s*(?:\\*\\*)?' + name + ':?(?:\\*\\*)?:?\\s*(.*)$', 'im').exec(body)?.[1].trim() ?? null
}

async function localImport(ref, { cwd }) {
  let dir = isAbsolute(ref.path) ? ref.path : resolve(cwd, ref.path)
  const info = await exists(dir)
  if (!info) throw new Error('No such spec path: ' + ref.path)
  if (info.isFile()) dir = dirname(dir)
  if (basename(dir) === 'issues' && !(await exists(join(dir, 'issues')))) dir = dirname(dir)
  const specFile = join(dir, 'spec.md')
  const specBody = (await exists(specFile)) ? await readFile(specFile, 'utf8') : ''
  const issuesDir = join(dir, 'issues')
  const files = (await exists(issuesDir))
    ? (await readdir(issuesDir)).filter((f) => /^\d+[-_].*\.md$|^\d+\.md$/i.test(f)).sort()
    : []
  const shown = (file) => relative(cwd, file).replace(/\\/g, '/') || file
  const warnings = []
  const items = []
  for (const file of files) {
    const path = join(issuesDir, file)
    const body = await readFile(path, 'utf8')
    const number = /^(\d+)/.exec(file)[1]
    const heading = /^#\s+(?:\d+\s*[:.-]\s*)?(.+?)\s*$/m.exec(body)?.[1] ?? file.replace(/\.md$/i, '')
    items.push({ file, path, body, number, title: heading, status: field(body, 'Status') ?? '' })
  }
  const byNumber = new Map(items.map((it) => [Number(it.number), it]))
  const skipped = items
    .filter((it) => doneStatus.test(it.status))
    .map((it) => ({ ref: shown(it.path), title: it.title, reason: 'status is ' + it.status }))
  const open = items.filter((it) => !doneStatus.test(it.status))
  const named = assignIds(open, (it) => 'T' + it.number)
  const idOf = new Map(open.map((it, i) => [Number(it.number), named[i].id]))
  let edges = false
  const tickets = []
  for (const [i, it] of open.entries()) {
    const declared = blockedByText(it.body)
    const dependsOn = []
    if (declared !== null && !saysNone(declared)) {
      const numbers = [...new Set([...declared.matchAll(/(?:^|[^\w])#?(\d{1,4})\b/g)].map((m) => Number(m[1])))]
      if (!numbers.length) {
        warnings.push(shown(it.path) + ': cannot read "Blocked by: ' + declared.trim() + '"; name blockers by number')
      }
      for (const n of numbers) {
        edges = true
        if (n === Number(it.number)) continue
        if (idOf.has(n)) dependsOn.push(idOf.get(n))
        else if (!byNumber.has(n)) throw new Error(shown(it.path) + ' is blocked by ' + n + ', which is not a ticket in ' + shown(issuesDir))
      }
    }
    tickets.push({
      id: named[i].id,
      title: named[i].title,
      prompt: promptFor(
        ['Ticket: ' + it.path, specBody ? 'Parent spec: ' + specFile : 'No spec.md next to the tickets.'],
        it.body,
      ),
      acceptance: acceptanceOf(it.body),
      depends_on: dependsOn,
      source: { kind: 'local', path: it.path },
    })
  }
  const slug = basename(dir).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 70) || 'spec'
  const specTitle = /^#\s+(.+?)\s*$/m.exec(specBody)?.[1] ?? slug
  return result({
    source: { kind: 'local', path: dir },
    spec: { id: slug, title: specTitle, ref: specBody ? specFile : dir, body: specBody },
    tickets,
    edges,
    skipped,
    warnings,
  })
}

/**
 * Read a spec and its tickets into a manifest draft. Read-only.
 * @param options.cwd - the captain's working directory; local paths resolve against it.
 * @param options.spec - "#N", "N", an issue URL, or a local path.
 * @param options.repo - optional owner/name for a bare issue number.
 * @param options.gh - the gh runner, replaceable in tests.
 */
export async function importTickets({ cwd, spec, repo, gh = runGh }) {
  const ref = parseSpecRef(spec, repo)
  return ref.kind === 'github' ? githubImport(ref, { cwd, gh }) : localImport(ref, { cwd })
}

/**
 * Report an integrated ticket on its GitHub issue: a comment naming the
 * integration branch and commit, then close when mode is "close".
 */
export async function writeback({ cwd, source, mode, runId, ref, landedSha, gh = runGh }) {
  if (source?.kind !== 'github') return { status: 'skipped', reason: 'not a GitHub ticket' }
  const target = source.repo + '#' + source.number
  const body =
    'dsh-agent-teams run `' + runId + '` integrated this ticket into `' + ref.replace(/^refs\/heads\//, '') +
    '` at ' + landedSha + '. It is not on the default branch until that branch is merged.'
  await gh(cwd, ['issue', 'comment', String(source.number), '--repo', source.repo, '--body', body])
  if (mode === 'close') await gh(cwd, ['issue', 'close', String(source.number), '--repo', source.repo, '--reason', 'completed'])
  return { status: mode === 'close' ? 'closed' : 'commented', target }
}
