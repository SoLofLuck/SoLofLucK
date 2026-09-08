// The Raffle Operator page's non-UI logic: talking to the GitHub REST API
// directly from the browser with a user-supplied Personal Access Token, and
// the small pure helpers (round selection, slot estimate, countdown) around
// it. See src/config.ts (OPERATOR_WALLET, GITHUB_REPO) for the design notes.
//
// The token is deliberately never handled by anything other than this file
// and the page that reads it out of localStorage — it is attached as an
// Authorization header on requests to api.github.com only, never logged,
// never sent anywhere else.

import { GITHUB_REPO, RAFFLE } from '../config'
import type { RaffleScheduleEntry } from './raffleSchedule'

export const PAT_STORAGE_KEY = 'solofluck.raffleOperator.githubPat'

export function loadStoredPat(): string {
  try {
    return window.localStorage.getItem(PAT_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

export function storePat(pat: string) {
  try {
    if (pat) window.localStorage.setItem(PAT_STORAGE_KEY, pat)
    else window.localStorage.removeItem(PAT_STORAGE_KEY)
  } catch {
    /* localStorage unavailable (private mode etc.) — the operator will just
       have to re-paste the token on the next visit; not fatal. */
  }
}

const API_BASE = 'https://api.github.com'

interface GhRequestOptions {
  method?: string
  body?: unknown
}

async function ghRequest(pat: string, path: string, opts: GhRequestOptions = {}): Promise<unknown> {
  if (!pat.trim()) throw new Error('Enter your GitHub token first.')
  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${pat.trim()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  if (res.status === 204) return null
  const text = await res.text()
  const data: unknown = text ? JSON.parse(text) : null
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && data !== null && 'message' in data
        ? String((data as { message: unknown }).message)
        : `GitHub API error (HTTP ${res.status})`
    if (res.status === 401) throw new Error('The token was rejected (401) — check that it was copied correctly.')
    if (res.status === 403)
      throw new Error(`Access denied (403): ${message}. Check the token's repository and permission scope.`)
    if (res.status === 404)
      throw new Error(
        `Not found (404): ${message}. Check that the token has access to ${GITHUB_REPO.owner}/${GITHUB_REPO.repo}.`,
      )
    throw new Error(message)
  }
  return data
}

/** Verifies the token actually works and can see this repo, before anything
 *  destructive is attempted — used by the "Verify Token" button. */
export async function verifyPatAccess(pat: string): Promise<{ login: string }> {
  const me = (await ghRequest(pat, '/user')) as { login?: string }
  await ghRequest(pat, `/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}`)
  return { login: me.login ?? 'unknown' }
}

export interface TwitterWinnersFile {
  sha: string
  data: Record<string, string[]>
}

export async function fetchTwitterWinnersFile(pat: string): Promise<TwitterWinnersFile> {
  const res = (await ghRequest(
    pat,
    `/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}/contents/${GITHUB_REPO.twitterWinnersPath}?ref=${GITHUB_REPO.branch}`,
  )) as { sha: string; content: string; encoding: string }
  const json = atob(res.content.replace(/\n/g, ''))
  return { sha: res.sha, data: JSON.parse(json) as Record<string, string[]> }
}

/** Writes this round's 3 Twitter winner addresses into data/twitter-winners.json
 *  via the Contents API (create-or-update, keyed by the file's current sha so
 *  a concurrent edit is rejected rather than silently overwritten). */
export async function updateTwitterWinners(
  pat: string,
  round: number,
  addresses: string[],
): Promise<void> {
  const current = await fetchTwitterWinnersFile(pat)
  const next = { ...current.data, [String(round)]: addresses }
  const content = btoa(JSON.stringify(next, null, 2) + '\n')
  await ghRequest(pat, `/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}/contents/${GITHUB_REPO.twitterWinnersPath}`, {
    method: 'PUT',
    body: {
      message: `chore(raffle): set round ${round} Twitter winners`,
      content,
      sha: current.sha,
      branch: GITHUB_REPO.branch,
    },
  })
}

export interface RaffleRunInputs {
  round_id: string
  announced_slot: string
  program_id: string
  mint: string
  start_iso: string
  network: 'devnet' | 'mainnet-beta'
  dry_run: boolean
}

/** Dispatches run-raffle-round.yml. GitHub's dispatch endpoint returns 204
 *  with no run id, so the caller has to poll listRecentRuns() to find it. */
export async function dispatchRaffleRun(pat: string, inputs: RaffleRunInputs): Promise<void> {
  await ghRequest(
    pat,
    `/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}/actions/workflows/${GITHUB_REPO.raffleWorkflowFile}/dispatches`,
    {
      method: 'POST',
      body: {
        ref: GITHUB_REPO.branch,
        inputs: {
          ...inputs,
          dry_run: inputs.dry_run ? 'true' : 'false',
        },
      },
    },
  )
}

export interface WorkflowRunSummary {
  id: number
  status: string
  conclusion: string | null
  html_url: string
  created_at: string
}

export async function listRecentRuns(pat: string, limit = 5): Promise<WorkflowRunSummary[]> {
  const res = (await ghRequest(
    pat,
    `/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}/actions/workflows/${GITHUB_REPO.raffleWorkflowFile}/runs?per_page=${limit}&branch=${GITHUB_REPO.branch}`,
  )) as { workflow_runs: WorkflowRunSummary[] }
  return res.workflow_runs
}

/** Polls until a run created AFTER `afterIso` appears (GitHub's dispatch
 *  response carries no run id), then returns it. Gives up after ~60s. */
export async function findDispatchedRun(pat: string, afterIso: string): Promise<WorkflowRunSummary> {
  const after = new Date(afterIso).getTime()
  for (let attempt = 0; attempt < 20; attempt++) {
    const runs = await listRecentRuns(pat, 10)
    const match = runs.find((r) => new Date(r.created_at).getTime() >= after)
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  throw new Error('The workflow run did not show up in time — check the Actions tab on GitHub directly.')
}

// ---------------------------------------------------------------------------
// Pure helpers: which round is next, and a rough slot estimate for it
// ---------------------------------------------------------------------------

export function nextPendingRound(schedule: RaffleScheduleEntry[]): RaffleScheduleEntry | null {
  const sorted = [...schedule].sort((a, b) => a.round - b.round)
  return sorted.find((r) => r.drawnAtIso === null) ?? null
}

// Solana's average slot time — used only to turn "how many days until this
// round is due" into a rough "roughly this slot" estimate for the operator to
// sanity-check against the real, publicly-announced slot. Never used to build
// or verify anything on chain — the workflow always takes the announced slot
// as its own separate, required input.
const AVG_SLOT_TIME_MS = 400

export function estimateSlotAt(currentSlot: number, targetIso: string): number {
  const deltaMs = new Date(targetIso).getTime() - Date.now()
  const deltaSlots = Math.round(deltaMs / AVG_SLOT_TIME_MS)
  return Math.max(currentSlot, currentSlot + deltaSlots)
}

export function formatCountdown(targetIso: string, nowMs: number): string {
  const deltaMs = new Date(targetIso).getTime() - nowMs
  if (deltaMs <= 0) return 'due now'
  const totalSeconds = Math.floor(deltaMs / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  return `${minutes}m ${seconds}s`
}

export function validateRoundId(round: number): string | null {
  if (!Number.isInteger(round) || round < 1 || round > RAFFLE.rounds) {
    return `Round must be a whole number between 1 and ${RAFFLE.rounds}.`
  }
  return null
}
