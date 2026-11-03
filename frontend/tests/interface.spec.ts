import { expect, test, type Locator, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { personas, personaStorageKey } from '../src/personas'
import type { PersonaId } from '../src/personas'
import { elapsedRunTime, messageTelemetry, messageTimestamp } from '../src/messageTelemetry'
import type { HarnessEvent } from '../src/messageTelemetry'

const assets = fileURLToPath(new URL('../../docs/assets/', import.meta.url))

async function expectNoOverlap(first: Locator, second: Locator) {
  const [a, b] = await Promise.all([first.boundingBox(), second.boundingBox()])
  if (!a || !b) throw new Error('Missing bounds for overlap check')
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  expect(width <= 1 || height <= 1, `Overlapping bounds: ${JSON.stringify({ a, b })}`).toBe(true)
}

async function expectContained(child: Locator, parent: Locator) {
  const [a, b] = await Promise.all([child.boundingBox(), parent.boundingBox()])
  if (!a || !b) throw new Error('Missing bounds for containment check')
  expect(a.x).toBeGreaterThanOrEqual(b.x - 1)
  expect(a.y).toBeGreaterThanOrEqual(b.y - 1)
  expect(a.x + a.width).toBeLessThanOrEqual(b.x + b.width + 1)
  expect(a.y + a.height).toBeLessThanOrEqual(b.y + b.height + 1)
}

async function openWelcome(page: Page) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path !== '/api/providers' && path !== '/api/sessions') {
      throw new Error(`Unexpected welcome request: ${path}`)
    }
    await route.fulfill({ json: [] })
  })
  await page.goto('/')
  await expect(page.locator('.provider-empty')).toBeVisible()
}

function sampleArtifact(id: string, fileName: string, sizeBytes = 0, version = 1) {
  return {
    id,
    session_id: 'sample-session',
    title: fileName,
    media_type: 'text/plain',
    current_version: version,
    created_at: '2026-11-02T14:00:00Z',
    updated_at: '2026-11-02T14:12:00Z',
    versions: [{ version, file_name: fileName, size_bytes: sizeBytes, created_at: '2026-11-02T14:12:00Z' }],
  }
}

function mixedOutputs() {
  const helper = sampleArtifact('session-helper', 'src/session.ts', 2048, 2)
  return [
    sampleArtifact('client', 'src\\client\\App.TSX', 1024),
    {
      ...helper,
      title: 'Session helper',
      versions: [...helper.versions, { version: 1, file_name: 'old/session.py', size_bytes: 16384, created_at: '2026-11-02T14:00:00Z' }],
    },
    sampleArtifact('config', 'package.json', 128),
    sampleArtifact('server', 'src/Handler.cs', 512),
    sampleArtifact('note', '.prudence/notes/design.md', 256),
    sampleArtifact('readme', 'README'),
  ]
}

function sampleProvider(id: string, name: string, kind: 'foundry' | 'local', model: string, boundary: 'machine' | 'local_network' | 'external') {
  return {
    id, name, kind, model,
    endpoint: kind === 'local' ? 'http://127.0.0.1:11434/v1' : 'https://example.invalid/openai/v1',
    api_key_env: null,
    max_context_window_tokens: 32768,
    max_output_tokens: 4096,
    data_boundary: boundary,
  }
}

function pairingProviders() {
  return [
    sampleProvider('sample-foundry', 'Foundry Counsel', 'foundry', 'counsel-reasoning', 'external'),
    sampleProvider('sample-phi', 'Local Phi 3.5 Mini', 'local', 'phi3.5-mini', 'local_network'),
    sampleProvider('sample-qwen', 'Local Qwen 2.5 Coder 7B', 'local', 'qwen2.5-coder-7b-instruct-cuda-gpu', 'machine'),
    sampleProvider('other-foundry', 'Other Foundry', 'foundry', 'other-reasoning', 'external'),
  ]
}

function sampleProbe(providerId: string, ok = true) {
  return { id: 1, provider_id: providerId, ok, message: ok ? 'Synthetic connection passed' : 'Synthetic connection failed', tool_calling: true, streaming: true, checked_at: '2026-11-02T14:12:00Z' }
}

async function selectProvider(page: Page, name: string) {
  await page.getByRole('button', { name: 'Active model provider', exact: true }).click()
  await page.getByRole('listbox', { name: 'Active model provider options' })
    .getByRole('option').filter({ has: page.getByTitle(name, { exact: true }) }).click()
}

async function openSample(
  page: Page,
  pendingApproval = false,
  outputs: ReturnType<typeof sampleArtifact>[] = [],
  providers = [sampleProvider('sample-local', 'Local model', 'local', 'local-code', 'machine')],
  creationPersona: PersonaId | null = 'default',
) {
  const provider = providers[0]
  if (!provider) throw new Error('The sample session requires a provider')
  const session = {
    id: 'sample-session',
    provider_id: provider.id,
    craft_provider_id: null,
    persona_id: creationPersona,
    title: 'Refactor authentication',
    created_at: '2026-11-02T14:00:00Z',
    updated_at: '2026-11-02T14:12:00Z',
    events: [
      {
        id: 1,
        session_id: 'sample-session',
        sequence: 1,
        type: 'user_message',
        payload: {
          content: 'Simplify the authentication flow. Keep the public API stable and show me the changes before writing any files.',
        },
        created_at: '2026-11-02T14:00:00Z',
      },
      {
        id: 2,
        session_id: 'sample-session',
        sequence: 2,
        type: 'assistant_message',
        payload: {
          content: '## A smaller, clearer authentication flow\n\nI reviewed the flow and prepared a three-step plan. The public API stays unchanged.\n\n- Consolidate token validation.\n- Extract the shared session helper.\n- Verify error handling and regression tests.\n\n**Your approval comes first.** I will show the exact diff before modifying workspace files.',
        },
        created_at: '2026-11-02T14:01:00Z',
      },
    ],
  }
  const state = {
    mode: 'plan',
    is_running: false,
    tasks: [
      { id: 1, title: 'Review authentication flow', description: 'Identify duplication and preserve the public API.', is_complete: true },
      { id: 2, title: 'Extract shared session helper', description: 'Prepare bounded changes for review.', is_complete: false },
      { id: 3, title: 'Run regression tests', description: 'Verify success and failure paths.', is_complete: false },
    ],
  }
  const workspace = {
    root_path: 'C:\\demo\\sample-workspace',
    instructions: [],
    context_files: [],
    discovered_file_count: 12,
    discovery_truncated: false,
    read_tools: ['read_file', 'search_files'],
    write_tools_enabled: true,
    auto_approve_enabled: false,
    write_tools: ['write_file'],
  }
  const approvals = pendingApproval ? [{
    id: 'sample-approval',
    tool_name: 'write_file',
    arguments: { path: 'src/session.ts', content: 'export const sessionTimeout = 30;\n' },
    preview: {
      operation: 'Update session helper',
      category: 'workspace_write',
      risk_level: 'medium',
      affected_paths: ['src/session.ts'],
      preview_kind: 'unified_diff',
      preview_content: '--- a/src/session.ts\n+++ b/src/session.ts\n@@ -1 +1 @@\n-export const sessionTimeout = 15;\n+export const sessionTimeout = 30;',
      preview_truncated: false,
    },
    status: 'pending',
  }] : []
  const unexpectedRequests: string[] = []
  const histories: Record<string, ReturnType<typeof sampleProbe>[]> = {}
  const probeFailures: Record<string, string> = {}
  const historyFailures: Record<string, string> = {}
  const providerRequests: string[] = []
  const historyReads: string[] = []
  const sampleSessions: Array<Omit<typeof session, 'craft_provider_id'> & { craft_provider_id: string | null }> = [session]
  const sessionCreations: { provider_id: string; craft_provider_id: string | null; persona_id: PersonaId; title: string }[] = []
  const sessionDeletes: string[] = []
  const sessionDeleteFailures: Record<string, string> = {}
  const decisions: unknown[] = []
  const modelRequests: string[] = []
  const artifactReads: string[] = []
  let startRun: () => void = () => { throw new Error('Fixture stream not connected') }
  let sendActivity: (type: string, payload: Record<string, unknown>, createdAt?: string) => void = () => {
    throw new Error('Fixture stream not connected')
  }
  let sendError: (message: string) => void = () => { throw new Error('Fixture stream not connected') }
  let sendDelta: (content: string) => void = () => { throw new Error('Fixture stream not connected') }
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const requestedSession = sampleSessions.find((entry) =>
      url.pathname === `/api/sessions/${entry.id}` || url.pathname.startsWith(`/api/sessions/${entry.id}/`),
    )
    const path = requestedSession
      ? url.pathname.replace(`/api/sessions/${requestedSession.id}`, '/api/sessions/sample-session')
      : url.pathname
    const method = route.request().method()
    const artifactMatch = path.match(/^\/api\/sessions\/sample-session\/artifacts\/([^/]+)$/)
    let body: unknown
    if (path === '/api/providers') body = providers
    else if (providers.some((entry) => path === `/api/providers/${entry.id}/probes`)) {
      const id = path.split('/')[3]
      historyReads.push(id)
      if (historyFailures[id]) {
        await route.fulfill({ status: 500, json: { detail: historyFailures[id] } })
        return
      }
      body = histories[id] ?? []
    } else if (providers.some((entry) => path === `/api/providers/${entry.id}/probe`) && method === 'POST') {
      const id = path.split('/')[3]
      providerRequests.push(`POST ${id}`)
      histories[id] = [sampleProbe(id, !probeFailures[id])]
      if (probeFailures[id]) {
        await route.fulfill({ status: 401, json: { detail: probeFailures[id] } })
        return
      }
      body = { message: 'Synthetic connection passed' }
    } else if (providers.some((entry) => path === `/api/providers/${entry.id}`) && ['PUT', 'DELETE'].includes(method)) {
      const index = providers.findIndex((entry) => path === `/api/providers/${entry.id}`)
      providerRequests.push(`${method} ${providers[index].id}`)
      if (method === 'DELETE') { providers.splice(index, 1); await route.fulfill({ status: 204 }); return }
      Object.assign(providers[index], route.request().postDataJSON())
      body = providers[index]
    }
    else if (path === '/api/sessions' && method === 'POST') {
      const creation: typeof sessionCreations[number] = route.request().postDataJSON()
      sessionCreations.push(creation)
      const created = { ...session, ...creation, id: `created-session-${sessionCreations.length}`, events: [] }
      sampleSessions.push(created)
      body = created
    }
    else if (path === '/api/sessions') body = sampleSessions
    else if (path === '/api/sessions/sample-session' && method === 'DELETE' && requestedSession) {
      sessionDeletes.push(requestedSession.id)
      if (sessionDeleteFailures[requestedSession.id]) {
        await route.fulfill({ status: 409, json: { detail: sessionDeleteFailures[requestedSession.id] } })
        return
      }
      sampleSessions.splice(sampleSessions.findIndex((entry) => entry.id === requestedSession.id), 1)
      await route.fulfill({ status: 204 })
      return
    }
    else if (path === '/api/sessions/sample-session') body = requestedSession
    else if (path === '/api/sessions/sample-session/state') body = state
    else if (path === '/api/sessions/sample-session/mode' && method === 'PUT') {
      state.mode = route.request().postDataJSON().mode
      body = state
    } else if (path === '/api/sessions/sample-session/workspace') body = workspace
    else if (path === '/api/sessions/sample-session/approvals') body = approvals
    else if (path === '/api/approvals/sample-approval/decision' && method === 'POST') {
      decisions.push(route.request().postDataJSON())
      approvals.splice(0)
      body = { status: 'approved' }
    } else if (path === '/api/sessions/sample-session/artifacts') body = outputs
    else if (artifactMatch && method === 'GET') {
      artifactReads.push(`${path}${url.search}`)
      const artifact = outputs.find((output) => output.id === artifactMatch[1])
      const requested = Number(url.searchParams.get('version') ?? artifact?.current_version)
      const version = artifact?.versions.find((entry) => entry.version === requested)
      if (!artifact || !version) {
        unexpectedRequests.push(`${method} ${path}${url.search}`)
        await route.fulfill({ status: 404, json: { detail: 'Synthetic artifact version not found' } })
        return
      }
      body = {
        ...artifact, version: requested,
        content: `// Synthetic preview ${artifact.id} v${requested}\n${'fixture'.repeat(50)}`,
        content_truncated: false,
      }
    } else if (['memories', 'instructions', 'skills', 'hooks', 'mcp-servers', 'subagents']
      .some((resource) => path === `/api/sessions/sample-session/${resource}`)) body = []
    else {
      unexpectedRequests.push(`${method} ${path}`)
      await route.fulfill({ status: 500, json: { detail: `Unexpected fixture request: ${method} ${path}` } })
      return
    }
    await route.fulfill({ json: body })
  })
  await page.routeWebSocket('**/api/sessions/*/stream', (socket) => {
    socket.onMessage((message) => modelRequests.push(String(message)))
    let eventId = 3
    sendActivity = (type, payload, createdAt = '2026-11-02T14:02:00Z') => socket.send(JSON.stringify({
      type: 'event',
      event: {
        id: eventId,
        session_id: 'sample-session',
        sequence: eventId++,
        type,
        payload,
        created_at: createdAt,
      },
    }))
    startRun = () => sendActivity('run_started', {})
    sendError = (message) => socket.send(JSON.stringify({ type: 'error', payload: { message } }))
    sendDelta = (content) => socket.send(JSON.stringify({ type: 'assistant_delta', payload: { content } }))
  })
  await page.goto('/')
  await page.getByRole('button', { name: /^Refactor authentication/ }).click()
  await expect(page.getByRole('textbox', { name: 'Message the agent' })).toHaveAttribute(
    'placeholder', pendingApproval ? 'Resolve the pending approval before continuing...' : 'Ask Prudence...',
  )
  await expect(page.locator('.connection')).toHaveText('Connected')
  await expect(page.getByText('Powered by Microsoft Agent Framework', { exact: true })).toHaveCount(1)
  return { unexpectedRequests, decisions, modelRequests, artifactReads, sessionCreations, sessionDeletes, sessionDeleteFailures, histories, probeFailures, historyFailures, providerRequests, historyReads, startRun, sendActivity, sendError, sendDelta }
}

function telemetryEvent(id: number, type: string, payload: Record<string, unknown> = {}): HarnessEvent {
  return { id, session_id: 'telemetry-session', sequence: id, type, payload, created_at: new Date(Date.UTC(2026, 10, 2, 14, 0, id)).toISOString() }
}

function emitMeasuredRun(fixture: Awaited<ReturnType<typeof openSample>>, model = 'recorded-main-model') {
  fixture.sendActivity('user_message', { content: 'Measured prompt for the agent' }, '2026-11-02T14:02:00Z')
  fixture.sendActivity('run_started', { model, craft_model: 'recorded-craft-model' }, '2026-11-02T14:02:00.500Z')
  fixture.sendActivity('tool_call', { name: 'read_file', arguments: { path: 'src/example.ts' } }, '2026-11-02T14:02:01Z')
  fixture.sendActivity('context_usage', { input_tokens: 120, output_tokens: 30, context_limit: 1000, context_percent: 12 }, '2026-11-02T14:02:01.500Z')
  fixture.sendActivity('assistant_message', { content: 'A measured answer from the agent.' }, '2026-11-02T14:02:02Z')
  fixture.sendActivity('run_completed', {}, '2026-11-02T14:02:03Z')
}

test('message telemetry scopes model, tokens and outcome to each prompt run', () => {
  const events = [
    telemetryEvent(1, 'user_message'),
    telemetryEvent(2, 'run_started', { model: 'first-model' }),
    telemetryEvent(3, 'context_usage', { input_tokens: 12, output_tokens: 3 }),
    telemetryEvent(4, 'assistant_message'),
    telemetryEvent(5, 'run_completed'),
    telemetryEvent(6, 'user_message'),
    telemetryEvent(7, 'run_started', { model: 'second-model' }),
    telemetryEvent(8, 'context_usage', { input_tokens: 0, output_tokens: 0 }),
    telemetryEvent(9, 'assistant_message'),
    telemetryEvent(10, 'run_completed'),
    telemetryEvent(11, 'context_usage', { input_tokens: 999, output_tokens: 999 }),
    telemetryEvent(12, 'assistant_message'),
  ]
  const result = messageTelemetry(events)
  expect(result.byMessage.get(1)).toMatchObject({ model: 'first-model', inputTokens: 12, outputTokens: 3, outcome: 'Completed' })
  expect(result.byMessage.get(4)).toBe(result.byMessage.get(1))
  expect(result.byMessage.get(6)).toMatchObject({ model: 'second-model', inputTokens: 0, outputTokens: 0, outcome: 'Completed' })
  expect(result.byMessage.get(9)).toBe(result.byMessage.get(6))
  expect(result.byMessage.has(12)).toBe(false)
  expect(result.activeRun).toBeNull()
})

test('message telemetry aggregates approval-resumed reports without double-counting tool results', () => {
  const result = messageTelemetry([
    telemetryEvent(1, 'user_message'),
    telemetryEvent(2, 'run_started', { model: 'counsel', craft_model: 'craft' }),
    telemetryEvent(3, 'tool_call'),
    telemetryEvent(4, 'context_usage', { input_tokens: 80, output_tokens: 4 }),
    telemetryEvent(5, 'run_waiting_approval'),
    telemetryEvent(6, 'approval_decided'),
    telemetryEvent(7, 'tool_result'),
    telemetryEvent(8, 'context_usage', { input_tokens: 50, output_tokens: 6 }),
    telemetryEvent(9, 'assistant_message'),
    telemetryEvent(10, 'run_completed'),
  ])
  const run = result.byMessage.get(1)
  expect(run).toMatchObject({ inputTokens: 130, outputTokens: 10, usageSamples: 2, toolCalls: 1, craftModel: 'craft', outcome: 'Completed' })
  if (!run) throw new Error('Expected recorded run')
  expect(elapsedRunTime(run)).toBe('8.0 s')
})

test('message telemetry keeps missing and invalid usage distinct from recorded zero', () => {
  const result = messageTelemetry([
    telemetryEvent(1, 'user_message'),
    telemetryEvent(2, 'run_started'),
    telemetryEvent(3, 'context_usage', { input_tokens: 10 }),
    telemetryEvent(4, 'context_usage', { input_tokens: 12, output_tokens: 5 }),
    telemetryEvent(5, 'assistant_message'),
    telemetryEvent(6, 'run_failed'),
    telemetryEvent(7, 'user_message'),
    telemetryEvent(8, 'run_started'),
    telemetryEvent(9, 'context_usage', { input_tokens: -1, output_tokens: Number.POSITIVE_INFINITY }),
    telemetryEvent(10, 'run_cancelled'),
  ])
  expect(result.byMessage.get(1)).toMatchObject({ inputTokens: 22, outputTokens: null, model: null, outcome: 'Failed' })
  expect(result.byMessage.get(7)).toMatchObject({ inputTokens: null, outputTokens: null, outcome: 'Cancelled' })
  expect(messageTelemetry([telemetryEvent(1, 'user_message'), telemetryEvent(2, 'assistant_message')]).byMessage.size).toBe(0)
})

test('message telemetry marks incomplete run boundaries and invalid timestamps explicitly', () => {
  const result = messageTelemetry([
    telemetryEvent(1, 'user_message'),
    telemetryEvent(2, 'run_started', { model: 'incomplete-model' }),
    telemetryEvent(3, 'assistant_message'),
    telemetryEvent(4, 'user_message'),
    telemetryEvent(5, 'run_started', { model: 'current-model' }),
    telemetryEvent(6, 'run_waiting_approval'),
  ])
  expect(result.byMessage.get(1)?.outcome).toBe('End not recorded')
  expect(result.byMessage.get(3)?.model).toBe('incomplete-model')
  expect(result.activeRun?.outcome).toBe('Waiting for approval')
  const current = result.activeRun
  if (!current) throw new Error('Expected current run')
  expect(elapsedRunTime(current)).toBeNull()
  expect(elapsedRunTime({ ...current, endedAt: 'invalid' })).toBeNull()
  expect(elapsedRunTime({ ...current, endedAt: '2020-01-01T00:00:00Z' })).toBeNull()
  expect(elapsedRunTime({ ...current, endedAt: current.startedAt })).toBe('0 ms')
  expect(elapsedRunTime({ ...current, endedAt: '2026-11-02T14:00:05.250Z' })).toBe('250 ms')
  expect(elapsedRunTime({ ...current, endedAt: '2026-11-02T14:00:06.500Z' })).toBe('1.5 s')
  expect(elapsedRunTime({ ...current, endedAt: '2026-11-02T14:01:05Z' })).toBe('1m 0s')
  expect(messageTimestamp('invalid')).toBeNull()
})

test.describe('message timestamp time zone', () => {
  test.use({ locale: 'en-US', timezoneId: 'America/Los_Angeles' })
  test('message dates include seconds and the browser time zone while keeping original ISO timestamps', async ({ page }) => {
    await openSample(page)
    const userTime = page.locator('.message.user .message-heading time').first()
    await expect(userTime).toHaveAttribute('datetime', '2026-11-02T14:00:00Z')
    await expect(userTime).toHaveAttribute('title', 'Message recorded: 2026-11-02T14:00:00Z')
    await expect(userTime).toContainText('Nov 2, 2026')
    await expect(userTime).toContainText(/6:00:00\s+AM\s+PST/)
    await expect(page.locator('.message.assistant .message-heading time')).toHaveAttribute('datetime', '2026-11-02T14:01:00Z')
    await expect(page.locator('.message-stats-unavailable')).toHaveCount(2)
  })
})

test('message run details show recorded metrics and do not switch to a later model or usage report', async ({ page }) => {
  const fixture = await openSample(page)
  emitMeasuredRun(fixture)
  const user = page.locator('.message.user').filter({ hasText: 'Measured prompt for the agent' })
  const assistant = page.locator('.message.assistant').filter({ hasText: 'A measured answer from the agent.' })
  await expect(assistant).toBeVisible()
  await expect(user.locator('.message-heading time')).toHaveAttribute('datetime', '2026-11-02T14:02:00Z')
  await expect(assistant.locator('.message-heading time')).toHaveAttribute('datetime', '2026-11-02T14:02:02Z')
  await expect(user.locator('.message-run-stats summary')).toContainText('Completed')
  await expect(user.locator('.message-run-stats summary')).toContainText('2.5 s')
  await expect(user.locator('.message-run-stats summary')).toContainText('1 tool request')
  await user.locator('.message-run-stats summary').click()
  await expect(user.locator('.message-run-stats dd')).toHaveText(['recorded-main-model', 'recorded-craft-model', '2.5 s', '120', '30', '1', '1'])
  fixture.sendActivity('user_message', { content: 'A second independent prompt' }, '2026-11-02T14:03:00Z')
  fixture.sendActivity('run_started', { model: 'later-model' }, '2026-11-02T14:03:01Z')
  fixture.sendActivity('context_usage', { input_tokens: 0, output_tokens: 0 }, '2026-11-02T14:03:02Z')
  fixture.sendActivity('assistant_message', { content: 'Second independent answer' }, '2026-11-02T14:03:03Z')
  fixture.sendActivity('run_completed', {}, '2026-11-02T14:03:04Z')
  const second = page.locator('.message.assistant').filter({ hasText: 'Second independent answer' })
  await second.locator('.message-run-stats summary').click()
  await expect(second.locator('.message-run-stats dd')).toHaveText(['later-model', '3.0 s', '0', '0', '1', '0'])
  await expect(user.locator('.message-run-stats dd')).toHaveText(['recorded-main-model', 'recorded-craft-model', '2.5 s', '120', '30', '1', '1'])
  expect(fixture.modelRequests).toEqual([])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('streaming and partial messages distinguish run start time, unknown usage and failed outcomes', async ({ page }) => {
  const fixture = await openSample(page)
  fixture.sendActivity('user_message', { content: 'A streamed prompt' }, '2026-11-02T14:04:00Z')
  fixture.sendActivity('run_started', { model: 'streamed-model' }, '2026-11-02T14:04:01Z')
  fixture.sendDelta('A partial streamed answer')
  const live = page.locator('.message.assistant').filter({ has: page.locator('.cursor') })
  await expect(live.locator('.message-heading')).toContainText('Streaming')
  await expect(live.locator('.message-heading time')).toHaveAttribute('title', 'Run started: 2026-11-02T14:04:01Z')
  fixture.sendActivity('context_usage', { output_tokens: 7, context_limit: 1000 }, '2026-11-02T14:04:02Z')
  await live.locator('.message-run-stats summary').click()
  await expect(live.locator('.message-run-stats dd')).toHaveText(['streamed-model', 'In progress', 'Not reported', '7', '1', '0'])
  await expect(page.locator('.usage-meter')).not.toBeVisible()
  fixture.sendActivity('assistant_message', { content: 'A partial streamed answer', partial: true }, '2026-11-02T14:04:03Z')
  fixture.sendActivity('run_failed', { message: 'Synthetic failure' }, '2026-11-02T14:04:04Z')
  const partial = page.locator('.message.assistant').filter({ hasText: 'A partial streamed answer' })
  await expect(partial.locator('.message-heading')).toContainText('Partial response')
  await expect(partial.locator('.message-heading time')).toHaveAttribute('title', 'Message recorded: 2026-11-02T14:04:03Z')
  await expect(partial.locator('.message-run-stats summary')).toContainText('Failed')
  expect(fixture.modelRequests).toEqual([])
})

test('message timestamps and expanded run statistics stay contained in compact layouts', async ({ page }) => {
  const fixture = await openSample(page)
  emitMeasuredRun(fixture, 'a-very-long-recorded-model-'.repeat(15))
  const message = page.locator('.message.user').filter({ hasText: 'Measured prompt for the agent' })
  await message.locator('.message-run-stats summary').click()
  for (const width of [1440, 820, 390]) {
    await page.setViewportSize({ width, height: 800 })
    const body = message.locator(':scope > div').last()
    await expectContained(message.locator('.message-heading'), body)
    await expectContained(message.locator('.message-heading time'), body)
    await expectContained(message.locator('.message-run-stats'), body)
    await expectNoOverlap(message.locator('.message-heading strong'), message.locator('.message-heading time'))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
})

test('persona dial provides seven symbol-only choices, restores default, and persists selection', async ({ page }) => {
  await openWelcome(page)
  const trigger = page.locator('.brand-mark')
  await expect(trigger.locator('img')).toHaveAttribute('src', '/prudence-icon.svg')
  for (const persona of personas) {
    await trigger.click()
    const menu = page.getByRole('menu', { name: 'Choose persona', exact: true })
    await expect(menu.getByRole('menuitemradio')).toHaveCount(8)
    await expect(menu).toHaveText('')
    const option = menu.getByRole('menuitemradio', { name: persona.name, exact: true })
    await expect(option.locator('svg')).toHaveCount(1)
    await option.click()
    await expect(menu).not.toBeVisible()
    await expect(trigger).toBeFocused()
    await expect(page.locator('.empty-state h2')).toHaveText(persona.heading)
    await expect(page.locator('.brand')).toContainText(persona.name)
  }
  await page.reload()
  await expect(trigger).toHaveAttribute('aria-label', 'Choose persona: Learning Coach')
  await trigger.click()
  await expect(page.getByRole('menuitemradio', { name: 'Learning Coach', exact: true })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('menuitemradio', { name: 'Prudence default', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your local agent workspace' })).toBeVisible()
  await expect(trigger.locator('img')).toBeVisible()
  await page.reload()
  await expect(trigger).toHaveAttribute('aria-label', 'Choose persona: Prudence default')
})

test('persona dial supports keyboard navigation and safe dismissal during a run', async ({ page }) => {
  const fixture = await openSample(page)
  const trigger = page.locator('.brand-mark')
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitemradio', { name: 'Prudence default', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('menuitemradio', { name: 'Software Engineer', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.press('Space')
  await expect(trigger).toHaveAttribute('aria-label', 'Choose persona: Learning Coach')
  fixture.startRun()
  await expect(page.getByRole('button', { name: 'Stop run' })).toBeEnabled()
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await expect(page.getByRole('menu')).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop run' })).toBeEnabled()
  await trigger.click()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('menu')).not.toBeVisible()
  await trigger.click()
  await page.getByRole('heading', { name: 'Refactor authentication', exact: true }).click()
  await expect(page.getByRole('menu')).not.toBeVisible()
  expect(fixture.modelRequests).toEqual([])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('personas tailor composer guidance without replacing drafts or sending hidden prompts', async ({ page }) => {
  const fixture = await openSample(page)
  const composer = page.getByRole('textbox', { name: 'Message the agent' })
  await composer.fill('Keep this draft')
  for (const persona of personas) {
    await page.locator('.brand-mark').click()
    await page.getByRole('menuitemradio', { name: persona.name, exact: true }).click()
    await expect(composer).toHaveValue('Keep this draft')
    await expect(composer).toHaveAttribute('placeholder', persona.placeholder)
    await expect(page.locator('.persona-brief')).toContainText(persona.description)
    for (const action of persona.actions) {
      await expect(page.getByRole('button', { name: action, exact: true })).toBeEnabled()
    }
  }
  await page.getByRole('button', { name: 'Set a learning goal', exact: true }).click()
  await page.getByRole('alertdialog', { name: 'Replace draft?' }).getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(composer).toHaveValue('Keep this draft')
  await page.getByRole('button', { name: 'Set a learning goal', exact: true }).click()
  await page.getByRole('alertdialog', { name: 'Replace draft?' }).getByRole('button', { name: 'Replace draft', exact: true }).click()
  await expect(composer).toHaveValue(personas[6].starters[0])
  await expect(composer).toBeFocused()
  expect(fixture.modelRequests).toEqual([])
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => fixture.modelRequests.length).toBe(1)
  expect(JSON.parse(fixture.modelRequests[0])).toEqual({ type: 'prompt', content: personas[6].starters[0] })
  expect(fixture.unexpectedRequests).toEqual([])
})

test('persona changes preserve approvals and model selection', async ({ page }) => {
  const fixture = await openSample(page, true)
  await page.locator('.brand-mark').click()
  await page.getByRole('menuitemradio', { name: 'Learning Coach', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Message the agent' })).toHaveAttribute('placeholder', 'Resolve the pending approval before continuing...')
  await expect(page.getByRole('button', { name: 'Set a learning goal', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  await expect(page.getByRole('heading', { name: 'Proposed changes' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Active model provider', exact: true })).toContainText('model')
  expect(fixture.decisions).toEqual([])
  expect(fixture.modelRequests).toEqual([])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('persona dial stays inside narrow and short viewports with distinct touch targets', async ({ page }) => {
  await openWelcome(page)
  for (const viewport of [{ width: 1440, height: 900 }, { width: 760, height: 640 }, { width: 320, height: 600 }]) {
    await page.setViewportSize(viewport)
    for (const trigger of [page.locator('.brand-mark'), page.locator('.persona-prominent')]) {
      await trigger.click()
      const menu = page.getByRole('menu', { name: 'Choose persona', exact: true })
      const bounds = await menu.boundingBox()
      if (!bounds) throw new Error('Persona menu has no bounds')
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.y).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height)
      const options = menu.getByRole('menuitemradio')
      const optionBounds = await options.evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }))
      for (const [index, a] of optionBounds.entries()) {
        expect(a.width).toBeGreaterThanOrEqual(44)
        expect(a.height).toBeGreaterThanOrEqual(44)
        expect(a.x).toBeGreaterThanOrEqual(bounds.x)
        expect(a.y).toBeGreaterThanOrEqual(bounds.y)
        expect(a.x + a.width).toBeLessThanOrEqual(bounds.x + bounds.width)
        expect(a.y + a.height).toBeLessThanOrEqual(bounds.y + bounds.height)
        for (const b of optionBounds.slice(index + 1)) {
          const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
          const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
          expect(width <= 1 || height <= 1).toBe(true)
        }
      }
      await expect(menu).toHaveCSS('animation-name', 'none')
      await page.keyboard.press('Escape')
    }
  }
})

test('persona task briefs preserve compact composer and approval layouts', async ({ page }) => {
  const fixture = await openSample(page, true)
  await page.locator('.brand-mark').click()
  await page.getByRole('menuitemradio', { name: 'Learning Coach', exact: true }).click()
  for (const [width, height] of [[1440, 1000], [1024, 420], [761, 600], [390, 800]]) {
    await page.setViewportSize({ width, height })
    await expectContained(page.locator('.persona-brief'), page.locator('main'))
    await expectContained(page.locator('.composer'), page.locator('main'))
    await expectNoOverlap(page.locator('.persona-brief'), page.locator('.approval-tray'))
    await expectNoOverlap(page.locator('.approval-tray'), page.locator('.composer'))
    await expectNoOverlap(page.locator('.composer'), page.locator('.framework-credit'))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  await page.locator('.persona-brief summary').click()
  await expect(page.getByRole('button', { name: 'Set a learning goal', exact: true })).not.toBeVisible()
  await page.locator('.persona-brief summary').click()
  await expect(page.getByRole('button', { name: 'Set a learning goal', exact: true })).toBeVisible()
  expect(fixture.modelRequests).toEqual([])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('invalid saved persona preferences are surfaced explicitly', async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, 'unsupported'), personaStorageKey)
  await openWelcome(page)
  await expect(page.getByRole('status').filter({ hasText: 'The saved persona is not supported' })).toBeVisible()
})

test('layered panes SVG is shared by default persona surfaces and the favicon without grayscale filters', async ({ page, request }) => {
  await openWelcome(page)
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/prudence-icon.svg')
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('type', 'image/svg+xml')
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#f6f2eb')
  const asset = await request.get('/prudence-icon.svg')
  expect(asset.ok()).toBe(true)
  expect(asset.headers()['content-type']).toContain('image/svg+xml')
  const svg = await asset.text()
  expect(svg).toContain('Prudence layered panes')
  expect(svg).not.toContain('stroke-dasharray')
  await page.locator('.persona-prominent').click()
  const images = page.locator('.persona-trigger img, .persona-default img')
  await expect(images).toHaveCount(3)
  for (const image of await images.all()) {
    await expect(image).toHaveAttribute('src', '/prudence-icon.svg')
    await expect(image).toHaveCSS('filter', 'none')
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
  }
  await page.getByRole('menuitemradio', { name: 'Prudence default', exact: true }).click()
  await expect(page.locator('.persona-prominent')).toHaveAttribute('aria-label', 'Choose persona: Prudence default')
})

test('session deletion uses a themed confirmation with cancel, Escape, focus containment and no native dialogs', async ({ page }) => {
  const nativeDialogs: string[] = []
  page.on('dialog', async (dialog) => { nativeDialogs.push(dialog.type()); await dialog.dismiss() })
  const fixture = await openSample(page)
  const trigger = page.getByRole('button', { name: 'Delete session Refactor authentication', exact: true })
  await trigger.click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete session?', exact: true })
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
  const confirm = dialog.getByRole('button', { name: 'Delete session', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Files in a bound workspace will not be deleted.')
  await expect(dialog).toHaveCSS('background-color', 'rgb(255, 253, 250)')
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(confirm).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: 'Workspace commands' })).not.toBeVisible()
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 420 }]) {
    await page.setViewportSize(viewport)
    const bounds = await dialog.boundingBox()
    if (!bounds) throw new Error('Confirmation dialog has no bounds')
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height)
    await expectContained(cancel, dialog)
    await expectContained(confirm, dialog)
    await expectNoOverlap(cancel, confirm)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await cancel.click()
  await expect(trigger).toBeFocused()
  expect(fixture.sessionDeletes).toEqual([])
  await trigger.click()
  await confirm.click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Sessions' })).toContainText('No sessions yet.')
  await expect(page.getByRole('button', { name: /^Commands/ })).toBeFocused()
  expect(fixture.sessionDeletes).toEqual(['sample-session'])
  expect(fixture.modelRequests).toEqual([])
  expect(fixture.unexpectedRequests).toEqual([])
  expect(nativeDialogs).toEqual([])
})

test('failed session deletion stays in the confirmation dialog and supports an explicit retry', async ({ page }) => {
  const fixture = await openSample(page)
  fixture.sessionDeleteFailures['sample-session'] = 'Synthetic deletion conflict: session is running.'
  await page.getByRole('button', { name: 'Delete session Refactor authentication', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete session?', exact: true })
  await dialog.getByRole('button', { name: 'Delete session', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Synthetic deletion conflict: session is running.')
  await expect(page.locator('.session-item')).toHaveCount(1)
  await expect(dialog.getByRole('button', { name: 'Delete session', exact: true })).toBeEnabled()
  delete fixture.sessionDeleteFailures['sample-session']
  await dialog.getByRole('button', { name: 'Delete session', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(fixture.sessionDeletes).toEqual(['sample-session', 'sample-session'])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('pending session deletion prevents duplicate submits and cannot be dismissed mid-request', async ({ page }) => {
  const fixture = await openSample(page)
  let finish: () => void = () => { throw new Error('Delete request not waiting') }
  const waiting = new Promise<void>((resolve) => { finish = resolve })
  await page.route('**/api/sessions/sample-session', async (route) => {
    if (route.request().method() === 'DELETE') await waiting
    await route.fallback()
  })
  await page.getByRole('button', { name: 'Delete session Refactor authentication', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete session?', exact: true })
  await dialog.getByRole('button', { name: 'Delete session', exact: true }).click()
  await expect(dialog).toHaveAttribute('aria-busy', 'true')
  await expect(dialog.getByRole('button', { name: 'Working...', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  finish()
  await expect(dialog).not.toBeVisible()
  expect(fixture.sessionDeletes).toEqual(['sample-session'])
})

test('confirmation Escape never cancels a running agent', async ({ page }) => {
  const fixture = await openSample(page)
  await page.getByRole('textbox', { name: 'Message the agent' }).fill('Keep this draft')
  await page.getByRole('button', { name: 'Edit & rerun', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Replace draft?', exact: true })
  fixture.startRun()
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeVisible()
  expect(fixture.modelRequests).toEqual([])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('session list records every creation persona and never follows later dial changes', async ({ page }) => {
  const fixture = await openSample(page)
  const nav = page.getByRole('navigation', { name: 'Sessions' })
  await expect(nav.getByRole('img', { name: 'Created as Prudence default', exact: true }).locator('img')).toHaveAttribute('src', '/prudence-icon.svg')
  for (const persona of personas) {
    await page.locator('.brand-mark').click()
    await page.getByRole('menuitemradio', { name: persona.name, exact: true }).click()
    await page.getByRole('button', { name: 'New session', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'New session', exact: true })).toBeVisible()
    await expect(nav.getByRole('img', { name: `Created as ${persona.name}`, exact: true })).toBeVisible()
    expect(fixture.sessionCreations.at(-1)?.persona_id).toBe(persona.id)
  }
  await page.locator('.brand-mark').click()
  await page.getByRole('menuitemradio', { name: 'Prudence default', exact: true }).click()
  await page.reload()
  for (const persona of personas) {
    const icon = nav.getByRole('img', { name: `Created as ${persona.name}`, exact: true })
    await expect(icon).toHaveCount(1)
    await expect(icon.locator('svg path')).toHaveAttribute('d', persona.symbol)
  }
  await expect(nav.locator('.session-item')).toHaveCount(8)
  for (const width of [1440, 761, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const row of await nav.locator('.session-row').all()) {
      await expectContained(row.locator('.session-persona'), row)
      await expectNoOverlap(row.locator('.session-persona'), row.locator('.session-copy'))
      await expectNoOverlap(row.locator('.session-copy'), row.locator('.session-delete'))
    }
  }
  expect(fixture.modelRequests).toEqual([])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('legacy session icons explicitly identify unrecorded creation personas', async ({ page }) => {
  await openSample(page, false, [], undefined, null)
  const nav = page.getByRole('navigation', { name: 'Sessions' })
  await expect(nav.getByRole('img', { name: 'Creation persona not recorded', exact: true })).toBeVisible()
  await expect(nav.getByRole('img', { name: 'Created as Prudence default', exact: true })).toHaveCount(0)
})

test('Craft picker supports keyboard selection and preserves new-session pairing payloads', async ({ page }) => {
  const fixture = await openSample(page, false, [], pairingProviders())
  const trigger = page.getByRole('button', { name: 'Craft local provider', exact: true })
  await expect(page.getByRole('combobox', { name: 'Craft local provider' })).toHaveCount(0)
  await expect(page.locator('.pairing-state')).toHaveText('Counsel only')
  await trigger.focus()
  await trigger.press('ArrowDown')
  const list = page.getByRole('listbox', { name: 'Craft local provider options' })
  await expect(list).toBeFocused()
  await expect(list.locator('.model-option strong')).toHaveText([
    'Counsel only', 'Phi 3.5 Mini', 'Qwen 2.5 Coder 7B',
  ])
  await page.keyboard.press('End')
  await expect(list).toHaveAttribute('aria-activedescendant', await list.getByRole('option').last().getAttribute('id') ?? '')
  await expect(page.locator('.pairing-state')).toHaveText('Counsel only')
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('p')
  await page.keyboard.press('Enter')
  await expect(trigger).toContainText('Phi 3.5 Mini')
  await expect(trigger.locator('.pairing-model')).toHaveAttribute('title', 'Local Phi 3.5 Mini · phi3.5-mini')
  await expect(trigger).toBeFocused()
  await expect(list).not.toBeVisible()
  await expect(page.locator('.pairing-state')).toHaveText('Paired')
  await expect(page.locator('.pairing-footer')).toContainText('local network')
  await expect(page.getByRole('group', { name: 'Agent mode' })).toBeVisible()
  expect(fixture.sessionCreations).toEqual([])
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Agent mode' })).toHaveCount(0)
  expect(fixture.sessionCreations).toEqual([{
    provider_id: 'sample-foundry', craft_provider_id: 'sample-phi', persona_id: 'default', title: 'New session',
  }])
  await trigger.click()
  await page.getByRole('option', { name: /Counsel only/ }).click()
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Agent mode' })).toBeVisible()
  expect(fixture.sessionCreations[1]).toEqual({
    provider_id: 'sample-foundry', craft_provider_id: null, persona_id: 'default', title: 'New session',
  })
  expect(fixture.unexpectedRequests).toEqual([])
  expect(fixture.modelRequests).toEqual([])
})

test('Craft picker closes with Escape, Tab, and outside clicks without cancelling an active run', async ({ page }) => {
  const fixture = await openSample(page, false, [], pairingProviders())
  const trigger = page.getByRole('button', { name: 'Craft local provider', exact: true })
  const list = page.getByRole('listbox', { name: 'Craft local provider options' })
  fixture.startRun()
  await expect(page.locator('.connection')).toHaveText('Agent working')
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(list).not.toBeVisible()
  await expect(trigger).toBeFocused()
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeVisible()
  await trigger.click()
  await page.keyboard.press('Tab')
  await expect(list).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Manage providers', exact: true })).toBeFocused()
  await trigger.click()
  await page.locator('.provider-heading .eyebrow').click()
  await expect(list).not.toBeVisible()
  await trigger.click()
  await page.getByRole('option', { name: /qwen2.5-coder/ }).click()
  await expect(trigger).toContainText('Qwen 2.5 Coder 7B')
  await expect(page.locator('.pairing-footer')).toContainText('machine')
  expect(fixture.unexpectedRequests).toEqual([])
  expect(fixture.modelRequests).toEqual([])
})

test('Craft picker makes missing local providers explicit', async ({ page }) => {
  const providers = [sampleProvider('sample-foundry', 'Foundry Counsel', 'foundry', 'counsel-reasoning', 'external')]
  const fixture = await openSample(page, false, [], providers)
  const trigger = page.getByRole('button', { name: 'Craft local provider', exact: true })
  await trigger.click()
  await expect(page.getByRole('listbox', { name: 'Craft local provider options' }).getByRole('option')).toHaveCount(1)
  await expect(page.getByText('No local providers configured. Add a provider to enable Craft.')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'New session', exact: true })).toBeVisible()
  expect(fixture.sessionCreations).toEqual([{
    provider_id: 'sample-foundry', craft_provider_id: null, persona_id: 'default', title: 'New session',
  }])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('Craft pairing clears when Counsel changes to a non-Foundry provider', async ({ page }) => {
  const fixture = await openSample(page, false, [], pairingProviders())
  const trigger = page.getByRole('button', { name: 'Craft local provider', exact: true })
  await trigger.click()
  await page.getByRole('option', { name: /qwen2.5/ }).click()
  await selectProvider(page, 'Local Phi 3.5 Mini')
  await expect(page.locator('.model-pairing')).toHaveCount(0)
  await selectProvider(page, 'Foundry Counsel')
  await expect(page.locator('.pairing-state')).toHaveText('Counsel only')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'New session', exact: true })).toBeVisible()
  expect(fixture.sessionCreations).toEqual([{
    provider_id: 'sample-foundry', craft_provider_id: null, persona_id: 'default', title: 'New session',
  }])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('Craft pairing and long model names stay contained without covering provider actions', async ({ page }) => {
  const fixture = await openSample(page, false, [], [
    sampleProvider('sample-foundry', 'Foundry Counsel', 'foundry', 'counsel-reasoning'.repeat(20), 'external'),
    sampleProvider('sample-qwen', 'Local Qwen'.repeat(30), 'local', 'qwen2.5-coder-7b-instruct-cuda-gpu'.repeat(20), 'external'),
  ])
  const pairing = page.locator('.model-pairing')
  const trigger = page.getByRole('button', { name: 'Craft local provider', exact: true })
  await trigger.click()
  await page.getByRole('option', { name: /qwen2.5/ }).click()
  await trigger.click()
  for (const [width, height] of [[1440, 1000], [1024, 700], [761, 600], [760, 700], [390, 800]]) {
    await page.setViewportSize({ width, height })
    await expectContained(trigger, pairing)
    for (const model of await pairing.locator('.pairing-model').all()) await expectContained(model, pairing)
    await expectContained(pairing.locator('.model-options'), pairing)
    for (const option of await pairing.getByRole('option').all()) {
      await expectContained(option, pairing.locator('.model-options'))
      await expectContained(option.locator('strong'), option)
    }
    await expectNoOverlap(trigger, pairing.locator('.model-options'))
    await expectNoOverlap(pairing, page.locator('.provider-manager-trigger'))
    const pairingBounds = await pairing.boundingBox()
    const actionsBounds = await page.locator('.provider-manager-trigger').boundingBox()
    if (!pairingBounds || !actionsBounds) throw new Error('Missing pairing or provider action bounds')
    expect(pairingBounds.y + pairingBounds.height).toBeLessThanOrEqual(actionsBounds.y)
  }
  await expect(pairing.locator('.pairing-footer .pair-boundary')).toHaveText('external')
  await expect(pairing.locator('.pairing-footer .pair-boundary')).toHaveAttribute('title', 'Prompts and tool outputs leave this machine')
  expect(fixture.unexpectedRequests).toEqual([])
})

test('Craft picker scrolls large model lists and supports ArrowUp and Space without early selection', async ({ page }) => {
  const fixture = await openSample(page, false, [], [
    sampleProvider('sample-foundry', 'Foundry Counsel', 'foundry', 'counsel-reasoning', 'external'),
    ...Array.from({ length: 12 }, (_, index) =>
      sampleProvider(`local-${index}`, `Local model ${index}`, 'local', `code-model-${index}`, 'machine'),
    ),
  ])
  const trigger = page.getByRole('button', { name: 'Craft local provider', exact: true })
  await trigger.focus()
  await trigger.press('ArrowUp')
  const list = page.getByRole('listbox', { name: 'Craft local provider options' })
  await list.press('End')
  await expect(list.getByRole('option', { selected: true })).toContainText('Counsel only')
  const bounds = await list.boundingBox()
  if (!bounds) throw new Error('Missing Craft listbox bounds')
  expect(bounds.height).toBeLessThanOrEqual(240)
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expectContained(list.getByRole('option').last(), list)
  await list.press('ArrowUp')
  await list.press(' ')
  await expect(trigger).toContainText('model 10')
  await expect(trigger).toBeFocused()
  await expect(list).not.toBeVisible()
  expect(fixture.sessionCreations).toEqual([])
  expect(fixture.modelRequests).toEqual([])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('main provider picker uses in-app options and preserves provider selection and session payloads', async ({ page }) => {
  const fixture = await openSample(page, false, [], pairingProviders())
  const trigger = page.getByRole('button', { name: 'Active model provider', exact: true })
  await expect(page.getByRole('combobox', { name: 'Active model provider' })).toHaveCount(0)
  await expect(trigger.locator('strong')).toHaveText('Counsel')
  await trigger.focus()
  await trigger.press('ArrowDown')
  const list = page.getByRole('listbox', { name: 'Active model provider options' })
  await expect(list).toBeFocused()
  await expect(list.locator('.model-option strong')).toHaveText([
    'Counsel', 'Phi 3.5 Mini', 'Qwen 2.5 Coder 7B', 'Other Foundry',
  ])
  await expect(list.getByRole('img', { name: 'Microsoft Foundry provider', exact: true })).toHaveCount(2)
  await expect(list.getByRole('img', { name: 'Local provider', exact: true })).toHaveCount(2)
  await list.press('End')
  await list.press('p')
  await expect(trigger.locator('strong')).toHaveText('Counsel')
  await list.press('Enter')
  await expect(trigger.locator('strong')).toHaveText('Phi 3.5 Mini')
  await expect(trigger.locator('small')).toHaveText('phi3.5-mini')
  await expect(trigger.getByRole('img', { name: 'Local provider', exact: true })).toBeVisible()
  await expect(trigger).toBeFocused()
  await expect(list).not.toBeVisible()
  await expect(page.locator('.model-pairing')).toHaveCount(0)
  expect(fixture.sessionCreations).toEqual([])
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'New session', exact: true })).toBeVisible()
  expect(fixture.sessionCreations).toEqual([{
    provider_id: 'sample-phi', craft_provider_id: null, persona_id: 'default', title: 'New session',
  }])
  await selectProvider(page, 'Foundry Counsel')
  await expect(page.locator('.pairing-state')).toHaveText('Counsel only')
  await trigger.click()
  await expect(list.getByRole('option', { name: /Choose a model/ })).toHaveCount(0)
  await list.press('Escape')
  expect(fixture.sessionCreations).toHaveLength(1)
  expect(fixture.unexpectedRequests).toEqual([])
  expect(fixture.modelRequests).toEqual([])
})

test('main provider picker has an explicit empty state without starting a session', async ({ page }) => {
  await openWelcome(page)
  const trigger = page.getByRole('button', { name: 'Active model provider', exact: true })
  await expect(trigger).toContainText('Choose a model')
  await trigger.click()
  const list = page.getByRole('listbox', { name: 'Active model provider options' })
  await expect(list.getByRole('option')).toHaveCount(1)
  await expect(list.getByRole('option')).toContainText('Select a configured provider')
  await list.press('Escape')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.locator('.notice')).toContainText('Create or select a provider first.')
})

test('provider symbols shorten display names without renaming profiles or changing selection contracts', async ({ page }) => {
  const providers = [
    sampleProvider('cloud', 'Microsoft Foundry', 'foundry', 'gpt-5.6-sol', 'external'),
    sampleProvider('phi', 'Foundry Local Phi 3.5 Mini', 'local', 'runtime-a', 'machine'),
    sampleProvider('qwen', 'Foundry Local Qwen 2.5 Coder', 'local', 'runtime-b', 'machine'),
    sampleProvider('custom', 'Studio Foundry', 'foundry', 'runtime-c', 'external'),
    sampleProvider('locality', 'Locality tools', 'local', 'runtime-d', 'local_network'),
  ]
  const fixture = await openSample(page, false, [], providers)
  const trigger = page.getByRole('button', { name: 'Active model provider', exact: true })
  await expect(trigger.locator('strong')).toHaveText('gpt-5.6-sol')
  await expect(trigger.locator('strong')).toHaveAttribute('title', 'Microsoft Foundry')
  await expect(trigger.locator('small')).toHaveCount(0)
  await expect(page.locator('.provider-summary')).toHaveCount(0)
  await trigger.click()
  const list = page.getByRole('listbox', { name: 'Active model provider options' })
  await expect(list.locator('strong')).toHaveText(['gpt-5.6-sol', 'Phi 3.5 Mini', 'Qwen 2.5 Coder', 'Studio Foundry', 'Locality tools'])
  const cloud = list.getByRole('option', { name: /^Microsoft Foundry ·/ })
  const local = list.getByRole('option', { name: /^Foundry Local Phi/ })
  await expect(cloud.locator('.model-option-copy small')).toHaveCount(0)
  const cloudPath = await cloud.locator('.provider-symbol path').getAttribute('d')
  expect(await local.locator('.provider-symbol path').getAttribute('d')).not.toBe(cloudPath)
  await expect(cloud.getByRole('img', { name: 'Microsoft Foundry provider', exact: true })).toBeVisible()
  await expect(local.getByRole('img', { name: 'Local provider', exact: true })).toBeVisible()
  await list.press('End')
  await list.press('p')
  await list.press('Enter')
  await expect(trigger.locator('strong')).toHaveText('Phi 3.5 Mini')
  await page.getByRole('button', { name: 'Manage providers', exact: true }).click()
  const manager = page.getByRole('dialog', { name: 'Provider manager', exact: true })
  await expect(manager.getByRole('heading', { name: 'Phi 3.5 Mini', exact: true })).toBeVisible()
  await manager.getByRole('button', { name: 'Edit provider', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Profile name', exact: true })).toHaveValue('Foundry Local Phi 3.5 Mini')
  expect(fixture.providerRequests).toEqual([])
  expect(fixture.modelRequests).toEqual([])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('side panels collapse independently and preserve drafts, activity, and inspection state', async ({ page }) => {
  const fixture = await openSample(page, false, mixedOutputs())
  const composer = page.getByRole('textbox', { name: 'Message the agent' })
  await composer.fill('Keep this draft while focusing the workspace')
  await page.getByText('Inspect files', { exact: true }).click()
  const main = page.locator('main')
  const original = await main.boundingBox()
  if (!original) throw new Error('Missing initial workspace bounds')
  fixture.startRun()
  await expect(page.locator('.connection')).toHaveText('Agent working')
  await expect(page.locator('.topbar').getByRole('button', { name: /sidebar|pane/i })).toHaveCount(0)
  await page.keyboard.press('Alt+v')
  await expect(page.locator('.sidebar')).toBeHidden()
  await expect(page.locator('.context-panel')).toBeVisible()
  const leftCollapsed = await main.boundingBox()
  if (!leftCollapsed) throw new Error('Missing left-collapsed workspace bounds')
  expect(leftCollapsed.width - original.width).toBeCloseTo(252, 0)
  await page.keyboard.press('Control+Alt+v')
  await expect(page.locator('.context-panel')).toBeHidden()
  const bothCollapsed = await main.boundingBox()
  if (!bothCollapsed) throw new Error('Missing full workspace bounds')
  expect(bothCollapsed.x).toBe(0)
  expect(bothCollapsed.width - leftCollapsed.width).toBeCloseTo(320, 0)
  await expect(composer).toHaveValue('Keep this draft while focusing the workspace')
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeVisible()
  await page.keyboard.press('Alt+v')
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(page.locator('.context-panel')).toBeHidden()
  await page.keyboard.press('Control+Alt+v')
  await expect(page.locator('.context-panel')).toBeVisible()
  await expect(page.locator('.output-inspection')).toHaveAttribute('open', '')
  const restored = await main.boundingBox()
  expect(restored).toEqual(original)
  expect(fixture.modelRequests).toEqual([])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('panel commands remain reachable in stacked layouts and respect settings availability', async ({ page }) => {
  const fixture = await openSample(page)
  for (const viewport of [{ width: 1024, height: 700 }, { width: 390, height: 800 }]) {
    await page.setViewportSize(viewport)
    await page.keyboard.press('Alt+v')
    await page.keyboard.press('Control+Alt+v')
    await expect(page.locator('.sidebar')).toBeHidden()
    await expect(page.locator('.context-panel')).toBeHidden()
    const main = await page.locator('main').boundingBox()
    if (!main) throw new Error('Missing collapsed workspace')
    expect(main.x).toBe(0)
    expect(main.width).toBeCloseTo(viewport.width, 0)
    await page.getByRole('button', { name: 'Session settings', exact: true }).click()
    await page.keyboard.press('Control+k')
    const commands = page.getByRole('dialog', { name: 'Workspace commands' })
    await expect(commands.getByRole('button', { name: /^Expand right pane/ })).toBeDisabled()
    await expect(commands.getByRole('button', { name: /^Expand left sidebar/ })).toBeEnabled()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Alt+v')
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click()
    await expect(page.locator('.context-panel')).toBeHidden()
    await page.keyboard.press('Control+Alt+v')
    await page.keyboard.press('Alt+v')
    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(page.locator('.context-panel')).toBeVisible()
  }
  expect(fixture.unexpectedRequests).toEqual([])
  expect(fixture.modelRequests).toEqual([])
})

test('collapsing side panels does not hide approvals or bypass prompt gates', async ({ page }) => {
  const fixture = await openSample(page, true)
  await page.keyboard.press('Alt+v')
  await page.keyboard.press('Control+Alt+v')
  await expect(page.getByRole('heading', { name: 'Proposed changes' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message the agent' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Run again', exact: true })).toBeDisabled()
  expect(fixture.decisions).toEqual([])
  expect(fixture.modelRequests).toEqual([])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('command palette exposes pane shortcuts and restores focus when a prior control becomes hidden', async ({ page }) => {
  const fixture = await openSample(page)
  await page.getByRole('button', { name: 'Active model provider', exact: true }).focus()
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Workspace commands' })
  const left = palette.getByRole('button', { name: /^Collapse left sidebar/ })
  const right = palette.getByRole('button', { name: /^Collapse right pane/ })
  await expect(left.locator('kbd')).toHaveText('Alt+V')
  await expect(right.locator('kbd')).toHaveText('Ctrl+Alt+V')
  await expect(left).toHaveAttribute('aria-keyshortcuts', 'Alt+V')
  await expect(right).toHaveAttribute('aria-keyshortcuts', 'Control+Alt+V')
  await left.click()
  await expect(page.locator('.sidebar')).toBeHidden()
  await expect(palette).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Commands/ })).toBeFocused()
  await page.keyboard.press('Control+k')
  await expect(palette.getByRole('button', { name: /^Expand left sidebar/ })).toBeEnabled()
  await page.getByRole('textbox', { name: 'Search workspace commands' }).fill('right pane')
  await page.keyboard.press('Enter')
  await expect(page.locator('.context-panel')).toBeHidden()
  await expect(page.locator('.sidebar')).toBeHidden()
  await expect(palette).toHaveCount(0)
  await page.keyboard.press('Control+k')
  await palette.getByRole('button', { name: /^Expand right pane/ }).click()
  await expect(page.locator('.context-panel')).toBeVisible()
  await expect(page.locator('.sidebar')).toBeHidden()
  await page.keyboard.press('Control+k')
  await palette.getByRole('button', { name: /^Expand left sidebar/ }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
  expect(fixture.modelRequests).toEqual([])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('pane shortcuts work from text fields, ignore repeats and AltGraph, and stay isolated from provider management', async ({ page }) => {
  const fixture = await openSample(page, false, mixedOutputs())
  const composer = page.getByRole('textbox', { name: 'Message the agent' })
  await composer.fill('Keep the input untouched')
  await composer.focus()
  await page.keyboard.press('Control+Alt+v')
  await expect(page.locator('.context-panel')).toBeHidden()
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(composer).toHaveValue('Keep the input untouched')
  await page.keyboard.press('Control+Alt+v')
  await page.keyboard.down('Alt')
  try {
    await page.keyboard.down('v')
    await page.keyboard.down('v')
    await page.keyboard.down('v')
  } finally {
    await page.keyboard.up('v')
    await page.keyboard.up('Alt')
  }
  await expect(page.locator('.sidebar')).toBeHidden()
  await page.keyboard.press('Alt+v')
  await page.evaluate(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'v', altKey: true, ctrlKey: true, modifierAltGraph: true, bubbles: true, cancelable: true,
  })))
  await expect(page.locator('.context-panel')).toBeVisible()
  await page.getByText('Inspect files', { exact: true }).click()
  await page.getByRole('textbox', { name: 'Search artifacts', exact: true }).focus()
  await page.keyboard.press('Control+Alt+v')
  await expect(page.locator('.context-panel')).toBeHidden()
  await expect(page.getByRole('button', { name: /^Commands/ })).toBeFocused()
  await page.keyboard.press('Control+Alt+v')
  await page.getByRole('button', { name: 'Manage providers', exact: true }).click()
  await page.keyboard.press('Alt+v')
  await page.keyboard.press('Control+Alt+v')
  await expect(page.getByRole('dialog', { name: 'Provider manager', exact: true })).toBeVisible()
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(page.locator('.context-panel')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(composer).toHaveValue('Keep the input untouched')
  expect(fixture.modelRequests).toEqual([])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('pane commands are available before a session and shortcuts dismiss the palette safely', async ({ page }) => {
  await openWelcome(page)
  await page.keyboard.press('Alt+v')
  await expect(page.locator('.sidebar')).toBeHidden()
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Workspace commands' })
  await expect(palette.getByRole('button', { name: /^Collapse right pane/ })).toBeDisabled()
  await expect(palette.getByRole('button', { name: /^Expand left sidebar/ })).toBeEnabled()
  await page.keyboard.press('Alt+v')
  await expect(palette).toHaveCount(0)
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Commands/ })).toBeFocused()
  await page.keyboard.press('Control+Alt+v')
  await expect(page.locator('.context-panel')).toHaveCount(0)
  await expect(page.locator('.sidebar')).toBeVisible()
})

test('main provider picker dismisses safely and contains long names without covering adjacent controls', async ({ page }) => {
  const fixture = await openSample(page, false, [], [
    sampleProvider('sample-foundry', 'Foundry Counsel', 'foundry', 'counsel-reasoning', 'external'),
    sampleProvider('sample-local', 'Local coding model'.repeat(20), 'local', 'code-model-'.repeat(30), 'machine'),
  ])
  const trigger = page.getByRole('button', { name: 'Active model provider', exact: true })
  const picker = page.locator('.provider-panel > .model-picker')
  const list = page.getByRole('listbox', { name: 'Active model provider options' })
  fixture.startRun()
  await expect(page.locator('.connection')).toHaveText('Agent working')
  await trigger.click()
  await list.press('Escape')
  await expect(list).not.toBeVisible()
  await expect(trigger).toBeFocused()
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeVisible()
  await trigger.click()
  await list.press('Tab')
  await expect(list).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Craft local provider', exact: true })).toBeFocused()
  await trigger.click()
  for (const [width, height] of [[1440, 1000], [1024, 700], [761, 600], [760, 700], [390, 800]]) {
    await page.setViewportSize({ width, height })
    await expectContained(trigger, picker)
    await expectContained(trigger.locator('strong'), trigger)
    await expectContained(picker.locator('.model-options'), picker)
    for (const option of await list.getByRole('option').all()) {
      await expectContained(option.locator('strong'), option)
      await expectContained(option.locator('small'), option)
    }
    await expectNoOverlap(trigger, picker.locator('.model-options'))
    await expectNoOverlap(picker, page.locator('.provider-panel > .data-boundary'))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  await page.locator('.provider-heading .eyebrow').click()
  await expect(list).not.toBeVisible()
  expect(fixture.unexpectedRequests).toEqual([])
  expect(fixture.modelRequests).toEqual([])
})

test('output summary counts current files, formats, source languages, bytes, and available versions', async ({ page }) => {
  const fixture = await openSample(page, false, mixedOutputs())
  const section = page.locator('#artifacts-section')
  await expect(section.locator('.output-metrics dd')).toHaveText(['6', '3.9 KiB', '7'])
  await expect(section.locator('.output-breakdown h3')).toHaveText(['Programming languages', 'File types'])
  const languageBounds = await section.locator('.output-breakdown').first().boundingBox()
  const typeBounds = await section.locator('.output-breakdown').nth(1).boundingBox()
  if (!languageBounds || !typeBounds) throw new Error('Missing output breakdown bounds')
  expect(languageBounds.y + languageBounds.height).toBeLessThanOrEqual(typeBounds.y)
  await expect(section.locator('.output-breakdown').nth(1).locator('dt')).toHaveText([
    '.cs', '.json', '.md', '.ts', '.tsx', 'No extension',
  ])
  await expect(section.locator('.output-breakdown').nth(1).locator('dd')).toHaveText(Array(6).fill('1 file'))
  await expect(section.locator('.output-breakdown').first().locator('dt')).toHaveText(['TypeScript', 'C#'])
  await expect(section.locator('.output-breakdown').first().locator('dd')).toHaveText(['2 files', '1 file'])
  await expect(section.getByText('Session helper', { exact: true })).not.toBeVisible()
  await expect(section.getByRole('textbox', { name: 'Search artifacts' })).not.toBeVisible()
  await expect(section.locator('.artifact-preview')).toHaveCount(0)
  await expect(section.locator('.output-inspection')).not.toHaveAttribute('open')
  expect(fixture.artifactReads).toEqual([])
  expect(fixture.modelRequests).toEqual([])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('inspection preserves search, previews, version downloads, and unfiltered statistics', async ({ page }) => {
  const fixture = await openSample(page, false, mixedOutputs())
  const section = page.locator('#artifacts-section')
  const disclosure = section.locator('.output-inspection > summary')
  await disclosure.focus()
  await disclosure.press('Enter')
  const search = section.getByRole('textbox', { name: 'Search artifacts' })
  await expect(search).toBeVisible()
  await search.fill('session.ts')
  await expect(section.locator('.artifact-list button')).toHaveCount(1)
  await expect(section.locator('.output-metrics dd')).toHaveText(['6', '3.9 KiB', '7'])
  await section.getByRole('button', { name: /Session helper.*v2/ }).click()
  await expect(section.locator('.artifact-preview pre')).toContainText('Synthetic preview session-helper v2')
  await expect(section.getByRole('link', { name: 'Download v2' })).toHaveAttribute(
    'href', '/api/sessions/sample-session/artifacts/session-helper/download?version=2',
  )
  await section.getByRole('button', { name: 'v1', exact: true }).click()
  await expect(section.locator('.artifact-preview pre')).toContainText('Synthetic preview session-helper v1')
  await expect(section.getByRole('link', { name: 'Download v1' })).toHaveAttribute(
    'href', '/api/sessions/sample-session/artifacts/session-helper/download?version=1',
  )
  await expect(section.locator('.output-metrics dd')).toHaveText(['6', '3.9 KiB', '7'])
  await search.fill('no match')
  await expect(section.getByText('No matching artifacts.')).toBeVisible()
  await disclosure.click()
  await expect(section.locator('.artifact-preview')).not.toBeVisible()
  expect(fixture.artifactReads).toEqual([
    '/api/sessions/sample-session/artifacts/session-helper',
    '/api/sessions/sample-session/artifacts/session-helper?version=1',
  ])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('output summary accounts for unavailable metadata without inferring code from titles or history', async ({ page }) => {
  const outputs = [
    { ...sampleArtifact('config', 'configs\\package.JSON'), title: 'settings.py' },
    { ...sampleArtifact('project', 'Server.csproj'), title: 'Server.cs' },
    sampleArtifact('environment', '.env.production'),
    { ...sampleArtifact('missing', 'missing.ts'), versions: [] },
    { ...sampleArtifact('history', 'old/code.py', 4096), current_version: 5 },
  ]
  const fixture = await openSample(page, false, outputs)
  const section = page.locator('#artifacts-section')
  await expect(section.locator('.output-metrics dd')).toHaveText(['5', '0 B', '4'])
  await expect(section.locator('.output-metrics dt')).toHaveText(['Indexed files', 'Known size', 'Available versions'])
  await expect(section.locator('.output-breakdown').nth(1).locator('dt')).toHaveText(['Unknown', '.csproj', '.env', '.json'])
  await expect(section.locator('.output-breakdown').nth(1).locator('dd')).toHaveText(['2 files', '1 file', '1 file', '1 file'])
  await expect(section.getByText('No programming-language filenames identified.')).toBeVisible()
  await expect(section.getByText('Size reported for 3 of 5 files.')).toBeVisible()
  await expect(section.getByText('Current-file metadata is missing for 2 outputs.')).toBeVisible()
  expect(fixture.artifactReads).toEqual([])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('output summary distinguishes invalid sizes from empty output', async ({ page }) => {
  await openSample(page, false, [sampleArtifact('invalid-size', 'main.ts', -1)])
  const section = page.locator('#artifacts-section')
  await expect(section.locator('.output-metrics dd')).toHaveText(['1', 'Not reported', '1'])
  await expect(section.getByText('Size reported for 0 of 1 file.')).toBeVisible()
})

test('empty output summary has explicit zero counts and no file browser', async ({ page }) => {
  await openSample(page)
  const section = page.locator('#artifacts-section')
  await expect(section.locator('.output-metrics dd')).toHaveText(['0', '0 B', '0'])
  await expect(section.getByText('Generated files and notes will be summarized here once indexed.')).toBeVisible()
  await expect(section.locator('.output-inspection')).toHaveCount(0)
})

test('output summary refreshes after a run records new files', async ({ page }) => {
  const outputs = [sampleArtifact('note', 'plan.md', 128)]
  const fixture = await openSample(page, false, outputs)
  const section = page.locator('#artifacts-section')
  await expect(section.locator('.output-metrics dd')).toHaveText(['1', '128 B', '1'])
  fixture.startRun()
  outputs.push(sampleArtifact('implementation', 'src/session.ts', 1024))
  fixture.sendActivity('run_completed', {})
  await expect(section.locator('.output-metrics dd')).toHaveText(['2', '1.1 KiB', '2'])
  await expect(section.locator('.output-breakdown').first().locator('dt')).toHaveText(['TypeScript'])
  expect(fixture.artifactReads).toEqual([])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('output statistics and optional long-file previews stay within the inspector', async ({ page }) => {
  const longName = `${'nested/'.repeat(12)}${'long-file-name-'.repeat(20)}.ts`
  const fixture = await openSample(page, false, [sampleArtifact('long-file', longName, 1024)])
  const section = page.locator('#artifacts-section')
  await section.locator('.output-inspection > summary').click()
  await section.locator('.artifact-list button').click()
  for (const [width, height] of [[1440, 1000], [1024, 700], [761, 600], [760, 700], [390, 800]]) {
    await page.setViewportSize({ width, height })
    await expectContained(section.locator('.output-metrics'), section)
    await expectContained(section.locator('.artifact-list button'), section)
    await expectContained(section.locator('.artifact-list button span'), section.locator('.artifact-list button'))
    await expectContained(section.locator('.artifact-preview strong'), section.locator('.artifact-preview'))
    await expectContained(section.locator('.artifact-preview a'), section.locator('.artifact-preview'))
    await expectContained(section.locator('.artifact-preview pre'), section.locator('.artifact-preview'))
    await expectNoOverlap(section.locator('.artifact-preview strong'), section.locator('.artifact-preview a'))
    await expectNoOverlap(section.locator('.artifact-preview'), section.locator('.artifact-list'))
  }
  expect(fixture.unexpectedRequests).toEqual([])
})

test('run-error notices never overlap the composer, footer, or activity panel', async ({ page }) => {
  const fixture = await openSample(page)
  fixture.sendActivity('run_failed', sampleFailure)
  fixture.sendError('The run failed. See the activity panel for details.')
  const notice = page.locator('.notice')
  await expect(notice).toBeVisible()
  for (const [width, height] of [[1440, 1000], [1024, 700], [820, 600], [761, 600], [760, 700], [390, 800]]) {
    await page.setViewportSize({ width, height })
    await expectContained(notice, page.locator('main'))
    await expectNoOverlap(notice, page.locator('.composer'))
    await expectNoOverlap(notice, page.locator('.framework-credit'))
    await expectNoOverlap(notice, page.locator('.context-panel'))
    await expect(page.getByRole('button', { name: 'Dismiss notification' })).toBeVisible()
  }
  await page.getByRole('textbox', { name: 'Message the agent' }).fill('A follow-up prompt')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect.poll(() => fixture.modelRequests.length).toBe(1)
  await expect(notice).not.toBeVisible()
})

test('composer and header controls stay inside their regions without intersecting', async ({ page }) => {
  await openSample(page)
  for (const [width, height] of [[1440, 1000], [1024, 700], [900, 700], [820, 600], [761, 600], [390, 800]]) {
    await page.setViewportSize({ width, height })
    const controls = [...await page.locator('.write-access-toggle').all(), page.locator('.send')]
    for (const control of controls) await expectContained(control, page.locator('.composer'))
    for (let index = 0; index < controls.length; index++) {
      for (const other of controls.slice(index + 1)) await expectNoOverlap(controls[index], other)
    }
    const headerItems = await page.locator('.topbar > *').all()
    for (const item of headerItems) await expectContained(item, page.locator('.topbar'))
    for (let index = 0; index < headerItems.length; index++) {
      for (const other of headerItems.slice(index + 1)) await expectNoOverlap(headerItems[index], other)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
})

test('settings and provider inputs remain within their cards at narrow widths', async ({ page }) => {
  await openSample(page)
  await page.getByRole('button', { name: 'Session settings', exact: true }).click()
  for (const width of [1024, 820, 390]) {
    await page.setViewportSize({ width, height: 700 })
    await expectContained(page.locator('.instruction-form textarea'), page.locator('.instruction-form label'))
    await expectContained(page.locator('.session-name-form input'), page.locator('.session-name-form'))
  }
  await page.locator('.provider-add').click()
  for (const width of [1024, 820, 390]) {
    await page.setViewportSize({ width, height: 700 })
    for (const input of await page.locator('.setup-card input').all()) {
      await expectContained(input, input.locator('..'))
    }
  }
})

test('long notices and approvals remain separate in short desktop viewports', async ({ page }) => {
  const fixture = await openSample(page, true)
  await page.setViewportSize({ width: 1024, height: 420 })
  fixture.sendError(`Provider error: ${'long-diagnostic-'.repeat(150)}`)
  await expect(page.locator('.notice')).toBeVisible()
  await expectContained(page.locator('.notice'), page.locator('main'))
  await expectContained(page.locator('.framework-credit'), page.locator('main'))
  await expectNoOverlap(page.locator('.notice'), page.locator('.approval-tray'))
  await expectNoOverlap(page.locator('.notice'), page.locator('.composer'))
  await page.getByRole('button', { name: 'Dismiss notification' }).click()
  await expect(page.locator('.notice')).not.toBeVisible()
})

const sampleFailure = {
  message: 'The agent run failed. Review the diagnostic detail before trying again.',
  detail: "The model service failed to complete the prompt: APIConnectionError('Connection error.').",
  category: 'internal',
  status_code: null,
  transient: false,
  retryable: false,
}

test('activity presents failures without reclassifying them or exposing JSON by default', async ({ page }) => {
  const fixture = await openSample(page)
  fixture.sendActivity('run_failed', sampleFailure)
  const activity = page.locator('#activity-section')
  await expect(activity.getByRole('heading', { name: 'Run failed', exact: true })).toBeVisible()
  await expect(activity.locator('.activity-item')).toHaveClass(/danger/)
  await expect(activity.locator('.activity-item')).toHaveCSS('border-top-width', '0px')
  await expect(activity).toContainText(sampleFailure.message)
  await expect(activity).toContainText('internal')
  await expect(activity).toContainText('Manual rerun only')
  await expect(activity).not.toContainText('Check that the model provider is running')
  await expect(activity.locator('pre').first()).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry last run' })).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Run again', exact: true })).toBeEnabled()
  await activity.getByText('Technical details', { exact: true }).click()
  await expect(activity.locator('pre').first()).toHaveText(sampleFailure.detail)
  await activity.getByText('Raw event payload', { exact: true }).click()
  await expect(activity.locator('.activity-raw pre')).toContainText('"retryable": false')
  expect(fixture.modelRequests).toEqual([])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('activity parses tool errors, zero token counts, delegation, and unknown events', async ({ page }) => {
  const fixture = await openSample(page)
  fixture.sendActivity('tool_result', { name: 'read_file', call_id: 'sample-call', exception: 'File not found', result: null })
  fixture.sendActivity('context_usage', { input_tokens: 0, output_tokens: 15, context_percent: 0 })
  fixture.sendActivity('subagent_failed', { name: 'review', error: 'Review timed out', duration_ms: 2500, tool_calls: 0 })
  fixture.sendActivity('custom_event', { unexpected: true })
  const activity = page.locator('#activity-section')
  await expect(activity.locator('.activity-item')).toHaveCount(4)
  await expect(activity.getByRole('heading', { name: 'Tool failed: read file' })).toBeVisible()
  await expect(activity.locator('.activity-item').filter({ hasText: 'Tool failed: read file' })).toHaveClass(/danger/)
  const usage = activity.locator('.activity-item').filter({ hasText: 'Context usage updated' })
  await expect(usage.locator('dd')).toHaveText(['0', '15', '0%'])
  const delegation = activity.locator('.activity-item').filter({ hasText: 'Subagent failed: review' })
  await expect(delegation).toHaveClass(/danger/)
  await expect(delegation.locator('dd')).toHaveText(['2,500 ms', '0'])
  await expect(activity.locator('.activity-item').first()).toContainText('no readable summary yet')
  await expect(activity.locator('.activity-raw pre').first()).not.toBeVisible()
})

test('activity makes the latest-twelve limit explicit', async ({ page }) => {
  const fixture = await openSample(page)
  for (let index = 0; index < 13; index++) fixture.sendActivity(`sample_event_${index}`, {})
  const activity = page.locator('#activity-section')
  await expect(activity.locator('.activity-item')).toHaveCount(12)
  await expect(activity.locator('.activity-count')).toHaveText('Latest 12 of 13 events · Newest first')
  await expect(activity.locator('.activity-item h3').first()).toHaveText('sample event 12')
})

test('running a previous prompt sends it once and preserves an unrelated draft', async ({ page }) => {
  const fixture = await openSample(page)
  const original = await page.locator('.message.user p').first().innerText()
  const composer = page.getByRole('textbox', { name: 'Message the agent' })
  await composer.fill('A draft for later')
  await page.getByRole('button', { name: 'Run again', exact: true }).click()
  await expect.poll(() => fixture.modelRequests.length).toBe(1)
  expect(JSON.parse(fixture.modelRequests[0])).toEqual({ type: 'prompt', content: original })
  await expect(composer).toHaveValue('A draft for later')
  await expect(page.getByRole('button', { name: 'Run again', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Edit & rerun', exact: true })).toBeDisabled()
  fixture.sendActivity('run_completed', {})
  await expect(page.getByRole('button', { name: 'Run again', exact: true })).toBeEnabled()
  expect(fixture.modelRequests).toHaveLength(1)
})

test('edit and rerun protects drafts and waits for explicit submission', async ({ page }) => {
  const fixture = await openSample(page)
  const original = await page.locator('.message.user p').first().innerText()
  const composer = page.getByRole('textbox', { name: 'Message the agent' })
  await composer.fill('Keep this draft')
  await page.getByRole('button', { name: 'Edit & rerun', exact: true }).click()
  await page.getByRole('alertdialog', { name: 'Replace draft?' }).getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(composer).toHaveValue('Keep this draft')
  await page.getByRole('button', { name: 'Edit & rerun', exact: true }).click()
  await page.getByRole('alertdialog', { name: 'Replace draft?' }).getByRole('button', { name: 'Replace draft', exact: true }).click()
  await expect(composer).toHaveValue(original)
  await expect(composer).toBeFocused()
  expect(fixture.modelRequests).toEqual([])
  await composer.fill('A revised prompt')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect.poll(() => fixture.modelRequests.length).toBe(1)
  expect(JSON.parse(fixture.modelRequests[0])).toEqual({ type: 'prompt', content: 'A revised prompt' })
})

test('rerun controls do not bypass running or pending-approval gates', async ({ page }) => {
  const fixture = await openSample(page, true)
  await expect(page.getByRole('button', { name: 'Run again', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Edit & rerun', exact: true })).toBeDisabled()
  expect(fixture.modelRequests).toEqual([])
})

test('welcome attribution is centered at the workspace bottom', async ({ page }) => {
  await openWelcome(page)
  const footer = page.getByText('Powered by Microsoft Agent Framework', { exact: true })
  await expect(footer).toBeVisible()
  const bounds = await footer.boundingBox()
  const main = await page.locator('main').boundingBox()
  if (!bounds || !main) throw new Error('Missing workspace or attribution bounds')
  expect(bounds.y).toBeGreaterThan(950)
  expect(bounds.x + bounds.width / 2).toBeCloseTo(main.x + main.width / 2, 0)
  await expect(page.locator('.empty-state')).not.toContainText('Microsoft Agent Framework')
})

test('light workspace preserves mode controls and keyboard navigation', async ({ page }) => {
  const fixture = await openSample(page)
  await expect(page.getByRole('button', { name: 'Plan', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Execute', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Execute', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Execute', exact: true })).toBeEnabled()
  const commands = page.getByRole('button', { name: /^Commands/ })
  await commands.focus()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await expect(commands).toBeFocused()
  await page.keyboard.press('/')
  await expect(page.getByRole('textbox', { name: 'Message the agent' })).toBeFocused()
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(238, 232, 223)')
  expect(fixture.unexpectedRequests).toEqual([])
  expect(fixture.modelRequests).toEqual([])
})

test('pending approvals keep prompt submission gated', async ({ page }) => {
  const fixture = await openSample(page, true)
  await expect(page.getByRole('textbox', { name: 'Message the agent' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled()
  await expect(page.getByRole('heading', { name: 'Proposed changes' })).toBeVisible()
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Message the agent' })).toBeEnabled()
  expect(fixture.decisions).toEqual([{ approved: true }])
  expect(fixture.unexpectedRequests).toEqual([])
  expect(fixture.modelRequests).toEqual([])
})

test('settings and provider forms retain their controls', async ({ page }) => {
  const fixture = await openSample(page)
  await page.getByRole('button', { name: 'Session settings', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Session instructions' })).toBeVisible()
  await expect(page.getByText('Powered by Microsoft Agent Framework', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Back to chat' }).click()
  await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible()
  await page.getByRole('button', { name: 'Manage providers', exact: true }).click()
  await page.getByRole('button', { name: 'Edit provider', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Edit model provider' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Provider manager', exact: true })).toHaveCount(0)
  expect(fixture.unexpectedRequests).toEqual([])
})

test('provider management traps focus and dismisses without stopping a run', async ({ page }) => {
  const fixture = await openSample(page)
  const summary = page.getByRole('button', { name: 'Manage providers', exact: true })
  await summary.focus()
  await page.keyboard.press('Enter')
  const actions = page.locator('.provider-actions button')
  await expect(actions).toHaveCount(5)
  let previousBottom = 0
  for (const action of await actions.all()) {
    const bounds = await action.boundingBox()
    if (!bounds) throw new Error('Missing provider action bounds')
    expect(bounds.y).toBeGreaterThanOrEqual(previousBottom)
    previousBottom = bounds.y + bounds.height
    await expect(action).toHaveCSS('border-top-width', '0px')
  }
  const close = page.getByRole('button', { name: 'Close provider manager' })
  await expect(close).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByRole('button', { name: 'Delete provider', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Provider manager', exact: true })).toHaveCount(0)
  await expect(summary).toBeFocused()
  fixture.startRun()
  await expect(page.locator('.connection')).toHaveText('Agent working')
  await summary.click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Provider manager', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeVisible()
  expect(fixture.unexpectedRequests).toEqual([])
})

test('provider manager is centered and never changes sidebar size or scrollbar geometry', async ({ page }) => {
  const fixture = await openSample(page, false, [], pairingProviders())
  const trigger = page.getByRole('button', { name: 'Manage providers', exact: true })
  const dialog = page.getByRole('dialog', { name: 'Provider manager', exact: true })
  for (const [width, height] of [[1440, 1000], [1024, 700], [390, 800]]) {
    await page.setViewportSize({ width, height })
    await trigger.scrollIntoViewIfNeeded()
    const snapshot = () => page.evaluate(() => ['.sidebar', '.provider-panel', '.provider-selector', '.provider-manager-trigger'].map((selector) => {
      const element = document.querySelector(selector)
      if (!element) throw new Error(`Missing sidebar geometry target: ${selector}`)
      const rect = element.getBoundingClientRect()
      return { selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop }
    }))
    const before = await snapshot()
    await trigger.click()
    await expect(dialog).toBeVisible()
    expect(await snapshot()).toEqual(before)
    const bounds = await dialog.boundingBox()
    if (!bounds) throw new Error('Missing provider manager bounds')
    expect(bounds.x + bounds.width / 2).toBeCloseTo(width / 2, 0)
    expect(bounds.y + bounds.height / 2).toBeCloseTo(height / 2, 0)
    expect(bounds.width).toBeLessThanOrEqual(Math.min(680, width - 32))
    expect(bounds.height).toBeLessThanOrEqual(height * 0.7 + 1)
    await expectContained(dialog.locator('.provider-manager-body'), dialog)
    await page.mouse.click(5, 5)
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(await snapshot()).toEqual(before)
  }
  await expect(page.locator('.sidebar')).toHaveCSS('scrollbar-gutter', 'stable')
  expect(fixture.unexpectedRequests).toEqual([])
})

test('provider manager tests the inspected profile and surfaces failure without switching models', async ({ page }) => {
  const fixture = await openSample(page, false, [], pairingProviders())
  fixture.histories['sample-foundry'] = [sampleProbe('sample-foundry')]
  fixture.probeFailures['sample-qwen'] = 'Synthetic authentication failed'
  expect(fixture.historyReads).toEqual([])
  await page.getByRole('button', { name: 'Manage providers', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Provider manager', exact: true })
  await expect(dialog.getByText('Passed', { exact: true })).toBeVisible()
  await dialog.locator('.provider-manager-list').getByRole('button', { name: /Local Qwen/ }).click()
  await expect(dialog.getByRole('heading', { name: 'Qwen 2.5 Coder 7B' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Test connection', exact: true })).toBeEnabled()
  await expect(page.locator('.provider-selector strong')).toHaveText('Counsel')
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('Synthetic authentication failed')
  await expect(dialog.getByText('Failed', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('status')).not.toContainText('succeeded')
  expect(fixture.providerRequests).toEqual(['POST sample-qwen'])
  await expect(page.locator('.sidebar .probe-history')).toHaveCount(0)
  expect(fixture.modelRequests).toEqual([])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('editing and deleting other managed profiles preserve the selected model', async ({ page }) => {
  const fixture = await openSample(page, false, [], pairingProviders())
  await selectProvider(page, 'Local Phi 3.5 Mini')
  const trigger = page.getByRole('button', { name: 'Manage providers', exact: true })
  await trigger.click()
  let dialog = page.getByRole('dialog', { name: 'Provider manager', exact: true })
  await dialog.locator('.provider-manager-list').getByRole('button', { name: /Local Qwen/ }).click()
  await dialog.getByRole('button', { name: 'Edit provider', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Profile name' }).fill('Renamed Qwen profile')
  await page.getByRole('button', { name: 'Save profile', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Edit model provider' })).toHaveCount(0)
  await expect(page.locator('.provider-selector strong')).toHaveText('Phi 3.5 Mini')
  await trigger.click()
  dialog = page.getByRole('dialog', { name: 'Provider manager', exact: true })
  await dialog.locator('.provider-manager-list').getByRole('button', { name: /Renamed Qwen profile/ }).click()
  await dialog.getByRole('button', { name: 'Delete provider', exact: true }).click()
  await page.getByRole('alertdialog', { name: 'Delete provider?' }).getByRole('button', { name: 'Delete provider', exact: true }).click()
  await expect(page.locator('.notice')).toContainText('Provider profile deleted.')
  await expect(page.locator('.provider-selector strong')).toHaveText('Phi 3.5 Mini')
  expect(fixture.providerRequests).toEqual(['PUT sample-qwen', 'DELETE sample-qwen'])
  expect(fixture.unexpectedRequests).toEqual([])
})

test('provider manager does not present failed history loads as empty history', async ({ page }) => {
  const fixture = await openSample(page)
  fixture.historyFailures['sample-local'] = 'Synthetic history unavailable'
  await page.getByRole('button', { name: 'Manage providers', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Provider manager', exact: true })
  await expect(dialog.locator('.probe-history')).toContainText('Synthetic history unavailable')
  await expect(dialog.getByRole('status')).toContainText('Synthetic history unavailable')
  await expect(dialog.getByText('No recorded connection tests.')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Close provider manager' }).click()
  await expect(page.locator('.notice')).toContainText('Synthetic history unavailable')
  expect(fixture.unexpectedRequests).toEqual([])
})

test('empty provider state exposes add and import without enabling invalid actions', async ({ page }) => {
  await openWelcome(page)
  await expect(page.locator('.provider-add')).toBeEnabled()
  await page.getByRole('button', { name: 'Manage providers', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Test connection' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Edit provider' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Export configuration' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Delete provider', exact: true })).toBeDisabled()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import configuration', exact: true }).click()
  await chooser
  await expect(page.getByRole('dialog', { name: 'Provider manager', exact: true })).toHaveCount(0)
  await page.locator('.provider-add').click()
  await expect(page.getByRole('heading', { name: 'Add a model provider' })).toBeVisible()
})

test('light theme and readable layout survive system dark mode and narrow widths', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await openSample(page)
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light')
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect(page.getByRole('button', { name: 'Plan', exact: true })).toBeVisible()
  }
})

test('primary actions and normal text meet WCAG AA contrast', async ({ page }) => {
  await openSample(page, true)
  const ratios = await page.evaluate(() => {
    const luminance = (color: string) => {
      const channels = color.match(/\d+/g)
      if (!channels || channels.length < 3) throw new Error(`Unsupported color: ${color}`)
      const linear = channels.slice(0, 3).map((channel) => {
        const value = Number(channel) / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
    }
    return [
      '.approval-card .primary',
      '.mode-toggle button.selected',
      '.session-item time',
      '.eyebrow',
      '.approval-tray h2',
      '.approval-heading h3',
      '.approval-preview h4',
      '.approval-card pre',
      '.message',
      '.framework-credit',
    ].map((selector) => {
      const element = document.querySelector(selector)
      if (!element) throw new Error(`Missing contrast target: ${selector}`)
      const style = getComputedStyle(element)
      let ancestor: Element | null = element
      let background = style.backgroundColor
      while (background === 'rgba(0, 0, 0, 0)' && ancestor?.parentElement) {
        ancestor = ancestor.parentElement
        background = getComputedStyle(ancestor).backgroundColor
      }
      const values = [luminance(style.color), luminance(background)].sort((a, b) => b - a)
      return { selector, ratio: (values[0] + 0.05) / (values[1] + 0.05) }
    })
  })
  for (const { selector, ratio } of ratios) expect(ratio, selector).toBeGreaterThanOrEqual(4.5)
})

test('workspace documentation screenshot @screenshots', async ({ page }) => {
  await openSample(page, false, mixedOutputs())
  await page.screenshot({ path: `${assets}prudence-app.png` })
})

test('message statistics documentation screenshot @screenshots', async ({ page }) => {
  const fixture = await openSample(page)
  emitMeasuredRun(fixture)
  const message = page.locator('.message.assistant').filter({ hasText: 'A measured answer from the agent.' })
  await message.locator('.message-run-stats summary').click()
  await expect(message.locator('.message-run-stats dd').first()).toHaveText('recorded-main-model')
  await message.screenshot({ path: `${assets}prudence-message-stats.png` })
})

test('persona dial documentation screenshot @screenshots', async ({ page }) => {
  await openWelcome(page)
  await page.locator('.persona-prominent').click()
  const menu = page.getByRole('menu', { name: 'Choose persona', exact: true })
  await expect(menu.getByRole('menuitemradio')).toHaveCount(8)
  await expect(page.locator('.persona-default img')).toHaveAttribute('src', '/prudence-icon.svg')
  await menu.screenshot({ path: `${assets}prudence-persona-dial.png` })
})

test('delete confirmation documentation screenshot @screenshots', async ({ page }) => {
  await openSample(page)
  await page.getByRole('button', { name: 'Delete session Refactor authentication', exact: true }).click()
  await page.getByRole('alertdialog', { name: 'Delete session?', exact: true }).screenshot({ path: `${assets}prudence-delete-confirmation.png` })
})

test('session personas documentation screenshot @screenshots', async ({ page }) => {
  await openSample(page)
  for (const persona of personas) {
    await page.locator('.brand-mark').click()
    await page.getByRole('menuitemradio', { name: persona.name, exact: true }).click()
    await page.getByRole('button', { name: 'New session', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'New session', exact: true })).toBeVisible()
  }
  const nav = page.getByRole('navigation', { name: 'Sessions' })
  await expect(nav.locator('.session-persona')).toHaveCount(8)
  await nav.screenshot({ path: `${assets}prudence-session-personas.png` })
})

test('focused workspace documentation screenshot @screenshots', async ({ page }) => {
  await openSample(page)
  await page.keyboard.press('Alt+v')
  await page.keyboard.press('Control+Alt+v')
  await expect(page.locator('.sidebar')).toBeHidden()
  await expect(page.locator('.context-panel')).toBeHidden()
  await page.screenshot({ path: `${assets}prudence-focused-workspace.png` })
})

test('pane commands documentation screenshot @screenshots', async ({ page }) => {
  await openSample(page)
  await page.keyboard.press('Control+k')
  await page.getByRole('textbox', { name: 'Search workspace commands' }).fill('collapse')
  const palette = page.getByRole('dialog', { name: 'Workspace commands' })
  await expect(palette.locator('.command-list button')).toHaveCount(2)
  await palette.screenshot({ path: `${assets}prudence-panel-commands.png` })
})

test('output summary documentation screenshot @screenshots', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  await openSample(page, false, mixedOutputs())
  const section = page.locator('#artifacts-section')
  await expect(section.locator('.output-metrics dd')).toHaveText(['6', '3.9 KiB', '7'])
  await expect(section.locator('.output-inspection')).not.toHaveAttribute('open')
  await section.screenshot({ path: `${assets}prudence-output-summary.png` })
})
test('approval documentation screenshot @screenshots', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  await openSample(page, true)
  await page.screenshot({ path: `${assets}prudence-approval.png` })
})

test('Counsel Craft pairing documentation screenshot @screenshots', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  await openSample(page, false, [], pairingProviders())
  await page.getByRole('button', { name: 'Craft local provider', exact: true }).click()
  await page.getByRole('option', { name: /qwen2.5-coder/ }).click()
  await page.locator('.model-pairing').screenshot({ path: `${assets}prudence-counsel-craft.png` })
})

test('Counsel Craft picker documentation screenshot @screenshots', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  await openSample(page, false, [], pairingProviders())
  await page.getByRole('button', { name: 'Craft local provider', exact: true }).click()
  await page.getByRole('option', { name: /qwen2.5-coder/ }).click()
  await page.getByRole('button', { name: 'Craft local provider', exact: true }).click()
  await page.locator('.model-pairing').screenshot({ path: `${assets}prudence-craft-picker.png` })
})
test('settings documentation screenshot @screenshots', async ({ page }) => {
  await openSample(page)
  await page.getByRole('button', { name: 'Session settings', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Session instructions' })).toBeVisible()
  await page.screenshot({ path: `${assets}prudence-settings.png` })
})

test('provider menu documentation screenshot @screenshots', async ({ page }) => {
  const fixture = await openSample(page, false, [], pairingProviders())
  fixture.histories['sample-foundry'] = [sampleProbe('sample-foundry')]
  await page.getByRole('button', { name: 'Manage providers', exact: true }).click()
  await expect(page.getByText('Passed', { exact: true })).toBeVisible()
  await page.getByRole('dialog', { name: 'Provider manager', exact: true }).screenshot({ path: `${assets}prudence-provider-menu.png` })
})

test('main provider picker documentation screenshot @screenshots', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  await openSample(page, false, [], pairingProviders().slice(0, 3))
  await selectProvider(page, 'Local Phi 3.5 Mini')
  await page.getByRole('button', { name: 'Active model provider', exact: true }).click()
  await page.locator('.provider-panel > .model-picker').screenshot({ path: `${assets}prudence-provider-picker.png` })
})
test('empty provider menu documentation screenshot @screenshots', async ({ page }) => {
  await openWelcome(page)
  await page.getByRole('button', { name: 'Manage providers', exact: true }).click()
  await page.getByRole('dialog', { name: 'Provider manager', exact: true }).screenshot({ path: `${assets}prudence-provider-empty.png` })
})

test('parsed activity documentation screenshot @screenshots', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  const fixture = await openSample(page)
  fixture.sendActivity('run_started', {})
  fixture.sendActivity('tool_call', { name: 'read_file', arguments: { path: 'src/session.ts' } })
  fixture.sendActivity('run_failed', sampleFailure)
  await expect(page.locator('#activity-section .activity-item')).toHaveCount(3)
  await page.locator('#activity-section').screenshot({ path: `${assets}prudence-activity.png` })
})

test('inline run-error documentation screenshot @screenshots', async ({ page }) => {
  const fixture = await openSample(page)
  fixture.sendActivity('run_failed', sampleFailure)
  fixture.sendError('The run failed. See the activity panel for details.')
  await expect(page.locator('.notice')).toBeVisible()
  await expectNoOverlap(page.locator('.notice'), page.locator('.composer'))
  await expectNoOverlap(page.locator('.notice'), page.locator('.context-panel'))
  await page.locator('#activity-section').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${assets}prudence-notice.png` })
})
