export type HarnessEvent = {
  id: number
  session_id: string
  sequence: number
  type: string
  payload: Record<string, unknown>
  created_at: string
}

export function payloadText(event: HarnessEvent, key: string): string | null {
  const value = event.payload[key]
  return typeof value === 'string' ? value : null
}

export function payloadNumber(event: HarnessEvent, key: string): number | null {
  const value = event.payload[key]
  return typeof value === 'number' ? value : null
}

export type RunTelemetry = {
  startedAt: string
  endedAt: string | null
  outcome: 'Running' | 'Waiting for approval' | 'Completed' | 'Failed' | 'Cancelled' | 'End not recorded'
  model: string | null
  craftModel: string | null
  inputTokens: number | null
  outputTokens: number | null
  usageSamples: number
  toolCalls: number
}

function tokenCount(event: HarnessEvent, key: string) {
  const value = payloadNumber(event, key)
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function addTokenCounts(total: number | null, value: number | null) {
  if (total === null || value === null) return null
  const sum = total + value
  return Number.isSafeInteger(sum) ? sum : null
}

export function messageTelemetry(events: HarnessEvent[]) {
  const byMessage = new Map<number, RunTelemetry>()
  let pendingUser: HarnessEvent | null = null
  let activeRun: RunTelemetry | null = null

  for (const event of events) {
    if (event.type === 'user_message') {
      if (activeRun) activeRun.outcome = 'End not recorded'
      pendingUser = event
      activeRun = null
    } else if (event.type === 'run_started') {
      if (activeRun) activeRun.outcome = 'End not recorded'
      activeRun = {
        startedAt: event.created_at,
        endedAt: null,
        outcome: 'Running',
        model: payloadText(event, 'model'),
        craftModel: payloadText(event, 'craft_model'),
        inputTokens: null,
        outputTokens: null,
        usageSamples: 0,
        toolCalls: 0,
      }
      if (pendingUser) byMessage.set(pendingUser.id, activeRun)
      pendingUser = null
    } else if (activeRun) {
      if (event.type === 'assistant_message') byMessage.set(event.id, activeRun)
      else if (event.type === 'context_usage') {
        const input = tokenCount(event, 'input_tokens')
        const output = tokenCount(event, 'output_tokens')
        activeRun.inputTokens = activeRun.usageSamples === 0 ? input : addTokenCounts(activeRun.inputTokens, input)
        activeRun.outputTokens = activeRun.usageSamples === 0 ? output : addTokenCounts(activeRun.outputTokens, output)
        activeRun.usageSamples += 1
      } else if (event.type === 'tool_call') activeRun.toolCalls += 1
      else if (event.type === 'run_waiting_approval') activeRun.outcome = 'Waiting for approval'
      else if (event.type === 'approval_decided') activeRun.outcome = 'Running'
      else if (['run_completed', 'run_failed', 'run_cancelled'].includes(event.type)) {
        activeRun.outcome = event.type === 'run_completed' ? 'Completed' : event.type === 'run_failed' ? 'Failed' : 'Cancelled'
        activeRun.endedAt = event.created_at
        activeRun = null
      }
    }
  }
  return { byMessage, activeRun }
}

export function elapsedRunTime(run: RunTelemetry): string | null {
  if (!run.endedAt) return null
  const elapsed = Date.parse(run.endedAt) - Date.parse(run.startedAt)
  if (!Number.isFinite(elapsed) || elapsed < 0) return null
  if (elapsed < 1000) return `${Math.round(elapsed)} ms`
  if (elapsed < 60_000) return `${(elapsed / 1000).toFixed(1)} s`
  const seconds = Math.floor(elapsed / 1000)
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
})

export function messageTimestamp(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? timestampFormatter.format(date) : null
}
