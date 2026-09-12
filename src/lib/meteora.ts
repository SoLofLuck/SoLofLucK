import DLMM, {
  ActivationType,
  StrategyType,
  LBCLMM_PROGRAM_IDS,
  deriveCustomizablePermissionlessLbPair,
} from '@meteora-ag/dlmm'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import BN from 'bn.js'
import Decimal from 'decimal.js'
import { FEE_WALLET, POOL_FEE_AMOUNT_SOL, type NetworkId } from '../config'
import { sendInstructions } from './sendTx'
import type { CreatePoolResult, MintRef } from './raydium'

// Raydium's CPMM program explicitly rejects any Token-2022 mint carrying a
// Transfer Hook extension (confirmed by reading raydium-cp-swap's own
// is_supported_mint(), on chain: "Not support token_2022 mint extension",
// custom error 6007) — a live pool-creation attempt for a sell-lock-enabled
// token failed with exactly that error. This is not a version quirk to work
// around; Raydium's allowed-extensions list simply never included
// TransferHook, because a hook can block a swap's transfer arbitrarily,
// which breaks the invariants Raydium's AMM relies on.
//
// Meteora's DLMM genuinely supports Transfer Hook mints instead (its SDK
// ships getExtraAccountMetasForTransferHook specifically for this), so pools
// for a sell-lock-enabled token are created here, on DLMM, rather than on
// Raydium. LiquidityPage.tsx picks between the two based on
// hasSellLockHook() (sellLock.ts) — everything downstream (the result card,
// the "lock selling into this pool" step) is unchanged, since this returns
// the exact same CreatePoolResult shape createCpmmPool does.
//
// IMPORTANT CAVEAT: this was written by reading the DLMM SDK's own shipped
// TypeScript type declarations (installed locally to inspect them — this
// sandbox cannot reach Solana RPCs or Meteora's API to run any of this for
// real) rather than from a working example verified end-to-end on a live
// network. The overall shape (create the pool, then open one position and
// seed it with both sides in a single bin at the chosen opening price) is a
// standard, documented DLMM pattern, but specific default choices below
// (bin step, pool fee, activation type, and the price/bin-id convention) are
// best-effort and have NOT been confirmed against an actual devnet
// transaction. This needs a real pool-creation attempt on-device before it
// should be trusted with real funds.

// A wide-ish default bin step (basis points of price movement per bin): a
// freshly launched token can move a long way in either direction on its
// first real trades, and a narrow bin step would push the price straight out
// of the single bin this seeds, leaving the pool unable to price anything
// until someone adds liquidity to the new active bin. 100 (~1% per bin) is
// on the wide end of Meteora's own common presets, trading a little
// precision for headroom on a brand-new pool.
const DEFAULT_BIN_STEP = 100
// The pool's own trading fee (separate from this site's service fee below).
const DEFAULT_FEE_BPS = 200

function buildPoolFeeInstruction(payer: PublicKey) {
  if (!FEE_WALLET || POOL_FEE_AMOUNT_SOL <= 0) return null
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: new PublicKey(FEE_WALLET),
    lamports: Math.round(POOL_FEE_AMOUNT_SOL * LAMPORTS_PER_SOL),
  })
}

/**
 * Creates a Meteora DLMM pool for a sell-lock-enabled (Transfer Hook) token
 * and seeds it with the amounts the user chose, in three steps:
 *   1. Create the (empty) pool at the opening price the deposited amounts imply.
 *   2. Open one liquidity position covering a single bin at that same price.
 *   3. Deposit both sides into that position — with this site's service fee
 *      folded into this same transaction (never a separate one; see
 *      buildPoolFeeInstruction and the equivalent Raydium comment in
 *      raydium.ts for why that matters).
 *
 * `mintA` is always treated as the DLMM pool's X side and `mintB` as its Y
 * side, matching the Create Pool form's own "the token" / "the liquidity
 * coin (SOL)" fields.
 */
export async function createDlmmPool(
  connection: Connection,
  wallet: WalletContextState,
  network: NetworkId,
  mintA: MintRef,
  mintB: MintRef,
  uiAmountA: string,
  uiAmountB: string,
  payer: PublicKey,
  onStatus?: (status: string) => void,
): Promise<CreatePoolResult> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error('Connect your wallet first to continue.')
  }
  const signer = { publicKey: payer, signTransaction: wallet.signTransaction }

  const programId = new PublicKey(
    network === 'devnet' ? LBCLMM_PROGRAM_IDS.devnet : LBCLMM_PROGRAM_IDS['mainnet-beta'],
  )
  const tokenX = new PublicKey(mintA.address)
  const tokenY = new PublicKey(mintB.address)

  const totalXAmount = new BN(new Decimal(uiAmountA).mul(10 ** mintA.decimals).toFixed(0))
  const totalYAmount = new BN(new Decimal(uiAmountB).mul(10 ** mintB.decimals).toFixed(0))

  // The opening price: how much of the Y side one whole unit of the X side is
  // worth, from the same amounts the user entered — the "the amounts you
  // enter set the pool's opening price" contract the Raydium flow already
  // documents to the user in this form.
  onStatus?.('Calculating the opening price...')
  const priceXInY = new Decimal(uiAmountB).div(new Decimal(uiAmountA)).toNumber()
  const activeIdNumber = DLMM.getBinIdFromPrice(priceXInY, DEFAULT_BIN_STEP, true)
  const activeId = new BN(activeIdNumber)
  const binStep = new BN(DEFAULT_BIN_STEP)

  onStatus?.('Preparing the pool creation transaction...')
  const createPoolTx = await DLMM.createCustomizablePermissionlessLbPair2(
    connection,
    binStep,
    tokenX,
    tokenY,
    activeId,
    new BN(DEFAULT_FEE_BPS),
    ActivationType.Slot,
    false,
    payer,
  )

  await sendInstructions(connection, signer, createPoolTx.instructions, onStatus, {
    confirmMessage: 'Waiting for approval in your wallet (pool creation)...',
  })

  const [lbPairPubkey] = deriveCustomizablePermissionlessLbPair(tokenX, tokenY, programId)

  onStatus?.('Loading the new pool...')
  const dlmmPool = await DLMM.create(connection, lbPairPubkey)

  const positionKeypair = Keypair.generate()
  onStatus?.('Preparing to seed liquidity...')
  const seedTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKeypair.publicKey,
    totalXAmount,
    totalYAmount,
    strategy: {
      minBinId: activeIdNumber,
      maxBinId: activeIdNumber,
      strategyType: StrategyType.Spot,
    },
    user: payer,
  })

  const feeIx = buildPoolFeeInstruction(payer)
  const seedIxs = feeIx ? [...seedTx.instructions, feeIx] : seedTx.instructions

  const seedTxId = await sendInstructions(connection, signer, seedIxs, onStatus, {
    extraSigners: [positionKeypair],
    confirmMessage: feeIx
      ? 'Waiting for approval in your wallet (seed liquidity + service fee, one transaction)...'
      : 'Waiting for approval in your wallet (seed liquidity)...',
  })

  return {
    txId: seedTxId,
    poolId: dlmmPool.pubkey.toBase58(),
    vaultA: dlmmPool.lbPair.reserveX.toBase58(),
    vaultB: dlmmPool.lbPair.reserveY.toBase58(),
  }
}
