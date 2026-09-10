/**
 * Larpp Gifts Bot — entry point.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { altgram } from './src/altgram'
import { handleUpdate } from './src/handlers'
import { db } from './src/db'
import type { TgUpdate, TgUser } from './src/types'

const PORT = Number(process.env.PORT) || 3012
const POLL_TIMEOUT = 30
const RETRY_MS = 2000
const OFFSET_FILE = `${import.meta.dir}/.offset.json`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ⚠️ offset хранится как STRING — update_id в Telegram может превышать
// Number.MAX_SAFE_INTEGER (2^53), и Number() теряет точность, из-за чего
// бот пропускает апдейты (кнопки "не работают"). Используем BigInt везде.
function readOffset(): string {
  try {
    if (!existsSync(OFFSET_FILE)) return '0'
    const raw = JSON.parse(readFileSync(OFFSET_FILE, 'utf8'))
    const v = raw.offset
    if (typeof v === 'string') return v
    if (typeof v === 'number') return String(v)
    return '0'
  } catch { return '0' }
}

function saveOffset(offset: string) {
  try { writeFileSync(OFFSET_FILE, JSON.stringify({ offset })) } catch {}
}

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/' || path === '/health') {
      return new Response('OK: larpp-bot running\n', { headers: { 'Content-Type': 'text/plain' } })
    }
    return new Response('Not Found', { status: 404 })
  },
})
console.log(`[larpp-bot] health server on port ${server.port}`)

async function main() {
  if (!process.env.BOT_TOKEN) {
    console.error('[larpp-bot] FATAL: BOT_TOKEN not set')
    process.exit(1)
  }

  let me: TgUser | null = null
  for (let i = 0; i < 10; i++) {
    const res = await altgram.getMe()
    if (res.ok && res.result) { me = res.result; break }
    await sleep(RETRY_MS)
  }
  if (!me) { console.error('[larpp-bot] auth failed'); return }
  console.log(`[larpp-bot] authorized as @${me.username}`)

  try { await altgram.deleteWebhook() } catch {}
  await altgram.setMyCommands([
    { command: 'start', description: '🎁 Главное меню' },
    { command: 'balance', description: '💼 Мой баланс' },
    { command: 'withdraw', description: '💸 Вывести звёзды' },
    { command: 'promo', description: '🎟️ Активировать промокод' },
    { command: 'ref', description: '👥 Реферальная ссылка' },
    { command: 'stats', description: '📊 Статистика' },
    { command: 'help', description: '❓ Помощь' },
    { command: 'admin', description: '👑 Админ-панель' },
    { command: 'addpromo', description: '[админ] Создать промокод' },
    { command: 'givegift', description: '[админ] Отправить NFT' },
    { command: 'broadcast', description: '[админ] Рассылка' },
    { command: 'listusers', description: '[админ] Юзеры' },
  ])

  console.log(`Bot started as @${me.username}`)

  try {
    const userCount = await db.user.count()
    console.log(`[db] Подключено. Юзеров: ${userCount}`)
  } catch (e) {
    console.error('[db] error:', e)
    throw e
  }

  let offset = readOffset()
  console.log(`[larpp-bot] polling from offset=${offset}`)

  let handled = 0

  while (true) {
    try {
      const apiUrl = `${process.env.ALTGRAM_API_URL}/bot${process.env.BOT_TOKEN}/getUpdates`
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: `{"offset":${offset},"timeout":${POLL_TIMEOUT},"allowed_updates":["message","callback_query"]}`,
      })

      if (!res.ok) {
        console.error(`[poll] HTTP ${res.status}`)
        await sleep(RETRY_MS)
        continue
      }

      const data = await res.json() as { ok: boolean; result?: TgUpdate[]; error_code?: number }

      if (!data.ok) {
        if (data.error_code === 409) {
          console.log('[poll] 409 Conflict. Waiting 60s...')
          await sleep(60_000)
        } else {
          await sleep(RETRY_MS)
        }
        continue
      }

      const updates = data.result ?? []
      for (const u of updates) {
        try {
          // BigInt — без потери точности для больших update_id
          offset = String(BigInt(u.update_id) + 1n)
          saveOffset(offset)
          handled++
          await handleUpdate(u)
        } catch (e) {
          console.error('[poll] handler error:', u.update_id, e)
        }
      }

      if (updates.length > 0) {
        console.log(`[poll] ${updates.length} updates, offset=${offset}, total=${handled}`)
      }
    } catch (e) {
      const msg = String(e)
      if (msg.includes('ConnectionRefused') || msg.includes('ECONNRESET')) {
        console.error('[poll] AltGram unreachable, 15s...')
        await sleep(15_000)
      } else {
        console.error('[poll] error:', e)
        await sleep(RETRY_MS * 2)
      }
    }
  }
}

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[larpp-bot] ${signal}, shutting down…`)
  server.stop(true)
  setTimeout(() => process.exit(0), 500).unref?.()
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGPIPE', () => {})

main().catch(async (e) => {
  console.error('[larpp-bot] fatal:', e)
  await sleep(10_000)
  main().catch(() => process.exit(1))
})

process.on('unhandledRejection', (r) => console.error('[larpp-bot] unhandled:', r))
process.on('uncaughtException', (e) => console.error('[larpp-bot] uncaught:', e))
