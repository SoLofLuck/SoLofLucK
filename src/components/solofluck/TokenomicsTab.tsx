import {
  LUCK_TOKEN,
  MARKETING_BREAKDOWN,
  PRESALE_DURATION_WEEKS,
  PRESALE_SOFT_CAP_SOL,
  PRESALE_SOL_ALLOCATION,
  PRESALE_TARGET_SOL,
  PRESALE_TOKENS_PER_SOL,
  PUBLIC_WALLETS,
  TOKENOMICS,
  VESTING_SCHEDULE,
} from '../../config'
import { PRESALE_OPS_FEE_PERCENT } from '../../lib/presale'
import { CopyButton } from '../CopyButton'

function solscanUrl(address: string) {
  return `https://solscan.io/account/${address}`
}

// Addresses are shown in full, never shortened (the whole string is needed to
// verify them); on narrow screens the box scrolls horizontally instead
// (see .luck-tokenomics__wallet-addr).
function WalletRow({ label, address }: { label: string; address: string }) {
  return (
    <li className="luck-tokenomics__wallet">
      <span className="luck-tokenomics__wallet-label">{label}</span>
      <a
        className="luck-tokenomics__wallet-addr"
        href={solscanUrl(address)}
        target="_blank"
        rel="noopener noreferrer"
      >
        {address}
      </a>
      <CopyButton value={address} label="Copy" />
    </li>
  )
}

function formatSupply(n: number) {
  return n.toLocaleString('en-US')
}

export function TokenomicsTab() {
  return (
    <div className="luck-tokenomics">
      <div className="luck-tokenomics__summary">
        <div className="luck-tokenomics__stat">
          <span>Total Supply</span>
          <strong>{formatSupply(LUCK_TOKEN.totalSupply)} $LUCK</strong>
        </div>
        <div className="luck-tokenomics__stat">
          <span>Decimals</span>
          <strong>{LUCK_TOKEN.decimals}</strong>
        </div>
        <div className="luck-tokenomics__stat">
          <span>Network</span>
          <strong>Solana (SPL Token)</strong>
        </div>
      </div>

      <div className="luck-tokenomics__bar" role="img" aria-label="Tokenomics distribution chart">
        {TOKENOMICS.map((t) => (
          <div
            key={t.key}
            className="luck-tokenomics__bar-segment"
            style={{ width: `${t.percent}%`, background: t.color }}
            title={`${t.label} — ${t.percent}%`}
          />
        ))}
      </div>

      <ul className="luck-tokenomics__list">
        {TOKENOMICS.map((t) => (
          <li key={t.key} className="luck-tokenomics__row">
            <span className="luck-tokenomics__dot" style={{ background: t.color }} />
            <div className="luck-tokenomics__row-body">
              <div className="luck-tokenomics__row-head">
                <strong>{t.label}</strong>
                <span className="luck-tokenomics__percent">{t.percent}%</span>
              </div>
              <div className="luck-tokenomics__row-supply">
                {formatSupply(Math.round((LUCK_TOKEN.totalSupply * t.percent) / 100))} $LUCK
              </div>
              <p className="luck-tokenomics__row-desc">{t.desc}</p>
            </div>
          </li>
        ))}
      </ul>

      <h3 className="luck-tokenomics__subhead">Presale Rules</h3>
      <ul className="luck-tokenomics__sol-list">
        <li>
          <span>Price (fixed)</span>
          <strong>1 SOL = {formatSupply(PRESALE_TOKENS_PER_SOL)} $LUCK</strong>
        </li>
        <li>
          <span>Target (hard cap)</span>
          <strong>{PRESALE_TARGET_SOL} SOL</strong>
        </li>
        <li>
          <span>Floor (soft cap)</span>
          <strong>{PRESALE_SOFT_CAP_SOL} SOL</strong>
        </li>
        <li>
          <span>Duration</span>
          <strong>{PRESALE_DURATION_WEEKS} weeks</strong>
        </li>
      </ul>
      <p className="subtab-desc">
        The price is fixed — a contributor knows exactly how many $LUCK they will receive at the
        moment they send the money. If the target is reached before the deadline the presale closes
        right there and TGE follows; nothing above {PRESALE_TARGET_SOL} SOL is accepted.
      </p>
      <p className="subtab-desc">
        <strong>If the target is not reached, the supply is scaled down proportionally.</strong> If
        X% of the target was collected, only X% is minted <strong>out of every bucket</strong>{' '}
        (presale, liquidity, community, team, marketing) and the remaining 100−X%{' '}
        <strong>is burned</strong>. The percentage split above is preserved exactly. That keeps the
        pool's opening price independent of the amount raised, so whatever level the presale closes
        at, a presale buyer starts above the presale price at listing. Burning only the unsold
        presale tokens while leaving the liquidity bucket untouched would break this: less SOL would
        go into the pool while the token side stayed the same, and the opening price would fall
        below the presale price.
      </p>
      <p className="subtab-desc">
        <strong>The floor is {PRESALE_SOFT_CAP_SOL} SOL.</strong> If that amount is not reached
        there is no TGE and contributions are refunded — every refund is individually verifiable on
        chain.
      </p>

      <h3 className="luck-tokenomics__subhead">Lock &amp; Unlock Schedule</h3>
      <p className="subtab-desc">
        The design principle is this: <strong>no unlock should ever be larger than the liquidity
        pool can absorb.</strong> That is why every bucket unlocks in stages and the end dates of
        the large locks are spread apart — there is no single "everybody sells" day on the calendar.
      </p>
      <div className="luck-tokenomics__timeline">
        {VESTING_SCHEDULE.map((v) => (
          <div key={v.key} className="luck-tokenomics__timeline-group">
            <h4>{v.label}</h4>
            <ul>
              {v.steps.map((st, i) => (
                <li key={i}>
                  <span className="luck-tokenomics__when">{st.when}</span>
                  <span className="luck-tokenomics__what">{st.what}</span>
                  {st.amount > 0 && (
                    <span className="luck-tokenomics__amount">{formatSupply(st.amount)}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <h3 className="luck-tokenomics__subhead">Inside The Marketing Bucket</h3>
      <p className="subtab-desc">
        <strong>CEX listing reserve — {formatSupply(MARKETING_BREAKDOWN.cexReserve.total)}</strong>{' '}
        (10% of total supply), held in {MARKETING_BREAKDOWN.cexReserve.wallets} separate vaults of{' '}
        {formatSupply(MARKETING_BREAKDOWN.cexReserve.perWallet)} each. Each vault is meant for one
        exchange listing; the vault addresses are published and every use is proven with the
        exchange announcement plus the transaction link. This reserve is{' '}
        <strong>not locked</strong> — deliberately so, because we do not want to make a lock
        promise we would have to break the moment a listing opportunity arrives on short notice.
      </p>
      <ul className="luck-tokenomics__wallet-list">
        {MARKETING_BREAKDOWN.cexReserve.addresses.map((w) => (
          <WalletRow key={w.address} label={w.label} address={w.address} />
        ))}
      </ul>
      <ul className="luck-tokenomics__sol-list">
        {MARKETING_BREAKDOWN.flow.items.map((it) => (
          <li key={it.label}>
            <span>
              {it.label} ({it.units} units)
            </span>
            <strong>{formatSupply(it.amount)}</strong>
          </li>
        ))}
      </ul>
      <p className="subtab-desc">
        The flowing part totals {formatSupply(MARKETING_BREAKDOWN.flow.total)} (1 unit ={' '}
        {formatSupply(MARKETING_BREAKDOWN.flow.unit)}): <strong>locked for 7 weeks</strong>, then
        spent in equal monthly slices over <strong>7 months</strong>.
      </p>

      <h3 className="luck-tokenomics__subhead">Where Does The Collected SOL Go?</h3>
      <p className="subtab-desc">
        The table above is the <strong>token</strong> distribution. This one shows the{' '}
        <strong>money</strong> raised in the presale — the two are separate things.{' '}
        <strong>{PRESALE_OPS_FEE_PERCENT.toLocaleString('en-US')}%</strong> of each contribution
        goes to a separate wallet in the same transaction, covering expenses until the token is
        live, and is not added to the pool. The rest is used as follows:
      </p>
      <ul className="luck-tokenomics__sol-list">
        {PRESALE_SOL_ALLOCATION.map((a) => (
          <li key={a.key}>
            <span>{a.label}</span>
            <strong>{a.percent}%</strong>
          </li>
        ))}
      </ul>

      <h3 className="luck-tokenomics__subhead">Published Wallets</h3>
      <p className="subtab-desc">
        Every lock and distribution promise above is verifiable on chain. You can follow the
        balance and every movement of the addresses below yourself on Solscan — you do not have to
        trust us, just look.
      </p>
      <ul className="luck-tokenomics__wallet-list">
        {PUBLIC_WALLETS.filter((w) => w.address).map((w) => (
          <WalletRow key={w.key} label={w.label} address={w.address} />
        ))}
      </ul>

      <h3 className="luck-tokenomics__subhead">Launch Commitments</h3>
      <ul className="luck-tokenomics__pledges">
        <li>
          <strong>Liquidity is burned.</strong> Once the pool is open the LP tokens are burned;
          nobody, the team included, can withdraw the liquidity from that pool. The link to the burn
          transaction is published here.
        </li>
        <li>
          <strong>Mint authority is revoked.</strong> After launch no new $LUCK can be minted; the
          total supply is fixed at {formatSupply(LUCK_TOKEN.totalSupply)}.
        </li>
        <li>
          <strong>Freeze authority is revoked.</strong> No wallet can be frozen — selling the token
          cannot be blocked technically.
        </li>
        <li>
          <strong>$LUCK is a standard SPL token.</strong> It carries no extension such as
          confidential transfers, a transfer tax or a blacklist; balances are public and verifiable.
        </li>
        <li>
          <strong>The CEX vault addresses are published.</strong> Every movement of the three vaults
          can be traced on chain; any vault left unused is burned at the end of the schedule or
          moved into the raffle bucket.
        </li>
        <li>
          <strong>The team receives no tokens for 7 months.</strong> Even once the lock ends the
          tokens do not arrive at once — they unlock in monthly slices over 7 months.
        </li>
      </ul>
    </div>
  )
}
