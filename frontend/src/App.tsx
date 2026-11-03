import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import './App.css'

type ProviderKind = 'foundry' | 'local'
type DataBoundary = 'machine' | 'local_network' | 'external'

type AssistantChoice = {
  label: string
  response: string
}

type AssistantChoicePrompt = {
  introduction: string
  choices: AssistantChoice[]
  followUp: string
}

function plainChoiceText(markdown: string) {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractAssistantChoices(content: string): AssistantChoicePrompt | null {
  const lines = content.trimEnd().split(/\r?\n/)
  const candidates: { listStart: number; listEnd: number; choices: AssistantChoice[] }[] = []

  for (let listStart = 0; listStart < lines.length; listStart += 1) {
    if (!/^\s*\d+[.)]\s+/.test(lines[listStart])) continue
    const choices: AssistantChoice[] = []
    let listEnd = listStart
    while (listEnd < lines.length) {
      const match = lines[listEnd].match(/^\s*\d+[.)]\s+(.+?)\s*$/)
      if (!match) break
      const label = plainChoiceText(match[1])
      const response = plainChoiceText(match[1].split(/\s+(?:—|–|-)\s+/, 1)[0])
      if (!label || !response) return null
      choices.push({ label, response })
      listEnd += 1
    }
    let promptLine = listStart - 1
    while (promptLine >= 0 && !lines[promptLine].trim()) promptLine -= 1
    if (
      choices.length >= 2 &&
      choices.length <= 6 &&
      promptLine >= 0 &&
      lines[promptLine].includes('?')
    ) {
      candidates.push({ listStart, listEnd, choices })
    }
    listStart = listEnd - 1
  }

  if (candidates.length !== 1) return null
  const [selected] = candidates
  const introduction = lines.slice(0, selected.listStart).join('\n').trimEnd()
  return {
    introduction,
    choices: selected.choices,
    followUp: lines.slice(selected.listEnd).join('\n').trim(),
  }
}

function CollapsibleContextSection({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string
  eyebrow: string
  title: string
  children: ReactNode
}) {
  const [collapsed, setCollapsed] = useState(false)
  const contentId = `${id}-content`

  return (
    <section id={id} className={`context-section ${collapsed ? 'collapsed' : ''}`}>
      <div className="context-section-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
        <button
          className="section-toggle"
          type="button"
          aria-controls={contentId}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
          onClick={() => setCollapsed((current) => !current)}
        >
          <span aria-hidden="true">{collapsed ? '＋' : '−'}</span>
        </button>
      </div>
      <div id={contentId} hidden={collapsed}>
        {children}
      </div>
    </section>
  )
}

type Provider = {
  id: string
  name: string
  kind: ProviderKind
  endpoint: string
  model: string
  api_key_env: string | null
  max_context_window_tokens: number
  max_output_tokens: number
  data_boundary: DataBoundary
}

type ProviderProbe = {
  id: number
  provider_id: string
  ok: boolean
  message: string
  tool_calling: boolean
  streaming: boolean
  checked_at: string
}

type SessionSummary = {
  id: string
  provider_id: string
  craft_provider_id: string | null
  title: string
  created_at: string
  updated_at: string
}

type HarnessEvent = {
  id: number
  session_id: string
  sequence: number
  type: string
  payload: Record<string, unknown>
  created_at: string
}

type SessionDetail = SessionSummary & { events: HarnessEvent[] }

type TaskItem = {
  id: number
  title: string
  description: string | null
  is_complete: boolean
}

type SessionState = {
  mode: 'plan' | 'execute'
  tasks: TaskItem[]
  is_running: boolean
}

type Approval = {
  id: string
  tool_name: string
  arguments: Record<string, unknown>
  preview: {
    operation: string
    category: string
    risk_level: string
    affected_paths: string[]
    preview_kind: string
    preview_content: string | null
    preview_truncated: boolean
  }
  status: 'pending' | 'approved' | 'denied'
}

type Memory = {
  file_name: string
  description: string | null
  content: string
}

type InstructionSource = {
  scope: string
  label: string
  relative_path: string
  precedence: number
  content: string
  editable: boolean
}

type WorkspaceContext = {
  root_path: string
  instructions: InstructionSource[]
  context_files: {
    relative_path: string
    kind: string
    size_bytes: number
  }[]
  discovered_file_count: number
  discovery_truncated: boolean
  read_tools: string[]
  write_tools_enabled: boolean
  auto_approve_enabled: boolean
  write_tools: string[]
}

type WorkspaceDirectorySelection = {
  path: string | null
}

type SkillSummary = {
  name: string
  description: string
  source: 'user' | 'project'
  precedence: number
  relative_path: string
  size_bytes: number
}

type HookSummary = {
  id: string
  event: string
  action: 'audit' | 'block'
  message: string
  source: 'user' | 'project'
  precedence: number
  relative_path: string
}

type McpServerSummary = {
  id: string
  description: string
  enabled: boolean
  transport: 'stdio'
  allowed_tools: string[]
  progressive_disclosure: boolean
  approval_required: boolean
  missing_env_vars: string[]
}

type SubagentSummary = {
  name: string
  description: string
  permissions: string[]
  timeout_seconds: number
  max_tool_calls: number
  max_tool_output_chars: number
  max_result_chars: number
  max_output_tokens: number
}

type ArtifactVersion = {
  version: number
  file_name: string
  size_bytes: number
  created_at: string
}

type ArtifactSummary = {
  id: string
  session_id: string
  title: string
  media_type: string
  current_version: number
  created_at: string
  updated_at: string
  versions: ArtifactVersion[]
}

type ArtifactPreview = ArtifactSummary & {
  version: number
  content: string
  content_truncated: boolean
}

const sourceLanguages: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.cs': 'C#', '.py': 'Python', '.java': 'Java', '.go': 'Go', '.rs': 'Rust',
  '.c': 'C', '.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++', '.hpp': 'C++',
  '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.kt': 'Kotlin', '.kts': 'Kotlin',
  '.scala': 'Scala', '.sh': 'Shell', '.bash': 'Shell', '.ps1': 'PowerShell', '.psm1': 'PowerShell',
  '.sql': 'SQL', '.bicep': 'Bicep', '.tf': 'HCL',
}

function describeOutputs(artifacts: ArtifactSummary[]) {
  const types = new Map<string, number>()
  const languages = new Map<string, number>()
  let bytes = 0
  let knownSizes = 0
  let missingMetadata = 0
  let versions = 0
  for (const artifact of artifacts) {
    versions += artifact.versions.length
    const current = artifact.versions.find((version) => version.version === artifact.current_version)
    const name = current?.file_name.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase()
    let extension = 'Unknown'
    if (name) {
      if (name === 'dockerfile' || name.startsWith('dockerfile.')) extension = 'Dockerfile'
      else if (name === '.env' || name.startsWith('.env.')) extension = '.env'
      else if (name.startsWith('.') && !name.slice(1).includes('.')) extension = name
      else extension = name.match(/\.[a-z0-9]+$/)?.[0] ?? 'No extension'
    } else missingMetadata += 1
    types.set(extension, (types.get(extension) ?? 0) + 1)
    const language = sourceLanguages[extension]
    if (language) languages.set(language, (languages.get(language) ?? 0) + 1)
    if (current && Number.isSafeInteger(current.size_bytes) && current.size_bytes >= 0) {
      bytes += current.size_bytes
      knownSizes += 1
    }
  }
  const counts = (values: Map<string, number>) => [...values]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return { files: artifacts.length, types: counts(types), languages: counts(languages), bytes, knownSizes, missingMetadata, versions }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`
}

type WorkspaceCommand = {
  id: string
  label: string
  shortcut?: string
  disabled?: boolean
  run: () => void
}

type ProviderDraft = {
  name: string
  kind: ProviderKind
  endpoint: string
  model: string
  api_key_env: string
  max_context_window_tokens: number
  max_output_tokens: number
}

const defaultProvider: ProviderDraft = {
  name: 'Local model',
  kind: 'local',
  endpoint: 'http://127.0.0.1:11434/v1',
  model: '',
  api_key_env: '',
  max_context_window_tokens: 32_768,
  max_output_tokens: 4_096,
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { detail?: string }
    throw new Error(body.detail ?? `Request failed with status ${response.status}`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function payloadText(event: HarnessEvent, key: string): string | null {
  const value = event.payload[key]
  return typeof value === 'string' ? value : null
}

function payloadNumber(event: HarnessEvent, key: string): number | null {
  const value = event.payload[key]
  return typeof value === 'number' ? value : null
}

function payloadTasks(event: HarnessEvent): TaskItem[] | null {
  const value = event.payload.tasks
  if (!Array.isArray(value)) return null
  const tasks: TaskItem[] = []
  for (const item of value) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof item.id !== 'number' ||
      typeof item.title !== 'string' ||
      typeof item.is_complete !== 'boolean'
    ) {
      return null
    }
    tasks.push({
      id: item.id,
      title: item.title,
      description: typeof item.description === 'string' ? item.description : null,
      is_complete: item.is_complete,
    })
  }
  return tasks
}

function activityTitle(event: HarnessEvent): string {
  if (event.type === 'tool_call') return `Tool requested: ${payloadText(event, 'name') ?? 'unknown'}`
  if (event.type === 'tool_result') {
    return `Tool ${event.payload.exception ? 'failed' : 'returned'}: ${payloadText(event, 'name') ?? 'unknown'}`
  }
  if (event.type === 'run_started') return 'Run started'
  if (event.type === 'run_completed') return 'Run completed'
  if (event.type === 'run_failed') return 'Run failed'
  if (event.type === 'run_cancelled') return 'Run stopped'
  if (event.type === 'run_waiting_approval' || event.type === 'approval_requested') return 'Approval needed'
  if (event.type === 'approval_decided') {
    return event.payload.approved === true
      ? 'Request approved'
      : event.payload.approved === false ? 'Request denied' : 'Approval decision recorded'
  }
  if (event.type === 'workspace_bound') return 'Workspace connected'
  if (event.type === 'workspace_capabilities_changed') return 'Workspace permissions changed'
  if (event.type === 'session_instructions_changed') return 'Session guidance updated'
  if (event.type === 'session_title_updated') return 'Session renamed'
  if (event.type === 'session_title_failed') return 'Session naming failed'
  if (event.type === 'context_usage') return 'Context usage updated'
  if (event.type === 'task_progress') return 'Plan progress updated'
  if (event.type === 'run_status') return payloadText(event, 'label') ?? 'Agent status updated'
  if (event.type === 'model_handoff_queued') return 'Craft microtask queued'
  if (event.type === 'model_handoff_started') return 'Counsel delegated work to Craft'
  if (event.type === 'model_handoff_attempt') {
    const attempt = payloadNumber(event, 'attempt')
    return attempt === null ? 'Craft attempt started' : `Craft attempt ${attempt} started`
  }
  if (event.type === 'model_handoff_retry') return 'Craft is retrying incomplete output'
  if (event.type === 'model_handoff_completed') return 'Craft returned work to Counsel'
  if (event.type === 'model_handoff_failed') return 'Craft handoff failed'
  if (event.type === 'model_handoff_rejected') return 'Craft microtask rejected'
  if (event.type === 'subagent_started') {
    return `Subagent started: ${payloadText(event, 'name') ?? 'unknown'}`
  }
  if (event.type === 'subagent_completed') {
    return `Subagent finished: ${payloadText(event, 'name') ?? 'unknown'}`
  }
  if (event.type === 'subagent_failed') {
    return `Subagent failed: ${payloadText(event, 'name') ?? 'unknown'}`
  }
  return event.type.replaceAll('_', ' ')
}

function progressHint(event: HarnessEvent): string | null {
  if (event.type === 'run_status') {
    return payloadText(event, 'label') ?? 'The agent is processing your request.'
  }
  if (event.type === 'task_progress') {
    const tasks = payloadTasks(event)
    const currentTask = tasks?.find((task) => !task.is_complete)
    return currentTask ? `Working on: ${currentTask.title}` : 'The planned tasks are complete.'
  }
  if (event.type === 'model_handoff_started') {
    const targetPath = payloadText(event, 'target_path')
    const outputTokens = payloadNumber(event, 'output_token_budget')
    return targetPath
      ? `Local Craft is generating ${targetPath}${outputTokens ? ` within ${outputTokens} output tokens` : ''}.`
      : `Counsel delegated a bounded task to local Craft${outputTokens ? ` with a ${outputTokens}-token output budget` : ''}.`
  }
  if (event.type === 'model_handoff_queued') {
    const position = payloadNumber(event, 'queue_position')
    return `Craft microtask queued${position ? ` at position ${position}` : ''}; local inference runs one at a time.`
  }
  if (event.type === 'model_handoff_attempt') {
    const attempt = payloadNumber(event, 'attempt') ?? 1
    const outputCharacters = payloadNumber(event, 'output_character_budget')
    return `Craft attempt ${attempt} is running${outputCharacters ? ` with a ${outputCharacters}-character ceiling` : ''}.`
  }
  if (event.type === 'model_handoff_retry') {
    return 'Craft output was incomplete; one fresh, shorter automatic retry is running.'
  }
  if (event.type === 'model_handoff_completed') {
    const targetPath = payloadText(event, 'target_path')
    return targetPath
      ? `Craft returned ${targetPath} for Counsel to verify.`
      : 'Craft returned a result for Counsel to verify.'
  }
  if (event.type === 'model_handoff_failed') {
    const reason = payloadText(event, 'reason')
    if (reason === 'incomplete_output') {
      return 'Craft output remained incomplete after retry; Counsel must delegate a smaller unit.'
    }
    if (reason === 'provider_queue_aborted') {
      return 'A queued Craft task was stopped because the local provider disconnected.'
    }
    if (reason === 'provider_error') {
      return 'The local Craft provider disconnected or rejected the request.'
    }
    return 'The Craft handoff failed.'
  }
  if (event.type === 'model_handoff_rejected') {
    return payloadText(event, 'error') ?? 'The Craft microtask did not fit its configured budget.'
  }
  if (event.type === 'approval_requested' || event.type === 'run_waiting_approval') {
    return 'Waiting for your approval before continuing.'
  }
  if (event.type === 'model_handoff_boundary_blocked') {
    return 'Prudence blocked code that did not come from the local Craft model.'
  }
  if (event.type === 'tool_call') {
    const toolName = payloadText(event, 'name')
    if (toolName === 'consult_craft') return null
    return `Preparing tool: ${(toolName ?? 'unknown').replaceAll('_', ' ')}.`
  }
  if (event.type === 'tool_result') {
    const toolName = payloadText(event, 'name')
    if (toolName === 'consult_craft') return null
    return `${event.payload.exception ? 'Tool failed' : 'Tool finished'}: ${(toolName ?? 'unknown').replaceAll('_', ' ')}.`
  }
  return null
}

type ActivityView = {
  title: string
  summary: string
  tone: 'neutral' | 'success' | 'warning' | 'danger'
  label: string
  facts: { label: string; value: string }[]
  nextStep?: string
}

function describeActivity(event: HarnessEvent): ActivityView {
  const view: ActivityView = {
    title: activityTitle(event).replaceAll('_', ' '),
    summary: 'This event has no readable summary yet. Inspect technical details for the recorded data.',
    tone: 'neutral',
    label: 'Event',
    facts: [],
  }
  const addNumber = (key: string, label: string, suffix = '') => {
    const value = payloadNumber(event, key)
    if (value !== null) view.facts.push({ label, value: `${value.toLocaleString()}${suffix}` })
  }
  if (event.type === 'run_failed') {
    view.tone = 'danger'
    view.label = 'Failed'
    view.summary = payloadText(event, 'message') ?? 'The run failed without a recorded failure summary.'
    const category = payloadText(event, 'category')
    if (category) view.facts.push({ label: 'Category', value: category.replaceAll('_', ' ') })
    addNumber('status_code', 'HTTP')
    view.facts.push({
      label: 'Retry',
      value: event.payload.retryable === true
        ? 'Available'
        : event.payload.retryable === false ? 'Manual rerun only' : 'Not reported',
    })
    const guidance: Record<string, string> = {
      connection: 'Check that the model provider is running and reachable before trying again.',
      timeout: 'Check provider connectivity before trying again.',
      rate_limit: 'Wait for the provider rate limit to clear before trying again.',
      provider_unavailable: 'Wait for the provider to recover before trying again.',
      authentication: 'Review provider credentials and access before running again.',
      invalid_request: 'Review the provider profile and request before running again.',
      policy_blocked: 'Review the policy restriction; running again will not bypass it.',
    }
    view.nextStep = (category && guidance[category]) || 'Review technical details before running again.'
  } else if (event.type === 'run_started') {
    view.label = 'Started'
    view.summary = 'The agent started processing your prompt.'
  } else if (event.type === 'run_completed') {
    view.tone = 'success'
    view.label = 'Completed'
    view.summary = 'This run finished. Review the response and any proposed changes.'
  } else if (event.type === 'run_cancelled') {
    view.tone = 'warning'
    view.label = 'Stopped'
    view.summary = 'The run was cancelled. Work already completed is not automatically undone.'
  } else if (event.type === 'approval_requested' || event.type === 'run_waiting_approval') {
    view.tone = 'warning'
    view.label = 'Waiting'
    view.summary = 'The agent needs your decision before continuing.'
    const tool = payloadText(event, 'tool_name')
    if (tool) view.facts.push({ label: 'Tool', value: tool.replaceAll('_', ' ') })
    view.nextStep = 'Review the permission request above the composer.'
  } else if (event.type === 'approval_decided') {
    const approved = event.payload.approved
    view.tone = approved === true ? 'success' : approved === false ? 'warning' : 'neutral'
    view.label = 'Decision'
    view.summary = approved === true
      ? 'You approved this request. Other actions remain subject to their own approval gates.'
      : approved === false ? 'You denied this request.' : 'The recorded decision is not recognized. Inspect technical details.'
  } else if (event.type === 'tool_call' || event.type === 'tool_result') {
    const failed = event.type === 'tool_result' && Boolean(event.payload.exception)
    view.tone = failed ? 'danger' : 'neutral'
    view.label = failed ? 'Failed' : event.type === 'tool_call' ? 'Requested' : 'Returned'
    view.summary = failed
      ? 'The tool reported an error. Inspect technical details before continuing.'
      : event.type === 'tool_call' ? 'The agent requested this tool.' : 'The tool returned a result for the agent to inspect.'
    const argumentsValue = event.payload.arguments
    if (typeof argumentsValue === 'object' && argumentsValue !== null && 'path' in argumentsValue &&
      typeof argumentsValue.path === 'string') {
      view.facts.push({ label: 'Path', value: argumentsValue.path })
    }
  } else if (event.type === 'task_progress') {
    view.label = 'Plan'
    const tasks = payloadTasks(event)
    if (tasks) {
      const completed = tasks.filter((task) => task.is_complete).length
      view.summary = `${completed} of ${tasks.length} tasks completed.`
      const current = tasks.find((task) => !task.is_complete)
      if (current) view.facts.push({ label: 'Next', value: current.title })
    } else view.summary = 'Plan progress was recorded without readable task details.'
  } else if (event.type === 'context_usage') {
    view.label = 'Usage'
    view.summary = 'Recorded model token usage for this run.'
    addNumber('input_tokens', 'Input tokens')
    addNumber('output_tokens', 'Output tokens')
    addNumber('context_percent', 'Context', '%')
  } else if (event.type === 'run_status') {
    view.label = 'Progress'
    view.title = 'Agent progress'
    view.summary = payloadText(event, 'label') ?? 'Agent status updated without a readable label.'
  } else if (event.type.startsWith('model_handoff_') || event.type.startsWith('subagent_')) {
    view.label = 'Delegation'
    if (event.type.endsWith('_failed') || event.type.endsWith('_rejected') || event.type.endsWith('_blocked')) {
      view.tone = 'danger'
    } else if (event.type.endsWith('_completed')) view.tone = 'success'
    view.summary = progressHint(event) ?? (
      event.type === 'subagent_started' ? 'A bounded subagent started its assigned task.'
        : event.type === 'subagent_completed' ? 'The subagent returned its result.'
          : event.type === 'subagent_failed' ? 'The subagent failed. Inspect technical details.'
            : 'An unrecognized delegation event was recorded. Inspect technical details.'
    )
    addNumber('duration_ms', 'Duration', ' ms')
    addNumber('tool_calls', 'Tool calls')
    const target = payloadText(event, 'target_path')
    if (target) view.facts.push({ label: 'Target', value: target })
  } else if (event.type === 'workspace_bound') {
    view.label = 'Workspace'
    view.summary = 'This session is now bound to a local workspace.'
    const root = payloadText(event, 'root_path')
    if (root) view.facts.push({ label: 'Folder', value: root })
    addNumber('context_file_count', 'Context files')
  } else if (event.type === 'workspace_capabilities_changed') {
    view.label = 'Permissions'
    view.summary = 'Workspace permission settings were updated.'
    for (const [key, label] of [['write_tools_enabled', 'Write access'], ['auto_approve_enabled', 'Auto-approve']]) {
      view.facts.push({
        label,
        value: event.payload[key] === true ? 'Enabled' : event.payload[key] === false ? 'Disabled' : 'Not reported',
      })
    }
  } else if (event.type === 'session_title_updated' || event.type === 'session_instructions_changed') {
    view.label = 'Session'
    view.summary = event.type === 'session_title_updated'
      ? payloadText(event, 'title') ?? 'The session title was updated.'
      : 'Guidance for this session was changed.'
  } else if (event.type === 'session_title_failed') {
    view.label = 'Failed'
    view.tone = 'warning'
    view.summary = 'Automatic session naming failed. This does not indicate that the main run failed.'
  }
  return view
}

function ActivityItem({ event }: { event: HarnessEvent }) {
  const view = describeActivity(event)
  const detail = payloadText(event, 'detail') ?? payloadText(event, 'error')
  return (
    <li className={`activity-item activity-${view.tone}`}>
      <span className="activity-marker" aria-hidden="true">
        <svg viewBox="0 0 16 16">
          {view.tone === 'success' ? <path d="m4 8 3 3 5-6" />
            : view.tone === 'danger' ? <path d="m5 5 6 6M11 5l-6 6" />
              : view.tone === 'warning' ? <path d="M8 4v5m0 2v1" />
                : <circle cx="8" cy="8" r="2" />}
        </svg>
      </span>
      <article>
        <header className="activity-meta">
          <span>{view.label}</span>
          <time dateTime={event.created_at}>{new Date(event.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
        </header>
        <h3>{view.title}</h3>
        <p className="activity-description">{view.summary}</p>
        {view.facts.length > 0 && (
          <dl className="activity-facts">
            {view.facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
          </dl>
        )}
        {view.nextStep && <p className="activity-next"><strong>Next step</strong>{view.nextStep}</p>}
        <details className="activity-technical">
          <summary>Technical details</summary>
          <p className="activity-event-type">{event.type}</p>
          {detail && <pre>{detail}</pre>}
          <details className="activity-raw">
            <summary>Raw event payload</summary>
            <pre>{JSON.stringify(event.payload, null, 2)}</pre>
          </details>
        </details>
      </article>
    </li>
  )
}

function dataBoundaryLabel(boundary: DataBoundary): string {
  if (boundary === 'machine') return 'Model traffic stays on this machine'
  if (boundary === 'local_network') return 'Model traffic stays on your local network'
  return 'Prompts and tool outputs leave this machine'
}

type ModelChoice = {
  id: string
  name: string
  model: string
  boundary: DataBoundary | null
  kind?: ProviderKind
}

function providerDisplayName(provider: Pick<Provider, 'name' | 'model'>): string {
  return provider.name.trim().replace(/^(?:(?:Microsoft\s+)?Foundry(?:\s+Local)?|Local)(?:\s+|$)/i, '').trim() || provider.model
}

function ProviderSymbol({ kind }: { kind: ProviderKind }) {
  const label = kind === 'foundry' ? 'Microsoft Foundry provider' : 'Local provider'
  return (
    <svg className={`provider-symbol ${kind}`} viewBox="0 0 24 24" role="img" aria-label={label}>
      <title>{label}</title>
      <path d={kind === 'foundry'
        ? 'm12 3 9 9-9 9-9-9 9-9ZM12 7v10M7 12h10'
        : 'm12 3 8 4.5v9L12 21l-8-4.5v-9L12 3ZM4 7.5l8 4.5 8-4.5M12 12v9'} />
    </svg>
  )
}

function ModelPicker({ choices, value, onChange, label, heading, triggerClassName, children, emptyHint }: {
  choices: ModelChoice[]
  value: string
  onChange: (value: string) => void
  label: string
  heading: string
  triggerClassName: string
  children: ReactNode
  emptyHint?: string
}) {
  const menuId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const typedRef = useRef({ text: '', time: 0 })
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState(value)
  const activeIndex = choices.findIndex((choice) => choice.id === activeId)

  useLayoutEffect(() => {
    if (!open) return
    setActiveId(choices.find((choice) => choice.id === value)?.id ?? choices[0]?.id ?? '')
    typedRef.current = { text: '', time: 0 }
    listRef.current?.focus()
  }, [open, choices, value])

  useLayoutEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, activeId])

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])

  function close() {
    setOpen(false)
    triggerRef.current?.focus()
  }

  function choose(id: string) {
    onChange(id)
    close()
  }

  function navigate(event: ReactKeyboardEvent<HTMLDivElement>) {
    const key = event.key
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
      event.preventDefault()
      const index = key === 'Home' ? 0 : key === 'End' ? choices.length - 1
        : Math.max(0, Math.min(choices.length - 1, activeIndex + (key === 'ArrowDown' ? 1 : -1)))
      const choice = choices[index]
      if (choice) setActiveId(choice.id)
    } else if (key === 'Enter' || key === ' ') {
      event.preventDefault()
      choose(activeId)
    } else if (key === 'Tab') close()
    else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      event.stopPropagation()
      const character = key.toLowerCase()
      const previous = Date.now() - typedRef.current.time < 700 ? typedRef.current.text : ''
      const text = previous === character ? character : previous + character
      typedRef.current = { text, time: Date.now() }
      const ordered = [...choices.slice(activeIndex + 1), ...choices.slice(0, activeIndex + 1)]
      const match = ordered.find((choice) => choice.model.toLowerCase().startsWith(text) || choice.name.toLowerCase().startsWith(text) || providerDisplayName(choice).toLowerCase().startsWith(text))
      if (match) setActiveId(match.id)
    }
  }

  return (
    <div
      className="model-picker"
      ref={rootRef}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          close()
        }
      }}
    >
        <button
          className={triggerClassName}
          ref={triggerRef}
          type="button"
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen(!open)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setOpen(true)
            }
          }}
        >
          {children}
          <svg className="model-picker-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d={open ? 'm8 14 4-4 4 4' : 'm8 10 4 4 4-4'} /></svg>
        </button>
      {open && (
        <div className="model-options">
          <p className="model-options-title">{heading}</p>
          <div
            id={menuId}
            className="model-listbox"
            role="listbox"
            aria-label={`${label} options`}
            aria-activedescendant={`${menuId}-${activeIndex}`}
            ref={listRef}
            tabIndex={-1}
            onKeyDown={navigate}
          >
            {choices.map((choice, index) => (
              <button
                id={`${menuId}-${index}`}
                className="model-option"
                type="button"
                role="option"
                aria-label={`${choice.name} · ${choice.model}${choice.kind ? ` · ${choice.kind === 'foundry' ? 'Microsoft Foundry' : 'Local provider'}` : ''}${choice.boundary ? ` · ${choice.boundary.replaceAll('_', ' ')}` : ''}`}
                aria-selected={value === choice.id}
                data-active={activeId === choice.id}
                tabIndex={-1}
                key={choice.id}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActiveId(choice.id)}
                onClick={() => choose(choice.id)}
              >
                <span className="model-option-copy">
                  <span className="model-option-name">
                    {choice.kind && <ProviderSymbol kind={choice.kind} />}
                    <strong title={choice.name}>{providerDisplayName(choice)}</strong>
                  </span>
                  {providerDisplayName(choice) !== choice.model && <small title={choice.model}>{choice.model}</small>}
                  {(choice.kind || choice.boundary) && (
                    <span className="model-option-meta">
                      {choice.boundary && <span className={`pair-boundary ${choice.boundary}`} title={dataBoundaryLabel(choice.boundary)}>{choice.boundary.replaceAll('_', ' ')}</span>}
                    </span>
                  )}
                </span>
                {value === choice.id && <svg className="model-option-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10" /></svg>}
              </button>
            ))}
          </div>
          {choices.length === 1 && emptyHint && <p className="pairing-caption">{emptyHint}</p>}
        </div>
      )}
    </div>
  )
}

function CraftPicker({ counsel, providers, value, onChange }: {
  counsel: Provider
  providers: Provider[]
  value: string
  onChange: (value: string) => void
}) {
  const choices = useMemo<ModelChoice[]>(() => [
    { id: '', name: 'Counsel only', model: 'Reason without a local coding model', boundary: null },
    ...providers.filter((provider) => provider.kind === 'local').map((provider) => ({
      id: provider.id, model: provider.model, name: provider.name, boundary: provider.data_boundary, kind: provider.kind,
    })),
  ], [providers])
  const craft = providers.find((provider) => provider.id === value && provider.kind === 'local')
  return (
    <section className="model-pairing" aria-label="Counsel and Craft setup">
      <div className="pairing-heading">
        <h3>Counsel &amp; Craft</h3>
        <span className={`pairing-state${craft ? ' paired' : ''}`}>{craft ? 'Paired' : 'Counsel only'}</span>
      </div>
      <div className="pairing-flow">
        <div className="pairing-row">
          <span className="pairing-icon counsel-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M7 8h10M7 12h7M7 16h4M5 3h14v18H5z" /></svg>
          </span>
          <div className="pairing-copy">
            <span className="pairing-role"><strong>Counsel</strong><small>Reasoning</small></span>
            <span className="pairing-model" title={`${counsel.name} · ${counsel.model}`}>{providerDisplayName(counsel)}</span>
          </div>
        </div>
        <ModelPicker
          choices={choices}
          value={value}
          onChange={onChange}
          label="Craft local provider"
          heading="Local coding model"
          triggerClassName="pairing-row craft-trigger"
          emptyHint="No local providers configured. Add a provider to enable Craft."
        >
          <span className="pairing-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="m8 8-4 4 4 4m8-8 4 4-4 4m-3-10-2 12" /></svg>
          </span>
          <span className="pairing-copy">
            <span className="pairing-role"><strong>Craft</strong><small>Bounded coding</small></span>
            <span className="pairing-model" title={craft ? `${craft.name} · ${craft.model}` : undefined}>{craft ? providerDisplayName(craft) : 'Choose a local model'}</span>
          </span>
        </ModelPicker>
      </div>
      <div className="pairing-footer">
        {craft && <span className={`pair-boundary ${craft.data_boundary}`} title={dataBoundaryLabel(craft.data_boundary)}>{craft.data_boundary.replaceAll('_', ' ')}</span>}
        <span>New-session setup</span>
      </div>
      <p className="pairing-caption">Counsel plans. Craft codes. Approvals still apply.</p>
    </section>
  )
}

function ProviderManager({ providers, initialId, onClose, onAdd, onEdit, onDelete, onImport, onExport, notify }: {
  providers: Provider[]
  initialId: string
  onClose: () => void
  onAdd: () => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onImport: () => void
  onExport: () => void
  notify: (message: string) => void
}) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [managedId, setManagedId] = useState(initialId)
  const [probes, setProbes] = useState<ProviderProbe[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [testing, setTesting] = useState(false)
  const [message, setMessage] = useState('')
  const managed = providers.find((provider) => provider.id === managedId) ?? providers[0]
  const profileId = managed?.id

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    closeRef.current?.focus()
    return () => dialog?.close()
  }, [])

  useEffect(() => {
    setProbes([])
    setMessage('')
    setHistoryError('')
    setHistoryLoading(false)
    if (!profileId) return
    let current = true
    setHistoryLoading(true)
    api<ProviderProbe[]>(`/api/providers/${profileId}/probes`)
      .then((history) => { if (current) setProbes(history) })
      .catch((error: unknown) => {
        if (!current) return
        const detail = error instanceof Error ? error.message : 'Could not load connectivity history.'
        setMessage(detail)
        setHistoryError(detail)
        notify(detail)
      })
      .finally(() => { if (current) setHistoryLoading(false) })
    return () => { current = false }
  }, [profileId, notify])

  function close() {
    dialogRef.current?.close()
    onClose()
  }

  async function testConnection() {
    if (!managed || testing) return
    setTesting(true)
    let result = 'Testing provider connection...'
    setMessage(result)
    notify(result)
    try {
      await api<{ message: string }>(`/api/providers/${managed.id}/probe`, { method: 'POST' })
      result = 'Provider connection succeeded.'
    } catch (error) {
      result = error instanceof Error ? error.message : 'Provider test failed.'
    }
    try {
      setProbes(await api<ProviderProbe[]>(`/api/providers/${managed.id}/probes`))
      setHistoryError('')
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Could not refresh connectivity history.'
      setHistoryError(detail)
      result += ` ${detail}`
    }
    setMessage(result)
    notify(result)
    setTesting(false)
  }

  return (
    <dialog
      ref={dialogRef}
      className="provider-manager"
      aria-modal="true"
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); close() }}
      onKeyDown={(event) => {
        event.stopPropagation()
        trapDialogFocus(event)
        if (event.key === 'Escape') {
          event.preventDefault()
          close()
        }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const bounds = event.currentTarget.getBoundingClientRect()
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close()
      }}
    >
      <header className="provider-manager-heading">
        <div><p className="eyebrow">Configuration</p><h2 id={titleId}>Provider manager</h2></div>
        <button ref={closeRef} type="button" className="secondary" aria-label="Close provider manager" onClick={close}>Close</button>
      </header>
      <div className="provider-manager-body">
        <div className="provider-manager-list" aria-label="Provider profiles">
          <div className="provider-manager-list-heading"><strong>Profiles · {providers.length}</strong><button type="button" className="secondary" onClick={() => { close(); onAdd() }}>Add provider</button></div>
          {providers.map((provider) => (
            <button key={provider.id} type="button" aria-label={provider.name} disabled={testing} aria-pressed={managed?.id === provider.id} onClick={() => setManagedId(provider.id)}>
              <span className="model-option-name"><ProviderSymbol kind={provider.kind} /><strong title={provider.name}>{providerDisplayName(provider)}</strong></span><small title={provider.model}>{provider.model}</small>
            </button>
          ))}
          {!providers.length && <p className="empty-copy">No providers configured. Add or import a profile to get started.</p>}
        </div>
        <section className="provider-manager-detail">
          {managed ? (
            <>
              <h3 title={managed.name}>{providerDisplayName(managed)}</h3><p className="provider-manager-model">{managed.model}</p>
              <div className={`data-boundary ${managed.data_boundary}`}><strong>{managed.data_boundary.replaceAll('_', ' ')}</strong><span>{dataBoundaryLabel(managed.data_boundary)}</span></div>
              <dl className="provider-limits"><div><dt>Context</dt><dd>{managed.max_context_window_tokens.toLocaleString()}</dd></div><div><dt>Output</dt><dd>{managed.max_output_tokens.toLocaleString()}</dd></div></dl>
            </>
          ) : <h3>No provider selected</h3>}
          <p className="provider-manager-hint">Inspecting a profile here does not switch the active model.</p>
          <div className="provider-actions">
            <div className="provider-action-group"><p>Selected profile</p>
              <button type="button" disabled={!managed || testing || historyLoading} onClick={() => void testConnection()}>{testing ? 'Testing connection...' : 'Test connection'}</button>
              <button type="button" disabled={!managed || testing} onClick={() => { if (managed) { close(); onEdit(managed.id) } }}>Edit provider</button>
            </div>
            <div className="provider-action-group"><p>Configuration</p>
              <button type="button" onClick={() => { close(); onImport() }}>Import configuration</button>
              <button type="button" disabled={!providers.length} onClick={() => { close(); onExport() }}>Export configuration</button>
            </div>
            <div className="provider-action-group">
              <button type="button" className="provider-delete" disabled={!managed || testing} onClick={() => { if (managed) { close(); onDelete(managed.id) } }}>Delete provider</button>
            </div>
          </div>
          <div className="probe-history">
            <strong>Connectivity history</strong>
            {!managed ? <p>Select a profile to view connectivity history.</p> : historyLoading ? <p>Loading history...</p> : historyError ? <p>{historyError}</p> : !probes.length ? <p>No recorded connection tests.</p> : probes.slice(0, 3).map((probe) => (
              <div key={probe.id}><span className={probe.ok ? 'probe-ok' : 'probe-failed'}>{probe.ok ? 'Passed' : 'Failed'}</span>
                <time>{new Date(probe.checked_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</time>
                <small>Streaming {probe.streaming ? 'yes' : 'no'} · tools {probe.tool_calling ? 'yes' : 'no'}</small>
              </div>
            ))}
          </div>
        </section>
      </div>
      {message && <p className="provider-manager-status" role="status">{message}</p>}
    </dialog>
  )
}

function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return
  const focusable = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ]
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function draftDataBoundary(kind: ProviderKind, endpoint: string): DataBoundary {
  if (kind === 'foundry') return 'external'
  try {
    const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/g, '').toLocaleLowerCase()
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1') {
      return 'machine'
    }
    const octets = hostname.split('.').map(Number)
    if (octets.length === 4 && octets.every((value) => Number.isInteger(value))) {
      if (octets[0] === 127) return 'machine'
      if (
        octets[0] === 10 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 169 && octets[1] === 254)
      ) {
        return 'local_network'
      }
    }
  } catch {
    return 'external'
  }
  return 'external'
}

function mergeSessionDetail(
  current: SessionDetail | null,
  loaded: SessionDetail,
): SessionDetail {
  if (!current || current.id !== loaded.id) return loaded
  const events = new Map(loaded.events.map((event) => [event.id, event]))
  for (const event of current.events) events.set(event.id, event)
  return {
    ...loaded,
    events: [...events.values()].sort((left, right) => left.sequence - right.sequence),
  }
}

function latestProgressTasks(session: SessionDetail): TaskItem[] | null {
  const progress = session.events.findLast((event) => event.type === 'task_progress')
  return progress ? payloadTasks(progress) : null
}

function App() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [providerManagerOpen, setProviderManagerOpen] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [selectedCraftProviderId, setSelectedCraftProviderId] = useState('')
  const [selectedSession, setSelectedSession] = useState<SessionDetail | null>(null)
  const [providerDraft, setProviderDraft] = useState(defaultProvider)
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [liveResponse, setLiveResponse] = useState('')
  const [status, setStatus] = useState<
    'idle' | 'connecting' | 'reconnecting' | 'ready' | 'running'
  >('idle')
  const [notice, setNotice] = useState('')
  const [showProviderForm, setShowProviderForm] = useState(false)
  const [showSessionSettings, setShowSessionSettings] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [contextCollapsed, setContextCollapsed] = useState(false)
  const [sessionState, setSessionState] = useState<SessionState | null>(null)
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [memories, setMemories] = useState<Memory[]>([])
  const [memoryName, setMemoryName] = useState('')
  const [memoryContent, setMemoryContent] = useState('')
  const [contextBusy, setContextBusy] = useState(false)
  const [workspace, setWorkspace] = useState<WorkspaceContext | null>(null)
  const [workspacePath, setWorkspacePath] = useState('')
  const [sessionTitleDraft, setSessionTitleDraft] = useState('')
  const [instructions, setInstructions] = useState<InstructionSource[]>([])
  const [sessionInstructionDraft, setSessionInstructionDraft] = useState('')
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [hooks, setHooks] = useState<HookSummary[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([])
  const [subagents, setSubagents] = useState<SubagentSummary[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([])
  const [artifactQuery, setArtifactQuery] = useState('')
  const [artifactPreview, setArtifactPreview] = useState<ArtifactPreview | null>(null)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const socketRef = useRef<WebSocket | null>(null)
  const providerImportRef = useRef<HTMLInputElement | null>(null)
  const providerManagerTriggerRef = useRef<HTMLButtonElement>(null)
  const archiveImportRef = useRef<HTMLInputElement | null>(null)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const commandSearchRef = useRef<HTMLInputElement | null>(null)
  const commandTriggerRef = useRef<HTMLButtonElement | null>(null)
  const commandPaletteRef = useRef<HTMLElement | null>(null)
  const priorFocusRef = useRef<HTMLElement | null>(null)
  const transcriptRef = useRef<HTMLElement | null>(null)
  const followTranscriptRef = useRef(true)
  const selectedSessionId = selectedSession?.id

  const refreshProviders = useCallback(async () => {
    const loaded = await api<Provider[]>('/api/providers')
    setProviders(loaded)
    if (!selectedProviderId && loaded[0]) setSelectedProviderId(loaded[0].id)
  }, [selectedProviderId])

  const refreshSessions = useCallback(async () => {
    setSessions(await api<SessionSummary[]>('/api/sessions'))
  }, [])

  const refreshContext = useCallback(async (sessionId: string) => {
    const [
      state,
      approvalList,
      memoryList,
      workspaceContext,
      instructionList,
      skillList,
      hookList,
      mcpServerList,
      subagentList,
      artifactList,
    ] = await Promise.all([
      api<SessionState>(`/api/sessions/${sessionId}/state`),
      api<Approval[]>(`/api/sessions/${sessionId}/approvals`),
      api<Memory[]>(`/api/sessions/${sessionId}/memories`),
      api<WorkspaceContext | null>(`/api/sessions/${sessionId}/workspace`),
      api<InstructionSource[]>(`/api/sessions/${sessionId}/instructions`),
      api<SkillSummary[]>(`/api/sessions/${sessionId}/skills`),
      api<HookSummary[]>(`/api/sessions/${sessionId}/hooks`),
      api<McpServerSummary[]>(`/api/sessions/${sessionId}/mcp-servers`),
      api<SubagentSummary[]>(`/api/sessions/${sessionId}/subagents`),
      api<ArtifactSummary[]>(`/api/sessions/${sessionId}/artifacts`),
    ])
    setSessionState(state)
    setApprovals(approvalList)
    setMemories(memoryList)
    setWorkspace(workspaceContext)
    setWorkspacePath(workspaceContext?.root_path ?? '')
    setInstructions(instructionList)
    setSessionInstructionDraft(
      instructionList.find((source) => source.scope === 'session')?.content ?? '',
    )
    setSkills(skillList)
    setHooks(hookList)
    setMcpServers(mcpServerList)
    setSubagents(subagentList)
    setArtifacts(artifactList)
    setArtifactPreview((current) =>
      current && artifactList.some((artifact) => artifact.id === current.id) ? current : null,
    )
    return state
  }, [])

  useEffect(() => {
    Promise.all([refreshProviders(), refreshSessions()]).catch((error: unknown) =>
      setNotice(error instanceof Error ? error.message : 'Failed to load the application.'),
    )
  }, [refreshProviders, refreshSessions])

  useEffect(() => {
    const counsel = providers.find((provider) => provider.id === selectedProviderId)
    const craft = providers.find((provider) => provider.id === selectedCraftProviderId)
    if (counsel?.kind !== 'foundry' || (selectedCraftProviderId && (!craft || craft.kind !== 'local'))) {
      setSelectedCraftProviderId('')
    }
  }, [providers, selectedCraftProviderId, selectedProviderId])

  useEffect(() => {
    followTranscriptRef.current = true
  }, [selectedSessionId])

  useEffect(() => {
    setSessionTitleDraft(selectedSession?.title ?? '')
  }, [selectedSession?.id, selectedSession?.title])

  useLayoutEffect(() => {
    if (!followTranscriptRef.current) return
    const transcript = transcriptRef.current
    if (transcript) transcript.scrollTop = transcript.scrollHeight
  }, [selectedSession?.events, liveResponse])

  useEffect(() => {
    if (!selectedSessionId) {
      socketRef.current?.close()
      socketRef.current = null
      setStatus('idle')
      return
    }

    let disposed = false
    let reconnectTimer: number | undefined
    let reconnectAttempt = 0
    const sessionId = selectedSessionId
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const streamUrl = `${protocol}://${window.location.host}/api/sessions/${sessionId}/stream`

    function connect() {
      setStatus(reconnectAttempt ? 'reconnecting' : 'connecting')
      const socket = new WebSocket(streamUrl)
      socketRef.current = socket
      socket.onopen = () => {
        reconnectAttempt = 0
        setStatus('ready')
        setNotice('')
        void Promise.all([
          api<SessionDetail>(`/api/sessions/${sessionId}`),
          refreshContext(sessionId),
        ])
          .then(([loaded, state]) => {
            setSelectedSession((current) => mergeSessionDetail(current, loaded))
            const tasks = state.is_running ? latestProgressTasks(loaded) : null
            if (tasks) setSessionState({ ...state, tasks })
          })
          .catch((error: unknown) =>
            setNotice(error instanceof Error ? error.message : 'Could not refresh the session.'),
          )
      }
      socket.onclose = (event) => {
        if (socketRef.current === socket) socketRef.current = null
        if (disposed) return
        if (event.code === 4404) {
          setStatus('idle')
          setNotice('This session no longer exists.')
          return
        }
        reconnectAttempt += 1
        const delay = Math.min(1000 * 2 ** (reconnectAttempt - 1), 10_000)
        setStatus('reconnecting')
        setNotice(`Connection lost. Reconnecting in ${delay / 1000} seconds...`)
        reconnectTimer = window.setTimeout(connect, delay)
      }
      socket.onerror = () => socket.close()
      socket.onmessage = (message) => {
        const packet = JSON.parse(message.data as string) as {
          type: string
          payload?: { content?: string; message?: string; title?: string }
          event?: HarnessEvent
        }
        if (packet.type === 'assistant_delta') {
          setLiveResponse((current) => current + (packet.payload?.content ?? ''))
        } else if (packet.type === 'event' && packet.event) {
          const event = packet.event
          setSelectedSession((current) => {
            if (!current || current.events.some((currentEvent) => currentEvent.id === event.id)) {
              return current
            }
            return {
              ...current,
              title:
                event.type === 'session_title_updated'
                  ? String(event.payload.title ?? current.title)
                  : current.title,
              events: [...current.events, event],
            }
          })
          if (event.type === 'assistant_message') setLiveResponse('')
          if (event.type === 'run_started') setStatus('running')
          if (event.type === 'task_progress') {
            const tasks = payloadTasks(event)
            if (tasks) {
              setSessionState((current) => ({
                mode: current?.mode ?? 'plan',
                tasks,
                is_running: true,
              }))
            }
          }
          if (
            event.type === 'run_completed' ||
            event.type === 'run_failed' ||
            event.type === 'run_cancelled' ||
            event.type === 'run_waiting_approval'
          ) {
            setStatus('ready')
            void refreshSessions()
            void refreshContext(sessionId)
          }
        } else if (packet.type === 'error') {
          setNotice(packet.payload?.message ?? 'The run failed.')
          setStatus('ready')
        }
      }
    }

    connect()

    return () => {
      disposed = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      const socket = socketRef.current
      socketRef.current = null
      if (socket) socket.close(1000, 'Session changed')
    }
  }, [refreshContext, refreshSessions, selectedSessionId])

  const messages = useMemo(
    () =>
      selectedSession?.events.filter(
        (event) => event.type === 'user_message' || event.type === 'assistant_message',
      ) ?? [],
    [selectedSession?.events],
  )
  const activityEvents = useMemo(
    () =>
      selectedSession?.events.filter(
        (event) => event.type !== 'user_message' && event.type !== 'assistant_message',
      ) ?? [],
    [selectedSession?.events],
  )
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending')
  const hasPendingApproval = pendingApprovals.length > 0
  const canSendPrompt = status === 'ready' && !hasPendingApproval && !contextBusy && !sessionState?.is_running
  const latestContextUsage = useMemo(
    () => activityEvents.findLast((event) => event.type === 'context_usage') ?? null,
    [activityEvents],
  )
  const latestRunStatus = useMemo(
    () => activityEvents.findLast((event) => event.type === 'run_status') ?? null,
    [activityEvents],
  )
  const latestRunOutcome = useMemo(
    () =>
      activityEvents.findLast((event) =>
        ['run_started', 'run_completed', 'run_failed', 'run_cancelled', 'run_waiting_approval'].includes(
          event.type,
        ),
      ) ?? null,
    [activityEvents],
  )
  const latestFailure = latestRunOutcome?.type === 'run_failed' ? latestRunOutcome : null
  const failureView = latestFailure ? describeActivity(latestFailure) : null
  const progressHints = useMemo(() => {
    if (status !== 'running' && !hasPendingApproval) return []
    const runStartIndex = activityEvents.findLastIndex((event) => event.type === 'run_started')
    const hints = activityEvents
      .slice(Math.max(runStartIndex, 0))
      .map(progressHint)
      .filter((hint): hint is string => hint !== null)
      .filter((hint, index, values) => index === 0 || hint !== values[index - 1])
    return hints.slice(-4)
  }, [activityEvents, hasPendingApproval, status])
  const visibleArtifacts = useMemo(() => {
    const query = artifactQuery.trim().toLocaleLowerCase()
    return query
      ? artifacts.filter((artifact) =>
          artifact.title.toLocaleLowerCase().includes(query) ||
          artifact.versions.some((version) =>
            version.version === artifact.current_version && version.file_name.toLocaleLowerCase().includes(query),
          ),
        )
      : artifacts
  }, [artifactQuery, artifacts])
  const outputStats = useMemo(() => describeOutputs(artifacts), [artifacts])
  const showContext = Boolean(selectedSession && !showProviderForm && !showSessionSettings)
  const providerChoices = useMemo<ModelChoice[]>(() => {
    if (!providers.length) return [{ id: '', name: 'Choose a model', model: 'Select a configured provider', boundary: null }]
    return providers.map((provider) => ({
      id: provider.id, name: provider.name, model: provider.model,
      boundary: provider.data_boundary, kind: provider.kind,
    }))
  }, [providers])

  async function saveProvider(event: FormEvent) {
    event.preventDefault()
    setNotice('')
    try {
      const saved = await api<Provider>(
        editingProviderId ? `/api/providers/${editingProviderId}` : '/api/providers',
        {
          method: editingProviderId ? 'PUT' : 'POST',
          body: JSON.stringify({
            ...providerDraft,
            api_key_env: providerDraft.api_key_env || null,
          }),
        },
      )
      setProviders((current) =>
        editingProviderId
          ? current.map((provider) => (provider.id === saved.id ? saved : provider))
          : [...current, saved],
      )
      setSelectedProviderId((current) => !editingProviderId || editingProviderId === current ? saved.id : current)
      setProviderDraft(defaultProvider)
      setEditingProviderId(null)
      setShowProviderForm(false)
      setNotice('Provider profile saved. Test the connection before relying on it.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save the provider.')
    }
  }

  function addProvider() {
    setEditingProviderId(null)
    setProviderDraft(defaultProvider)
    setShowProviderForm(true)
  }

  function editProvider(providerId = selectedProviderId) {
    const provider = providers.find((item) => item.id === providerId)
    if (!provider) return
    setEditingProviderId(provider.id)
    setProviderDraft({
      name: provider.name,
      kind: provider.kind,
      endpoint: provider.endpoint,
      model: provider.model,
      api_key_env: provider.api_key_env ?? '',
      max_context_window_tokens: provider.max_context_window_tokens,
      max_output_tokens: provider.max_output_tokens,
    })
    setShowProviderForm(true)
  }

  async function deleteProvider(providerId = selectedProviderId) {
    const provider = providers.find((item) => item.id === providerId)
    if (!provider || !window.confirm(`Delete provider "${provider.name}"?`)) return
    try {
      await api<void>(`/api/providers/${provider.id}`, { method: 'DELETE' })
      const remaining = providers.filter((item) => item.id !== provider.id)
      setProviders(remaining)
      setSelectedProviderId((current) => current === provider.id ? remaining[0]?.id ?? '' : current)
      setNotice('Provider profile deleted.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not delete the provider.')
    }
  }

  async function exportProviders() {
    try {
      const configuration = await api<Record<string, unknown>>('/api/providers/export')
      const blob = new Blob([JSON.stringify(configuration, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'prudence-providers.json'
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not export providers.')
    }
  }

  async function importProviders(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const configuration = JSON.parse(await file.text()) as unknown
      const imported = await api<Provider[]>('/api/providers/import', {
        method: 'POST',
        body: JSON.stringify(configuration),
      })
      setProviders((current) => [...current, ...imported])
      if (imported[0]) setSelectedProviderId(imported[0].id)
      setNotice(`Imported ${imported.length} provider profile${imported.length === 1 ? '' : 's'}.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not import providers.')
    }
  }

  async function exportSessionArchive() {
    if (!selectedSessionId) return
    try {
      const archive = await api<Record<string, unknown>>(
        `/api/sessions/${selectedSessionId}/export`,
      )
      const blob = new Blob([JSON.stringify(archive, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `prudence-session-${selectedSessionId}.json`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not export the session archive.')
    }
  }

  async function importSessionArchive(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !selectedProviderId) return
    try {
      const archive = JSON.parse(await file.text()) as unknown
      const imported = await api<SessionSummary>('/api/sessions/import', {
        method: 'POST',
        body: JSON.stringify({ provider_id: selectedProviderId, archive }),
      })
      await refreshSessions()
      await openSession(imported.id)
      setNotice('Session archive imported without provider secrets or resumable run state.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not import the session archive.')
    }
  }

  async function createSession() {
    if (!selectedProviderId) {
      setNotice('Create or select a provider first.')
      return
    }

    try {
      const created = await api<SessionSummary>('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          provider_id: selectedProviderId,
          craft_provider_id: selectedCraftProviderId || null,
          title: 'New session',
        }),
      })
      await refreshSessions()
      await openSession(created.id)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create the session.')
    }
  }

  function openCommandPalette() {
    const activeElement = document.activeElement
    priorFocusRef.current =
      activeElement instanceof HTMLElement && activeElement !== document.body
        ? activeElement
        : null
    setCommandQuery('')
    setCommandPaletteOpen(true)
  }

  function closeProviderManager() {
    setProviderManagerOpen(false)
    providerManagerTriggerRef.current?.focus()
  }

  function closeCommandPalette() {
    setCommandPaletteOpen(false)
    window.setTimeout(
      () => {
        const prior = priorFocusRef.current
        const target = prior?.isConnected && prior.getClientRects().length ? prior : commandTriggerRef.current
        target?.focus()
      },
      0,
    )
  }

  function toggleSidebar() {
    if (!sidebarCollapsed && document.activeElement?.closest('#workspace-sidebar')) commandTriggerRef.current?.focus()
    setSidebarCollapsed((current) => !current)
  }

  function toggleContext() {
    if (!contextCollapsed && document.activeElement?.closest('#session-context')) commandTriggerRef.current?.focus()
    setContextCollapsed((current) => !current)
  }

  async function openSession(sessionId: string) {
    setNotice('')
    setLiveResponse('')
    setShowSessionSettings(false)
    try {
      const loaded = await api<SessionDetail>(`/api/sessions/${sessionId}`)
      setSelectedProviderId(loaded.provider_id)
      setSelectedCraftProviderId(loaded.craft_provider_id ?? '')
      const state = await refreshContext(sessionId)
      setSelectedSession(loaded)
      const tasks = state.is_running ? latestProgressTasks(loaded) : null
      if (tasks) setSessionState({ ...state, tasks })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not load the session.')
    }
  }

  async function deleteSession(session: SessionSummary) {
    if (!window.confirm(`Delete session "${session.title}"? This cannot be undone.`)) return
    try {
      await api<void>(`/api/sessions/${session.id}`, { method: 'DELETE' })
      const remaining = sessions.filter((item) => item.id !== session.id)
      setSessions(remaining)
      if (selectedSession?.id === session.id) {
        setSelectedSession(null)
        setShowSessionSettings(false)
        setLiveResponse('')
        setWorkspace(null)
        if (remaining[0]) await openSession(remaining[0].id)
      }
      setNotice('Session deleted.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not delete the session.')
    }
  }

  function submitPrompt(event: FormEvent) {
    event.preventDefault()
    sendPrompt(prompt)
  }

  function sendPrompt(value: string, clearDraft = true) {
    const content = value.trim()
    if (!content) {
      setNotice('Enter a prompt before sending.')
      return
    }
    if (!canSendPrompt) {
      setNotice(hasPendingApproval
        ? 'Resolve the pending approval before running a prompt.'
        : 'Wait for the current run or session update to finish before sending.')
      return
    }
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setNotice('The session is disconnected. Wait for it to reconnect before sending.')
      return
    }
    followTranscriptRef.current = true
    setNotice('')
    if (clearDraft) setPrompt('')
    setLiveResponse('')
    setStatus('running')
    socketRef.current.send(JSON.stringify({ type: 'prompt', content }))
  }

  function editAndRerun(content: string) {
    if (!canSendPrompt) {
      setNotice('Wait until the session is ready before editing a prompt to rerun.')
      return
    }
    if (prompt && prompt !== content && !window.confirm('Replace the current draft with this prompt?')) return
    setPrompt(content)
    setNotice('')
    promptRef.current?.focus()
  }

  async function updateMode(mode: SessionState['mode']) {
    if (!selectedSessionId) return
    setContextBusy(true)
    try {
      setSessionState(
        await api<SessionState>(`/api/sessions/${selectedSessionId}/mode`, {
          method: 'PUT',
          body: JSON.stringify({ mode }),
        }),
      )
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not update the agent mode.')
    } finally {
      setContextBusy(false)
    }
  }

  async function approvePlanAndExecute() {
    if (
      !selectedSessionId ||
      !socketRef.current ||
      status !== 'ready' ||
      !sessionState?.tasks.some((task) => !task.is_complete)
    ) {
      return
    }
    setContextBusy(true)
    try {
      const updated = await api<SessionState>(
        `/api/sessions/${selectedSessionId}/plan/approve`,
        { method: 'POST' },
      )
      setSessionState(updated)
      setStatus('running')
      setLiveResponse('')
      socketRef.current.send(
        JSON.stringify({
          type: 'prompt',
          content: 'Execute the approved plan. Complete every remaining todo item.',
        }),
      )
    } catch (error) {
      setStatus('ready')
      setNotice(error instanceof Error ? error.message : 'Could not start the approved plan.')
    } finally {
      setContextBusy(false)
    }
  }

  async function decideApproval(approvalId: string, approved: boolean) {
    if (!selectedSessionId) return
    setContextBusy(true)
    setStatus('running')
    try {
      await api<Approval>(`/api/approvals/${approvalId}/decision`, {
        method: 'POST',
        body: JSON.stringify({ approved }),
      })
      const loaded = await api<SessionDetail>(`/api/sessions/${selectedSessionId}`)
      setSelectedSession(loaded)
      await refreshContext(selectedSessionId)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not decide the approval.')
    } finally {
      setStatus('ready')
      setContextBusy(false)
    }
  }

  async function addMemory(event: FormEvent) {
    event.preventDefault()
    if (!selectedSessionId || !memoryName.trim()) return
    setContextBusy(true)
    try {
      await api<Memory>(`/api/sessions/${selectedSessionId}/memories`, {
        method: 'POST',
        body: JSON.stringify({
          file_name: memoryName.trim(),
          content: memoryContent,
        }),
      })
      setMemoryName('')
      setMemoryContent('')
      await refreshContext(selectedSessionId)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save the memory.')
    } finally {
      setContextBusy(false)
    }
  }

  async function bindWorkspace(event: FormEvent) {
    event.preventDefault()
    if (!selectedSessionId || !workspacePath.trim()) return
    setContextBusy(true)
    try {
      const bound = await api<WorkspaceContext>(
        `/api/sessions/${selectedSessionId}/workspace`,
        {
          method: 'PUT',
          body: JSON.stringify({ path: workspacePath.trim() }),
        },
      )
      setWorkspace(bound)
      setWorkspacePath(bound.root_path)
      const [loaded, instructionList, skillList, hookList, subagentList] = await Promise.all([
        api<SessionDetail>(`/api/sessions/${selectedSessionId}`),
        api<InstructionSource[]>(`/api/sessions/${selectedSessionId}/instructions`),
        api<SkillSummary[]>(`/api/sessions/${selectedSessionId}/skills`),
        api<HookSummary[]>(`/api/sessions/${selectedSessionId}/hooks`),
        api<SubagentSummary[]>(`/api/sessions/${selectedSessionId}/subagents`),
      ])
      setInstructions(instructionList)
      setSkills(skillList)
      setHooks(hookList)
      setSubagents(subagentList)
      setSelectedSession((current) => mergeSessionDetail(current, loaded))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not bind the workspace.')
    } finally {
      setContextBusy(false)
    }
  }

  async function renameSession(event: FormEvent) {
    event.preventDefault()
    const title = sessionTitleDraft.trim()
    if (!selectedSessionId || !title || title === selectedSession?.title) return
    setContextBusy(true)
    try {
      const updated = await api<SessionSummary>(`/api/sessions/${selectedSessionId}/title`, {
        method: 'PUT',
        body: JSON.stringify({ title }),
      })
      setSelectedSession((current) =>
        current?.id === updated.id ? { ...current, ...updated } : current,
      )
      setSessionTitleDraft(updated.title)
      await refreshSessions()
      setNotice('Session renamed.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not rename the session.')
    } finally {
      setContextBusy(false)
    }
  }

  async function saveSessionInstructions(event: FormEvent) {
    event.preventDefault()
    if (!selectedSessionId || !sessionInstructionDraft.trim()) return
    setContextBusy(true)
    try {
      const loaded = await api<InstructionSource[]>(
        `/api/sessions/${selectedSessionId}/instructions`,
        {
          method: 'PUT',
          body: JSON.stringify({ content: sessionInstructionDraft }),
        },
      )
      setInstructions(loaded)
      setSessionInstructionDraft(
        loaded.find((source) => source.scope === 'session')?.content ?? '',
      )
      setNotice('Session instructions saved.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save session instructions.')
    } finally {
      setContextBusy(false)
    }
  }

  async function clearSessionInstructions() {
    if (!selectedSessionId) return
    setContextBusy(true)
    try {
      setInstructions(
        await api<InstructionSource[]>(`/api/sessions/${selectedSessionId}/instructions`, {
          method: 'DELETE',
        }),
      )
      setSessionInstructionDraft('')
      setNotice('Session instructions cleared.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not clear session instructions.')
    } finally {
      setContextBusy(false)
    }
  }

  async function chooseWorkspaceDirectory() {
    setContextBusy(true)
    try {
      const selection = await api<WorkspaceDirectorySelection>('/api/workspace/select-directory', {
        method: 'POST',
      })
      if (selection.path) setWorkspacePath(selection.path)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not open the folder picker.')
    } finally {
      setContextBusy(false)
    }
  }

  async function toggleWorkspaceWriteTools() {
    if (!selectedSessionId || !workspace) return
    setContextBusy(true)
    try {
      const updated = await api<WorkspaceContext>(
        `/api/sessions/${selectedSessionId}/workspace/capabilities`,
        {
          method: 'PUT',
          body: JSON.stringify({ write_tools_enabled: !workspace.write_tools_enabled }),
        },
      )
      setWorkspace(updated)
      const loaded = await api<SessionDetail>(`/api/sessions/${selectedSessionId}`)
      setSelectedSession((current) => mergeSessionDetail(current, loaded))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not update workspace tools.')
    } finally {
      setContextBusy(false)
    }
  }

  async function toggleWorkspaceAutoApprove() {
    if (!selectedSessionId || !workspace || !workspace.write_tools_enabled) return
    setContextBusy(true)
    try {
      const updated = await api<WorkspaceContext>(
        `/api/sessions/${selectedSessionId}/workspace/capabilities`,
        {
          method: 'PUT',
          body: JSON.stringify({ auto_approve_enabled: !workspace.auto_approve_enabled }),
        },
      )
      setWorkspace(updated)
      const loaded = await api<SessionDetail>(`/api/sessions/${selectedSessionId}`)
      setSelectedSession((current) => mergeSessionDetail(current, loaded))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not update auto-approve.')
    } finally {
      setContextBusy(false)
    }
  }

  async function openArtifact(artifactId: string, version?: number) {
    if (!selectedSessionId) return
    setContextBusy(true)
    try {
      const suffix = version ? `?version=${version}` : ''
      setArtifactPreview(
        await api<ArtifactPreview>(
          `/api/sessions/${selectedSessionId}/artifacts/${artifactId}${suffix}`,
        ),
      )
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not preview the artifact.')
    } finally {
      setContextBusy(false)
    }
  }

  async function cancelRun() {
    if (!selectedSessionId) return
    try {
      const result = await api<{ cancelled: boolean }>(
        `/api/sessions/${selectedSessionId}/cancel`,
        { method: 'POST' },
      )
      if (!result.cancelled) setNotice('The run had already stopped.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not stop the run.')
    }
  }

  function retryLastRun() {
    if (
      !selectedSession ||
      !latestFailure ||
      latestFailure.payload.retryable !== true ||
      status !== 'ready' ||
      !socketRef.current
    ) {
      return
    }
    const lastPrompt = selectedSession.events.findLast((event) => event.type === 'user_message')
    const content = lastPrompt ? payloadText(lastPrompt, 'content') : null
    if (!content) {
      setNotice('The original prompt is unavailable, so this run cannot be retried.')
      return
    }
    sendPrompt(content, false)
  }

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId)
  const sessionProvider = providers.find(
    (provider) => provider.id === selectedSession?.provider_id,
  )
  const sessionCraftProvider = providers.find(
    (provider) => provider.id === selectedSession?.craft_provider_id,
  )
  const contextPercent = Math.min(
    100,
    Math.max(0, latestContextUsage ? (payloadNumber(latestContextUsage, 'context_percent') ?? 0) : 0),
  )
  const workspaceCommands: WorkspaceCommand[] = [
    {
      id: 'new-session',
      label: 'Create new session',
      shortcut: 'Alt+N',
      disabled: !selectedProviderId,
      run: () => void createSession(),
    },
    {
      id: 'focus-composer',
      label: 'Focus message composer',
      shortcut: '/',
      disabled: !selectedSession || status !== 'ready',
      run: () => promptRef.current?.focus(),
    },
    {
      id: 'configure-provider',
      label: 'Add model provider',
      run: addProvider,
    },
    {
      id: 'toggle-left-sidebar',
      label: `${sidebarCollapsed ? 'Expand' : 'Collapse'} left sidebar`,
      shortcut: 'Alt+V',
      run: toggleSidebar,
    },
    {
      id: 'toggle-right-pane',
      label: `${contextCollapsed ? 'Expand' : 'Collapse'} right pane`,
      shortcut: 'Ctrl+Alt+V',
      disabled: !showContext,
      run: toggleContext,
    },
    {
      id: 'choose-workspace',
      label: 'Choose workspace folder',
      disabled: !selectedSession,
      run: () => void chooseWorkspaceDirectory(),
    },
    {
      id: 'export-session',
      label: 'Export portable session archive',
      disabled: !selectedSession,
      run: () => void exportSessionArchive(),
    },
    {
      id: 'import-session',
      label: 'Import portable session archive',
      disabled: !selectedProviderId,
      run: () => archiveImportRef.current?.click(),
    },
    {
      id: 'stop-run',
      label: 'Stop active run',
      shortcut: 'Escape',
      disabled: status !== 'running',
      run: () => void cancelRun(),
    },
  ]
  const visibleCommands = workspaceCommands.filter((command) =>
    command.label.toLocaleLowerCase().includes(commandQuery.trim().toLocaleLowerCase()),
  )

  useEffect(() => {
    if (commandPaletteOpen) commandSearchRef.current?.focus()
  }, [commandPaletteOpen])

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (providerManagerOpen) return
      if (event.altKey && !event.metaKey && !event.shiftKey && !event.getModifierState('AltGraph') && event.key.toLocaleLowerCase() === 'v') {
        event.preventDefault()
        if (event.repeat) return
        if (event.ctrlKey) {
          if (showContext) toggleContext()
        } else toggleSidebar()
        if (commandPaletteOpen) closeCommandPalette()
        return
      }
      const target = event.target
      const isEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        openCommandPalette()
        return
      }
      if (event.altKey && event.key.toLocaleLowerCase() === 'n') {
        event.preventDefault()
        if (selectedProviderId) void createSession()
        return
      }
      if (event.key === 'Escape') {
        if (commandPaletteOpen) {
          event.preventDefault()
          closeCommandPalette()
        } else if (status === 'running') {
          event.preventDefault()
          void cancelRun()
        }
        return
      }
      if (!isEditable && event.key === '/' && selectedSession && status === 'ready') {
        event.preventDefault()
        promptRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  })

  return (
    <div
      className={`shell ${showContext ? 'has-context' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}${contextCollapsed ? ' context-collapsed' : ''}`}
    >
      <aside className="sidebar" id="workspace-sidebar" aria-label="Sessions and providers" hidden={sidebarCollapsed}>
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <img src="/prudence-icon.png" alt="" />
          </div>
          <div>
            <strong>Prudence</strong>
            <span>Agent harness</span>
          </div>
        </div>

        <button className="primary full" type="button" onClick={() => void createSession()}>
          <span aria-hidden="true">+</span> New session
        </button>
        <details className="workspace-menu">
          <summary>Workspace menu</summary>
          <div>
            <button type="button" onClick={openCommandPalette}>
              Commands <kbd>Ctrl K</kbd>
            </button>
            <button type="button" onClick={() => promptRef.current?.focus()} disabled={!selectedSession}>
              Focus composer <kbd>/</kbd>
            </button>
            <button type="button" onClick={addProvider}>
              Add provider
            </button>
            <button type="button" onClick={() => void exportSessionArchive()} disabled={!selectedSession}>
              Export session
            </button>
            <button type="button" onClick={() => archiveImportRef.current?.click()} disabled={!selectedProviderId}>
              Import session
            </button>
          </div>
        </details>
        <input
          ref={archiveImportRef}
          className="visually-hidden"
          type="file"
          accept="application/json,.json"
          aria-label="Import portable session archive"
          onChange={(event) => void importSessionArchive(event)}
        />

        <nav aria-label="Sessions">
          <p className="eyebrow">Sessions</p>
          {sessions.length === 0 ? (
            <p className="empty-copy">No sessions yet.</p>
          ) : (
            sessions.map((session) => (
              <div className="session-row" key={session.id}>
                <button
                  className={`session-item ${selectedSession?.id === session.id ? 'active' : ''}`}
                  type="button"
                  aria-current={selectedSession?.id === session.id ? 'page' : undefined}
                  onClick={() => void openSession(session.id)}
                >
                  <span>{session.title}</span>
                  <time>{new Date(session.updated_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</time>
                </button>
                <button
                  className="session-delete"
                  disabled={selectedSession?.id === session.id && status === 'running'}
                  type="button"
                  aria-label={`Delete session ${session.title}`}
                  title="Delete session"
                  onClick={() => void deleteSession(session)}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </nav>

        <div className="provider-panel">
          <div className="provider-heading">
            <p className="eyebrow">Model provider</p>
            <button className="provider-add" type="button" onClick={addProvider} aria-label="Add provider" title="Add provider">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </div>
          <ModelPicker
            choices={providerChoices}
            value={selectedProviderId}
            onChange={setSelectedProviderId}
            label="Active model provider"
            heading="Available providers"
            triggerClassName="provider-selector"
          >
            <span className="provider-trigger-icon">
              {selectedProvider ? <ProviderSymbol kind={selectedProvider.kind} /> : <span aria-hidden="true">+</span>}
            </span>
            <span className="provider-trigger-copy">
              <strong title={selectedProvider?.name}>{selectedProvider ? providerDisplayName(selectedProvider) : 'Choose a model'}</strong>
              {(!selectedProvider || providerDisplayName(selectedProvider) !== selectedProvider.model) && (
                <small title={selectedProvider?.model}>{selectedProvider?.model ?? 'Select a configured provider'}</small>
              )}
            </span>
          </ModelPicker>
          {!providers.length && <p className="provider-empty">Add a provider to connect your first model.</p>}
            {selectedProvider && (
              <>
              <div className={`data-boundary ${selectedProvider.data_boundary}`}>
                <strong>{selectedProvider.data_boundary.replaceAll('_', ' ')}</strong>
                <span>{dataBoundaryLabel(selectedProvider.data_boundary)}</span>
              </div>
              <dl className="provider-limits">
                <div>
                  <dt>Context</dt>
                  <dd>{selectedProvider.max_context_window_tokens.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Output</dt>
                  <dd>{selectedProvider.max_output_tokens.toLocaleString()}</dd>
                </div>
              </dl>
              {selectedProvider.kind === 'foundry' && (
                <CraftPicker
                  key={selectedProvider.id}
                  counsel={selectedProvider}
                  providers={providers}
                  value={selectedCraftProviderId}
                  onChange={setSelectedCraftProviderId}
                />
              )}
              </>
            )}
            <button
              ref={providerManagerTriggerRef}
              className="provider-manager-trigger"
              type="button"
              aria-haspopup="dialog"
              onClick={() => setProviderManagerOpen(true)}
            >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16M9 4v6M15 14v6" /></svg>
                Manage providers
            </button>
            <input
              ref={providerImportRef}
              className="visually-hidden"
              type="file"
              accept="application/json,.json"
              aria-label="Import provider configuration"
              onChange={(event) => void importProviders(event)}
            />
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">
              {showSessionSettings ? 'Session settings' : 'Agent workspace'}
            </p>
            <h1>{selectedSession?.title ?? 'Welcome'}</h1>
          </div>
          {selectedSession && !showProviderForm && !showSessionSettings && !sessionCraftProvider && (
            <div className="mode-toggle" role="group" aria-label="Agent mode">
              {(['plan', 'execute'] as const).map((mode) => (
                <button
                  className={sessionState?.mode === mode ? 'selected' : ''}
                  aria-pressed={sessionState?.mode === mode}
                  disabled={contextBusy}
                  key={mode}
                  type="button"
                  onClick={() => void updateMode(mode)}
                >
                  {mode === 'plan' ? 'Plan' : 'Execute'}
                </button>
              ))}
            </div>
          )}
          <div className={`connection ${status}`} role="status" aria-live="polite">
            <span aria-hidden="true" />
            {status === 'running' ? 'Agent working' : status === 'ready' ? 'Connected' : status}
          </div>
          <button
            ref={commandTriggerRef}
            className="command-trigger"
            type="button"
            onClick={openCommandPalette}
            aria-keyshortcuts="Control+K Meta+K"
          >
            Commands <kbd>Ctrl K</kbd>
          </button>
          {selectedSession && !showProviderForm && (
            <button
              className={`settings-button${showSessionSettings ? ' active' : ''}`}
              type="button"
              aria-pressed={showSessionSettings}
              aria-label={showSessionSettings ? 'Back to chat' : 'Session settings'}
              title={showSessionSettings ? 'Back to chat' : 'Session settings'}
              onClick={() => setShowSessionSettings((current) => !current)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                {showSessionSettings ? (
                  <path d="M6 6l12 12M18 6 6 18" />
                ) : (
                  <>
                    <path d="m9.6 2-.5 2.7c-.5.2-.9.4-1.3.7L5.2 4.5 2.8 8.6l2.1 1.8a8 8 0 0 0 0 1.5l-2.1 1.8 2.4 4.1 2.6-.9c.4.3.8.5 1.3.7l.5 2.7h4.8l.5-2.7c.5-.2.9-.4 1.3-.7l2.6.9 2.4-4.1-2.1-1.8a8 8 0 0 0 0-1.5l2.1-1.8-2.4-4.1-2.6.9c-.4-.3-.8-.5-1.3-.7L14.4 2H9.6Z" />
                    <circle cx="12" cy="12" r="3" />
                  </>
                )}
              </svg>
            </button>
          )}
          {status === 'running' && (
            <button className="danger" type="button" onClick={() => void cancelRun()}>
              Stop run
            </button>
          )}
        </header>

        {showProviderForm ? (
          <section className="setup-view" aria-labelledby="provider-heading">
            <div className="setup-card">
              <p className="eyebrow">Configuration</p>
              <h2 id="provider-heading">
                {editingProviderId ? 'Edit model provider' : 'Add a model provider'}
              </h2>
              <p>Credentials remain on the backend. The database stores only an environment-variable reference.</p>
              <form onSubmit={(event) => void saveProvider(event)}>
                <div className="segmented" role="group" aria-label="Provider type">
                  {(['local', 'foundry'] as const).map((kind) => (
                    <button
                      className={providerDraft.kind === kind ? 'selected' : ''}
                      key={kind}
                      type="button"
                      onClick={() =>
                        setProviderDraft((draft) => ({
                          ...draft,
                          kind,
                          name: kind === 'local' ? 'Local model' : 'Microsoft Foundry',
                          api_key_env: kind === 'local' ? draft.api_key_env : '',
                          endpoint:
                            kind === 'local'
                              ? 'http://127.0.0.1:11434/v1'
                              : 'https://example.services.ai.azure.com/api/projects/example',
                        }))
                      }
                    >
                      {kind === 'local' ? 'Local model' : 'Microsoft Foundry'}
                    </button>
                  ))}
                </div>
                <label>
                  Profile name
                  <input
                    required
                    value={providerDraft.name}
                    onChange={(event) => setProviderDraft({ ...providerDraft, name: event.target.value })}
                  />
                </label>
                <label>
                  {providerDraft.kind === 'foundry' ? 'Project endpoint' : 'OpenAI-compatible base URL'}
                  <input
                    required
                    type="url"
                    value={providerDraft.endpoint}
                    onChange={(event) => setProviderDraft({ ...providerDraft, endpoint: event.target.value })}
                  />
                </label>
                <label>
                  {providerDraft.kind === 'foundry' ? 'Deployment name' : 'Model name'}
                  <input
                    required
                    value={providerDraft.model}
                    onChange={(event) => setProviderDraft({ ...providerDraft, model: event.target.value })}
                    placeholder={providerDraft.kind === 'foundry' ? 'gpt-4.1' : 'qwen3'}
                  />
                </label>
                {providerDraft.kind === 'local' && (
                  <label>
                    API key environment variable <span>(optional)</span>
                    <input
                      value={providerDraft.api_key_env}
                      onChange={(event) =>
                        setProviderDraft({ ...providerDraft, api_key_env: event.target.value })
                      }
                      placeholder="LOCAL_MODEL_API_KEY"
                    />
                  </label>
                )}
                <div className="field-pair">
                  <label>
                    Context window tokens
                    <input
                      required
                      type="number"
                      min={1024}
                      value={providerDraft.max_context_window_tokens}
                      onChange={(event) =>
                        setProviderDraft({
                          ...providerDraft,
                          max_context_window_tokens: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    Maximum output tokens
                    <input
                      required
                      type="number"
                      min={256}
                      value={providerDraft.max_output_tokens}
                      onChange={(event) =>
                        setProviderDraft({
                          ...providerDraft,
                          max_output_tokens: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                </div>
                <div className="form-actions">
                  <button className="secondary" type="button" onClick={() => {
                    setShowProviderForm(false)
                    setEditingProviderId(null)
                    setProviderDraft(defaultProvider)
                  }}>
                    Cancel
                  </button>
                  <button className="primary" type="submit">Save profile</button>
                </div>
                <p className={`data-disclosure ${draftDataBoundary(providerDraft.kind, providerDraft.endpoint)}`}>
                  {dataBoundaryLabel(draftDataBoundary(providerDraft.kind, providerDraft.endpoint))}
                </p>
              </form>
            </div>
          </section>
        ) : selectedSession && showSessionSettings ? (
          <section className="session-settings-view" aria-labelledby="session-settings-heading">
            <div className="session-settings-heading">
              <p className="eyebrow">Session configuration</p>
              <h2 id="session-settings-heading">Settings</h2>
              <p>
                Configure the workspace context and capabilities that remain stable across this
                session.
              </p>
            </div>
            <form className="session-name-form" onSubmit={(event) => void renameSession(event)}>
              <label htmlFor="session-name">Session name</label>
              <div>
                <input
                  id="session-name"
                  maxLength={120}
                  value={sessionTitleDraft}
                  onChange={(event) => setSessionTitleDraft(event.target.value)}
                />
                <button
                  className="secondary"
                  disabled={
                    contextBusy
                    || status === 'running'
                    || !sessionTitleDraft.trim()
                    || sessionTitleDraft.trim() === selectedSession.title
                  }
                  type="submit"
                >
                  Rename
                </button>
              </div>
            </form>
            <div className="session-settings-grid">
              <CollapsibleContextSection id="workspace-section" eyebrow="Project scope" title="Workspace">
                <form className="workspace-form" onSubmit={(event) => void bindWorkspace(event)}>
                  <label>
                    Absolute local directory
                    <div className="workspace-path-row">
                      <input
                        aria-label="Workspace directory"
                        placeholder="C:\path\to\project"
                        value={workspacePath}
                        onChange={(event) => setWorkspacePath(event.target.value)}
                      />
                      <button
                        className="folder-picker"
                        disabled={contextBusy}
                        type="button"
                        aria-label="Choose workspace folder"
                        title="Choose workspace folder"
                        onClick={() => void chooseWorkspaceDirectory()}
                      >
                        <svg aria-hidden="true" viewBox="0 0 24 24">
                          <path d="M3.5 6.5h6l2 2h9v9a2 2 0 0 1-2 2h-15v-13Z" />
                          <path d="M3.5 9.5h17" />
                        </svg>
                      </button>
                    </div>
                  </label>
                  <button
                    className="secondary"
                    disabled={contextBusy || !workspacePath.trim()}
                    type="submit"
                  >
                    {workspace ? 'Refresh workspace' : 'Bind workspace'}
                  </button>
                </form>
                {workspace && (
                  <div className="workspace-summary">
                    <p title={workspace.root_path}>{workspace.root_path}</p>
                    <dl>
                      <div>
                        <dt>Files discovered</dt>
                        <dd>
                          {workspace.discovered_file_count.toLocaleString()}
                          {workspace.discovery_truncated ? '+' : ''}
                        </dd>
                      </div>
                      <div>
                        <dt>Instructions</dt>
                        <dd>{instructions.length}</dd>
                      </div>
                    </dl>
                    <div className="context-file-list" aria-label="Enabled read-only tools">
                      {workspace.read_tools.map((toolName) => (
                        <span key={toolName}>{toolName.replaceAll('_', ' ')}</span>
                      ))}
                    </div>
                    {workspace.write_tools.length > 0 && (
                      <div className="context-file-list" aria-label="Enabled approval-gated tools">
                        {workspace.write_tools.map((toolName) => (
                          <span key={toolName}>{toolName.replaceAll('_', ' ')}</span>
                        ))}
                      </div>
                    )}
                    <div className="context-file-list">
                      {workspace.context_files.map((file) => (
                        <span key={file.relative_path} title={`${file.size_bytes} bytes`}>
                          {file.relative_path}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </CollapsibleContextSection>

              <CollapsibleContextSection
                id="instructions-section"
                eyebrow="Ordered guidance"
                title="Instructions"
              >
                <div className="instruction-stack">
                  {instructions.length ? (
                    instructions.map((source) => (
                      <details
                        className="instruction-source"
                        key={`${source.scope}:${source.relative_path}`}
                      >
                        <summary>
                          <span>
                            {source.label}
                            <small>{source.scope.replaceAll('_', ' ')}</small>
                          </span>
                          <small>Priority {source.precedence}</small>
                        </summary>
                        <p>{source.relative_path}</p>
                        <pre>{source.content}</pre>
                      </details>
                    ))
                  ) : (
                    <p className="empty-copy">
                      No managed, user, project, local, or session guidance is active.
                    </p>
                  )}
                </div>
                <form
                  className="instruction-form"
                  onSubmit={(event) => void saveSessionInstructions(event)}
                >
                  <label>
                    Session override
                    <textarea
                      aria-label="Session instructions"
                      rows={4}
                      maxLength={65_536}
                      placeholder="Add guidance that applies only to this session"
                      value={sessionInstructionDraft}
                      onChange={(event) => setSessionInstructionDraft(event.target.value)}
                    />
                  </label>
                  <div className="button-row">
                    <button
                      className="secondary"
                      disabled={contextBusy || !sessionInstructionDraft.trim()}
                      type="submit"
                    >
                      Save override
                    </button>
                    <button
                      className="secondary"
                      disabled={
                        contextBusy || !instructions.some((source) => source.scope === 'session')
                      }
                      type="button"
                      onClick={() => void clearSessionInstructions()}
                    >
                      Clear
                    </button>
                  </div>
                </form>
              </CollapsibleContextSection>

              <CollapsibleContextSection id="skills-section" eyebrow="Reusable guidance" title="Skills">
                <div className="context-list">
                  {skills.length ? (
                    skills.map((skill) => (
                      <article className="skill-card" key={skill.name}>
                        <div>
                          <strong>{skill.name}</strong>
                          <span>{skill.source}</span>
                        </div>
                        <p>{skill.description}</p>
                        <small title={skill.relative_path}>
                          Precedence {skill.precedence} · {skill.relative_path}
                        </small>
                      </article>
                    ))
                  ) : (
                    <p className="empty-copy">
                      Add user skills under the harness data directory or project skills under
                      .prudence/skills.
                    </p>
                  )}
                </div>
              </CollapsibleContextSection>

              <CollapsibleContextSection id="hooks-section" eyebrow="Deterministic policy" title="Hooks">
                <div className="context-list">
                  {hooks.length ? (
                    hooks.map((hook) => (
                      <article className="skill-card hook-card" key={hook.id}>
                        <div>
                          <strong>{hook.id}</strong>
                          <span className={hook.action}>{hook.action}</span>
                        </div>
                        <p>
                          {hook.event.replaceAll('_', ' ')}
                          {hook.message ? ` · ${hook.message}` : ''}
                        </p>
                        <small title={hook.relative_path}>
                          {hook.source} · precedence {hook.precedence} · {hook.relative_path}
                        </small>
                      </article>
                    ))
                  ) : (
                    <p className="empty-copy">
                      Add declarative hooks in hooks.json or .prudence/hooks.json.
                    </p>
                  )}
                </div>
              </CollapsibleContextSection>

              <CollapsibleContextSection id="mcp-section" eyebrow="Trusted local tools" title="MCP servers">
                <div className="context-list">
                  {mcpServers.length ? (
                    mcpServers.map((server) => (
                      <article className="skill-card mcp-card" key={server.id}>
                        <div>
                          <strong>{server.id}</strong>
                          <span className={server.enabled ? '' : 'disabled'}>
                            {server.enabled ? 'enabled' : 'disabled'}
                          </span>
                        </div>
                        <p>{server.description}</p>
                        <small>
                          stdio · approval required · {server.allowed_tools.length} allowlisted tool
                          {server.allowed_tools.length === 1 ? '' : 's'}
                        </small>
                        {server.missing_env_vars.length > 0 && (
                          <p className="configuration-warning">
                            Missing environment: {server.missing_env_vars.join(', ')}
                          </p>
                        )}
                      </article>
                    ))
                  ) : (
                    <p className="empty-copy">
                      Add explicitly enabled local stdio servers in the harness mcp.json.
                    </p>
                  )}
                </div>
              </CollapsibleContextSection>

              <CollapsibleContextSection
                id="subagents-section"
                eyebrow="Bounded delegation"
                title="Subagents"
              >
                <div className="context-list">
                  {subagents.length ? (
                    subagents.map((subagent) => (
                      <article className="skill-card subagent-card" key={subagent.name}>
                        <div>
                          <strong>{subagent.name.replaceAll('_', ' ')}</strong>
                          <span>read only</span>
                        </div>
                        <p>{subagent.description}</p>
                        <div className="context-file-list" aria-label={`${subagent.name} permissions`}>
                          {subagent.permissions.map((permission) => (
                            <span key={permission}>{permission.replaceAll('_', ' ')}</span>
                          ))}
                        </div>
                        <small>
                          {subagent.timeout_seconds}s · {subagent.max_tool_calls} tool calls ·{' '}
                          {subagent.max_output_tokens.toLocaleString()} output tokens
                        </small>
                      </article>
                    ))
                  ) : (
                    <p className="empty-copy">
                      Bind a workspace to enable constrained explore and review delegation.
                    </p>
                  )}
                </div>
              </CollapsibleContextSection>
            </div>
          </section>
        ) : selectedSession ? (
          <>
            <section
              ref={transcriptRef}
              className="transcript"
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              aria-label="Conversation"
              onScroll={(event) => {
                const transcript = event.currentTarget
                followTranscriptRef.current =
                  transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 160
              }}
            >
              {messages.length === 0 && !liveResponse && progressHints.length === 0 ? (
                <div className="welcome-card">
                  <div className="welcome-icon" aria-hidden="true">✦</div>
                  <h2>What should the agent work on?</h2>
                  <p>
                    This session uses {sessionProvider ? providerDisplayName(sessionProvider) : 'its configured provider'}
                    {sessionCraftProvider ? ` as Counsel and ${providerDisplayName(sessionCraftProvider)} as Craft` : ''}.
                    Activity and framework session state are persisted locally.
                  </p>
                </div>
              ) : (
                messages.map((message, index) => {
                  const content = payloadText(message, 'content') ?? ''
                  const choicePrompt =
                    message.type === 'assistant_message' && index === messages.length - 1
                      ? extractAssistantChoices(content)
                      : null
                  return (
                    <article className={`message ${message.type === 'user_message' ? 'user' : 'assistant'}`} key={message.id}>
                      <div className="avatar" aria-hidden="true">{message.type === 'user_message' ? 'S' : 'P'}</div>
                      <div>
                        <strong>{message.type === 'user_message' ? 'You' : 'Agent'}</strong>
                        {message.type === 'assistant_message' ? (
                          <>
                            <ReactMarkdown>{choicePrompt?.introduction ?? content}</ReactMarkdown>
                            {choicePrompt && (
                              <>
                                <div className="choice-picker" role="group" aria-label="Suggested responses">
                                  {choicePrompt.choices.map((choice) => (
                                    <button
                                      className="choice-option"
                                      type="button"
                                      key={`${choice.response}-${choice.label}`}
                                      disabled={!canSendPrompt}
                                      onClick={() => sendPrompt(choice.response)}
                                    >
                                      <span>{choice.label}</span>
                                    </button>
                                  ))}
                                </div>
                                {choicePrompt.followUp && (
                                  <ReactMarkdown>{choicePrompt.followUp}</ReactMarkdown>
                                )}
                              </>
                            )}
                          </>
                        ) : (
                          <>
                            <p>{content || 'Message content is unavailable.'}</p>
                            <div className="prompt-actions" role="group" aria-label="Prompt actions">
                              <button
                                type="button"
                                disabled={!canSendPrompt || !content.trim()}
                                title="Send this prompt again in this session. Previous work is not undone."
                                onClick={() => sendPrompt(content, false)}
                              >
                                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6a6 6 0 1 1-1 6M4 2v4h4" /></svg>
                                Run again
                              </button>
                              <button
                                type="button"
                                disabled={!canSendPrompt || !content.trim()}
                                title="Load this prompt into the composer to edit before sending."
                                onClick={() => editAndRerun(content)}
                              >
                                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 4 4 4M3 17l4-1L17 6a2 2 0 0 0-4-4L3 12v5Z" /></svg>
                                Edit &amp; rerun
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </article>
                  )
                })
              )}
              {progressHints.length > 0 && (
                <article className="message assistant progress-message" aria-live="polite">
                  <div className="avatar" aria-hidden="true">P</div>
                  <div>
                    <strong>Working</strong>
                    <ul>
                      {progressHints.map((hint) => <li key={hint}>{hint}</li>)}
                    </ul>
                  </div>
                </article>
              )}
              {liveResponse && (
                <article className="message assistant">
                  <div className="avatar" aria-hidden="true">P</div>
                  <div>
                    <strong>Agent</strong>
                    <ReactMarkdown>{liveResponse}</ReactMarkdown>
                    <span className="cursor" aria-hidden="true" />
                  </div>
                </article>
              )}
            </section>
            <div className="composer-stack">
              {hasPendingApproval && (
                <section className="approval-tray" aria-label="Pending approvals" aria-live="polite">
                  <header>
                    <div>
                      <p className="eyebrow">Permission gate</p>
                      <h2>Approval required</h2>
                    </div>
                    <span>{pendingApprovals.length}</span>
                  </header>
                  <div className="approval-tray-list">
                    {pendingApprovals.map((approval) => (
                      <article className="approval-card" key={approval.id}>
                        <div className="approval-heading">
                          <h3>{approval.preview.operation}</h3>
                          <div className="approval-badges" aria-label="Approval classification">
                            <span>{approval.preview.category.replaceAll('_', ' ')}</span>
                            <span className="risk">{approval.preview.risk_level} risk</span>
                          </div>
                        </div>
                        {approval.preview.affected_paths.length > 0 && (
                          <div className="affected-paths" aria-label="Affected paths">
                            {approval.preview.affected_paths.map((path) => (
                              <code key={path}>{path}</code>
                            ))}
                          </div>
                        )}
                        {approval.preview.preview_content && (
                          <section
                            className={`approval-preview ${approval.preview.preview_kind === 'unified_diff' ? 'diff' : ''}`}
                            aria-labelledby={`approval-preview-${approval.id}`}
                          >
                            <h4 id={`approval-preview-${approval.id}`}>
                              {approval.preview.preview_kind === 'unified_diff'
                                ? 'Proposed changes'
                                : 'Approval summary'}
                            </h4>
                            {approval.preview.preview_kind === 'unified_diff' ? (
                              <pre>{approval.preview.preview_content}</pre>
                            ) : (
                              <p>{approval.preview.preview_content}</p>
                            )}
                            {approval.preview.preview_truncated && (
                              <p className="preview-warning">Preview truncated at the safety limit.</p>
                            )}
                          </section>
                        )}
                        <details className="approval-arguments">
                          <summary>Exact tool arguments</summary>
                          <pre>{JSON.stringify(approval.arguments, null, 2)}</pre>
                        </details>
                        <div className="button-row">
                          <button
                            className="primary"
                            disabled={contextBusy}
                            type="button"
                            onClick={() => void decideApproval(approval.id, true)}
                          >
                            Approve
                          </button>
                          <button
                            className="secondary"
                            disabled={contextBusy}
                            type="button"
                            onClick={() => void decideApproval(approval.id, false)}
                          >
                            Deny
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}
              <form className="composer" onSubmit={submitPrompt}>
                <textarea
                  ref={promptRef}
                  aria-label="Message the agent"
                  aria-keyshortcuts="/"
                  placeholder={
                    hasPendingApproval
                      ? 'Resolve the pending approval before continuing...'
                      : status === 'ready'
                        ? 'Ask Prudence...'
                        : 'Waiting for the local backend...'
                  }
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      event.currentTarget.form?.requestSubmit()
                    }
                  }}
                  disabled={status !== 'ready' || hasPendingApproval}
                  rows={3}
                />
                <div className="composer-footer">
                  <div className="composer-meta">
                    <span>
                      {sessionProvider
                        ? sessionCraftProvider
                          ? `Counsel ${sessionProvider.model} → Craft ${sessionCraftProvider.model}`
                          : `${sessionProvider.kind} · ${sessionProvider.model} · ${sessionProvider.data_boundary.replaceAll('_', ' ')}`
                        : 'No provider selected'}
                    </span>
                    {workspace && (
                      <>
                        <button
                          className={`write-access-toggle${workspace.write_tools_enabled ? ' enabled' : ''}`}
                          disabled={contextBusy || status === 'running'}
                          type="button"
                          role="switch"
                          aria-checked={workspace.write_tools_enabled}
                          aria-label={`Workspace write access ${workspace.write_tools_enabled ? 'enabled' : 'disabled'}`}
                          title="Allow generated files at real workspace paths. Mutations require approval unless auto-approve is enabled."
                          onClick={() => void toggleWorkspaceWriteTools()}
                        >
                          <span>Write access</span>
                          <span className="write-access-track" aria-hidden="true">
                            <span />
                          </span>
                        </button>
                        <button
                          className={`write-access-toggle${workspace.auto_approve_enabled ? ' enabled' : ''}`}
                          disabled={
                            contextBusy || status === 'running' || !workspace.write_tools_enabled
                          }
                          type="button"
                          role="switch"
                          aria-checked={workspace.auto_approve_enabled}
                          aria-label={`Auto-approve workspace mutations ${workspace.auto_approve_enabled ? 'enabled' : 'disabled'}`}
                          title="Automatically approve bounded workspace mutation tools for this workspace."
                          onClick={() => void toggleWorkspaceAutoApprove()}
                        >
                          <span>Auto-approve</span>
                          <span className="write-access-track" aria-hidden="true">
                            <span />
                          </span>
                        </button>
                      </>
                    )}
                  </div>
                  <button className="send" type="submit" disabled={!prompt.trim() || !canSendPrompt} aria-label="Send message">↑</button>
                </div>
              </form>
            </div>
          </>
        ) : (
          <section className="empty-state">
            <div className="orbit" aria-hidden="true"><span>✦</span></div>
            <h2>Your local agent workspace</h2>
            <p>Connect Microsoft Foundry or a local OpenAI-compatible model, then create a durable session.</p>
            <div className="empty-actions">
              <button className="primary" type="button" onClick={() => setShowProviderForm(true)}>
                Configure provider
              </button>
              <button className="secondary" type="button" onClick={() => void createSession()} disabled={!selectedProviderId}>
                Create session
              </button>
            </div>
          </section>
        )}

        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice('')} aria-label="Dismiss notification">×</button>
          </div>
        )}
        <footer className="framework-credit">Powered by Microsoft Agent Framework</footer>
      </main>
      {showContext && (
        <aside className="context-panel" id="session-context" aria-label="Session context" hidden={contextCollapsed}>
          <CollapsibleContextSection id="runtime-section" eyebrow="Runtime" title="Current activity">
            <div className="runtime-card" aria-live="polite">
              <strong>
                {failureView
                  ? failureView.title
                  : status === 'running'
                  ? (latestRunStatus && payloadText(latestRunStatus, 'label')) ?? 'Agent working'
                  : status === 'ready'
                    ? 'Ready for your next request'
                    : 'Connecting to the local backend'}
              </strong>
              {latestFailure && (
                <div className="runtime-error" role="alert">
                  <p>{failureView?.summary}</p>
                  <span>
                    {payloadText(latestFailure, 'category')?.replaceAll('_', ' ') ?? 'run failure'}
                  </span>
                  <p>{failureView?.nextStep}</p>
                  {payloadText(latestFailure, 'detail') && (
                    <details>
                      <summary>Diagnostic detail</summary>
                      <p>{payloadText(latestFailure, 'detail')}</p>
                    </details>
                  )}
                  {latestFailure.payload.retryable === true && (
                    <button className="secondary" type="button" disabled={!canSendPrompt} onClick={retryLastRun}>
                      Retry last run
                    </button>
                  )}
                </div>
              )}
              {latestContextUsage ? (
                <>
                  <div
                    className="usage-meter"
                    role="meter"
                    aria-label="Model context window usage"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={contextPercent}
                  >
                    <span style={{ width: `${contextPercent}%` }} />
                  </div>
                  <p>
                    {payloadNumber(latestContextUsage, 'input_tokens')?.toLocaleString() ?? '0'}
                    {' of '}
                    {payloadNumber(latestContextUsage, 'context_limit')?.toLocaleString() ?? 'unknown'}
                    {' context tokens · '}
                    {contextPercent.toFixed(1)}%
                  </p>
                </>
              ) : (
                <p>Token usage will appear after the first model response.</p>
              )}
            </div>
          </CollapsibleContextSection>

          <CollapsibleContextSection
            id="tasks-section"
            eyebrow="Agent state"
            title="Tasks"
          >
            {!sessionCraftProvider &&
              sessionState?.mode === 'plan' &&
              sessionState.tasks.some((task) => !task.is_complete) && (
                <button
                  className="primary approve-plan"
                  disabled={contextBusy || status !== 'ready'}
                  type="button"
                  onClick={() => void approvePlanAndExecute()}
                >
                  Approve plan & execute
                </button>
              )}
            <div className="context-list">
              {sessionState && sessionState.tasks.length > 1 ? (
                <ol className="task-stepper" aria-label="Plan progress">
                  {sessionState.tasks.map((task, index) => {
                    const firstOpenIndex = sessionState.tasks.findIndex(
                      (candidate) => !candidate.is_complete,
                    )
                    const isCurrent = !task.is_complete && index === firstOpenIndex
                    return (
                      <li
                        className={
                          task.is_complete ? 'complete' : isCurrent ? 'current' : 'upcoming'
                        }
                        key={task.id}
                        aria-current={isCurrent ? 'step' : undefined}
                      >
                        <span className="step-dot" aria-hidden="true">
                          {task.is_complete ? '✓' : index + 1}
                        </span>
                        <div>
                          <strong>{task.title}</strong>
                          <small>
                            {task.is_complete ? 'Completed' : isCurrent ? 'Current step' : 'Upcoming'}
                          </small>
                          {task.description && <p>{task.description}</p>}
                        </div>
                      </li>
                    )
                  })}
                </ol>
              ) : sessionState?.tasks.length ? (
                sessionState.tasks.map((task) => (
                  <article className="task-card" key={task.id}>
                    <span className={task.is_complete ? 'complete' : 'open'}>
                      {task.is_complete ? 'Done' : 'Open'}
                    </span>
                    <strong>{task.title}</strong>
                    {task.description && <p>{task.description}</p>}
                  </article>
                ))
              ) : (
                <p className="empty-copy">Harness tasks will appear here.</p>
              )}
            </div>
          </CollapsibleContextSection>

          <CollapsibleContextSection id="memory-section" eyebrow="Local context" title="Memory">
            <div className="context-list">
              {memories.map((memory) => (
                <details className="memory-card" key={memory.file_name}>
                  <summary>{memory.file_name}</summary>
                  {memory.description && <p>{memory.description}</p>}
                  <pre>{memory.content}</pre>
                </details>
              ))}
            </div>
            <form className="memory-form" onSubmit={(event) => void addMemory(event)}>
              <input
                aria-label="Memory file name"
                placeholder="memory.md"
                value={memoryName}
                onChange={(event) => setMemoryName(event.target.value)}
              />
              <textarea
                aria-label="Memory content"
                placeholder="Add durable context for this session"
                rows={3}
                value={memoryContent}
                onChange={(event) => setMemoryContent(event.target.value)}
              />
              <button
                className="secondary"
                disabled={contextBusy || !memoryName.trim()}
                type="submit"
              >
                Add memory
              </button>
            </form>
          </CollapsibleContextSection>

          <CollapsibleContextSection id="artifacts-section" eyebrow="Generated output" title="Output summary">
            <dl className="output-metrics">
              <div><dt>Indexed files</dt><dd>{outputStats.files.toLocaleString()}</dd></div>
              <div>
                <dt>{outputStats.knownSizes === outputStats.files ? 'Recorded size' : 'Known size'}</dt>
                <dd>{outputStats.knownSizes > 0 || outputStats.files === 0 ? formatBytes(outputStats.bytes) : 'Not reported'}</dd>
              </div>
              <div><dt>Available versions</dt><dd>{outputStats.versions.toLocaleString()}</dd></div>
            </dl>
            {artifacts.length > 0 ? (
              <>
                <p className="output-description">
                  Latest indexed outputs for this {workspace ? 'workspace' : 'session'}, not a scan of every workspace file.
                </p>
                <div className="output-breakdown">
                  <h3>Programming languages</h3>
                  {outputStats.languages.length > 0 ? (
                    <dl>
                      {outputStats.languages.map((language) => (
                        <div key={language.name}><dt>{language.name}</dt><dd>{language.count} {language.count === 1 ? 'file' : 'files'}</dd></div>
                      ))}
                    </dl>
                  ) : <p className="output-description">No programming-language filenames identified.</p>}
                </div>
                <div className="output-breakdown">
                  <h3>File types</h3>
                  <dl>
                    {outputStats.types.map((type) => (
                      <div key={type.name}><dt>{type.name}</dt><dd>{type.count} {type.count === 1 ? 'file' : 'files'}</dd></div>
                    ))}
                  </dl>
                </div>
                <p className="output-note">Languages are inferred from filename extensions, not content analysis.</p>
                {outputStats.knownSizes < outputStats.files && (
                  <p className="output-note">Size reported for {outputStats.knownSizes} of {outputStats.files} {outputStats.files === 1 ? 'file' : 'files'}.</p>
                )}
                {outputStats.missingMetadata > 0 && (
                  <p className="output-note">Current-file metadata is missing for {outputStats.missingMetadata} {outputStats.missingMetadata === 1 ? 'output' : 'outputs'}.</p>
                )}
                <details className="output-inspection">
                  <summary>Inspect files</summary>
                  <input
                    className="artifact-search"
                    aria-label="Search artifacts"
                    placeholder="Search artifacts"
                    value={artifactQuery}
                    onChange={(event) => setArtifactQuery(event.target.value)}
                  />
                  <div className="artifact-list">
                    {visibleArtifacts.length ? (
                      visibleArtifacts.map((artifact) => (
                        <button
                          className={artifactPreview?.id === artifact.id ? 'selected' : ''}
                          key={artifact.id}
                          type="button"
                          onClick={() => void openArtifact(artifact.id)}
                        >
                          <span>{artifact.title}</span>
                          <small>
                            v{artifact.current_version} ·{' '}
                            {new Date(artifact.updated_at).toLocaleDateString()}
                          </small>
                        </button>
                      ))
                    ) : (
                      <p className="empty-copy">No matching artifacts.</p>
                    )}
                  </div>
                  {artifactPreview && selectedSessionId && (
                    <article className="artifact-preview">
                      <div>
                        <strong>{artifactPreview.title}</strong>
                        <a
                          href={`/api/sessions/${selectedSessionId}/artifacts/${artifactPreview.id}/download?version=${artifactPreview.version}`}
                        >
                          Download v{artifactPreview.version}
                        </a>
                      </div>
                      <pre>{artifactPreview.content}</pre>
                      {artifactPreview.content_truncated && (
                        <p>Preview truncated. Download the artifact to inspect the full content.</p>
                      )}
                      <div className="artifact-versions" aria-label="Artifact versions">
                        {artifactPreview.versions.map((version) => (
                          <button
                            className={artifactPreview.version === version.version ? 'selected' : ''}
                            disabled={contextBusy}
                            key={version.version}
                            type="button"
                            onClick={() => void openArtifact(artifactPreview.id, version.version)}
                          >
                            v{version.version}
                          </button>
                        ))}
                      </div>
                    </article>
                  )}
                </details>
              </>
            ) : <p className="empty-copy">Generated files and notes will be summarized here once indexed.</p>}
          </CollapsibleContextSection>

          <CollapsibleContextSection id="activity-section" eyebrow="Audit trail" title="Activity">
            <p className="activity-count">
              {activityEvents.length > 12 ? `Latest 12 of ${activityEvents.length} events` : `${activityEvents.length} recorded events`}
              {activityEvents.length > 0 && ' · Newest first'}
            </p>
            {activityEvents.length === 0 && <p className="empty-copy">No activity yet. Events appear when a run starts.</p>}
            <ol className="activity-list">
              {activityEvents
                .slice(-12)
                .reverse()
                .map((event) => (
                  <ActivityItem event={event} key={event.id} />
                ))}
            </ol>
          </CollapsibleContextSection>
        </aside>
      )}
      {providerManagerOpen && (
        <ProviderManager
          providers={providers}
          initialId={selectedProviderId}
          onClose={closeProviderManager}
          onAdd={addProvider}
          onEdit={editProvider}
          onDelete={(id) => void deleteProvider(id)}
          onImport={() => providerImportRef.current?.click()}
          onExport={() => void exportProviders()}
          notify={setNotice}
        />
      )}
      {commandPaletteOpen && (
        <div className="command-backdrop" onMouseDown={closeCommandPalette}>
          <section
            ref={commandPaletteRef}
            className="command-palette"
            role="dialog"
            aria-modal="true"
            aria-labelledby="command-palette-title"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={trapDialogFocus}
          >
            <div className="command-palette-heading">
              <h2 id="command-palette-title">Workspace commands</h2>
              <button type="button" onClick={closeCommandPalette} aria-label="Close command palette">
                ×
              </button>
            </div>
            <input
              ref={commandSearchRef}
              value={commandQuery}
              onChange={(event) => setCommandQuery(event.target.value)}
              placeholder="Search commands"
              aria-label="Search workspace commands"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  const command = visibleCommands.find((item) => !item.disabled)
                  if (command) {
                    command.run()
                    closeCommandPalette()
                  }
                }
              }}
            />
            <div className="command-list">
              {visibleCommands.map((command) => (
                <button
                  key={command.id}
                  type="button"
                  disabled={command.disabled}
                  aria-keyshortcuts={command.shortcut?.replace('Ctrl+', 'Control+')}
                  onClick={() => {
                    command.run()
                    closeCommandPalette()
                  }}
                >
                  <span>{command.label}</span>
                  {command.shortcut && <kbd>{command.shortcut}</kbd>}
                </button>
              ))}
              {visibleCommands.length === 0 && <p>No matching commands.</p>}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export default App
