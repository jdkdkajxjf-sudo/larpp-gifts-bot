/** Telegram types for Larpp bot. */

export interface TgUser {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
}

export interface TgChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
}

export interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  date: number
  text?: string
  reply_to_message?: TgMessage
  forward_from?: TgUser
  forward_origin?: { type: string; sender_user?: TgUser }
}

export interface TgCallbackQuery {
  id: string
  from: TgUser
  message?: TgMessage
  data?: string
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallbackQuery
  pre_checkout_query?: {
    id: string
    from: TgUser
    currency: string
    total_amount: number
    invoice_payload: string
  }
}
