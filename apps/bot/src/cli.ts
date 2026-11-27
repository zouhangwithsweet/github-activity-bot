import { createPullRequestQuery, hasFailingChecks } from './github.ts'

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('Usage: pnpm prs [--failed]')
    return
  }
  if (args.some((arg) => arg !== '--failed')) {
    throw new Error('Unknown argument. Use pnpm prs --help.')
  }

  const query = createPullRequestQuery()
  if (!query) {
    throw new Error('Set GH_TOKEN or GH_ORG_TOKEN in the environment or in a local .env file.')
  }

  const { login, pullRequests, unavailableRepositories } = await query()
  const failedOnly = args.includes('--failed')
  const selected = failedOnly ? pullRequests.filter(hasFailingChecks) : pullRequests

  console.log(
    `@${login} · ${selected.length} visible open PR(s)${failedOnly ? ' with failing checks' : ''}`,
  )
  if (unavailableRepositories.length) {
    console.log(`Incomplete results. Cannot read PRs in: ${unavailableRepositories.join(', ')}.`)
  }
  for (const pr of selected) {
    const draft = pr.draft ? ' [DRAFT]' : ''
    console.log(
      `[${pr.checks ?? 'NO CHECK DATA'}]${draft} ${pr.repository}#${pr.number} ${pr.title}`,
    )
    console.log(`  ${pr.url}`)
  }
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
