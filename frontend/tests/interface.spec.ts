import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const assets = fileURLToPath(new URL('../../docs/assets/', import.meta.url))

async function openSample(page: Page, pendingApproval = false) {
  const provider = {
    id: 'sample-local',
    name: 'Local model',
    kind: 'local',
    endpoint: 'http://127.0.0.1:11434/v1',
    model: 'local-code',
    api_key_env: null,
    max_context_window_tokens: 32768,
    max_output_tokens: 4096,
    data_boundary: 'machine',
  }
  const session = {
    id: 'sample-session',
    provider_id: provider.id,
    craft_provider_id: null,
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
  const decisions: unknown[] = []
  const modelRequests: string[] = []
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    let body: unknown
    if (path === '/api/providers') body = [provider]
    else if (path === '/api/providers/sample-local/probes') body = []
    else if (path === '/api/sessions') body = [session]
    else if (path === '/api/sessions/sample-session') body = session
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
    } else if (['memories', 'instructions', 'skills', 'hooks', 'mcp-servers', 'subagents', 'artifacts']
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
  })
  await page.goto('/')
  await page.getByRole('button', { name: /^Refactor authentication/ }).click()
  await expect(page.getByRole('textbox', { name: 'Message the agent' })).toHaveAttribute(
    'placeholder', pendingApproval ? 'Resolve the pending approval before continuing...' : 'Ask Prudence...',
  )
  await expect(page.locator('.connection')).toHaveText('Connected')
  await expect(page.getByText('Powered by Microsoft Agent Framework', { exact: true })).toHaveCount(1)
  return { unexpectedRequests, decisions, modelRequests }
}

test('welcome attribution is centered at the workspace bottom', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path !== '/api/providers' && path !== '/api/sessions') {
      throw new Error(`Unexpected welcome request: ${path}`)
    }
    await route.fulfill({ json: [] })
  })
  await page.goto('/')
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
  await page.locator('.provider-actions-menu > summary').click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Edit model provider' })).toBeVisible()
  expect(fixture.unexpectedRequests).toEqual([])
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
  await openSample(page)
  await page.screenshot({ path: `${assets}prudence-app.png` })
})

test('approval documentation screenshot @screenshots', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  await openSample(page, true)
  await page.screenshot({ path: `${assets}prudence-approval.png` })
})

test('settings documentation screenshot @screenshots', async ({ page }) => {
  await openSample(page)
  await page.getByRole('button', { name: 'Session settings', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Session instructions' })).toBeVisible()
  await page.screenshot({ path: `${assets}prudence-settings.png` })
})
