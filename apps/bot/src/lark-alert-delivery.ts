import type { Client } from '@larksuiteoapi/node-sdk'

type MessageApi = Pick<Client['im']['v1']['message'], 'create'>

export interface AlertToDeliver {
  id: string
  recipientOpenId: string
  text: string
}

export type AlertDelivery =
  | { kind: 'sent' }
  | { kind: 'retry'; reason: string; retryAfterMs?: number }
  | { kind: 'failed' | 'unknown'; reason: string }

function properties(value: unknown) {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function retryAfterMs(header: unknown) {
  if ((typeof header !== 'string' && typeof header !== 'number') || String(header).trim() === '') {
    return undefined
  }
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const date = Date.parse(String(header))
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

export function createLarkAlertSender(messages: MessageApi, redact: (text: string) => string) {
  return async (alert: AlertToDeliver): Promise<AlertDelivery> => {
    try {
      const response = await messages.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: alert.recipientOpenId,
          msg_type: 'text',
          content: JSON.stringify({ text: redact(alert.text) }),
          uuid: alert.id,
        },
      })
      if (response.code === 230020) return { kind: 'retry', reason: 'rate_limited' }
      if (typeof response.code === 'number' && response.code !== 0) {
        return { kind: 'failed', reason: `lark_${response.code}` }
      }
      if (response.data?.message_id) return { kind: 'sent' }
      return { kind: 'unknown', reason: 'missing_message_id' }
    } catch (error) {
      const fields = properties(error)
      const response = properties(fields.response)
      const cause = properties(fields.cause)
      if (response.status === 429) {
        return {
          kind: 'retry',
          reason: 'rate_limited',
          retryAfterMs: retryAfterMs(properties(response.headers)['retry-after']),
        }
      }
      if (
        !response.status &&
        (fields.code === 'ECONNRESET' || cause.code === 'ECONNRESET') &&
        [fields.message, cause.message].some(
          (message) =>
            typeof message === 'string' &&
            message.includes('before secure TLS connection was established'),
        )
      ) {
        return { kind: 'retry', reason: 'tls_disconnected' }
      }
      const status = response.status
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) {
        return { kind: 'failed', reason: `http_${status}` }
      }
      // The API may have accepted the message before the response was lost.
      return { kind: 'unknown', reason: 'delivery_unconfirmed' }
    }
  }
}
