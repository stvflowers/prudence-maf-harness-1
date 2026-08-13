import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
    <section className={`context-section ${collapsed ? 'collapsed' : ''}`}>
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
  if (event.type === 'tool_result') return `Tool finished: ${payloadText(event, 'name') ?? 'unknown'}`
  if (event.type === 'context_usage') return 'Context usage updated'
  if (event.type === 'task_progress') return 'Plan progress updated'
  if (event.type === 'run_status') return payloadText(event, 'label') ?? 'Agent status updated'
  if (event.type === 'model_handoff_queued') return 'Craft microtask queued'
  if (event.type === 'model_handoff_started') return 'Counsel delegated work to Craft'
  if (event.type === 'model_handoff_attempt') {
    return `Craft attempt ${payloadNumber(event, 'attempt') ?? 1} started`
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

function dataBoundaryLabel(boundary: DataBoundary): string {
  if (boundary === 'machine') return 'Model traffic stays on this machine'
  if (boundary === 'local_network') return 'Model traffic stays on your local network'
  return 'Prompts and tool outputs leave this machine'
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
  const [providerProbes, setProviderProbes] = useState<ProviderProbe[]>([])
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
    if (!selectedProviderId) {
      setProviderProbes([])
      return
    }
    api<ProviderProbe[]>(`/api/providers/${selectedProviderId}/probes`)
      .then(setProviderProbes)
      .catch((error: unknown) =>
        setNotice(error instanceof Error ? error.message : 'Could not load connectivity history.'),
      )
  }, [selectedProviderId])

  useEffect(() => {
    const counsel = providers.find((provider) => provider.id === selectedProviderId)
    const craft = providers.find((provider) => provider.id === selectedCraftProviderId)
    if (counsel?.kind !== 'foundry' || (craft && craft.kind !== 'local')) {
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
      ? artifacts.filter((artifact) => artifact.title.toLocaleLowerCase().includes(query))
      : artifacts
  }, [artifactQuery, artifacts])

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
      setSelectedProviderId(saved.id)
      setProviderDraft(defaultProvider)
      setEditingProviderId(null)
      setShowProviderForm(false)
      setNotice('Provider profile saved. Test the connection before relying on it.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save the provider.')
    }
  }

  async function testProvider() {
    if (!selectedProviderId) return
    setNotice('Testing provider connection...')
    try {
      await api<{ message: string }>(
        `/api/providers/${selectedProviderId}/probe`,
        { method: 'POST' },
      )
      setNotice('Provider connection succeeded.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Provider test failed.')
    }
    try {
      setProviderProbes(
        await api<ProviderProbe[]>(`/api/providers/${selectedProviderId}/probes`),
      )
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not refresh connectivity history.'
      setNotice((current) => `${current} ${message}`.trim())
    }
  }

  function addProvider() {
    setEditingProviderId(null)
    setProviderDraft(defaultProvider)
    setShowProviderForm(true)
  }

  function editProvider() {
    const provider = providers.find((item) => item.id === selectedProviderId)
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

  async function deleteProvider() {
    const provider = providers.find((item) => item.id === selectedProviderId)
    if (!provider || !window.confirm(`Delete provider "${provider.name}"?`)) return
    try {
      await api<void>(`/api/providers/${provider.id}`, { method: 'DELETE' })
      const remaining = providers.filter((item) => item.id !== provider.id)
      setProviders(remaining)
      setSelectedProviderId(remaining[0]?.id ?? '')
      setProviderProbes([])
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

  function closeCommandPalette() {
    setCommandPaletteOpen(false)
    window.setTimeout(
      () => (priorFocusRef.current ?? commandTriggerRef.current)?.focus(),
      0,
    )
  }

  function trapCommandPaletteFocus(event: ReactKeyboardEvent<HTMLElement>) {
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

  function sendPrompt(value: string) {
    const content = value.trim()
    if (!content || status !== 'ready' || hasPendingApproval || !socketRef.current) return
    followTranscriptRef.current = true
    setNotice('')
    setPrompt('')
    setLiveResponse('')
    socketRef.current.send(JSON.stringify({ type: 'prompt', content }))
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
    setNotice('')
    setLiveResponse('')
    setStatus('running')
    socketRef.current.send(JSON.stringify({ type: 'prompt', content }))
  }

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId)
  const sessionProvider = providers.find(
    (provider) => provider.id === selectedSession?.provider_id,
  )
  const selectedCraftProvider = providers.find(
    (provider) => provider.id === selectedCraftProviderId,
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
      className={`shell ${
        selectedSession && !showProviderForm && !showSessionSettings ? 'has-context' : ''
      }`}
    >
      <aside className="sidebar">
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
          <p className="eyebrow">Model provider</p>
            <select
              aria-label="Active model provider"
              value={selectedProviderId}
              onChange={(event) => setSelectedProviderId(event.target.value)}
            >
              <option value="">Select a provider</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
            {selectedProvider && (
              <>
              <div className="provider-summary">
                <span className={`provider-dot ${selectedProvider.kind}`} />
                <div>
                  <strong>{selectedProvider.kind === 'foundry' ? 'Microsoft Foundry' : 'Local'}</strong>
                  <span>{selectedProvider.model}</span>
                </div>
              </div>
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
                <div className="dual-mode-picker">
                  <label htmlFor="craft-provider">Counsel &amp; Craft</label>
                  <select
                    id="craft-provider"
                    aria-label="Craft local provider"
                    value={selectedCraftProviderId}
                    onChange={(event) => setSelectedCraftProviderId(event.target.value)}
                  >
                    <option value="">Counsel only</option>
                    {providers
                      .filter((provider) => provider.kind === 'local')
                      .map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name}
                        </option>
                      ))}
                  </select>
                  <small>
                    Foundry Counsel plans and reasons. Local Craft supplies code and bounded
                    simple work.
                  </small>
                  {selectedCraftProvider && (
                    <span className={`data-boundary ${selectedCraftProvider.data_boundary}`}>
                      Craft · {selectedCraftProvider.model} ·{' '}
                      {selectedCraftProvider.data_boundary.replaceAll('_', ' ')}
                    </span>
                  )}
                </div>
              )}
              </>
            )}
            <details className="provider-actions-menu">
              <summary>Provider actions</summary>
              <div className="provider-actions">
                <button className="secondary" type="button" onClick={() => void testProvider()} disabled={!selectedProviderId}>
                  Test
                </button>
                <button className="secondary" type="button" onClick={editProvider} disabled={!selectedProviderId}>
                  Edit
                </button>
                <button className="secondary" type="button" onClick={addProvider}>
                  Add
                </button>
                <button className="secondary" type="button" onClick={() => void exportProviders()} disabled={!providers.length}>
                  Export
                </button>
                <button className="secondary" type="button" onClick={() => providerImportRef.current?.click()}>
                  Import
                </button>
                <button className="danger compact" type="button" onClick={() => void deleteProvider()} disabled={!selectedProviderId}>
                  Delete
                </button>
              </div>
            </details>
            <input
              ref={providerImportRef}
              className="visually-hidden"
              type="file"
              accept="application/json,.json"
              aria-label="Import provider configuration"
              onChange={(event) => void importProviders(event)}
            />
            {providerProbes.length > 0 && (
              <div className="probe-history">
                <strong>Connectivity history</strong>
                {providerProbes.slice(0, 3).map((probe) => (
                  <div key={probe.id}>
                    <span className={probe.ok ? 'probe-ok' : 'probe-failed'}>
                      {probe.ok ? 'Passed' : 'Failed'}
                    </span>
                    <time>{new Date(probe.checked_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</time>
                    <small>
                      Streaming {probe.streaming ? 'yes' : 'no'} · tools {probe.tool_calling ? 'yes' : 'no'}
                    </small>
                  </div>
                ))}
              </div>
            )}
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
                    This session uses {sessionProvider?.name ?? 'its configured provider'}
                    {sessionCraftProvider ? ` as Counsel and ${sessionCraftProvider.name} as Craft` : ''}.
                    Activity and framework session state are persisted locally.
                  </p>
                </div>
              ) : (
                messages.map((message, index) => {
                  const content = String(message.payload.content ?? '')
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
                                      disabled={status !== 'ready' || hasPendingApproval}
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
                          <p>{content}</p>
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
                        ? 'Message the agent...'
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
                  <button className="send" type="submit" disabled={!prompt.trim() || status !== 'ready' || hasPendingApproval} aria-label="Send message">↑</button>
                </div>
              </form>
            </div>
          </>
        ) : (
          <section className="empty-state">
            <div className="orbit" aria-hidden="true"><span>✦</span></div>
            <p className="eyebrow">Microsoft Agent Framework</p>
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
      </main>
      {selectedSession && !showProviderForm && !showSessionSettings && (
        <aside className="context-panel" id="session-context" aria-label="Session context">
          <CollapsibleContextSection id="runtime-section" eyebrow="Runtime" title="Current activity">
            <div className="runtime-card" aria-live="polite">
              <strong>
                {latestFailure
                  ? payloadText(latestFailure, 'message')
                  : status === 'running'
                  ? (latestRunStatus && payloadText(latestRunStatus, 'label')) ?? 'Agent working'
                  : status === 'ready'
                    ? 'Ready for your next request'
                    : 'Connecting to the local backend'}
              </strong>
              {latestFailure && (
                <div className="runtime-error" role="alert">
                  <span>
                    {payloadText(latestFailure, 'category')?.replaceAll('_', ' ') ?? 'run failure'}
                  </span>
                  {payloadText(latestFailure, 'detail') && (
                    <details>
                      <summary>Diagnostic detail</summary>
                      <p>{payloadText(latestFailure, 'detail')}</p>
                    </details>
                  )}
                  {latestFailure.payload.retryable === true && (
                    <button className="secondary" type="button" onClick={retryLastRun}>
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
            title={sessionCraftProvider ? 'Tasks' : 'Mode & tasks'}
          >
            {!sessionCraftProvider && (
              <div className="context-heading">
                <div className="mode-toggle" aria-label="Agent mode">
                  {(['plan', 'execute'] as const).map((mode) => (
                    <button
                      className={sessionState?.mode === mode ? 'selected' : ''}
                      disabled={contextBusy}
                      key={mode}
                      type="button"
                      onClick={() => void updateMode(mode)}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>
            )}
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

          <CollapsibleContextSection id="artifacts-section" eyebrow="Generated output" title="Artifacts">
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
          </CollapsibleContextSection>

          <CollapsibleContextSection id="activity-section" eyebrow="Audit trail" title="Activity">
            <ol className="activity-list">
              {activityEvents
                .slice(-12)
                .reverse()
                .map((event) => (
                  <li key={event.id}>
                    <details>
                      <summary>
                        <span className={`event-kind ${event.type}`}>
                          {event.type === 'tool_call'
                            ? 'Tool'
                            : event.type === 'tool_result'
                              ? 'Result'
                              : event.type === 'context_usage'
                                ? 'Usage'
                                : event.type.startsWith('subagent_') ||
                                    event.type.startsWith('model_handoff_')
                                  ? 'Agent'
                                : 'Status'}
                        </span>
                        <span>{activityTitle(event)}</span>
                        <time>{new Date(event.created_at).toLocaleTimeString()}</time>
                      </summary>
                      <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                    </details>
                  </li>
                ))}
            </ol>
          </CollapsibleContextSection>
        </aside>
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
            onKeyDown={trapCommandPaletteFocus}
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
