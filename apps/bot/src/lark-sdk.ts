import {
  defaultHttpInstance,
  LoggerLevel,
  type HttpInstance,
  type HttpRequestOptions,
  type LarkChannel,
  type LarkChannelOptions,
  type Logger,
} from '@larksuiteoapi/node-sdk'

const requestTimeoutMs = 15_000
const handshakeTimeoutMs = 10_000

const transportCodes = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ERR_BAD_REQUEST',
  'ERR_BAD_RESPONSE',
  'ERR_CANCELED',
  'ETIMEDOUT',
])

function fields(value: unknown) {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function sdkLogger(write: (line: string) => void): Logger {
  const ignore = () => {}
  return {
    error(...args: unknown[]) {
      // The SDK wraps its logging arguments in arrays. Axios errors can contain
      // the entire request body and headers, including credentials.
      const values = args.flat(3)
      const error = fields(values.find((value) => value instanceof Error))
      const { status } = fields(error.response)
      const { url } = fields(error.config)
      const path =
        typeof url === 'string' ? URL.parse(url, 'https://open.larksuite.com')?.pathname : undefined
      let stage = 'rest'
      if (path === '/open-apis/auth/v3/tenant_access_token/internal') stage = 'tenant_token'
      if (values.includes('[ws]') || path === '/callback/ws/endpoint') stage = 'websocket'
      write(
        JSON.stringify({
          event: 'lark.sdk_error',
          stage,
          code:
            typeof error.code === 'string' && transportCodes.has(error.code)
              ? error.code
              : undefined,
          status:
            typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
              ? status
              : undefined,
        }),
      )
    },
    warn: ignore,
    info: ignore,
    debug: ignore,
    trace: ignore,
  }
}

function boundedHttp(maxTimeoutMs: number, shutdown?: AbortSignal): HttpInstance {
  function request<T = unknown, R = T, D = unknown>(
    options: HttpRequestOptions<D> & { signal?: AbortSignal },
  ) {
    const requested = options.timeout ?? maxTimeoutMs
    const timeout =
      Number.isFinite(requested) && requested > 0
        ? Math.max(1, Math.min(Math.floor(requested), maxTimeoutMs))
        : maxTimeoutMs
    const deadline = AbortSignal.timeout(timeout)
    const signals = [deadline]
    if (options.signal) signals.push(options.signal)
    if (shutdown) signals.push(shutdown)
    // Keep the SDK's response normalization, multipart handling and proxy
    // settings. The abort signal also covers requests that stall before a socket is ready.
    return defaultHttpInstance.request({
      ...options,
      timeout,
      signal: AbortSignal.any(signals),
    }) as Promise<R>
  }

  return {
    request,
    get: (url, options) => request({ ...options, url, method: 'get' }),
    delete: (url, options) => request({ ...options, url, method: 'delete' }),
    head: (url, options) => request({ ...options, url, method: 'head' }),
    options: (url, options) => request({ ...options, url, method: 'options' }),
    post: (url, data, options) => request({ ...options, url, data, method: 'post' }),
    put: (url, data, options) => request({ ...options, url, data, method: 'put' }),
    patch: (url, data, options) => request({ ...options, url, data, method: 'patch' }),
  }
}

export function createLarkSdkOptions({
  signal,
  timeoutMs = requestTimeoutMs,
  writeError = console.error,
}: {
  signal?: AbortSignal
  timeoutMs?: number
  writeError?: (line: string) => void
} = {}): Pick<
  LarkChannelOptions,
  'logger' | 'loggerLevel' | 'httpInstance' | 'handshakeTimeoutMs'
> {
  return {
    logger: sdkLogger(writeError),
    loggerLevel: LoggerLevel.error,
    httpInstance: boundedHttp(timeoutMs, signal),
    handshakeTimeoutMs,
  }
}

export async function closeLarkChannel(channel: Pick<LarkChannel, 'rawWsClient' | 'disconnect'>) {
  try {
    // disconnect() skips cleanup until the initial handshake has succeeded.
    channel.rawWsClient?.close({ force: true })
  } finally {
    await channel.disconnect()
  }
}
