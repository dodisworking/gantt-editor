// gantt-editor v2 — with auth + persistence
import { createServer } from 'http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { join, extname } from 'path'
import { fileURLToPath } from 'url'
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PORT = process.env.PORT || 3000
const DATA_DIR = process.env.PERSIST_DIR || join(__dirname, 'data')

// ── Ensure data directories exist ────────────────────────────────────────────
function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) }
ensureDir(DATA_DIR)
ensureDir(join(DATA_DIR, 'charts'))

const USERS_FILE = join(DATA_DIR, 'users.json')
const SESSIONS_FILE = join(DATA_DIR, 'sessions.json')

function readJSON(path) { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} } }
function writeJSON(path, data) { writeFileSync(path, JSON.stringify(data, null, 2)) }

// ── Seed admin account ───────────────────────────────────────────────────────
function seedAdmin() {
  const users = readJSON(USERS_FILE)
  if (!users.marshgx) {
    const salt = randomBytes(16).toString('hex')
    const hash = scryptSync('123', salt, 64).toString('hex')
    users.marshgx = { passwordHash: hash, salt, password: '123', role: 'admin', created: new Date().toISOString() }
    writeJSON(USERS_FILE, users)
    console.log('[auth] Admin account "marshgx" seeded')
  }
}
seedAdmin()

// ── Auth helpers ─────────────────────────────────────────────────────────────
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return { hash, salt }
}

function verifyPassword(password, hash, salt) {
  const buf = scryptSync(password, salt, 64)
  return timingSafeEqual(buf, Buffer.from(hash, 'hex'))
}

function createSession(username) {
  const token = randomBytes(32).toString('hex')
  const sessions = readJSON(SESSIONS_FILE)
  // Clean expired sessions
  const now = Date.now()
  for (const [t, s] of Object.entries(sessions)) {
    if (new Date(s.expires).getTime() < now) delete sessions[t]
  }
  sessions[token] = { username, created: new Date().toISOString(), expires: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString() }
  writeJSON(SESSIONS_FILE, sessions)
  return token
}

function getUserFromRequest(req) {
  const cookie = req.headers.cookie || ''
  const match = cookie.match(/session=([a-f0-9]+)/)
  if (!match) return null
  const token = match[1]
  const sessions = readJSON(SESSIONS_FILE)
  const session = sessions[token]
  if (!session) return null
  if (new Date(session.expires).getTime() < Date.now()) {
    delete sessions[token]
    writeJSON(SESSIONS_FILE, sessions)
    return null
  }
  const users = readJSON(USERS_FILE)
  const user = users[session.username]
  if (!user) return null
  return { username: session.username, role: user.role || 'user' }
}

// ── Request body helper ──────────────────────────────────────────────────────
async function readBody(req) {
  let body = ''
  for await (const chunk of req) body += chunk
  try { return JSON.parse(body) } catch { return {} }
}

// ── JSON response helpers ────────────────────────────────────────────────────
function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(data))
}

// ── Chart file helpers ───────────────────────────────────────────────────────
function userChartsDir(username) {
  const dir = join(DATA_DIR, 'charts', username)
  ensureDir(dir)
  return dir
}

function listUserCharts(username) {
  const dir = userChartsDir(username)
  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
  return files.map(f => {
    const chart = readJSON(join(dir, f))
    return { id: chart.id, title: chart.title, modified: chart.modified, phaseCount: (chart.phases || []).length }
  }).sort((a, b) => new Date(b.modified) - new Date(a.modified))
}

function getChart(username, id) {
  const file = join(userChartsDir(username), `${id}.json`)
  if (!existsSync(file)) return null
  return readJSON(file)
}

function saveChart(username, chart) {
  chart.modified = new Date().toISOString()
  const file = join(userChartsDir(username), `${chart.id}.json`)
  writeJSON(file, chart)
  return chart
}

function deleteChart(username, id) {
  const file = join(userChartsDir(username), `${id}.json`)
  if (existsSync(file)) { unlinkSync(file); return true }
  return false
}

// ── AI Generation ────────────────────────────────────────────────────────────
async function handleAiGenerate(req, res) {
  const { prompt } = await readBody(req)
  if (!prompt?.trim()) return json(res, 400, { error: 'prompt is required' })

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim()
  const openaiKey = process.env.OPENAI_API_KEY?.trim()
  if (!anthropicKey && !openaiKey) return json(res, 500, { error: 'No AI API key configured.' })

  const systemPrompt = `You are a project planning assistant. Given a description of a project or timeline, generate a Gantt chart data structure.

Return ONLY valid JSON (no markdown, no backticks) with this exact structure:
{
  "title": "Chart Title",
  "note": "Optional note about the timeline",
  "phases": [
    {
      "title": "Phase Name",
      "subtitle": "Brief description",
      "icon": "one of: location, search, checkmark, dollar, calendar, people, camera, star, flag, clock, bolt, clipboard",
      "color": "one of: #3478F6, #7B61C4, #E8883C, #8E8E93, #34C759, #FF3B30, #5AC8FA, #FF2D55, #5856D6, #A2845E",
      "barStyle": "solid or blocks",
      "highlight": false,
      "spans": [{"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}]
    }
  ]
}

Guidelines:
- Use realistic date ranges starting from today or the dates mentioned
- Group related phases with similar colors
- Use appropriate icons (camera for shoots, dollar for budgets, calendar for planning, etc.)
- Use "blocks" barStyle only for intermittent tasks (like tech scouts)
- Set highlight:true for major milestone/deliverable phases
- Order phases chronologically by their start dates
- Keep titles concise (2-4 words) and subtitles descriptive (5-10 words)
- Create 5-15 phases depending on project complexity`

  try {
    let result
    if (anthropicKey) {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4096, system: systemPrompt, messages: [{ role: 'user', content: prompt }] }),
      })
      if (!resp.ok) throw new Error(`Anthropic API error: ${resp.status}`)
      result = (await resp.json()).content[0].text
    } else {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }], temperature: 0.7 }),
      })
      if (!resp.ok) throw new Error(`OpenAI API error: ${resp.status}`)
      result = (await resp.json()).choices[0].message.content
    }
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    json(res, 200, JSON.parse(cleaned))
  } catch (err) {
    console.error('[gantt-ai]', err.message)
    json(res, 500, { error: err.message })
  }
}

// ── Route Handler ────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname

  // ── Auth Routes ──────────────────────────────────────────────────────────
  if (path === '/api/auth/signup' && req.method === 'POST') {
    const { username, password } = await readBody(req)
    if (!username?.trim() || !password) return json(res, 400, { error: 'Username and password required' })
    if (username.length < 3) return json(res, 400, { error: 'Username must be at least 3 characters' })
    if (password.length < 1) return json(res, 400, { error: 'Password required' })
    const users = readJSON(USERS_FILE)
    if (users[username.toLowerCase()]) return json(res, 409, { error: 'Username already taken' })
    const { hash, salt } = hashPassword(password)
    users[username.toLowerCase()] = { passwordHash: hash, salt, password, role: 'user', created: new Date().toISOString() }
    writeJSON(USERS_FILE, users)
    const token = createSession(username.toLowerCase())
    return json(res, 200, { username: username.toLowerCase(), role: 'user' }, { 'Set-Cookie': `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}` })
  }

  if (path === '/api/auth/login' && req.method === 'POST') {
    const { username, password } = await readBody(req)
    if (!username || !password) return json(res, 400, { error: 'Username and password required' })
    const users = readJSON(USERS_FILE)
    const user = users[username.toLowerCase()]
    if (!user) return json(res, 401, { error: 'Invalid username or password' })
    if (!verifyPassword(password, user.passwordHash, user.salt)) return json(res, 401, { error: 'Invalid username or password' })
    const token = createSession(username.toLowerCase())
    return json(res, 200, { username: username.toLowerCase(), role: user.role || 'user' }, { 'Set-Cookie': `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}` })
  }

  if (path === '/api/auth/logout' && req.method === 'POST') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0' })
  }

  if (path === '/api/auth/me' && req.method === 'GET') {
    const user = getUserFromRequest(req)
    if (!user) return json(res, 401, { error: 'Not authenticated' })
    return json(res, 200, user)
  }

  // ── Admin Routes ─────────────────────────────────────────────────────────
  if (path === '/api/admin/users' && req.method === 'GET') {
    const user = getUserFromRequest(req)
    if (!user || user.role !== 'admin') return json(res, 403, { error: 'Forbidden' })
    const users = readJSON(USERS_FILE)
    const list = Object.entries(users).map(([username, u]) => ({
      username, role: u.role || 'user', password: u.password, created: u.created,
      chartCount: existsSync(join(DATA_DIR, 'charts', username)) ? readdirSync(join(DATA_DIR, 'charts', username)).filter(f => f.endsWith('.json')).length : 0
    }))
    return json(res, 200, list)
  }

  if (path.startsWith('/api/admin/user-charts/') && req.method === 'GET') {
    const user = getUserFromRequest(req)
    if (!user || user.role !== 'admin') return json(res, 403, { error: 'Forbidden' })
    const targetUser = path.split('/').pop()
    return json(res, 200, listUserCharts(targetUser))
  }

  // ── Chart Routes (authenticated) ─────────────────────────────────────────
  if (path === '/api/charts' && req.method === 'GET') {
    const user = getUserFromRequest(req)
    if (!user) return json(res, 401, { error: 'Not authenticated' })
    return json(res, 200, listUserCharts(user.username))
  }

  if (path.match(/^\/api\/charts\/[\w-]+$/) && req.method === 'GET') {
    const user = getUserFromRequest(req)
    if (!user) return json(res, 401, { error: 'Not authenticated' })
    const id = path.split('/').pop()
    const chart = getChart(user.username, id)
    if (!chart) return json(res, 404, { error: 'Chart not found' })
    return json(res, 200, chart)
  }

  if (path === '/api/charts' && req.method === 'POST') {
    const user = getUserFromRequest(req)
    if (!user) return json(res, 401, { error: 'Not authenticated' })
    const chart = await readBody(req)
    if (!chart.id) chart.id = 'c_' + randomBytes(8).toString('hex')
    if (!chart.created) chart.created = new Date().toISOString()
    const saved = saveChart(user.username, chart)
    return json(res, 200, { id: saved.id })
  }

  if (path.match(/^\/api\/charts\/[\w-]+$/) && req.method === 'PUT') {
    const user = getUserFromRequest(req)
    if (!user) return json(res, 401, { error: 'Not authenticated' })
    const id = path.split('/').pop()
    const chart = await readBody(req)
    chart.id = id
    saveChart(user.username, chart)
    return json(res, 200, { ok: true })
  }

  if (path.match(/^\/api\/charts\/[\w-]+$/) && req.method === 'DELETE') {
    const user = getUserFromRequest(req)
    if (!user) return json(res, 401, { error: 'Not authenticated' })
    const id = path.split('/').pop()
    deleteChart(user.username, id)
    return json(res, 200, { ok: true })
  }

  // ── AI ───────────────────────────────────────────────────────────────────
  if (path === '/api/gantt/ai-generate' && req.method === 'POST') {
    const user = getUserFromRequest(req)
    if (!user) return json(res, 401, { error: 'Not authenticated' })
    return handleAiGenerate(req, res)
  }

  // ── Static Files ─────────────────────────────────────────────────────────
  let filePath = join(__dirname, 'public', path === '/' ? 'index.html' : path)
  if (!existsSync(filePath)) { res.writeHead(404); return res.end('Not found') }
  const ext = extname(filePath)
  const mime = MIME[ext] || 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': mime })
  res.end(readFileSync(filePath))
})

server.listen(PORT, () => {
  console.log(`[gantt-editor] running at http://localhost:${PORT}`)
  console.log(`[gantt-editor] data dir: ${DATA_DIR}`)
})
