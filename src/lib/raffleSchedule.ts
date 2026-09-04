// The public, site-served record of each raffle round's due date and — once a
// round has really been drawn — the slot that was announced beforehand versus
// the block that was actually used (see scripts/raffle-schedule.mjs and
// .github/workflows/run-raffle-round.yml, which write this file). Purely
// informational: unlike merkle round files, nothing here is used to build or
// verify an on-chain instruction.

export interface RaffleScheduleEntry {
  round: number
  dueIso: string | null
  announcedSlot: number | null
  actualSlot: number | null
  drawnAtIso: string | null
}

let cache: RaffleScheduleEntry[] | null = null

export async function fetchRaffleSchedule(): Promise<RaffleScheduleEntry[]> {
  if (cache) return cache
  const res = await fetch('/raffle-schedule.json')
  if (!res.ok) throw new Error('The raffle schedule was not found.')
  const parsed = (await res.json()) as unknown
  if (!Array.isArray(parsed)) throw new Error('The raffle schedule is corrupt.')
  cache = parsed as RaffleScheduleEntry[]
  return cache
}
