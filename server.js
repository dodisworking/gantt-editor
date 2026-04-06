import { createServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { join, extname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PORT = process.env.PORT || 3000

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

// ── AI Generation Endpoint ───────────────────────────────────────────────────
async function handleAiGenerate(req, res) {
  let body = ''
  for await (const chunk of req) body += chunk
  const { prompt } = JSON.parse(body)

  if (!prompt?.trim()) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: 'prompt is required' }))
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim()
  const openaiKey = process.env.OPENAI_API_KEY?.trim()

  if (!anthropicKey && !openaiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: 'No AI API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.' }))
  }

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
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      if (!resp.ok) throw new Error(`Anthropic API error: ${resp.status} ${await resp.text()}`)
      const data = await resp.json()
      result = data.content[0].text
    } else {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          temperature: 0.7,
        }),
      })
      if (!resp.ok) throw new Error(`OpenAI API error: ${resp.status} ${await resp.text()}`)
      const data = await resp.json()
      result = data.choices[0].message.content
    }

    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const parsed = JSON.parse(cleaned)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(parsed))
  } catch (err) {
    console.error('[gantt-ai]', err.message)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

// ── Static File Server ───────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  // API
  if (req.method === 'POST' && req.url === '/api/gantt/ai-generate') {
    return handleAiGenerate(req, res)
  }

  // Static files
  let filePath = join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url)
  if (!existsSync(filePath)) {
    res.writeHead(404)
    return res.end('Not found')
  }
  const ext = extname(filePath)
  const mime = MIME[ext] || 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': mime })
  res.end(readFileSync(filePath))
})

server.listen(PORT, () => {
  console.log(`[gantt-editor] running at http://localhost:${PORT}`)
})
