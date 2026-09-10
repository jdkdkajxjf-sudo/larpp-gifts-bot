/**
 * Larpp Gifts Bot — раздача NFT от @larpp
 *
 * Features:
 * - Каталог gifts от @larpp
 * - Кнопка "Лучший ТГК @larpp" в главном меню
 * - Промокоды: NFT/звёзды, лимит активаций, по времени
 * - Рефералка: 2 Scared Cat за каждого приглашённого
 * - Админ-панель: создание промокодов, статистика
 */

import { db } from './db'
import { altgram, md, type TgInlineKeyboardMarkup } from './altgram'
import type { TgCallbackQuery, TgMessage, TgUpdate, TgUser } from './types'

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'xyz').toLowerCase()
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || 'larpp'

// NFT который раздаём (Scared Cat, 25⭐, gift_id=9000000000000030)
const NFT_GIFT_ID = '9000000000000030'
const NFT_NAME = 'Scared Cat'
const NFT_EMOJI = '🐱'
const NFT_PRICE = 25
const REF_REWARD = 2 // 2 кота за каждого реферала

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function send(chatId: number | string, text: string, kb?: TgInlineKeyboardMarkup, replyTo?: number) {
  const { text: plain, entities } = md(text)
  return altgram.sendMessage({ chat_id: chatId, text: plain, entities, reply_markup: kb, reply_to_message_id: replyTo })
}

function genRefCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)]
  return code
}

async function upsertUser(from: TgUser) {
  const isAdmin = from.username?.toLowerCase() === ADMIN_USERNAME
  const existing = await db.user.findUnique({ where: { tgId: String(from.id) } })
  if (!existing) {
    let refCode = genRefCode()
    while (await db.user.findUnique({ where: { refCode } })) refCode = genRefCode()
    return db.user.create({
      data: {
        tgId: String(from.id),
        username: from.username?.toLowerCase() ?? null,
        firstName: from.first_name ?? null,
        isAdmin,
        refCode,
      },
    })
  }
  return db.user.update({
    where: { tgId: String(from.id) },
    data: {
      username: from.username?.toLowerCase() ?? null,
      firstName: from.first_name ?? null,
      ...(isAdmin || existing.isAdmin ? { isAdmin: true } : {}),
    },
  })
}

// Отправка NFT gift юзеру
async function sendNftGift(tgId: string, count: number = 1): Promise<{ sent: number; failed: number }> {
  let sent = 0, failed = 0
  for (let i = 0; i < count; i++) {
    let giftSent = false
    // Пробуем с текстом
    const res = await altgram.sendGift({
      user_id: Number(tgId),
      gift_id: NFT_GIFT_ID,
      text: `🎁 Подарок от @${CHANNEL_USERNAME}`,
    })
    if (res.ok) { giftSent = true }
    else {
      // Пробуем без текста
      const res2 = await altgram.sendGift({ user_id: Number(tgId), gift_id: NFT_GIFT_ID })
      if (res2.ok) { giftSent = true }
    }
    if (giftSent) sent++; else failed++
  }
  return { sent, failed }
}

/* ------------------------------------------------------------------ */
/* Update dispatch                                                     */
/* ------------------------------------------------------------------ */

export async function handleUpdate(update: TgUpdate): Promise<void> {
  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query)
      return
    }
    const msg = update.message
    if (!msg || !msg.text) return
    await handleText(msg)
  } catch (e) {
    console.error('[handler] error:', e)
  }
}

async function handleText(msg: TgMessage) {
  const from = msg.from
  if (!from || from.is_bot || msg.chat.type !== 'private') return

  const user = await upsertUser(from)
  const text = (msg.text ?? '').trim()
  const parts = text.split(/\s+/)
  const cmd = (parts[0]?.split('@')[0] ?? '').toLowerCase()

  console.log(`[msg] @${from.username ?? from.id}: ${text.slice(0, 80)}`)

  switch (cmd) {
    case '/start': {
      const arg = parts[1]
      if (arg?.startsWith('ref_')) {
        const refCode = arg.slice(4)
        const referrer = await db.user.findUnique({ where: { refCode } })
        if (referrer && referrer.tgId !== user.tgId && !user.referredById) {
          await db.user.update({ where: { id: user.id }, data: { referredById: referrer.id } })
          // Награда рефереру: 2 кота
          const result = await sendNftGift(referrer.tgId, REF_REWARD)
          await send(referrer.tgId,
            `🎉 По вашей ссылке пришёл @${user.username ?? user.firstName}!\n🎁 Награда: ${result.sent} × ${NFT_EMOJI} ${NFT_NAME}!`)
        }
      }
      await sendMenu(msg.chat.id, user)
      break
    }
    case '/help':
      await send(msg.chat.id,
        [
          `🎁 **Подарки от @${CHANNEL_USERNAME}**`,
          ``,
          '**Команды:**',
          '• /start — главное меню',
          '• /promo <код> — активировать промокод',
          '• /ref — реферальная ссылка',
          '• /stats — статистика',
          '• /help — помощь',
        ].join('\n'))
      break
    case '/promo': {
      const code = parts[1]
      await handlePromo(msg, user, code)
      break
    }
    case '/ref':
    case '/referral': {
      const refLink = `https://altgram.xyz/nftshopbot?start=ref_${user.refCode}`
      const refCount = await db.user.count({ where: { referredById: user.id } })
      await send(msg.chat.id,
        [
          `👥 **Реферальная программа**`,
          ``,
          `Приглашай друзей — получай ${NFT_EMOJI} ${NFT_NAME}!`,
          `За каждого друга: **${REF_REWARD} × ${NFT_EMOJI}**`,
          ``,
          `📋 Приглашено: **${refCount}** чел.`,
          `🎁 Получено: **${refCount * REF_REWARD}** ${NFT_EMOJI}`,
          ``,
          `🔗 Твоя ссылка:`,
          `${refLink}`,
        ].join('\n'))
      break
    }
    case '/stats': {
      const refCount = await db.user.count({ where: { referredById: user.id } })
      const promoCount = await db.promoRedemption.count({ where: { userId: user.id } })
      await send(msg.chat.id,
        [
          `📊 **Твоя статистика**`,
          ``,
          `👥 Приглашено: ${refCount}`,
          `🎁 ${NFT_EMOJI} получено: ${refCount * REF_REWARD}`,
          `🎟️ Промокодов активировано: ${promoCount}`,
        ].join('\n'))
      break
    }
    // Админ
    case '/admin':
      await sendAdminPanel(msg.chat.id, user)
      break
    case '/addpromo':
      await handleAddPromo(msg, user, parts.slice(1))
      break
    case '/broadcast':
      await handleBroadcast(msg, user, parts.slice(1).join(' '))
      break
    case '/listusers':
      await handleListUsers(msg, user)
      break
    case '/givegift':
      await handleGiveGift(msg, user, parts[1], parts[2])
      break
    default:
      if (cmd.startsWith('/')) {
        await send(msg.chat.id, '🤔 Используй /start')
      }
  }
}

/* ------------------------------------------------------------------ */
/* Main menu                                                           */
/* ------------------------------------------------------------------ */

async function sendMenu(chatId: number, user: { firstName: string | null; username: string | null; isAdmin: boolean; tgId: string }) {
  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [
      [{ text: `📢 Лучший ТГК @${CHANNEL_USERNAME}`, url: `https://altgram.xyz/${CHANNEL_USERNAME}` }],
      [
        { text: '🎟️ Промокод', callback_data: 'promo_input' },
        { text: '👥 Рефералка', callback_data: 'ref' },
      ],
      [{ text: '📊 Статистика', callback_data: 'stats' }],
      // Админ-панель убрана из меню — доступ только через /admin
    ],
  }
  await send(chatId,
    [
      `👋 Привет, **${user.firstName || user.username || 'друг'}**!`,
      ``,
      `🎁 **Подарки от @${CHANNEL_USERNAME}**`,
      ``,
      `Здесь ты можешь:`,
      `• 🎟️ Активировать промокод на ${NFT_EMOJI} ${NFT_NAME}`,
      `• 👥 Пригласить друзей и получить ${NFT_EMOJI} за каждого`,
      `• 📊 Посмотреть свою статистику`,
      ``,
      `🎁 За каждого друга — **${REF_REWARD} × ${NFT_EMOJI} ${NFT_NAME}**!`,
    ].join('\n'), kb)
}

/* ------------------------------------------------------------------ */
/* Promo codes                                                         */
/* ------------------------------------------------------------------ */

async function handlePromo(msg: TgMessage, user: { id: string; tgId: string }, code?: string) {
  if (!code) {
    await send(msg.chat.id, '⚠️ Введи код: `/promo ABCD1234`')
    return
  }

  const promo = await db.promoCode.findUnique({ where: { code: code.toUpperCase() } })
  if (!promo || !promo.isActive) {
    await send(msg.chat.id, '❌ Промокод не найден или неактивен')
    return
  }

  if (promo.expiresAt && promo.expiresAt < new Date()) {
    await send(msg.chat.id, '❌ Срок действия промокода истёк')
    return
  }

  if (promo.usedCount >= promo.maxUses) {
    await send(msg.chat.id, '❌ Промокод уже использован максимальное число раз')
    return
  }

  const existing = await db.promoRedemption.findUnique({
    where: { promoId_userId: { promoId: promo.id, userId: user.id } },
  })
  if (existing) {
    await send(msg.chat.id, '❌ Ты уже использовал этот промокод')
    return
  }

  // Редим
  await db.promoRedemption.create({ data: { promoId: promo.id, userId: user.id } })
  const newUsed = promo.usedCount + 1
  await db.promoCode.update({
    where: { id: promo.id },
    data: { usedCount: newUsed, isActive: newUsed >= promo.maxUses ? false : true },
  })

  if (promo.type === 'nft') {
    const count = promo.reward
    await send(msg.chat.id, `🎉 Промокод активирован! Отправляю ${count} × ${NFT_EMOJI} ${NFT_NAME}...`)

    const result = await sendNftGift(user.tgId, count)
    if (result.sent > 0) {
      await send(msg.chat.id, `✅ Отправлено ${result.sent} × ${NFT_EMOJI} ${NFT_NAME}!`)
    } else {
      await send(msg.chat.id, `⚠️ NFT временно недоступен. Попробуй позже.`)
    }
  } else if (promo.type === 'stars') {
    // Звёзды — просто уведомляем (баланс не храним)
    await send(msg.chat.id, `🎉 Промокод активирован! +${promo.reward}⭐`)
  }
}

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */

async function sendAdminPanel(chatId: number, user: { isAdmin: boolean }) {
  if (!user.isAdmin) { await send(chatId, '🚫 Только админ.'); return }

  const userCount = await db.user.count()
  const promoCount = await db.promoCode.count({ where: { isActive: true } })
  const totalRedemptions = await db.promoRedemption.count()
  const totalRefs = await db.user.count({ where: { referredById: { not: null } } })

  await send(chatId,
    [
      `👑 **Админ-панель @${CHANNEL_USERNAME}**`,
      ``,
      `👥 Юзеров: **${userCount}**`,
      `🎟️ Активных промокодов: **${promoCount}**`,
      `📊 Всего активаций: **${totalRedemptions}**`,
      `👥 Рефералов: **${totalRefs}**`,
      ``,
      '**Команды:**',
      '• `/addpromo nft 5 100` — 5 котов, 100 активаций',
      '• `/addpromo nft 3 50 24h` — 3 кота, 50 активаций, 24 часа',
      '• `/addpromo stars 1000 10` — 1000⭐, 10 активаций',
      '• `/givegift @user 5` — отправить 5 котов юзеру',
      '• `/broadcast текст` — рассылка всем',
      '• `/listusers` — список юзеров',
    ].join('\n'))
}

async function handleAddPromo(msg: TgMessage, user: { tgId: string; isAdmin: boolean }, args: string[]) {
  if (!user.isAdmin) { await send(msg.chat.id, '🚫 Только админ.'); return }

  // /addpromo nft 5 100        → 5 котов, 100 активаций, бессрочно
  // /addpromo nft 3 50 24h     → 3 кота, 50 активаций, 24 часа
  // /addpromo nft 2 10 7d      → 2 кота, 10 активаций, 7 дней
  // /addpromo stars 1000 10    → 1000 звёзд, 10 активаций
  const type = args[0]?.toLowerCase()
  const reward = parseInt(args[1] ?? '0')
  const maxUses = parseInt(args[2] ?? '1') || 1
  const durationArg = args[3] // 24h, 7d, 30d

  if (type !== 'nft' && type !== 'stars') {
    await send(msg.chat.id,
      [
        '⚠️ Использование:',
        '',
        '`/addpromo nft 5 100` — 5 котов, 100 активаций',
        '`/addpromo nft 3 50 24h` — 3 кота, 50 активаций, 24 часа',
        '`/addpromo nft 2 10 7d` — 2 кота, 10 активаций, 7 дней',
        '`/addpromo stars 1000 10` — 1000⭐, 10 активаций',
        '',
        'Длительность: 1h, 12h, 24h, 7d, 30d (необязательно)',
      ].join('\n'))
    return
  }

  if (reward <= 0) {
    await send(msg.chat.id, '⚠️ Укажи количество: `/addpromo nft 5 100`')
    return
  }

  // Вычисляем expiry
  let expiresAt: Date | null = null
  if (durationArg) {
    const m = durationArg.toLowerCase().match(/^(\d+)([hм]|[dд]|[wн])$/)
    if (m) {
      const num = parseInt(m[1])
      const unit = m[2]
      const now = new Date()
      if (unit === 'h' || unit === 'м') {
        expiresAt = new Date(now.getTime() + num * 60 * 60 * 1000)
      } else if (unit === 'd' || unit === 'д') {
        expiresAt = new Date(now.getTime() + num * 24 * 60 * 60 * 1000)
      } else if (unit === 'w' || unit === 'н') {
        expiresAt = new Date(now.getTime() + num * 7 * 24 * 60 * 60 * 1000)
      }
    }
  }

  // Генерируем код
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)]

  const promo = await db.promoCode.create({
    data: {
      code,
      type,
      reward,
      nftSlug: type === 'nft' ? 'scared-cat' : null,
      maxUses,
      expiresAt,
      createdById: user.tgId,
    },
  })

  const expiryText = expiresAt ? expiresAt.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'бессрочно'
  const rewardText = type === 'nft' ? `${reward} × ${NFT_EMOJI} ${NFT_NAME}` : `${reward}⭐`

  await send(msg.chat.id,
    [
      `✅ **Промокод создан!**`,
      ``,
      `📝 Код: \`${code}\``,
      `🎁 Награда: ${rewardText}`,
      `🔄 Лимит: ${maxUses} активаций`,
      `⏰ Действует до: ${expiryText}`,
      ``,
      `Поделись: \`/promo ${code}\``,
    ].join('\n'))
}

async function handleGiveGift(msg: TgMessage, user: { isAdmin: boolean }, targetArg?: string, countArg?: string) {
  if (!user.isAdmin) { await send(msg.chat.id, '🚫 Только админ.'); return }
  if (!targetArg?.startsWith('@')) { await send(msg.chat.id, '⚠️ `/givegift @user 5`'); return }

  const targetUsername = targetArg.slice(1).toLowerCase()
  const count = Math.min(Math.max(parseInt(countArg ?? '1') || 1, 1), 50)

  const target = await db.user.findFirst({ where: { username: targetUsername } })
  if (!target) { await send(msg.chat.id, `❌ @${targetUsername} не найден`); return }

  await send(msg.chat.id, `⏳ Отправляю ${count} × ${NFT_EMOJI} ${NFT_NAME} юзеру @${targetUsername}...`)

  const result = await sendNftGift(target.tgId, count)
  await send(msg.chat.id,
    [
      `🎁 **Результат:**`,
      `👤 @${targetUsername}`,
      `💰 ${NFT_EMOJI} ${NFT_NAME} × ${count}`,
      `✅ Отправлено: ${result.sent}`,
      `❌ Не удалось: ${result.failed}`,
    ].join('\n'))

  if (result.sent > 0) {
    try { await send(target.tgId, `🎁 Вам отправлено ${result.sent} × ${NFT_EMOJI} ${NFT_NAME} от @${CHANNEL_USERNAME}!`) } catch {}
  }
}

async function handleBroadcast(msg: TgMessage, user: { isAdmin: boolean }, text?: string) {
  if (!user.isAdmin) { await send(msg.chat.id, '🚫 Только админ.'); return }
  if (!text) { await send(msg.chat.id, '⚠️ `/broadcast текст`'); return }

  const users = await db.user.findMany({ select: { tgId: true } })
  let sent = 0, failed = 0
  for (const u of users) {
    try {
      await send(u.tgId, `📢 **@${CHANNEL_USERNAME}**\n\n${text}`)
      sent++
    } catch { failed++ }
    await sleep(50)
  }
  await send(msg.chat.id, `✅ Отправлено: ${sent}\n❌ Не удалось: ${failed}`)
}

async function handleListUsers(msg: TgMessage, user: { isAdmin: boolean }) {
  if (!user.isAdmin) { await send(msg.chat.id, '🚫 Только админ.'); return }
  const users = await db.user.findMany({
    select: { username: true, tgId: true, isAdmin: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 50,
  })
  const lines = users.map(u => {
    const name = u.username ? `@${u.username}` : `id:${u.tgId}`
    const tag = u.isAdmin ? ' 👑' : ''
    return `• ${name}${tag}`
  })
  await send(msg.chat.id, `📋 **Юзеры (${users.length}):**\n\n${lines.join('\n')}`)
}

/* ------------------------------------------------------------------ */
/* Callback handler                                                    */
/* ------------------------------------------------------------------ */

async function handleCallback(cq: TgCallbackQuery) {
  const data = cq.data ?? ''
  const from = cq.from
  if (!from) return

  let act = data
  let arg = ''
  if (data.includes(':')) [act, arg] = data.split(':')

  const user = await upsertUser(from)
  const chatId = cq.message?.chat.id ?? from.id

  console.log(`[callback] data="${data}" → act="${act}"`)

  try { await altgram.answerCallbackQuery({ callback_query_id: cq.id }) } catch {}

  if (act === 'promo_input') {
    await send(chatId, '🎟️ Введи промокод:\n\n`/promo ТВОЙ_КОД`')
  } else if (act === 'ref') {
    const refLink = `https://altgram.xyz/nftshopbot?start=ref_${user.refCode}`
    const refCount = await db.user.count({ where: { referredById: user.id } })
    await send(chatId,
      [
        `👥 **Реферальная программа**`,
        ``,
        `Приглашай друзей — получай ${NFT_EMOJI} ${NFT_NAME}!`,
        `За каждого: **${REF_REWARD} × ${NFT_EMOJI}**`,
        ``,
        `📋 Приглашено: ${refCount}`,
        `🎁 Получено: ${refCount * REF_REWARD} ${NFT_EMOJI}`,
        ``,
        `🔗 ${refLink}`,
      ].join('\n'))
  } else if (act === 'stats') {
    const refCount = await db.user.count({ where: { referredById: user.id } })
    const promoCount = await db.promoRedemption.count({ where: { userId: user.id } })
    await send(chatId,
      [
        `📊 **Твоя статистика**`,
        ``,
        `👥 Приглашено: ${refCount}`,
        `🎁 ${NFT_EMOJI} получено: ${refCount * REF_REWARD}`,
        `🎟️ Промокодов: ${promoCount}`,
      ].join('\n'))
  } else if (act === 'menu') {
    await sendMenu(chatId, user)
  }
}
