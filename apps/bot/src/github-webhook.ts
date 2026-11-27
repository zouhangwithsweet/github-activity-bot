import { createHmac, timingSafeEqual } from 'node:crypto'
import Fastify from 'fastify'
import { isRepositoryName } from './github.ts'

export interface GitHubWebhookEvent {
  kind: 'star' | 'fork' | 'pull_request' | 'ci'
  repository: string
  action: string
  headSha?: string
  pullRequestNumber?: number
  actor?: string
  url: string
}

interface GitHubWebhookOptions {
  secret: string
  repository: string
  receive: (
    deliveryId: string,
    event: GitHubWebhookEvent,
    receivedAtMs: number,
  ) => boolean | Promise<boolean>
  now?: () => number
}

const starActions = new Set(['created', 'deleted'])
const pullRequestActions = new Set([
  'opened',
  'reopened',
  'closed',
  'synchronize',
  'ready_for_review',
  'converted_to_draft',
])
const ciEvents = new Set(['check_run', 'check_suite', 'workflow_run'])
const commitStates = new Set(['error', 'failure', 'pending', 'success'])
const utf8 = new TextDecoder('utf-8', { fatal: true })

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
}

function sha(value: unknown) {
  if (typeof value === 'string' && /^[a-f\d]{40}$/i.test(value)) return value.toLowerCase()
}

function prNumber(value: unknown) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647) {
    return value
  }
}

function relatedPullRequest(pulls: unknown, repository: string, repositoryId: unknown) {
  if (!Array.isArray(pulls)) return
  let match: number | undefined
  const repositoryPath = repository.toLowerCase()
  for (const value of pulls as unknown[]) {
    const pull = asObject(value)
    const number = prNumber(pull?.number)
    if (!number) continue
    const repo = asObject(asObject(pull?.base)?.repo)
    if (
      !(typeof repositoryId === 'number' && repo?.id === repositoryId) &&
      !(typeof repo?.full_name === 'string' && repo.full_name.toLowerCase() === repositoryPath) &&
      !(
        typeof repo?.url === 'string' &&
        repo.url.toLowerCase() === `https://api.github.com/repos/${repositoryPath}`
      )
    ) {
      continue
    }
    if (match && match !== number) return
    match = number
  }
  return match
}

function verifiedSignature(body: Buffer, secret: string, signature: unknown) {
  if (typeof signature !== 'string' || !/^sha256=[a-f\d]{64}$/i.test(signature)) return false
  const expected = createHmac('sha256', secret).update(body).digest()
  const supplied = Buffer.from(signature.slice('sha256='.length), 'hex')
  return timingSafeEqual(expected, supplied)
}

function normalizeEvent(
  name: string,
  payload: Record<string, unknown>,
  allowedRepository: string,
): GitHubWebhookEvent | undefined {
  const ownerRepository = asObject(payload.repository)
  const repository = ownerRepository?.full_name
  if (
    typeof repository !== 'string' ||
    !isRepositoryName(repository) ||
    repository.toLowerCase() !== allowedRepository
  ) {
    return
  }
  const githubUrl = `https://github.com/${repository}`
  const login = asObject(payload.sender)?.login
  const actor =
    typeof login === 'string' && /^[a-z\d-]{1,100}(?:\[bot\])?$/i.test(login) ? login : undefined
  const origin = { repository, ...(actor === undefined ? {} : { actor }) }
  const action = typeof payload.action === 'string' ? payload.action : ''

  if (name === 'star' && starActions.has(action)) {
    return { ...origin, kind: 'star', action, url: githubUrl }
  }
  if (name === 'fork') {
    const forkee = asObject(payload.forkee)?.full_name
    const url =
      typeof forkee === 'string' && isRepositoryName(forkee)
        ? `https://github.com/${forkee}`
        : githubUrl
    return { ...origin, kind: 'fork', action: 'forked', url }
  }
  if (name === 'pull_request' && pullRequestActions.has(action)) {
    const pull = asObject(payload.pull_request)
    const pullRequestNumber = prNumber(payload.number)
    if (
      !pull ||
      !pullRequestNumber ||
      (pull.number !== undefined && pull.number !== pullRequestNumber)
    )
      return
    const headSha = sha(asObject(pull.head)?.sha)
    return {
      ...origin,
      kind: 'pull_request',
      action,
      pullRequestNumber,
      ...(headSha === undefined ? {} : { headSha }),
      url: `${githubUrl}/pull/${pullRequestNumber}`,
    }
  }
  if (name === 'status') {
    const headSha = sha(payload.sha)
    const state = payload.state
    if (!headSha || typeof state !== 'string' || !commitStates.has(state)) return
    return {
      ...origin,
      kind: 'ci',
      action: state,
      headSha,
      url: `${githubUrl}/commit/${headSha}/checks`,
    }
  }
  if (!ciEvents.has(name) || action !== 'completed') return
  const check = asObject(payload[name])
  const headSha = sha(check?.head_sha)
  if (!headSha) return
  const pullRequestNumber = relatedPullRequest(
    check?.pull_requests,
    repository,
    ownerRepository?.id,
  )
  const runId = check?.id
  const url =
    name === 'workflow_run' && typeof runId === 'number' && Number.isSafeInteger(runId) && runId > 0
      ? `${githubUrl}/actions/runs/${runId}`
      : `${githubUrl}/commit/${headSha}/checks`
  return {
    ...origin,
    kind: 'ci',
    action,
    headSha,
    ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
    url,
  }
}

export function createGitHubWebhookServer(options: GitHubWebhookOptions) {
  const { secret, repository, receive, now = Date.now } = options
  if (!secret.trim()) throw new Error('A GitHub webhook secret is required.')
  if (!isRepositoryName(repository))
    throw new Error('GitHub webhook repository must be owner/repo.')
  const allowedRepository = repository.toLowerCase()

  const server = Fastify({ bodyLimit: 2 * 1_024 * 1_024, requestTimeout: 10_000 })
  server.removeAllContentTypeParsers()
  server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body)
  })
  server.post<{ Body: Buffer }>('/webhooks/github', async (request, reply) => {
    const { body, headers } = request
    if (
      !Buffer.isBuffer(body) ||
      !verifiedSignature(body, secret, headers['x-hub-signature-256'])
    ) {
      return reply.code(401).send()
    }
    const name = headers['x-github-event']
    const deliveryId = headers['x-github-delivery']
    if (
      typeof name !== 'string' ||
      !/^[a-z\d_]{1,64}$/.test(name) ||
      typeof deliveryId !== 'string' ||
      !/^[a-z\d._-]{1,128}$/i.test(deliveryId)
    ) {
      return reply.code(400).send()
    }

    let payload: Record<string, unknown> | undefined
    try {
      payload = asObject(JSON.parse(utf8.decode(body)))
    } catch {
      return reply.code(400).send()
    }
    if (!payload) return reply.code(400).send()
    if (name === 'ping') return reply.code(200).send()
    const event = normalizeEvent(name, payload, allowedRepository)
    if (!event) return reply.code(204).send()

    try {
      const queued = await receive(deliveryId, event, now())
      return reply.code(queued ? 202 : 200).send()
    } catch {
      return reply.code(503).send()
    }
  })
  return server
}
