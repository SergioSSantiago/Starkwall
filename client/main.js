import './style.css'
import { InfiniteCanvas } from './canvas.js'
import { PostManager } from './postManager.js'
import { DojoManager } from './dojoManager.js'
import { StarkzapManager } from './starkzapManager.js'
import Controller from '@cartridge/controller'
import { init as initDojo, KeysClause, ToriiQueryBuilder } from '@dojoengine/sdk'
import controllerOpts from './controller.js'
import manifest from './manifest.js'
import {
  DOMAIN_CHAIN_ID, TORII_URL, IS_SEPOLIA, FAUCET_URL, YIELD_DUAL_POOL_ENABLED,
  BTC_TRACK_SYMBOL, SEPOLIA_BTC_SWAP_TOKEN, SEALED_BID_VERIFIER_ADDRESS, SEALED_RELAY_URL, PAYMENT_TOKEN_ADDRESS,
} from './config.js'

// Evitar que un rechazo de promesa no capturado provoque recarga o cierre de la app
window.addEventListener('unhandledrejection', (event) => {
  event.preventDefault()
  console.error('Unhandled promise rejection:', event.reason)
})

const DOMAIN_SEPARATOR = {
  name: 'di',
  version: '1.0',
  chainId: DOMAIN_CHAIN_ID,
  revision: '1',
}

let canvas, postManager, dojoManager, controller, currentUsername, currentAccount
let starkzapManager = null
/** Clave de balance de la wallet conectada; fijada al conectar para que todas las operaciones usen la misma. */

const LAST_SESSION_KEY = 'starkwall_last_session'

async function getChainBalance(address) {
  if (!dojoManager) return 0
  return dojoManager.getTokenBalance(address)
}

function loadLastSession() {
  try {
    const raw = localStorage.getItem(LAST_SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveLastSession(address, username) {
  try {
    if (!address) {
      localStorage.removeItem(LAST_SESSION_KEY)
      return
    }
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({
      address: String(address),
      username: String(username || ''),
      updatedAt: Date.now(),
    }))
  } catch {
    // ignore localStorage failures
  }
}

const socialState = {
  loaded: false,
  profilesByAddress: new Map(),
  usernameByAddress: new Map(),
  followingByUser: new Map(),
  followersByUser: new Map(),
}

const actionsContractMeta = manifest.contracts.find((contract) => contract.tag === 'di-actions') || null
const actionsSystems = new Set(actionsContractMeta?.systems || [])
const hasOnchainSocialInManifest = actionsSystems.has('follow') && actionsSystems.has('unfollow')
const hasYieldInManifest = actionsSystems.has('yield_deposit') && actionsSystems.has('yield_withdraw') && actionsSystems.has('yield_claim')
// Sealed bidding is enabled by default for Privacy Track; can be disabled via env.
const ENABLE_SEALED_BID_UI = String(import.meta.env?.VITE_ENABLE_SEALED_BID_UI || 'true').toLowerCase() !== 'false'
const hasSealedBidInManifest =
  ENABLE_SEALED_BID_UI &&
  actionsSystems.has('create_auction_post_3x3_sealed') &&
  actionsSystems.has('commit_bid') &&
  actionsSystems.has('reveal_bid') &&
  actionsSystems.has('claim_commit_refund')
let socialOnchainAvailable = hasOnchainSocialInManifest
let socialOnchainWarned = false
let cachedYieldState = null
let postUpdatesSubscription = null
let postUpdatesRetryTimer = null
let postUpdatesRetryCount = 0
let postUpdatesBeforeUnloadBound = false
let automationTickTimer = null
let uiHandlersInitialized = false
let lastSocialRevalidationKickAt = 0

const SOCIAL_FALLBACK_KEY = 'starkwall_social_fallback_v1'

function readSocialFallback() {
  try {
    const raw = localStorage.getItem(SOCIAL_FALLBACK_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeSocialFallback(data) {
  try {
    localStorage.setItem(SOCIAL_FALLBACK_KEY, JSON.stringify(data || {}))
  } catch {
    // ignore
  }
}

function applyFallbackFollow(follower, following, shouldFollow) {
  const f = normalizeSocialAddress(follower)
  const t = normalizeSocialAddress(following)
  if (!f || !t || f === t) return false

  const store = readSocialFallback()
  const list = new Set(Array.isArray(store[f]) ? store[f].map(normalizeSocialAddress).filter(Boolean) : [])
  if (shouldFollow) list.add(t)
  else list.delete(t)
  store[f] = [...list]
  writeSocialFallback(store)
  return true
}

function mergeFallbackIntoSocialState() {
  const store = readSocialFallback()
  for (const [follower, list] of Object.entries(store)) {
    const f = normalizeSocialAddress(follower)
    if (!f) continue
    if (!socialState.followingByUser.has(f)) socialState.followingByUser.set(f, new Set())

    for (const targetRaw of (Array.isArray(list) ? list : [])) {
      const t = normalizeSocialAddress(targetRaw)
      if (!t || t === f) continue
      socialState.followingByUser.get(f).add(t)
      if (!socialState.followersByUser.has(t)) socialState.followersByUser.set(t, new Set())
      socialState.followersByUser.get(t).add(f)
    }
  }
}

function normalizeSocialAddress(address) {
  if (address === null || address === undefined) return ''

  try {
    if (typeof address === 'bigint') {
      const hex = address.toString(16).replace(/^0+/, '')
      return `0x${hex || '0'}`
    }
    if (typeof address === 'number' && Number.isFinite(address)) {
      const hex = BigInt(Math.trunc(address)).toString(16).replace(/^0+/, '')
      return `0x${hex || '0'}`
    }
    if (typeof address === 'object') {
      const low = address?.low
      const high = address?.high
      if (low !== undefined || high !== undefined) {
        const lowBn = BigInt(low || 0)
        const highBn = BigInt(high || 0)
        const asHex = ((highBn << 128n) + lowBn).toString(16).replace(/^0+/, '')
        return `0x${asHex || '0'}`
      }
    }
  } catch {}

  const raw = String(address || '').trim().toLowerCase()
  if (!raw) return ''

  try {
    if (raw.startsWith('0x')) {
      const normalizedHex = raw.slice(2).replace(/^0+/, '')
      return `0x${normalizedHex || '0'}`
    }
    if (/^[0-9]+$/.test(raw)) {
      const asHex = BigInt(raw).toString(16).replace(/^0+/, '')
      return `0x${asHex || '0'}`
    }
    const normalizedHex = raw.replace(/^0+/, '')
    return `0x${normalizedHex || '0'}`
  } catch {
    const hex = raw.startsWith('0x') ? raw.slice(2) : raw
    const normalized = hex.replace(/^0+/, '')
    return `0x${normalized || '0'}`
  }
}

function rememberUsername(address, username) {
  const addr = normalizeSocialAddress(address)
  const name = String(username || '').trim()
  if (!addr || !name) return
  socialState.usernameByAddress.set(addr, name)
}

function rememberUsersFromPosts(posts = []) {
  if (!Array.isArray(posts)) return
  for (const post of posts) {
    const createdBy = normalizeSocialAddress(post?.created_by)
    const owner = normalizeSocialAddress(post?.current_owner)
    const creatorName = String(post?.creator_username || '').trim()

    if (createdBy && creatorName) socialState.usernameByAddress.set(createdBy, creatorName)
    if (owner && !socialState.usernameByAddress.has(owner)) {
      socialState.usernameByAddress.set(owner, owner.slice(0, 8) + '...' + owner.slice(-6))
    }
  }
}

function rebuildSocialMapsFromRelations(relations = []) {
  socialState.followingByUser = new Map()
  socialState.followersByUser = new Map()

  for (const rel of relations) {
    const follower = normalizeSocialAddress(rel?.follower)
    const following = normalizeSocialAddress(rel?.following)
    if (!follower || !following) continue

    if (!socialState.followingByUser.has(follower)) socialState.followingByUser.set(follower, new Set())
    if (!socialState.followersByUser.has(following)) socialState.followersByUser.set(following, new Set())

    socialState.followingByUser.get(follower).add(following)
    socialState.followersByUser.get(following).add(follower)
  }
}

async function refreshSocialData() {
  if (!dojoManager) return

  const social = await dojoManager.querySocialData()

  socialState.profilesByAddress = new Map()
  for (const profile of social.profiles || []) {
    const addr = normalizeSocialAddress(profile.user)
    const username = String(profile.username || '').trim()
    if (!addr) continue
    socialState.profilesByAddress.set(addr, profile)
    if (username) socialState.usernameByAddress.set(addr, username)
  }

  rebuildSocialMapsFromRelations(social.relations || [])
  // In Sepolia/prod we want deterministic cross-device values (Torii/indexed state),
  // so avoid mixing local fallback follows from browser storage.
  if (!IS_SEPOLIA) {
    mergeFallbackIntoSocialState()
  }
  rememberUsersFromPosts(postManager?.posts || [])
  socialState.loaded = true
}

async function ensureSocialDataLoaded() {
  if (socialState.loaded) return
  await refreshSocialData()
}

function getSocialFollowersFollowing(targetAddress) {
  const target = normalizeSocialAddress(targetAddress)
  const followingSet = socialState.followingByUser.get(target) || new Set()
  const followersSet = socialState.followersByUser.get(target) || new Set()

  return {
    followers: [...followersSet],
    following: [...followingSet],
    usernames: Object.fromEntries(socialState.usernameByAddress.entries()),
  }
}

function setFollowingForUser(userAddress, followingList) {
  const user = normalizeSocialAddress(userAddress)
  if (!user) return
  socialState.followingByUser.set(user, new Set((followingList || []).map(normalizeSocialAddress).filter(Boolean)))
}

async function followUserLocally(targetAddress) {
  const me = normalizeSocialAddress(currentAccount?.address)
  const target = normalizeSocialAddress(targetAddress)
  if (!me || !target || me === target) return false

  // Update UI immediately for snappy UX, then reconcile in background.
  applyFallbackFollow(me, target, true)
  scheduleSocialRevalidation(600)

  if (!socialOnchainAvailable) {
    if (!socialOnchainWarned) {
      showToast('Social on-chain not enabled in this deployment yet')
      socialOnchainWarned = true
    }
    return true
  }

  dojoManager.followUser(target)
    .then(() => {
      scheduleSocialRevalidation(900)
    })
    .catch((error) => {
      console.warn('follow on-chain failed, reverting optimistic state:', error?.message || error)
      const errMsg = String(error?.message || error || '')
      if (errMsg.includes('ENTRYPOINT_NOT_FOUND')) {
        socialOnchainAvailable = false
      }
      applyFallbackFollow(me, target, false)
      scheduleSocialRevalidation(200)
      showToast('Follow failed on-chain')
    })

  return true
}

async function unfollowUserLocally(targetAddress) {
  const me = normalizeSocialAddress(currentAccount?.address)
  const target = normalizeSocialAddress(targetAddress)
  if (!me || !target || me === target) return false

  // Update UI immediately for snappy UX, then reconcile in background.
  applyFallbackFollow(me, target, false)
  scheduleSocialRevalidation(600)

  if (!socialOnchainAvailable) {
    if (!socialOnchainWarned) {
      showToast('Social on-chain not enabled in this deployment yet')
      socialOnchainWarned = true
    }
    return true
  }

  dojoManager.unfollowUser(target)
    .then(() => {
      scheduleSocialRevalidation(900)
    })
    .catch((error) => {
      console.warn('unfollow on-chain failed, reverting optimistic state:', error?.message || error)
      const errMsg = String(error?.message || error || '')
      if (errMsg.includes('ENTRYPOINT_NOT_FOUND')) {
        socialOnchainAvailable = false
      }
      applyFallbackFollow(me, target, true)
      scheduleSocialRevalidation(200)
      showToast('Unfollow failed on-chain')
    })

  return true
}

let socialRevalidationTimer = null

function scheduleSocialRevalidation(delayMs = 800) {
  if (socialRevalidationTimer) clearTimeout(socialRevalidationTimer)
  socialRevalidationTimer = setTimeout(async () => {
    socialRevalidationTimer = null
    await refreshSocialData().catch(() => {})
    await updateWalletInfo().catch(() => {})

    const followingModal = document.getElementById('followingModal')
    if (followingModal?.classList.contains('active')) {
      const term = String(document.getElementById('followingSearchInput')?.value || '')
      renderFollowingModal(term)
    }

    const followersModal = document.getElementById('followersModal')
    if (followersModal?.classList.contains('active')) {
      await openFollowersModal().catch(() => {})
    }
  }, Math.max(0, Number(delayMs) || 0))
}

function getKnownUsersForSearch() {
  const users = new Set()

  for (const addr of socialState.usernameByAddress.keys()) users.add(normalizeSocialAddress(addr))
  for (const [addr, set] of socialState.followingByUser.entries()) {
    users.add(normalizeSocialAddress(addr))
    for (const x of set) users.add(normalizeSocialAddress(x))
  }

  for (const post of (postManager?.posts || [])) {
    users.add(normalizeSocialAddress(post?.created_by))
    users.add(normalizeSocialAddress(post?.current_owner))
  }

  const me = normalizeSocialAddress(currentAccount?.address)
  users.delete(me)

  return [...users].filter(Boolean).map((addr) => ({
    address: addr,
    username: socialState.usernameByAddress.get(addr) || (addr.slice(0, 8) + '...' + addr.slice(-6)),
  }))
}

function computeLiveYieldEarningsStrk(yieldState) {
  const pending = Number(yieldState?.pending_strk || 0)
  return Number.isFinite(pending) ? pending : 0
}

function withTimeout(promise, timeoutMs, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), Math.max(1, Number(timeoutMs) || 1)),
    ),
  ])
}

async function handleYieldPrimaryAction() {
  if (!dojoManager || !currentAccount) return
  if (!hasYieldInManifest) {
    showToast('Yield not enabled on this deployment yet')
    return
  }
  const yieldModal = document.getElementById('yieldModal')
  const titleEl = document.getElementById('yieldModalTitle')
  const summaryEl = document.getElementById('yieldModalSummary')
  const depositFields = document.getElementById('yieldDepositFields')
  const manageFields = document.getElementById('yieldManageFields')
  const manageInfoEl = document.getElementById('yieldManageInfo')
  const amountLabel = document.getElementById('yieldAmountLabel')
  const amountInput = document.getElementById('yieldAmountInput')
  const strategyStrkInput = document.getElementById('yieldStrategyStrkInput')
  const strategyBtcInput = document.getElementById('yieldStrategyBtcInput')
  const withdrawInput = document.getElementById('yieldWithdrawInput')
  const primaryBtn = document.getElementById('yieldPrimaryBtn')
  const claimBtn = document.getElementById('yieldClaimBtn')
  const modeBtn = document.getElementById('yieldModeBtn')
  const queueBtn = document.getElementById('yieldQueueBtn')
  const cancelBtn = document.getElementById('yieldCancelBtn')
  if (!yieldModal || !titleEl || !summaryEl || !depositFields || !manageFields || !manageInfoEl || !amountLabel || !amountInput || !strategyStrkInput || !strategyBtcInput || !withdrawInput || !primaryBtn || !claimBtn || !modeBtn || !queueBtn || !cancelBtn) return

  const closeYieldModal = () => {
    yieldModal.classList.remove('active')
    primaryBtn.disabled = false
  }
  cancelBtn.onclick = closeYieldModal
  yieldModal.onclick = (e) => {
    if (e.target === yieldModal) closeYieldModal()
  }

  const state = cachedYieldState || {
    principal_strk: 0,
    pending_strk: 0,
    pool_id: 0,
    pool_token_symbol: 'STRK',
    last_accrual_ts: 0,
    use_btc_mode: false,
    apr_bps: 100,
    earnings_pool_strk: 0,
    liquid_buffer_strk: 0,
    staked_principal_strk: 0,
    queued_exit_strk: 0,
  }
  const activeSymbol = String(state.pool_token_symbol || (state.use_btc_mode ? 'WBTC' : 'STRK'))
  strategyStrkInput.checked = true
  strategyBtcInput.checked = false
  strategyBtcInput.disabled = !YIELD_DUAL_POOL_ENABLED
  modeBtn.style.display = 'none'
  const strkBalance = await getChainBalance(currentAccount.address).catch(() => 0)
  const tbtcBalance = YIELD_DUAL_POOL_ENABLED
    ? await dojoManager.getTokenBalance(currentAccount.address, SEPOLIA_BTC_SWAP_TOKEN, 8).catch(() => 0)
    : 0
  const btcSymbol = BTC_TRACK_SYMBOL

  titleEl.textContent = 'Stake'
  summaryEl.innerHTML = YIELD_DUAL_POOL_ENABLED
    ? `Wallet balance: ${Number(strkBalance || 0).toFixed(2)} STRK · ${Number(tbtcBalance || 0).toFixed(6)} ${btcSymbol}`
    : `Wallet balance: ${Number(strkBalance || 0).toFixed(2)} STRK`
  summaryEl.innerHTML += '<br><span class="yield-token-help">Select token and amount, then confirm in your wallet.</span>'
  depositFields.style.display = 'block'
  manageFields.style.display = 'none'
  claimBtn.style.display = 'none'
  modeBtn.style.display = 'none'
  queueBtn.style.display = 'none'
  primaryBtn.style.display = 'inline-block'
  primaryBtn.textContent = 'Stake'
  amountInput.value = ''
  amountLabel.firstChild.textContent = strategyBtcInput.checked ? `Amount (${btcSymbol}) ` : 'Amount (STRK) '
  strategyStrkInput.onchange = () => {
    amountLabel.firstChild.textContent = 'Amount (STRK) '
  }
  strategyBtcInput.onchange = () => {
    amountLabel.firstChild.textContent = `Amount (${btcSymbol}) `
  }
  primaryBtn.onclick = async () => {
    const amount = Number(amountInput.value || '0')
    const useBtcMode = YIELD_DUAL_POOL_ENABLED ? Boolean(strategyBtcInput.checked) : false
    const symbol = useBtcMode ? btcSymbol : 'STRK'
    if (!Number.isFinite(amount) || amount <= 0) {
      alert('Enter a valid amount.')
      return
    }
    const selectedBalance = useBtcMode ? Number(tbtcBalance || 0) : Number(strkBalance || 0)
    if (selectedBalance > 0 && amount > selectedBalance) {
      alert(`Amount exceeds available balance (${selectedBalance.toFixed(useBtcMode ? 6 : 2)} ${symbol}).`)
      return
    }
    try {
      const result = await runWithBusyButton(primaryBtn, {
        idleText: 'Stake',
        busyText: 'Staking...',
        pendingToast: 'Open wallet to confirm staking. Waiting for confirmation...',
      }, async () => {
        let providerPath = 'dojo'
        let txHash = ''
        console.info('[Stake] Start', {
          user: currentAccount.address,
          symbol,
          amount,
          useBtcMode,
        })
        if (starkzapManager) {
          try {
            if (useBtcMode && IS_SEPOLIA && dojoManager?.stakeWbtcViaAvnu) {
              const res = await dojoManager.stakeWbtcViaAvnu(amount)
              txHash = String(res?.transaction_hash || '')
              providerPath = 'avnu-staking'
              console.info('[Stake] AVNU WBTC staking success', {
                user: currentAccount.address,
                symbol,
                amount,
                txHash,
                poolAddress: String(res?.poolAddress || ''),
                tokenAddress: String(res?.tokenAddress || ''),
                routeKind: String(res?.routeKind || ''),
              })
            } else {
              const res = await starkzapManager.stake(symbol, amount)
              txHash = String(res?.tx?.hash || '')
              providerPath = 'starkzap'
              console.info('[Stake] Starkzap success', {
                user: currentAccount.address,
                symbol,
                amount,
                txHash,
              })
            }
          } catch (starkzapError) {
            console.error('[Stake] Starkzap failed message:', starkzapError?.message || String(starkzapError))
            if (useBtcMode && IS_SEPOLIA && dojoManager?.stakeWbtcViaAvnu) {
              throw new Error(`WBTC staking via AVNU failed: ${starkzapError?.message || 'Unknown error'}`)
            }
            // WBTC staking must stay on the Starkzap path; Dojo fallback uses a
            // different token balance and can produce misleading "insufficient" errors.
            if (useBtcMode) {
              console.error('[Stake] Starkzap failed; no Dojo fallback for WBTC', {
                user: currentAccount.address,
                symbol,
                amount,
                error: errorInfo(starkzapError),
              })
              if (isControllerInitError(starkzapError)) {
                throw new Error('WBTC staking needs Cartridge Controller. Open https://localhost:5173, allow popups/cookies for localhost, reconnect wallet, and retry.')
              }
              const poolTokenAddress = parseStakePoolTokenAddress(starkzapError)
              const swapTokenAddress = normalizeStarknetAddress(SEPOLIA_BTC_SWAP_TOKEN)
              const requiredStakeAmount = parseStakeRequiredAmount(starkzapError, amount)
              const canAutoBridge =
                Boolean(poolTokenAddress) &&
                poolTokenAddress !== swapTokenAddress &&
                Boolean(dojoManager)
              if (canAutoBridge) {
                try {
                  const availableSwapBalance = Number(
                    await dojoManager.getTokenBalance(currentAccount.address, SEPOLIA_BTC_SWAP_TOKEN, 8).catch(() => 0),
                  )
                  if (availableSwapBalance <= 0 || availableSwapBalance + 1e-12 < requiredStakeAmount) {
                    throw new Error(
                      `Insufficient WBTC in swap token for auto-conversion. Need ~${requiredStakeAmount.toFixed(6)} WBTC, available ${availableSwapBalance.toFixed(6)} WBTC.`,
                    )
                  }
                  const strkTokenAddress = normalizeStarknetAddress(PAYMENT_TOKEN_ADDRESS)
                  const bridgePlan = await planWbtcStakeBridge({
                    dojoManager,
                    fromToken: SEPOLIA_BTC_SWAP_TOKEN,
                    targetToken: poolTokenAddress,
                    strkToken: strkTokenAddress,
                    desiredTargetAmount: amount,
                    maxSellAmount: availableSwapBalance,
                  })
                  if (!bridgePlan) {
                    throw new Error(
                      `No viable AVNU route currently converts WBTC (swap) into the staking pool token for ${amount.toFixed(6)} WBTC. ` +
                      `Try a larger amount or retry later when liquidity updates.`,
                    )
                  }

                  showToast(
                    bridgePlan.kind === 'direct'
                      ? 'Converting WBTC to staking pool token via AVNU...'
                      : 'Converting WBTC via STRK bridge for staking...',
                  )

                  if (bridgePlan.kind === 'direct') {
                    const swapTx = await dojoManager.swapTokens(
                      SEPOLIA_BTC_SWAP_TOKEN,
                      poolTokenAddress,
                      bridgePlan.sellAmount,
                      1,
                    )
                    const swapTxHash = String(swapTx?.transaction_hash || '')
                    showToast(`WBTC converted for staking${swapTxHash ? ` · ${shortTxHash(swapTxHash)}` : ''}`)
                    const retried = await starkzapManager.stake(symbol, amount)
                    txHash = String(retried?.tx?.hash || '')
                    providerPath = 'starkzap+avnu-bridge'
                    console.info('[Stake] Starkzap success after AVNU bridge', {
                      user: currentAccount.address,
                      symbol,
                      amount,
                      sellAmount: bridgePlan.sellAmount,
                      poolTokenAddress,
                      txHash,
                    })
                    return
                  }

                  const strkBeforeRaw = await dojoManager.getTokenBalanceRaw(currentAccount.address, strkTokenAddress).catch(() => 0n)
                  await dojoManager.swapTokens(
                    SEPOLIA_BTC_SWAP_TOKEN,
                    strkTokenAddress,
                    bridgePlan.sellAmount,
                    1,
                  )
                  const strkAfterRaw = await dojoManager.getTokenBalanceRaw(currentAccount.address, strkTokenAddress).catch(() => 0n)
                  const bridgedStrkRaw = BigInt(strkAfterRaw || 0n) - BigInt(strkBeforeRaw || 0n)
                  if (bridgedStrkRaw <= 0n) {
                    throw new Error('WBTC -> STRK bridge produced no spendable STRK.')
                  }
                  const strkDecimals = await dojoManager.getTokenDecimals(strkTokenAddress).catch(() => 18)
                  const bridgedStrkAmount = unitsToTokenNumber(bridgedStrkRaw, strkDecimals, 10)
                  if (!Number.isFinite(bridgedStrkAmount) || bridgedStrkAmount <= 0) {
                    throw new Error('Unable to derive bridged STRK amount.')
                  }
                  await dojoManager.swapTokens(
                    strkTokenAddress,
                    poolTokenAddress,
                    bridgedStrkAmount,
                    1,
                  )
                  const retriedViaStrk = await starkzapManager.stake(symbol, amount)
                  txHash = String(retriedViaStrk?.tx?.hash || '')
                  providerPath = 'starkzap+avnu-bridge-via-strk'
                  console.info('[Stake] Starkzap success after AVNU bridge via STRK', {
                    user: currentAccount.address,
                    symbol,
                    amount,
                    sellAmount: bridgePlan.sellAmount,
                    bridgedStrkAmount,
                    poolTokenAddress,
                    txHash,
                  })
                  return
                } catch (bridgeError) {
                  throw new Error(`WBTC staking failed after AVNU conversion attempt: ${bridgeError?.message || 'Unknown bridge error'}`)
                }
              }
              throw new Error(`WBTC staking failed on Starkzap: ${starkzapError?.message || 'Unknown error'}`)
            }
            console.error('[Stake] Starkzap failed; fallback to Dojo', {
              user: currentAccount.address,
              symbol,
              amount,
              error: errorInfo(starkzapError),
            })
            if (isControllerInitError(starkzapError)) {
              showToast('Controller did not open correctly (popup/cookies). Using standard stake flow...')
            } else {
              showToast('Starkzap staking failed. Falling back to standard stake flow...')
            }
            const tx = await dojoManager.stake(amount, useBtcMode)
            txHash = String(tx?.transaction_hash || '')
            providerPath = 'dojo-fallback'
            console.info('[Stake] Fallback Dojo success', {
              user: currentAccount.address,
              symbol,
              amount,
              txHash,
            })
          }
        } else {
          const tx = await dojoManager.stake(amount, useBtcMode)
          txHash = String(tx?.transaction_hash || '')
          console.info('[Stake] Dojo success', {
            user: currentAccount.address,
            symbol,
            amount,
            txHash,
          })
        }
        addActivityEvent({
          actionType: 'stake',
          token: symbol,
          amount,
          providerPath,
          txHash,
          status: 'success',
          details: { useBtcMode },
        })
        return { providerPath, txHash }
      })
      closeYieldModal()
      const txLabel = shortTxHash(result?.txHash || '')
      const providerLabel = result?.providerPath === 'starkzap' ? 'via Starkzap' : 'via standard flow'
      showToast(`Staked ${amount.toFixed(useBtcMode ? 6 : 2)} ${symbol} ${providerLabel}${txLabel ? ` · ${txLabel}` : ''}`)
      await updateWalletInfo()
    } catch (error) {
      console.error('Stake action error:', error)
      addActivityEvent({
        actionType: 'stake',
        token: symbol,
        amount,
        providerPath: 'unknown',
        txHash: '',
        status: 'failed',
        errorMessage: String(error?.message || 'Unknown error'),
        details: { useBtcMode },
      })
      alert('Stake failed: ' + (error?.message || 'Unknown error'))
    }
  }

  yieldModal.classList.add('active')
}

/**
 */












/** Inicializa la app con la cuenta ya conectada (tras connect() o restauración de sesión). */
async function enterApp(account) {
  const connectScreen = document.getElementById('connect-screen')
  const connectStatus = document.getElementById('connect-status')
  const connectButton = document.getElementById('connect-wallet')
  const canvasElement = document.getElementById('canvas')
  const controlsElement = document.getElementById('controls')

  currentAccount = account
    try {
    currentUsername = await controller.username()
  } catch {
    const cached = loadLastSession()
    currentUsername = cached?.username || null
  }
  saveLastSession(account.address, currentUsername)
  rememberUsername(account.address, currentUsername || '')
  console.log('✓ Wallet:', currentAccount.address, '| Username:', currentUsername)

  if (IS_SEPOLIA && (!TORII_URL || TORII_URL === '')) {
    connectStatus.innerHTML = '<span style="color: #f44336;">Missing Torii URL. Set VITE_TORII_URL in production.</span>'
    throw new Error('Missing VITE_TORII_URL')
  }

  connectStatus.textContent = 'Loading blockchain...'
  connectStatus.style.color = '#4CAF50'

  const toriiClient = await withTimeout(initDojo({
    client: {
      worldAddress: manifest.world.address,
      toriiUrl: TORII_URL,
    },
    domain: DOMAIN_SEPARATOR,
  }), 12000, 'initDojo')
  console.log('✓ Torii client initialized')

  canvas = new InfiniteCanvas(canvasElement)
  dojoManager = new DojoManager(currentAccount, manifest, toriiClient)
  starkzapManager = new StarkzapManager({ account: currentAccount })
  postManager = new PostManager(canvas, dojoManager)

  setupUIHandlers()
  canvas.setPostClickHandler((post) => showPostDetails(post, 'canvas'))

  connectStatus.textContent = 'Loading posts...'
  const hydrated = postManager.loadPostsFromCache()
  if (hydrated) {
    console.log('✓ Posts hydrated from cache')
    rememberUsersFromPosts(postManager.posts)
  }

  // Keep wallet connect flow read-only: do not auto-send profile tx here.
  // Some wallets/sessions may still resolve stale policies/contracts and fail on connect.

  document.getElementById('loading-screen').style.display = 'none'
  connectScreen.style.display = 'none'
  canvasElement.style.display = 'block'
  controlsElement.style.display = 'flex'
  connectButton.disabled = false
  connectButton.textContent = '🎮 Connect Wallet'

  if (postManager.posts.length > 0) {
    const oldestPost = postManager.posts.reduce((oldest, p) => {
      if (!oldest) return p
      return Number(p.id) < Number(oldest.id) ? p : oldest
    }, null)
    const target = oldestPost || postManager.posts[0]
    canvas.centerOn(target.x_position, target.y_position, 0.3)
  } else {
    canvas.centerOn(0, 0, 0.3)
  }

  await updateWalletInfo().catch(() => {})

  // Sync fresh posts and subscriptions in background to keep login snappy.
  void (async () => {
    try {
      await withTimeout(postManager.loadPosts(), 18000, 'loadPosts')
      rememberUsersFromPosts(postManager.posts)
      await refreshSocialData().catch(() => {})
      await autoRevealPendingSealedCommits('initial-load')
      await autoFinalizeEndedAuctionSlots('initial-load')
      await autoClaimPendingSealedRefunds('initial-load')
      console.log('✓ Loaded', postManager.posts.length, 'posts')
    } catch (e) {
      console.warn('Initial post load failed, continuing with cached/empty view:', e?.message || e)
    }

    try {
      await withTimeout(subscribeToPostUpdates(toriiClient), 12000, 'subscribeToPostUpdates')
      console.log('✓ Subscribed to updates')
    } catch (e) {
      console.warn('Post updates subscription skipped:', e?.message || e)
    }

    await updateWalletInfo().catch(() => {})
    if (!automationTickTimer) {
      automationTickTimer = setInterval(() => {
        void autoRevealPendingSealedCommits('interval')
        void autoFinalizeEndedAuctionSlots('interval')
        void autoClaimPendingSealedRefunds('interval')
      }, 15000)
    }
    console.log('✓ App ready!')
  })()
}

// Cartridge Controller helper.
//
// Cartridge Controller uses a keychain iframe (not a browser extension). In Firefox,
// strict tracking/cookie settings can block iframe storage and make Controller init
// fail early. We lazy-init and provide a clearer message in connect flow.
let controllerInitError = null
let walletModalEventsBound = false

function ensureController() {
  if (controller) return controller
  try {
    controller = new Controller(controllerOpts)
    controllerInitError = null
    return controller
  } catch (e) {
    controllerInitError = e
    controller = null
    return null
  }
}

function showToast(message) {
  const toast = document.getElementById('toast')
  toast.textContent = message
  toast.classList.add('show')
  
  setTimeout(() => {
    toast.classList.remove('show')
  }, 3000)
}

async function runWithBusyButton(button, opts, task) {
  const {
    idleText = button?.textContent || '',
    busyText = 'Working...',
    pendingToast = 'Please confirm in wallet and wait for on-chain confirmation...',
    pendingAfterMs = 2500,
  } = opts || {}
  let pendingTimer = null
  if (button) {
    button.disabled = true
    button.textContent = busyText
  }
  pendingTimer = setTimeout(() => showToast(pendingToast), Math.max(0, Number(pendingAfterMs) || 0))
  try {
    return await task()
  } finally {
    if (pendingTimer) clearTimeout(pendingTimer)
    if (button && button.isConnected) {
      button.disabled = false
      button.textContent = idleText
    }
  }
}

function shortTxHash(hash) {
  const h = String(hash || '').trim()
  if (!h) return ''
  return h.length > 14 ? `${h.slice(0, 8)}...${h.slice(-6)}` : h
}

function errorInfo(error) {
  if (!error) return { message: 'Unknown error' }
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code || '',
    cause: error?.cause ? String(error.cause?.message || error.cause) : '',
    stack: error?.stack || '',
  }
}

function isControllerInitError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return message.includes('cartridge controller failed to initialize')
    || message.includes('failed to initialize')
}

let yieldActionInProgress = ''
let yieldActionLastCompletedAt = 0
let yieldActionLastName = ''
const YIELD_ACTION_GHOST_CLICK_WINDOW_MS = 1400

async function runExclusiveYieldAction(actionName, task) {
  const now = Date.now()
  if (
    yieldActionLastName
    && yieldActionLastName !== actionName
    && (now - yieldActionLastCompletedAt) < YIELD_ACTION_GHOST_CLICK_WINDOW_MS
  ) {
    showToast('Please wait a second before triggering another action.')
    console.info('[Yield] Action ignored: ghost click guard', {
      requested: actionName,
      lastAction: yieldActionLastName,
      sinceLastMs: now - yieldActionLastCompletedAt,
    })
    return null
  }
  if (yieldActionInProgress) {
    showToast('Another wallet action is still in progress.')
    console.info('[Yield] Action ignored: another action is in progress', {
      requested: actionName,
      inProgress: yieldActionInProgress,
    })
    return null
  }
  yieldActionInProgress = actionName
  const actionButtons = [
    document.getElementById('wallet-yield-deposit-btn'),
    document.getElementById('wallet-yield-withdraw-btn'),
    document.getElementById('wallet-yield-claim-btn'),
  ].filter(Boolean)
  for (const btn of actionButtons) btn.disabled = true
  try {
    return await task()
  } finally {
    for (const btn of actionButtons) {
      if (btn?.isConnected) btn.disabled = false
    }
    yieldActionInProgress = ''
    yieldActionLastName = actionName
    yieldActionLastCompletedAt = Date.now()
  }
}

async function askYieldToken(actionLabel, preferred = 'STRK') {
  const modal = document.getElementById('yieldTokenPickerModal')
  const title = document.getElementById('yieldTokenPickerTitle')
  const hint = document.getElementById('yieldTokenPickerHint')
  const strkBtn = document.getElementById('yieldTokenPickerStrkBtn')
  const wbtcBtn = document.getElementById('yieldTokenPickerWbtcBtn')
  const cancelBtn = document.getElementById('yieldTokenPickerCancelBtn')
  if (!modal || !title || !hint || !strkBtn || !wbtcBtn || !cancelBtn) {
    return null
  }

  const normalizedPreferred = String(preferred || 'STRK').toUpperCase() === 'WBTC' ? 'WBTC' : 'STRK'
  title.textContent = `${actionLabel} · Choose token`
  hint.textContent = `Select the token you want to use for this action. Recommended: ${normalizedPreferred}.`

  strkBtn.disabled = false
  wbtcBtn.disabled = false

  return new Promise((resolve) => {
    const close = (value = null) => {
      modal.classList.remove('active')
      modal.onclick = null
      strkBtn.onclick = null
      wbtcBtn.onclick = null
      cancelBtn.onclick = null
      resolve(value)
    }
    strkBtn.onclick = () => close('STRK')
    wbtcBtn.onclick = () => close('WBTC')
    cancelBtn.onclick = () => close(null)
    modal.onclick = (e) => {
      if (e.target === modal) close(null)
    }
    modal.classList.add('active')
  })
}

const ACTIVITY_LEDGER_LIMIT = 120
let activityLedger = []

function addActivityEvent(event) {
  const txHash = String(event?.txHash || '').trim()
  if (!txHash) return null
  const record = {
    actionType: String(event?.actionType || 'unknown'),
    token: String(event?.token || '').toUpperCase(),
    amount: Number(event?.amount || 0),
    providerPath: String(event?.providerPath || 'unknown'),
    txHash,
    status: String(event?.status || 'submitted'),
    timestamp: Number(event?.timestamp || Date.now()),
    errorMessage: String(event?.errorMessage || ''),
    details: event?.details && typeof event.details === 'object' ? event.details : {},
  }
  activityLedger = [record, ...activityLedger].slice(0, ACTIVITY_LEDGER_LIMIT)
  return record
}

async function copyToClipboard(text) {
  const t = String(text || '')
  if (!t) return false

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(t)
      return true
    }
  } catch {
    // fall through
  }

  // Fallback for older mobile browsers
  try {
    const ta = document.createElement('textarea')
    ta.value = t
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    ta.style.top = '0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, ta.value.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return Boolean(ok)
  } catch {
    return false
  }
}

function normalizeStarknetAddress(address) {
  const raw = String(address || '').trim().toLowerCase()
  if (!raw) return ''
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw

  // Keep exactly 64 nibbles so other wallets/explorers don't reject shorter forms.
  if (!/^[0-9a-f]+$/.test(hex)) return raw
  return `0x${hex.padStart(64, '0')}`
}

// Exponer toast para otros módulos (postManager.js)
globalThis.showToast = showToast

// Tracks slots currently being auto-finalized to avoid duplicate transactions.
const autoFinalizingSlots = new Set()
// Tracks sealed commits currently being auto-revealed to avoid duplicate relayer requests.
const autoRevealingSlots = new Set()
// Tracks sealed refund claims currently being auto-submitted.
const autoClaimingRefundSlots = new Set()
// Prevent noisy repeated toasts/logs when sealed finalize is blocked by unrevealed commits.
const autoFinalizeBlockedSealedSlots = new Set()
const ZK_DEBUG_LOGS = Boolean(import.meta.env?.DEV) || ['localhost', '127.0.0.1', '::1'].includes(String(globalThis?.location?.hostname || '').toLowerCase())

function zkConsole(event, payload = {}) {
  if (!ZK_DEBUG_LOGS) return
  try {
    console.info(`[sealed-zk] ${String(event || '')}`, payload)
  } catch {}
}

function redactSealedDebugPayload(payload = {}) {
  const safe = { ...(payload || {}) }
  if (Object.prototype.hasOwnProperty.call(safe, 'bidAmount')) safe.bidAmount = '[hidden]'
  if (Object.prototype.hasOwnProperty.call(safe, 'salt')) safe.salt = '[hidden]'
  return safe
}

function isNoSwapRouteError(error) {
  const msg = String(error?.message || error || '').toLowerCase()
  return msg.includes('no swap route available')
    || msg.includes('no swap route')
    || msg.includes('no route')
    || msg.includes('insufficient liquidity')
}

function buildNoRouteHint(sellSymbol, buySymbol) {
  return `No route for ${sellSymbol} -> ${buySymbol} right now. No swap was executed. Try a smaller amount, retry in a few minutes, or swap to a different token first.`
}

function parseStakePoolTokenAddress(error) {
  const msg = String(error?.message || error || '')
  const m = msg.match(/pool token:\s*(0x[0-9a-f]+)/i)
  return m?.[1] ? normalizeStarknetAddress(m[1]) : ''
}

function parseStakeRequiredAmount(error, fallbackAmount = 0) {
  const msg = String(error?.message || error || '')
  const m = msg.match(/required:\s*[a-z0-9_]+\s*([0-9]+(?:[.,][0-9]+)?)/i)
  if (!m?.[1]) return Number(fallbackAmount || 0)
  const parsed = Number(String(m[1]).replace(',', '.'))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number(fallbackAmount || 0)
}

function unitsToTokenNumber(rawUnits, decimals = 18, precision = 8) {
  const raw = BigInt(rawUnits || 0)
  const d = Math.max(0, Number(decimals || 0))
  if (d === 0) return Number(raw)
  const base = 10n ** BigInt(d)
  const whole = raw / base
  const fraction = (raw % base).toString().padStart(d, '0').slice(0, Math.max(0, precision))
  const asNum = Number(`${whole.toString()}.${fraction || '0'}`)
  return Number.isFinite(asNum) ? asNum : 0
}

async function planWbtcStakeBridge({
  dojoManager,
  fromToken,
  targetToken,
  strkToken,
  desiredTargetAmount,
  maxSellAmount,
}) {
  const desired = Math.max(0, Number(desiredTargetAmount || 0))
  const maxSell = Math.max(0, Number(maxSellAmount || 0))
  if (!Number.isFinite(desired) || desired <= 0 || !Number.isFinite(maxSell) || maxSell <= 0) return null

  const multipliers = [1, 1.25, 1.5, 2, 3, 5, 8, 10]
  const candidateSet = new Set()
  for (const m of multipliers) {
    const sell = Math.min(maxSell, desired * m)
    if (sell > 0) candidateSet.add(Number(sell.toFixed(8)))
  }
  candidateSet.add(Number(maxSell.toFixed(8)))
  const candidates = Array.from(candidateSet).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b)
  const targetTolerance = desired * 0.995

  for (const sellAmount of candidates) {
    try {
      const direct = await dojoManager.getTokenSwapQuote(fromToken, targetToken, sellAmount)
      const directOut = Number(direct?.estimatedBuyAmount || 0)
      if (Number.isFinite(directOut) && directOut >= targetTolerance) {
        return { kind: 'direct', sellAmount, estimatedTargetAmount: directOut }
      }
    } catch {}

    try {
      const hop1 = await dojoManager.getTokenSwapQuote(fromToken, strkToken, sellAmount)
      const estimatedStrk = Number(hop1?.estimatedBuyAmount || 0)
      if (!Number.isFinite(estimatedStrk) || estimatedStrk <= 0) continue
      const hop2 = await dojoManager.getTokenSwapQuote(strkToken, targetToken, estimatedStrk)
      const estimatedTarget = Number(hop2?.estimatedBuyAmount || 0)
      if (Number.isFinite(estimatedTarget) && estimatedTarget >= targetTolerance) {
        return {
          kind: 'via-strk',
          sellAmount,
          estimatedStrkAmount: estimatedStrk,
          estimatedTargetAmount: estimatedTarget,
        }
      }
    } catch {}
  }

  return null
}

async function tryAutoFinalizeAuctionSlot(post, source = 'auto') {
  if (!dojoManager || !postManager || !post) return false

  const isAuctionSlot = Number(post.post_kind) === 2
  const slot = post.auction_slot || null
  const group = post.auction_group || null
  const sealedCfg = post.auction_sealed_config || null
  if (!isAuctionSlot || !slot || !group || slot.finalized) return false

  const now = Math.floor(Date.now() / 1000)
  const ended = now >= Number(group.end_time || 0)
  if (!ended) return false

  const slotId = Number(post.id)
  if (!Number.isFinite(slotId) || autoFinalizingSlots.has(slotId)) return false

  autoFinalizingSlots.add(slotId)
  try {
    console.log(`⏱️ Auto-finalizing slot ${slotId} (source: ${source})`)
    if (sealedCfg?.sealed_mode && SEALED_RELAY_URL) {
      const commits = Array.isArray(post?.auction_commits) ? post.auction_commits : []
      const hasCommits = commits.length > 0
      const hasRevealedCommit = commits.some((c) => Boolean(c?.revealed))
      const hasPendingUnrevealedCommit = commits.some((c) => !c?.revealed && !c?.refunded)
      if (hasCommits && !hasRevealedCommit && hasPendingUnrevealedCommit) {
        zkConsole('finalize:blocked-unrevealed-commits', {
          slotId,
          commits: commits.length,
          source,
        })
        if (!autoFinalizeBlockedSealedSlots.has(slotId)) {
          autoFinalizeBlockedSealedSlots.add(slotId)
          showToast('Sealed finalize delayed: waiting for a valid reveal proof.')
        }
        return false
      }
      autoFinalizeBlockedSealedSlots.delete(slotId)
      await requestSealedImmediateFinalize({ slotPostId: slotId })
    } else {
      await dojoManager.finalizeAuctionSlot(slotId)
    }
    await new Promise((resolve) => setTimeout(resolve, 5000))
    await postManager.loadPosts()
    await postManager.loadImages()
    canvas.setPosts(postManager.posts)
    await updateWalletInfo()
    return true
  } catch (error) {
    console.warn(`Auto-finalize skipped for slot ${slotId}:`, error?.message || error)
    return false
  } finally {
    autoFinalizingSlots.delete(slotId)
  }
}

async function autoFinalizeEndedAuctionSlots(source = 'scan') {
  if (!postManager?.posts?.length) return
  const endedSlots = postManager.posts.filter((post) => {
    if (Number(post.post_kind) !== 2) return false
    const slot = post.auction_slot || null
    const group = post.auction_group || null
    const sealedCfg = post.auction_sealed_config || null
    if (!slot || !group || slot.finalized) return false
    const now = Math.floor(Date.now() / 1000)
    const endTs = sealedCfg?.sealed_mode
      ? Number(sealedCfg.reveal_end_time || group.end_time || 0)
      : Number(group.end_time || 0)
    return now >= endTs
  })

  for (const post of endedSlots) {
    await tryAutoFinalizeAuctionSlot(post, source)
  }
}

/** Límite del contrato: cada ByteArray puede tener como mucho 300 chunks de 31 bytes. */
const CONTRACT_MAX_CHUNKS_PER_FIELD = 300
const CONTRACT_MAX_BYTES_PER_FIELD = CONTRACT_MAX_CHUNKS_PER_FIELD * 31

// Keep a strong safety margin to avoid edge-case overflows in calldata/encoding.
const CONTRACT_SAFE_MAX_CHUNKS_PER_FIELD = 260
const CONTRACT_SAFE_MAX_BYTES_PER_FIELD = CONTRACT_SAFE_MAX_CHUNKS_PER_FIELD * 31
const AUCTION_POST_CREATION_FEE_STRK = 10
const SEALED_BID_SALT_MAP_KEY = 'starkwall_sealed_bid_salts_v1'
const SEALED_BID_AMOUNT_MAP_KEY = 'starkwall_sealed_bid_amounts_v1'

function randomSaltFelt() {
  const a = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))
  const b = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))
  return `0x${((a << 53n) + b).toString(16)}`
}

function readSaltMap() {
  try {
    const raw = localStorage.getItem(SEALED_BID_SALT_MAP_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveSaltForSlot(slotPostId, salt) {
  const map = readSaltMap()
  map[String(slotPostId)] = String(salt || '')
  try { localStorage.setItem(SEALED_BID_SALT_MAP_KEY, JSON.stringify(map)) } catch {}
}

function getSaltForSlot(slotPostId) {
  const map = readSaltMap()
  return String(map[String(slotPostId)] || '')
}

function readBidAmountMap() {
  try {
    const raw = localStorage.getItem(SEALED_BID_AMOUNT_MAP_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveBidAmountForSlot(slotPostId, bidAmount) {
  const map = readBidAmountMap()
  map[String(slotPostId)] = Number.isFinite(Number(bidAmount)) ? Number(bidAmount) : 0
  try { localStorage.setItem(SEALED_BID_AMOUNT_MAP_KEY, JSON.stringify(map)) } catch {}
}

function getBidAmountForSlot(slotPostId) {
  const map = readBidAmountMap()
  const n = Number(map[String(slotPostId)] || 0)
  return Number.isFinite(n) ? n : 0
}

async function tryAutoRevealSealedCommit(post, source = 'auto') {
  if (!post || !postManager || !dojoManager || !currentAccount || !SEALED_RELAY_URL) return false

  const slotId = Number(post.id || 0)
  if (!Number.isFinite(slotId) || slotId <= 0) return false

  const slot = post.auction_slot || null
  const group = post.auction_group || null
  const sealedCfg = post.auction_sealed_config || null
  if (!slot || !group || !sealedCfg?.sealed_mode || slot.finalized) return false

  const now = Math.floor(Date.now() / 1000)
  const commitEndTs = Number(sealedCfg.commit_end_time || group.end_time || 0)
  const revealEndTs = Number(sealedCfg.reveal_end_time || group.end_time || 0)
  if (!(now >= commitEndTs && now < revealEndTs)) return false

  const myAddr = normalizeSocialAddress(currentAccount.address || '')
  const myCommit = (post.auction_commits || []).find((c) => normalizeSocialAddress(c.bidder) === myAddr) || null
  if (!myCommit || myCommit.revealed) return false

  const salt = getSaltForSlot(slotId)
  if (!salt) return false

  const bidFromLocal = getBidAmountForSlot(slotId)
  const bidAmount = bidFromLocal > 0 ? bidFromLocal : Number(myCommit.escrow_amount || 0)
  if (!Number.isFinite(bidAmount) || bidAmount <= 0) return false

  const lockKey = `${slotId}:${myAddr}`
  if (autoRevealingSlots.has(lockKey)) return false

  autoRevealingSlots.add(lockKey)
  try {
    console.log(`🤖 Auto-revealing sealed commit for slot ${slotId} (source: ${source})`)
    const revealed = await requestSealedImmediateReveal({
      slotPostId: slotId,
      groupId: Number(post?.auction_group_id || slot?.group_id || 0),
      bidder: currentAccount.address,
      bidAmount,
      salt,
    })
    await new Promise((resolve) => setTimeout(resolve, 5000))
    await postManager.loadPosts()
    await postManager.loadImages()
    canvas.setPosts(postManager.posts)
    await updateWalletInfo()
    showToast(revealed?.txHash ? `Auto-reveal sent (${shortTxHash(revealed.txHash)})` : 'Auto-reveal sent')
    return true
  } catch (error) {
    console.warn(`Auto-reveal skipped for slot ${slotId}:`, error?.message || error)
    return false
  } finally {
    autoRevealingSlots.delete(lockKey)
  }
}

async function autoRevealPendingSealedCommits(source = 'scan') {
  if (!postManager?.posts?.length || !currentAccount || !SEALED_RELAY_URL) return
  for (const post of postManager.posts) {
    await tryAutoRevealSealedCommit(post, source)
  }
}

async function tryAutoClaimSealedRefund(post, source = 'auto') {
  if (!post || !postManager || !dojoManager || !currentAccount) return false

  const slotId = Number(post.id || 0)
  if (!Number.isFinite(slotId) || slotId <= 0) return false

  const slot = post.auction_slot || null
  const group = post.auction_group || null
  const sealedCfg = post.auction_sealed_config || null
  if (!slot || !group || !sealedCfg?.sealed_mode) return false

  const now = Math.floor(Date.now() / 1000)
  const revealEndTs = Number(sealedCfg.reveal_end_time || group.end_time || 0)
  if (now < revealEndTs) return false

  const myAddr = normalizeSocialAddress(currentAccount.address || '')
  const myCommit = (post.auction_commits || []).find((c) => normalizeSocialAddress(c.bidder) === myAddr) || null
  if (!myCommit || myCommit.refunded) return false

  const isWinner = Boolean(slot.has_bid) && normalizeSocialAddress(slot.highest_bidder) === myAddr
  if (isWinner) return false

  const lockKey = `${slotId}:${myAddr}`
  if (autoClaimingRefundSlots.has(lockKey)) return false

  autoClaimingRefundSlots.add(lockKey)
  try {
    console.log(`🤖 Auto-claiming sealed refund for slot ${slotId} (source: ${source})`)
    if (SEALED_RELAY_URL) {
      await requestSealedImmediateRefund({ slotPostId: slotId, bidder: currentAccount.address })
    } else {
      await dojoManager.claimAuctionCommitRefund(slotId)
    }
    await new Promise((resolve) => setTimeout(resolve, 5000))
    await postManager.loadPosts()
    await postManager.loadImages()
    canvas.setPosts(postManager.posts)
    await updateWalletInfo()
    showToast('Refund claimed automatically')
    return true
  } catch (error) {
    console.warn(`Auto-refund claim skipped for slot ${slotId}:`, error?.message || error)
    return false
  } finally {
    autoClaimingRefundSlots.delete(lockKey)
  }
}

async function autoClaimPendingSealedRefunds(source = 'scan') {
  if (!postManager?.posts?.length || !currentAccount) return
  for (const post of postManager.posts) {
    await tryAutoClaimSealedRefund(post, source)
  }
}

async function scheduleSealedAutoReveal({ slotPostId, groupId, bidder, bidAmount, salt, commitEndTime, revealEndTime }) {
  const baseUrl = String(SEALED_RELAY_URL || '').trim()
  if (!baseUrl) return { ok: false, reason: 'relay-disabled' }
  const endpoint = `${baseUrl.replace(/\/$/, '')}/sealed/schedule`
  const payload = {
    slotPostId: Number(slotPostId),
    groupId: Number(groupId),
    bidder: String(bidder || ''),
    bidAmount: Number(bidAmount),
    salt: String(salt || ''),
    revealAfterUnix: Number(commitEndTime || 0),
    finalizeAfterUnix: Number(revealEndTime || 0),
  }
  zkConsole('schedule:request', redactSealedDebugPayload(payload))
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => ({}))
  zkConsole('schedule:response', {
    ok: response.ok && Boolean(body?.ok),
    status: response.status,
    jobId: body?.jobId || '',
    relayStatus: body?.status || '',
  })
  if (!response.ok || !body?.ok) {
    throw new Error(String(body?.error || `Relay scheduling failed (${response.status})`))
  }
  return { ok: true, jobId: String(body.jobId || '') }
}

async function requestSealedImmediateReveal({ slotPostId, groupId, bidder, bidAmount, salt }) {
  const baseUrl = String(SEALED_RELAY_URL || '').trim()
  if (!baseUrl) return { ok: false, reason: 'relay-disabled' }
  const endpoint = `${baseUrl.replace(/\/$/, '')}/sealed/reveal-now`
  const payload = {
    slotPostId: Number(slotPostId),
    groupId: Number(groupId),
    bidder: String(bidder || ''),
    bidAmount: Number(bidAmount),
    salt: String(salt || ''),
  }
  zkConsole('reveal-now:request', redactSealedDebugPayload(payload))
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => ({}))
  zkConsole('reveal-now:response', {
    ok: response.ok && Boolean(body?.ok),
    status: response.status,
    txHash: body?.txHash || '',
    relayStatus: body?.status || '',
  })
  if (!response.ok || !body?.ok) {
    throw new Error(String(body?.error || `Relay reveal failed (${response.status})`))
  }
  return {
    ok: true,
    txHash: String(body.txHash || ''),
    status: String(body.status || 'submitted'),
  }
}

async function requestSealedImmediateFinalize({ slotPostId }) {
  const baseUrl = String(SEALED_RELAY_URL || '').trim()
  if (!baseUrl) return { ok: false, reason: 'relay-disabled' }
  const endpoint = `${baseUrl.replace(/\/$/, '')}/sealed/finalize-now`
  zkConsole('finalize-now:request', { slotPostId: Number(slotPostId) })
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slotPostId: Number(slotPostId) }),
  })
  const body = await response.json().catch(() => ({}))
  zkConsole('finalize-now:response', {
    ok: response.ok && Boolean(body?.ok),
    status: response.status,
    txHash: body?.txHash || '',
    relayStatus: body?.status || '',
  })
  if (!response.ok || !body?.ok) {
    throw new Error(String(body?.error || `Relay finalize failed (${response.status})`))
  }
  return {
    ok: true,
    txHash: String(body.txHash || ''),
    status: String(body.status || 'submitted'),
  }
}

async function requestSealedImmediateRefund({ slotPostId, bidder }) {
  const baseUrl = String(SEALED_RELAY_URL || '').trim()
  if (!baseUrl) return { ok: false, reason: 'relay-disabled' }
  const endpoint = `${baseUrl.replace(/\/$/, '')}/sealed/refund-now`
  zkConsole('refund-now:request', { slotPostId: Number(slotPostId), bidder: String(bidder || '') })
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slotPostId: Number(slotPostId), bidder: String(bidder || '') }),
  })
  const body = await response.json().catch(() => ({}))
  zkConsole('refund-now:response', {
    ok: response.ok && Boolean(body?.ok),
    status: response.status,
    txHash: body?.txHash || '',
    relayStatus: body?.status || '',
  })
  if (!response.ok || !body?.ok) {
    throw new Error(String(body?.error || `Relay refund failed (${response.status})`))
  }
  return {
    ok: true,
    txHash: String(body.txHash || ''),
    status: String(body.status || 'submitted'),
  }
}

const RELAY_JOBS_CACHE_TTL_MS = 8000
let relayJobsCache = { fetchedAt: 0, jobs: [] }

async function fetchSealedRelayJobs(force = false) {
  const baseUrl = String(SEALED_RELAY_URL || '').trim()
  if (!baseUrl) return []
  const now = Date.now()
  if (!force && relayJobsCache.jobs.length && (now - relayJobsCache.fetchedAt) < RELAY_JOBS_CACHE_TTL_MS) {
    return relayJobsCache.jobs
  }
  const endpoint = `${baseUrl.replace(/\/$/, '')}/sealed/jobs`
  const response = await fetch(endpoint, { method: 'GET' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !body?.ok || !Array.isArray(body?.jobs)) {
    throw new Error(String(body?.error || `Relay jobs fetch failed (${response.status})`))
  }
  if (ZK_DEBUG_LOGS) {
    const counts = {}
    for (const job of body.jobs) {
      const key = String(job?.status || 'n/a')
      counts[key] = Number(counts[key] || 0) + 1
    }
    zkConsole('jobs:snapshot', { total: body.jobs.length, byStatus: counts, force })
  }
  relayJobsCache = { fetchedAt: now, jobs: body.jobs }
  return relayJobsCache.jobs
}

function relayStageLabel(status, kind = 'reveal') {
  const s = String(status || '')
  if (s === 'running') return kind === 'reveal' ? 'Generating ZK proof (Garaga)...' : 'Submitting transaction...'
  if (s === 'submitted') return kind === 'reveal' ? 'Proof verified onchain' : 'Submitted onchain'
  if (s === 'scheduled') return kind === 'reveal' ? 'Waiting for commit phase to end (queued)' : 'Queued'
  if (s === 'skipped') return kind === 'reveal' ? 'Skipped (privacy or phase constraint)' : 'Skipped'
  if (s === 'failed') return 'Failed'
  return 'N/A'
}

function formatRelayUnix(unix) {
  const ts = Number(unix || 0)
  if (!Number.isFinite(ts) || ts <= 0) return 'n/a'
  const d = new Date(ts * 1000)
  const utc = d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  return `${d.toLocaleString()} (${utc})`
}

function summarizeRelayPipelineForSlot(jobs, slotId, bidder) {
  const slotJobs = (Array.isArray(jobs) ? jobs : []).filter((j) => Number(j?.slotPostId || 0) === Number(slotId || 0))
  if (!slotJobs.length) return `<br/><strong>ZK pipeline:</strong> Waiting for first sealed commit`
  const bidderNorm = normalizeSocialAddress(bidder || '')
  const myJobs = slotJobs
    .filter((j) => normalizeSocialAddress(j?.bidder || '') === bidderNorm)
    .sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))
  const sorted = [...slotJobs].sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))
  const chosen = myJobs[0] || sorted[0]
  const isMine = Boolean(myJobs[0])

  const lines = [
    `<br/><strong>ZK pipeline:</strong> ${relayStageLabel(chosen.status, 'reveal')}`,
  ]

  // If this wallet has no commit in this slot, keep status generic and privacy-safe.
  if (!isMine) {
    if (chosen?.status === 'scheduled') {
      lines.push('<br/>Slot automation ready. Proof starts when commit phase closes.')
    }
    if (chosen?.revealTxHash) lines.push(`<br/>Reveal tx: ${shortTxHash(chosen.revealTxHash)}`)
    if (chosen?.finalizeTxHash) lines.push(`<br/>Finalize tx: ${shortTxHash(chosen.finalizeTxHash)}`)
    return lines.join('')
  }

  if (chosen?.revealTxHash) lines.push(`<br/>Reveal tx: ${shortTxHash(chosen.revealTxHash)}`)
  if (chosen?.finalizeStatus && chosen.finalizeStatus !== 'scheduled') {
    lines.push(`<br/>Finalize: ${relayStageLabel(chosen.finalizeStatus, 'finalize')}`)
  }
  if (chosen?.finalizeTxHash) lines.push(`<br/>Finalize tx: ${shortTxHash(chosen.finalizeTxHash)}`)
  if (chosen?.refundStatus && chosen.refundStatus !== 'scheduled') {
    lines.push(`<br/>Refund: ${relayStageLabel(chosen.refundStatus, 'refund')}`)
  }
  if (chosen?.refundTxHash) lines.push(`<br/>Refund tx: ${shortTxHash(chosen.refundTxHash)}`)
  if (chosen?.status === 'scheduled' && Number(chosen?.revealAfterUnix || 0) > 0) {
    const wait = Math.max(0, Number(chosen.revealAfterUnix) - Math.floor(Date.now() / 1000))
    lines.push(`<br/>Proof starts after: ${formatRelayUnix(chosen.revealAfterUnix)} (in ${formatRemaining(wait)})`)
  }
  if (chosen?.status === 'failed' && chosen?.error) lines.push('<br/>Proof error: check relayer logs')
  if (chosen?.status === 'skipped' && String(chosen?.error || '').toLowerCase().includes('winner selected')) {
    lines.push('<br/>Privacy mode: loser reveal suppressed')
  }
  return lines.join('')
}

function getRelayJobForSlot(jobs, slotId, bidder) {
  const filtered = (Array.isArray(jobs) ? jobs : []).filter((j) => Number(j?.slotPostId || 0) === Number(slotId || 0))
  if (!filtered.length) return null
  const bidderNorm = normalizeSocialAddress(bidder || '')
  const mine = filtered
    .filter((j) => normalizeSocialAddress(j?.bidder || '') === bidderNorm)
    .sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))
  const sorted = filtered.sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))
  return mine[0] || sorted[0] || null
}

function shouldShowVerifyProofButton(job) {
  if (!job || typeof job !== 'object') return false
  if (job.zkTrace) return true
  if (job.revealTxHash || job.finalizeTxHash || job.refundTxHash) return true
  const reveal = String(job.status || '')
  const finalize = String(job.finalizeStatus || '')
  const refund = String(job.refundStatus || '')
  return (
    ['running', 'submitted', 'failed', 'skipped'].includes(reveal) ||
    ['running', 'submitted', 'failed', 'skipped'].includes(finalize) ||
    ['running', 'submitted', 'failed', 'skipped'].includes(refund)
  )
}

async function enrichSealedProofStatus(post, postAuctionInfo, expectedPostId, verifyProofBtn = null) {
  if (!post || !postAuctionInfo || !SEALED_RELAY_URL) return
  try {
    const jobs = await fetchSealedRelayJobs()
    const modal = document.getElementById('postDetailsModal')
    if (!modal || String(modal?.dataset?.postId || '') !== String(expectedPostId || '')) return
    const job = getRelayJobForSlot(jobs, Number(post?.id || 0), currentAccount?.address || '')
    const snippet = summarizeRelayPipelineForSlot(jobs, Number(post?.id || 0), currentAccount?.address || '')
    if (verifyProofBtn) {
      verifyProofBtn.textContent = '🧪 Verify Sealed Result'
      verifyProofBtn.style.display = shouldShowVerifyProofButton(job) ? 'inline-block' : 'none'
    }
    zkConsole('job:selected', {
      slotId: Number(post?.id || 0),
      jobId: String(job?.id || ''),
      status: String(job?.status || ''),
      finalizeStatus: String(job?.finalizeStatus || ''),
      refundStatus: String(job?.refundStatus || ''),
      hasZkTrace: Boolean(job?.zkTrace),
      revealAfterUnix: Number(job?.revealAfterUnix || 0),
    })
    if (!snippet) return
    if (!postAuctionInfo.innerHTML.includes('<strong>ZK pipeline:</strong>')) {
      postAuctionInfo.innerHTML += snippet
    } else {
      postAuctionInfo.innerHTML = postAuctionInfo.innerHTML.replace(/<br\/?><strong>ZK pipeline:[\s\S]*$/, '') + snippet
    }
  } catch (error) {
    console.warn('Could not load relay ZK status:', error?.message || error)
  }
}

function byteArrayChunkCount(str) {
  const bytes = new TextEncoder().encode(String(str || '')).length
  return Math.ceil(bytes / 31)
}

/** Redimensiona y comprime una imagen hasta que quepa en el contrato (data URL <= safe ByteArray margin). */
function resizeImageToDataUrlWithMaxLength(fileOrDataUrl, maxBytes = CONTRACT_SAFE_MAX_BYTES_PER_FIELD) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src)
      const canvas = document.createElement('canvas')
      const encoder = new TextEncoder()
      const tries = [
        { w: 393, h: 852, q: 0.5 },
        { w: 320, h: 694, q: 0.45 },
        { w: 280, h: 606, q: 0.4 },
        { w: 220, h: 477, q: 0.35 },
        { w: 180, h: 390, q: 0.3 },
        { w: 150, h: 325, q: 0.25 },
        { w: 120, h: 260, q: 0.22 },
        { w: 100, h: 217, q: 0.2 },
      ]

      let smallestDataUrl = ''
      let smallestBytes = Number.MAX_SAFE_INTEGER

      for (const { w, h, q } of tries) {
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, w, h)

        const dataUrl = canvas.toDataURL('image/jpeg', q)
        const byteLen = encoder.encode(dataUrl).length
        if (byteLen < smallestBytes) {
          smallestBytes = byteLen
          smallestDataUrl = dataUrl
        }

        if (byteLen <= maxBytes) {
          resolve(dataUrl)
          return
        }
      }

      reject(new Error(`Image is too large for on-chain storage (${smallestBytes} bytes, safe limit ${maxBytes}). Try a simpler photo.`))
    }
    img.onerror = () => {
      if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src)
      reject(new Error('No se pudo cargar la imagen'))
    }
    if (typeof fileOrDataUrl === 'string') {
      img.src = fileOrDataUrl
    } else {
      img.src = URL.createObjectURL(fileOrDataUrl)
    }
  })
}

/** Cerrar sesión y volver a la pantalla de login. Obliga a hacer login de nuevo. */
function logout() {
  saveLastSession(null)
  currentAccount = null
  try {
    if (controller && typeof controller.disconnect === 'function') {
      controller.disconnect()
    }
  } catch (e) {
    console.warn('Controller disconnect:', e)
  }
  const connectScreen = document.getElementById('connect-screen')
  const canvasEl = document.getElementById('canvas')
  const controlsEl = document.getElementById('controls')
  const connectStatus = document.getElementById('connect-status')
  const connectButton = document.getElementById('connect-wallet')
  const loadingScreen = document.getElementById('loading-screen')
  if (loadingScreen) loadingScreen.style.display = 'none'
  connectScreen.style.display = 'flex'
  canvasEl.style.display = 'none'
  controlsEl.style.display = 'none'
  connectStatus.textContent = ''
  connectStatus.innerHTML = ''
  connectButton.disabled = false
  connectButton.textContent = '🎮 Connect Wallet'
}

async function connectWallet() {
  const connectStatus = document.getElementById('connect-status')
  const connectButton = document.getElementById('connect-wallet')

  const c = ensureController()
  if (!c) {
    console.warn('Controller init failed:', controllerInitError)
    connectStatus.innerHTML = [
      '<span style="color: #f44336;">Cartridge no disponible todavía.</span>',
      '<div style="margin-top: 8px; color: #999; font-size: 12px;">En Firefox suele ser por bloqueo de cookies/tracking que impide al iframe de Cartridge inicializarse.</div>',
      '<div style="margin-top: 8px; color: #999; font-size: 12px;">Prueba esto y recarga:</div>',
      '<div style="margin-top: 6px; color: #999; font-size: 12px;">1) Abre <a href="https://x.cartridge.gg/" target="_blank" rel="noreferrer">x.cartridge.gg</a> e inicia sesión</div>',
      '<div style="margin-top: 6px; color: #999; font-size: 12px;">2) En el icono del escudo (Protección contra rastreo) desactívala para este sitio</div>',
      '<div style="margin-top: 6px; color: #999; font-size: 12px;">3) Vuelve aquí y refresca la página</div>',
    ].join('')
    return
  }

  connectButton.disabled = true
  connectButton.textContent = '⏳ Connecting...'
  connectStatus.textContent = 'Abre Cartridge y elige una cuenta...'
  connectStatus.style.color = '#4CAF50'
  connectStatus.innerHTML = ''

  try {
    const account = await withTimeout(c.connect(), 90000, 'wallet connect')
    if (!account) {
      connectStatus.innerHTML = '<span style="color: #f44336;">No se obtuvo cuenta. Completa el login en Cartridge y vuelve a intentar.</span>'
      connectButton.disabled = false
      connectButton.textContent = '🎮 Connect Wallet'
      return
    }
    await enterApp(account)
  } catch (error) {
    console.error('Connection error:', error)
    connectStatus.innerHTML = `<span style="color: #f44336;">❌ ${error.message || 'Error de conexión'}</span>`
    connectButton.disabled = false
    connectButton.textContent = '🎮 Connect Wallet'
  }
}

/** Restaura sesión al recargar usando probe() — NUNCA abre popup ni pide login. */
async function tryRestoreSessionOnLoad() {
  const loadingScreen = document.getElementById('loading-screen')
  const connectScreen = document.getElementById('connect-screen')
  const connectStatus = document.getElementById('connect-status')
  const connectButton = document.getElementById('connect-wallet')

  const showConnect = () => {
    if (loadingScreen) loadingScreen.style.display = 'none'
    connectScreen.style.display = 'flex'
    connectStatus.textContent = ''
    connectStatus.innerHTML = ''
    connectButton.disabled = false
    connectButton.textContent = '🎮 Connect Wallet'
  }

  // Solo intentar si el usuario ya había hecho login antes
  const hadSession = loadLastSession()
  if (!hadSession?.address) { showConnect(); return }

  const c = ensureController()
  if (!c) { showConnect(); return }

  try {
    // probe() = restauración completamente silenciosa, sin abrir ningún popup ni modal
    const account = await withTimeout(c.probe(), 8000, 'session restore')
    if (account) {
      try {
        await enterApp(account)
        return
      } catch (e) {
        console.warn('enterApp restore failed:', e?.message || e)
      }
    }
  } catch (e) {
    console.warn('probe() restore failed:', e?.message || e)
  }

  showConnect()
}

function setupUIHandlers() {
  if (uiHandlersInitialized) return
  uiHandlersInitialized = true

  const modal = document.getElementById('modal')
  const postForm = document.getElementById('postForm')
  const imageFileInput = document.getElementById('imageFile')
  const imageFileCameraInput = document.getElementById('imageFileCamera')
  const imageDataUrlInput = document.getElementById('imageDataUrl')
  const captionInput = document.getElementById('caption')
  const postSizeInput = document.getElementById('postSize')
  const isPaidInput = document.getElementById('isPaid')
  const isAuctionInput = document.getElementById('isAuction')
  const auctionEndAtInput = document.getElementById('auctionEndAt')
  const auctionCommitEndAtInput = document.getElementById('auctionCommitEndAt')
  const auctionRevealEndAtInput = document.getElementById('auctionRevealEndAt')
  const sealedAuctionOptions = document.getElementById('sealedAuctionOptions')
  const auctionEndPreview = document.getElementById('auctionEndPreview')
  const photoPreview = document.getElementById('photoPreview')
  const photoPlaceholder = document.getElementById('photoPlaceholder')
  const photoPreviewImg = document.getElementById('photoPreviewImg')
  const btnChoosePhoto = document.getElementById('btnChoosePhoto')
  const btnGallery = document.getElementById('btnGallery')
  const removePhotoBtn = document.getElementById('removePhoto')
  const submitPostBtn = document.getElementById('submitPostBtn')
  const paidPostOptions = document.getElementById('paidPostOptions')
  const auctionPostOptions = document.getElementById('auctionPostOptions')
  const paidPostPriceEl = document.getElementById('paidPostPrice')
  const postSizeRadios = document.querySelectorAll('input[name="postSizeRadio"]')
  const auctionModeRadios = document.querySelectorAll('input[name="auctionModeRadio"]')
  const SEALED_REVEAL_WINDOW_SECONDS = 6 * 60 * 60 // 6 hours reveal window before auction end
  const SEALED_MIN_COMMIT_SECONDS = 6 * 60
  const SEALED_MIN_REVEAL_SECONDS = 2 * 60
  const SEALED_MIN_TOTAL_SECONDS = SEALED_MIN_COMMIT_SECONDS + SEALED_MIN_REVEAL_SECONDS
  if (!hasSealedBidInManifest) {
    auctionModeRadios.forEach((r) => {
      if (r.value === 'sealed') {
        if (r.parentElement) r.parentElement.style.display = 'none'
        r.checked = false
      }
      if (r.value === 'public') r.checked = true
    })
  }

  const addPostBtn = document.getElementById('addPost')
  const addPaidPostBtn = document.getElementById('addPaidPost')
  const addAuctionPostBtn = document.getElementById('addAuctionPost')
  const mobileCreateWrap = document.getElementById('mobileCreateWrap')
  const mobileCreateBtn = document.getElementById('mobileCreateBtn')
  const mobileCreateFreeBtn = document.getElementById('mobileCreateFreeBtn')
  const mobileCreatePaidBtn = document.getElementById('mobileCreatePaidBtn')
  const mobileCreateAuctionBtn = document.getElementById('mobileCreateAuctionBtn')
  const cancelPostBtn = document.getElementById('cancelPost')

  const sendStrkModal = document.getElementById('sendStrkModal')
  const sendStrkForm = document.getElementById('sendStrkForm')
  const sendStrkRecipient = document.getElementById('sendStrkRecipient')
  const sendStrkAmount = document.getElementById('sendStrkAmount')
  const cancelSendStrkBtn = document.getElementById('cancelSendStrkBtn')
  const confirmSendStrkBtn = document.getElementById('confirmSendStrkBtn')
  const swapWbtcModal = document.getElementById('swapWbtcModal')
  const swapWbtcForm = document.getElementById('swapWbtcForm')
  const swapSellToken = document.getElementById('swapSellToken')
  const swapBuyToken = document.getElementById('swapBuyToken')
  const swapWbtcAmount = document.getElementById('swapWbtcAmount')
  const swapWbtcEstimate = document.getElementById('swapWbtcEstimate')
  const swapWbtcBalanceHint = document.getElementById('swapWbtcBalanceHint')
  const cancelSwapWbtcBtn = document.getElementById('cancelSwapWbtcBtn')
  const confirmSwapWbtcBtn = document.getElementById('confirmSwapWbtcBtn')
  let swapQuoteRequestId = 0
  let swapQuoteDebounceTimer = null
  let createPostInFlight = false
  let sealedVerifierProbe = { address: '', ok: null, reason: '' }

  function updatePaidPriceLabel() {
    const size = parseInt(postSizeInput.value) || 2
    const price = PostManager.getPriceForPaidPost(size)
    paidPostPriceEl.textContent = `${price} STRK`
    if (isPaidInput.value === 'true') {
      submitPostBtn.textContent = `Create Paid Post (${price} STRK)`
    }
  }

  function formatRemaining(seconds) {
    const total = Math.max(0, Number(seconds || 0))
    const days = Math.floor(total / 86400)
    const hours = Math.floor((total % 86400) / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    if (days > 0) return `${days}d ${hours}h ${minutes}m`
    return `${hours}h ${minutes}m`
  }

  function updateAuctionEndPreview() {
    if (!auctionEndPreview) return
    const isSealedMode = getAuctionMode() === 'sealed'
    const raw = String(auctionEndAtInput?.value || '')
    const endMs = Date.parse(raw)
    if (!raw || !Number.isFinite(endMs)) {
      auctionEndPreview.textContent = isSealedMode
        ? 'Displayed in your local timezone and UTC. Sealed mode needs at least 8 minutes from now.'
        : 'Displayed in your local timezone and UTC.'
      return
    }

    const nowUnix = Math.floor(Date.now() / 1000)
    const endUnix = Math.floor(endMs / 1000)
    const endDate = new Date(endMs)
    const localLabel = endDate.toLocaleString()
    const utcLabel = endDate.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    const remaining = formatRemaining(Math.floor((endMs - Date.now()) / 1000))
    const base = `Ends (local): ${localLabel} | Ends (UTC): ${utcLabel} | Remaining: ${remaining}`
    if (!isSealedMode) {
      auctionEndPreview.textContent = base
      return
    }

    const minEndUnix = nowUnix + SEALED_MIN_TOTAL_SECONDS
    const minEndDate = new Date(minEndUnix * 1000)
    const minLocal = minEndDate.toLocaleString()
    const minUtc = minEndDate.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    if (endUnix < minEndUnix) {
      const shortBy = formatRemaining(minEndUnix - endUnix)
      auctionEndPreview.textContent = `${base} | Too early for sealed by ${shortBy}. Minimum: ${minLocal} (${minUtc})`
      return
    }
    auctionEndPreview.textContent = `${base} | Sealed minimum satisfied`
  }

  function toDatetimeLocalValue(unixSeconds) {
    const d = new Date(Number(unixSeconds || 0) * 1000)
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  }

  function deriveSealedTimeline(revealEndUnix, nowUnix = Math.floor(Date.now() / 1000)) {
    const remaining = Math.max(0, revealEndUnix - nowUnix)
    const dynamicRevealWindow = Math.floor(remaining * 0.2) // 20% reveal, 80% commit for better bidding UX.
    const revealWindow = Math.min(
      SEALED_REVEAL_WINDOW_SECONDS,
      Math.max(SEALED_MIN_REVEAL_SECONDS, dynamicRevealWindow),
    )
    const minCommitFromNow = nowUnix + SEALED_MIN_COMMIT_SECONDS
    const latestCommitAllowed = revealEndUnix - SEALED_MIN_REVEAL_SECONDS
    const preferredCommit = revealEndUnix - revealWindow
    const commitEndUnix = Math.min(latestCommitAllowed, Math.max(minCommitFromNow, preferredCommit))
    return { commitEndUnix, revealEndUnix }
  }

  function syncSealedTimelineFromAuctionEnd() {
    if (getAuctionMode() !== 'sealed') return
    const endRaw = String(auctionEndAtInput?.value || '')
    const endMs = Date.parse(endRaw)
    if (!Number.isFinite(endMs)) return
    const revealEndUnix = Math.floor(endMs / 1000)
    const { commitEndUnix } = deriveSealedTimeline(revealEndUnix)
    if (auctionCommitEndAtInput) auctionCommitEndAtInput.value = toDatetimeLocalValue(commitEndUnix)
    if (auctionRevealEndAtInput) auctionRevealEndAtInput.value = toDatetimeLocalValue(revealEndUnix)
  }

  function getAuctionMode() {
    if (!hasSealedBidInManifest) return 'public'
    const selected = [...auctionModeRadios].find((r) => r.checked)
    return selected?.value === 'sealed' ? 'sealed' : 'public'
  }

  function updateSealedAuctionVisibility() {
    const sealed = getAuctionMode() === 'sealed'
    if (sealedAuctionOptions) sealedAuctionOptions.style.display = sealed ? 'block' : 'none'
    if (!sealed) return
    // Keep sealed timeline deterministic from auction end to avoid misconfiguration.
    if (auctionCommitEndAtInput) auctionCommitEndAtInput.readOnly = true
    if (auctionRevealEndAtInput) auctionRevealEndAtInput.readOnly = true
    syncSealedTimelineFromAuctionEnd()
  }

  function setCreateMode(mode) {
    const isPaid = mode === 'paid'
    const isAuction = mode === 'auction'
    isPaidInput.value = isPaid ? 'true' : 'false'
    if (isAuctionInput) isAuctionInput.value = isAuction ? 'true' : 'false'

    paidPostOptions.style.display = isPaid ? 'block' : 'none'
    if (auctionPostOptions) auctionPostOptions.style.display = isAuction ? 'block' : 'none'

    if (isPaid) {
      postSizeInput.value = '2'
      postSizeRadios.forEach((r) => { r.checked = r.value === '2' })
      updatePaidPriceLabel()
    } else {
      postSizeInput.value = '1'
      postSizeRadios.forEach((r) => { r.checked = false })
    }

    if (isAuction) {
      submitPostBtn.textContent = `Create Auction Post (3x3 · ${AUCTION_POST_CREATION_FEE_STRK} STRK)`
      if (auctionEndAtInput && !auctionEndAtInput.value) {
        const d = new Date(Date.now() + 24 * 60 * 60 * 1000)
        d.setMinutes(0, 0, 0)
        auctionEndAtInput.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      }
      updateAuctionEndPreview()
      updateSealedAuctionVisibility()
    } else if (!isPaid) {
      submitPostBtn.textContent = 'Create Post'
      if (auctionEndPreview) auctionEndPreview.textContent = 'Displayed in your local timezone and UTC.'
      if (sealedAuctionOptions) sealedAuctionOptions.style.display = 'none'
    }
  }

  const webcamModal = document.getElementById('webcamModal')
  const webcamVideo = document.getElementById('webcamVideo')
  const webcamCaptureBtn = document.getElementById('webcamCapture')
  const webcamCancelBtn = document.getElementById('webcamCancel')
  let webcamStream = null

  function setPhotoFromDataUrl(dataUrl) {
    if (!dataUrl) return

    const chunks = byteArrayChunkCount(dataUrl)
    if (chunks > CONTRACT_SAFE_MAX_CHUNKS_PER_FIELD) {
      alert(`Image still too heavy for on-chain storage (${chunks} chunks). Try another image.`)
      return
    }

    imageDataUrlInput.value = dataUrl
    photoPreviewImg.src = dataUrl
    photoPlaceholder.style.display = 'none'
    photoPreview.style.display = 'flex'
    submitPostBtn.disabled = false
  }

  function setPhotoFromFile(file) {
    if (!file || !file.type.startsWith('image/')) return
    resizeImageToDataUrlWithMaxLength(file)
      .then(setPhotoFromDataUrl)
      .catch((err) => {
        console.error(err)
        alert('No se pudo procesar la imagen. Prueba con otra.')
      })
  }

  function closeWebcam() {
    if (webcamStream) {
      webcamStream.getTracks().forEach((t) => t.stop())
      webcamStream = null
    }
    webcamModal.classList.remove('active')
  }

  function openWebcam() {
    webcamModal.classList.add('active')
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 393 }, height: { ideal: 852 } } })
      .then((stream) => {
        webcamStream = stream
        webcamVideo.srcObject = stream
      })
      .catch((err) => {
        console.error(err)
        alert('No se pudo acceder a la cámara. Comprueba los permisos del navegador o usa Galería.')
        closeWebcam()
      })
  }

  webcamCaptureBtn.addEventListener('click', () => {
    const video = webcamVideo
    if (!video.srcObject || video.readyState < 2) return
    const canvas = document.createElement('canvas')
    canvas.width = 393
    canvas.height = 852
    const ctx = canvas.getContext('2d')
    const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight)
    const w = video.videoWidth * scale
    const h = video.videoHeight * scale
    ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h)
    const rawDataUrl = canvas.toDataURL('image/jpeg', 0.65)
    // Recompress to fit contract limit (max 300*31 bytes per ByteArray)
    resizeImageToDataUrlWithMaxLength(rawDataUrl)
      .then((dataUrl) => {
        setPhotoFromDataUrl(dataUrl)
        closeWebcam()
      })
      .catch(() => {
        setPhotoFromDataUrl(rawDataUrl)
        closeWebcam()
      })
  })
  webcamCancelBtn.addEventListener('click', closeWebcam)
  webcamModal.addEventListener('click', (e) => {
    if (e.target === webcamModal) closeWebcam()
  })

  function clearPhoto() {
    imageDataUrlInput.value = ''
    imageFileInput.value = ''
    imageFileCameraInput.value = ''
    photoPreviewImg.src = ''
    photoPlaceholder.style.display = 'flex'
    photoPreview.style.display = 'none'
    submitPostBtn.disabled = true
  }

  function openSendStrkModal() {
    if (!sendStrkModal) return
    sendStrkForm?.reset()
    sendStrkModal.classList.add('active')
    setTimeout(() => sendStrkRecipient?.focus(), 0)
  }

  function closeSendStrkModal() {
    sendStrkModal?.classList.remove('active')
  }

  function getSwapPairConfig() {
    const sellSymbol = String(swapSellToken?.value || 'STRK').toUpperCase()
    const buySymbol = String(swapBuyToken?.value || 'WBTC').toUpperCase()
    const tokenBySymbol = {
      STRK: PAYMENT_TOKEN_ADDRESS,
      WBTC: SEPOLIA_BTC_SWAP_TOKEN,
    }
    return {
      sellSymbol,
      buySymbol,
      sellTokenAddress: tokenBySymbol[sellSymbol] || PAYMENT_TOKEN_ADDRESS,
      buyTokenAddress: tokenBySymbol[buySymbol] || SEPOLIA_BTC_SWAP_TOKEN,
    }
  }

  function isSupportedSwapPair(sellSymbol, buySymbol) {
    const s = String(sellSymbol || '').toUpperCase()
    const b = String(buySymbol || '').toUpperCase()
    return (s === 'STRK' && b === 'WBTC') || (s === 'WBTC' && b === 'STRK')
  }

  async function refreshSwapEstimate() {
    if (!swapWbtcEstimate || !swapWbtcAmount || !dojoManager || !currentAccount) return false
    if (!swapWbtcModal?.classList.contains('active')) return false
    const cfg = getSwapPairConfig()
    if (cfg.sellSymbol === cfg.buySymbol) {
      swapWbtcEstimate.textContent = 'Select different tokens for swap.'
      return false
    }
    if (!isSupportedSwapPair(cfg.sellSymbol, cfg.buySymbol)) {
      swapWbtcEstimate.textContent = 'Supported pair: STRK ↔ WBTC (Sepolia).'
      return false
    }
    const amount = Number(swapWbtcAmount.value || 0)
    if (!Number.isFinite(amount) || amount <= 0) {
      swapWbtcEstimate.textContent = `Estimated receive: - ${cfg.buySymbol}`
      return false
    }
    const requestId = ++swapQuoteRequestId
    swapWbtcEstimate.textContent = 'Estimating...'
    try {
      const quote = await dojoManager.getTokenSwapQuote(cfg.sellTokenAddress, cfg.buyTokenAddress, amount)
      if (requestId !== swapQuoteRequestId) return false
      const receive = Number(quote?.estimatedBuyAmount ?? 0)
      const gas = Number(quote?.estimatedGasFeeStrk || 0)
      const impactBps = Number(quote?.priceImpactBps || 0)
      if (!Number.isFinite(receive) || receive <= 0) {
        swapWbtcEstimate.textContent = buildNoRouteHint(cfg.sellSymbol, cfg.buySymbol)
        return false
      }
      swapWbtcEstimate.textContent =
        `Estimated receive: ${receive.toFixed(6)} ${cfg.buySymbol} · Gas: ~${gas.toFixed(6)} STRK · Impact: ${(impactBps / 100).toFixed(2)}%`
      return true
    } catch (error) {
      if (requestId !== swapQuoteRequestId) return false
      swapWbtcEstimate.textContent = isNoSwapRouteError(error)
        ? buildNoRouteHint(cfg.sellSymbol, cfg.buySymbol)
        : String(error?.message || 'Could not fetch quote right now.')
      return false
    }
  }

  function scheduleSwapEstimateRefresh() {
    if (!swapWbtcModal?.classList.contains('active')) return
    if (swapQuoteDebounceTimer) clearTimeout(swapQuoteDebounceTimer)
    swapQuoteDebounceTimer = setTimeout(() => {
      void refreshSwapEstimate()
    }, 350)
  }

  async function openSwapWbtcModal() {
    if (!swapWbtcModal || !swapWbtcForm || !dojoManager || !currentAccount) return
    if (!IS_SEPOLIA) {
      alert('Token swap is currently enabled on Sepolia only.')
      return
    }
    swapWbtcForm.reset()
    if (swapSellToken) swapSellToken.value = 'STRK'
    if (swapBuyToken) swapBuyToken.value = 'WBTC'
    swapQuoteRequestId += 1
    const cfg = getSwapPairConfig()
    if (swapWbtcEstimate) swapWbtcEstimate.textContent = `Estimated receive: - ${cfg.buySymbol}`
    if (swapWbtcBalanceHint) {
      swapWbtcBalanceHint.textContent = `Loading ${cfg.sellSymbol} balance...`
      const balance = await dojoManager.getTokenBalance(currentAccount.address, cfg.sellTokenAddress).catch(() => 0)
      swapWbtcBalanceHint.textContent = `Available: ${Number(balance || 0).toFixed(6)} ${cfg.sellSymbol}`
    }
    swapWbtcModal.classList.add('active')
    setTimeout(() => swapWbtcAmount?.focus(), 0)
  }

  function closeSwapWbtcModal() {
    if (swapQuoteDebounceTimer) clearTimeout(swapQuoteDebounceTimer)
    swapWbtcModal?.classList.remove('active')
  }

  // Expose modal open actions for wallet-info dynamic buttons rendered outside this scope.
  if (!walletModalEventsBound) {
    window.addEventListener('starkwall:open-send-strk', openSendStrkModal)
    window.addEventListener('starkwall:open-swap-strk-wbtc', () => {
      void openSwapWbtcModal()
    })
    walletModalEventsBound = true
  }

  document.getElementById('btnWebcam').addEventListener('click', openWebcam)
  btnGallery.addEventListener('click', () => imageFileInput.click())
  imageFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0]
    setPhotoFromFile(file)
  })
  imageFileCameraInput.addEventListener('change', (e) => {
    const file = e.target.files[0]
    setPhotoFromFile(file)
  })
  if (auctionEndAtInput) {
    auctionEndAtInput.addEventListener('input', updateAuctionEndPreview)
    auctionEndAtInput.addEventListener('change', updateAuctionEndPreview)
    auctionEndAtInput.addEventListener('input', syncSealedTimelineFromAuctionEnd)
    auctionEndAtInput.addEventListener('change', syncSealedTimelineFromAuctionEnd)
  }
  auctionModeRadios.forEach((radio) => {
    radio.addEventListener('change', updateSealedAuctionVisibility)
  })
  if (auctionCommitEndAtInput) {
    auctionCommitEndAtInput.addEventListener('input', updateSealedAuctionVisibility)
    auctionCommitEndAtInput.addEventListener('change', updateSealedAuctionVisibility)
  }
  if (auctionRevealEndAtInput) {
    auctionRevealEndAtInput.addEventListener('input', updateSealedAuctionVisibility)
    auctionRevealEndAtInput.addEventListener('change', updateSealedAuctionVisibility)
  }
  removePhotoBtn.addEventListener('click', clearPhoto)
  // En desktop ya no usamos el input con capture; Cámara abre la webcam
  // (imageFileCameraInput se mantiene por si en móvil quieres priorizar cámara nativa)

  addPostBtn.addEventListener('click', () => {
    setCreateMode('free')
    clearPhoto()
    modal.classList.add('active')
  })

  addPaidPostBtn.addEventListener('click', () => {
    setCreateMode('paid')
    clearPhoto()
    modal.classList.add('active')
  })

  if (addAuctionPostBtn) {
    addAuctionPostBtn.addEventListener('click', () => {
      setCreateMode('auction')
      clearPhoto()
      modal.classList.add('active')
    })
  }

  if (mobileCreateBtn && mobileCreateWrap) {
    mobileCreateBtn.onclick = (e) => {
      e.stopPropagation()
      mobileCreateWrap.classList.toggle('open')
    }
  }
  if (mobileCreateFreeBtn && mobileCreateWrap) {
    mobileCreateFreeBtn.onclick = () => {
      mobileCreateWrap.classList.remove('open')
      addPostBtn?.click()
    }
  }
  if (mobileCreatePaidBtn && mobileCreateWrap) {
    mobileCreatePaidBtn.onclick = () => {
      mobileCreateWrap.classList.remove('open')
      addPaidPostBtn?.click()
    }
  }
  if (mobileCreateAuctionBtn && mobileCreateWrap) {
    mobileCreateAuctionBtn.onclick = () => {
      mobileCreateWrap.classList.remove('open')
      addAuctionPostBtn?.click()
    }
  }
  if (mobileCreateWrap) {
    document.addEventListener('click', (e) => {
      if (!mobileCreateWrap.contains(e.target)) {
        mobileCreateWrap.classList.remove('open')
      }
    })
  }

  if (cancelSendStrkBtn) {
    cancelSendStrkBtn.addEventListener('click', closeSendStrkModal)
  }

  if (sendStrkModal) {
    sendStrkModal.addEventListener('click', (e) => {
      if (e.target === sendStrkModal) closeSendStrkModal()
    })
  }
  if (swapWbtcModal) {
    swapWbtcModal.addEventListener('click', (e) => {
      if (e.target === swapWbtcModal) closeSwapWbtcModal()
    })
  }
  if (cancelSwapWbtcBtn) {
    cancelSwapWbtcBtn.addEventListener('click', closeSwapWbtcModal)
  }
  if (swapWbtcAmount) {
    swapWbtcAmount.addEventListener('input', scheduleSwapEstimateRefresh)
    swapWbtcAmount.addEventListener('change', scheduleSwapEstimateRefresh)
  }
  const onSwapTokenSelectionChange = async () => {
    if (swapSellToken && swapBuyToken && swapSellToken.value === swapBuyToken.value) {
      swapBuyToken.value = swapSellToken.value === 'STRK' ? 'WBTC' : 'STRK'
    }
    const cfg = getSwapPairConfig()
    if (!swapWbtcModal?.classList.contains('active')) return
    if (swapWbtcBalanceHint && dojoManager && currentAccount) {
      if (cfg.sellSymbol === cfg.buySymbol) {
        swapWbtcBalanceHint.textContent = 'Select different tokens for swap.'
      } else {
        swapWbtcBalanceHint.textContent = `Loading ${cfg.sellSymbol} balance...`
        const balance = await dojoManager.getTokenBalance(currentAccount.address, cfg.sellTokenAddress).catch(() => 0)
        swapWbtcBalanceHint.textContent = `Available: ${Number(balance || 0).toFixed(6)} ${cfg.sellSymbol}`
      }
    }
    if (swapWbtcEstimate) {
      swapWbtcEstimate.textContent = cfg.sellSymbol === cfg.buySymbol
        ? 'Select different tokens for swap.'
        : `Estimated receive: - ${cfg.buySymbol}`
    }
    scheduleSwapEstimateRefresh()
  }
  if (swapSellToken) swapSellToken.addEventListener('change', () => { void onSwapTokenSelectionChange() })
  if (swapBuyToken) swapBuyToken.addEventListener('change', () => { void onSwapTokenSelectionChange() })

  if (sendStrkForm) sendStrkForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (!dojoManager || !currentAccount) return

    const recipient = String(sendStrkRecipient?.value || '').trim()
    const amount = Number(sendStrkAmount?.value || 0)

    if (!recipient.startsWith('0x')) {
      alert('Invalid recipient address. Use 0x...')
      return
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      alert('Invalid amount.')
      return
    }

    const senderBalance = await getChainBalance(currentAccount.address)
    if (senderBalance < amount) {
      alert(`Insufficient balance. You have ${senderBalance} STRK and need ${amount} STRK.`)
      return
    }

    if (confirmSendStrkBtn) {
      confirmSendStrkBtn.disabled = true
      confirmSendStrkBtn.textContent = 'Sending...'
    }

    try {
      await dojoManager.sendStrk(recipient, amount)
      closeSendStrkModal()
      await updateWalletInfo()
      showToast(`Sent ${amount} STRK`)
    } catch (error) {
      console.error('Send STRK error:', error)
      alert('Failed to send STRK: ' + (error?.message || 'Unknown error'))
    } finally {
      if (confirmSendStrkBtn) {
        confirmSendStrkBtn.disabled = false
        confirmSendStrkBtn.textContent = 'Send'
      }
    }
  })

  if (swapWbtcForm) swapWbtcForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (!dojoManager || !currentAccount || !swapWbtcAmount) return
    const cfg = getSwapPairConfig()
    if (cfg.sellSymbol === cfg.buySymbol) {
      alert('Choose different tokens for swap.')
      return
    }
    if (!isSupportedSwapPair(cfg.sellSymbol, cfg.buySymbol)) {
      alert('Supported pair on this flow: STRK ↔ WBTC (Sepolia).')
      return
    }
    const amount = Number(swapWbtcAmount.value || 0)
    if (!Number.isFinite(amount) || amount <= 0) {
      alert(`Invalid ${cfg.sellSymbol} amount.`)
      return
    }

    const sourceBalance = await dojoManager.getTokenBalance(currentAccount.address, cfg.sellTokenAddress).catch(() => 0)
    if (Number(sourceBalance || 0) < amount) {
      alert(`Insufficient ${cfg.sellSymbol}. You have ${Number(sourceBalance || 0).toFixed(6)} ${cfg.sellSymbol}.`)
      return
    }

    try {
      await runWithBusyButton(confirmSwapWbtcBtn, {
        idleText: 'Swap',
        busyText: 'Swapping...',
        pendingToast: `Confirm ${cfg.sellSymbol} -> ${cfg.buySymbol} swap in wallet...`,
      }, async () => {
        console.info('[Swap] Start', {
          user: currentAccount.address,
          sellToken: cfg.sellSymbol,
          buyToken: cfg.buySymbol,
          amount,
        })
        let estimatedBuyAmount = 0
        try {
          const quotePreview = await dojoManager.getTokenSwapQuote(cfg.sellTokenAddress, cfg.buyTokenAddress, amount)
          estimatedBuyAmount = Number(quotePreview?.estimatedBuyAmount || 0)
        } catch {
          // continue; swapTokens will run its own quote call and fail with normalized message if needed.
        }

        const tx = await dojoManager.swapTokens(cfg.sellTokenAddress, cfg.buyTokenAddress, amount, 1)
        const txHash = String(tx?.transaction_hash || '')
        addActivityEvent({
          actionType: 'swap',
          token: cfg.buySymbol,
          amount,
          providerPath: 'avnu',
          txHash,
          status: 'success',
          details: {
            sellToken: cfg.sellSymbol,
            buyToken: cfg.buySymbol,
            estimatedBuyAmount,
          },
        })
        console.info('[Swap] Success', {
          user: currentAccount.address,
          sellToken: cfg.sellSymbol,
          buyToken: cfg.buySymbol,
          amount,
          txHash,
        })
        closeSwapWbtcModal()
        await updateWalletInfo()
        const txLabel = shortTxHash(txHash)
        showToast(`Converted ${amount} ${cfg.sellSymbol} to ${cfg.buySymbol}${txLabel ? ` · ${txLabel}` : ''}`)
      })
    } catch (error) {
      console.error('Token swap error:', error)
      addActivityEvent({
        actionType: 'swap',
        token: cfg.buySymbol,
        amount,
        providerPath: 'avnu',
        txHash: '',
        status: 'failed',
        errorMessage: String(error?.message || 'Unknown error'),
        details: {
          sellToken: cfg.sellSymbol,
          buyToken: cfg.buySymbol,
        },
      })
      if (isNoSwapRouteError(error)) {
        if (swapWbtcEstimate) swapWbtcEstimate.textContent = buildNoRouteHint(cfg.sellSymbol, cfg.buySymbol)
        showToast(buildNoRouteHint(cfg.sellSymbol, cfg.buySymbol))
      } else {
        alert(`Failed to convert ${cfg.sellSymbol} to ${cfg.buySymbol}: ` + (error?.message || 'Unknown error'))
      }
    }
  })

  postSizeRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      postSizeInput.value = radio.value
      updatePaidPriceLabel()
    })
  })

  cancelPostBtn.addEventListener('click', () => {
    modal.classList.remove('active')
    postForm.reset()
    clearPhoto()
    paidPostOptions.style.display = 'none'
    if (auctionPostOptions) auctionPostOptions.style.display = 'none'
    if (sealedAuctionOptions) sealedAuctionOptions.style.display = 'none'
    auctionModeRadios.forEach((r) => { r.checked = r.value === 'public' })
    if (isAuctionInput) isAuctionInput.value = 'false'
    submitPostBtn.textContent = 'Create Post'
  })

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.remove('active')
      postForm.reset()
      clearPhoto()
      paidPostOptions.style.display = 'none'
      if (auctionPostOptions) auctionPostOptions.style.display = 'none'
      if (sealedAuctionOptions) sealedAuctionOptions.style.display = 'none'
      auctionModeRadios.forEach((r) => { r.checked = r.value === 'public' })
      if (isAuctionInput) isAuctionInput.value = 'false'
      submitPostBtn.textContent = 'Create Post'
    }
  })

  function truncateToMaxBytes(str, maxBytes = CONTRACT_MAX_BYTES_PER_FIELD - 100) {
    const encoder = new TextEncoder()
    if (encoder.encode(str).length <= maxBytes) return str
    let s = str
    while (encoder.encode(s).length > maxBytes && s.length > 0) s = s.slice(0, -1)
    return s
  }

  postForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (createPostInFlight) {
      showToast('Creation already in progress...')
      return
    }
    createPostInFlight = true
    try {

    const imageUrl = imageDataUrlInput.value
    const caption = truncateToMaxBytes(captionInput.value)
    const username = truncateToMaxBytes(currentUsername || 'user')
    const size = parseInt(postSizeInput.value) || 1
    const isPaid = isPaidInput.value === 'true'
    const isAuction = isAuctionInput?.value === 'true'

    if (!imageUrl) {
      alert('Elige una foto para tu post.')
      return
    }

    const imageChunks = byteArrayChunkCount(imageUrl)
    if (imageChunks > CONTRACT_SAFE_MAX_CHUNKS_PER_FIELD) {
      alert(`Image too large for on-chain post (${imageChunks} chunks). Pick a lighter image.`)
      return
    }

    if (isPaid) {
      if (!currentAccount) return
      const price = PostManager.getPriceForPaidPost(size)
      const balanceActual = await getChainBalance(currentAccount.address)
      if (balanceActual < price) {
        if (IS_SEPOLIA) {
          alert(`Saldo insuficiente. Necesitas ${price} STRK y tienes ${balanceActual} STRK en Sepolia.`)
        } else {
          alert(`Saldo insuficiente. Necesitas ${price} STRK y tienes ${balanceActual} STRK. Haz clic en "Obtener STRK" si no tienes fondos.`)
        }
        return
      }
    }

    if (isAuction) {
      if (!currentAccount) return
      const balanceActual = await getChainBalance(currentAccount.address)
      if (balanceActual < AUCTION_POST_CREATION_FEE_STRK) {
        if (IS_SEPOLIA) {
          alert(`Insufficient balance. You need ${AUCTION_POST_CREATION_FEE_STRK} STRK to create an auction and you have ${balanceActual} STRK.`)
        } else {
          alert(`Insufficient balance. You need ${AUCTION_POST_CREATION_FEE_STRK} STRK to create an auction and you have ${balanceActual} STRK. Click "Obtener STRK" if needed.`)
        }
        return
      }
    }

    let auctionEndUnix = 0
    let sealedAuctionConfig = null
    if (isAuction) {
      const auctionMode = getAuctionMode()
      const endRaw = String(auctionEndAtInput?.value || '')
      if (!endRaw) {
        alert('Please choose auction end date/time.')
        return
      }
      const endMs = Date.parse(endRaw)
      if (!Number.isFinite(endMs)) {
        alert('Invalid auction end date/time.')
        return
      }
      auctionEndUnix = Math.floor(endMs / 1000)
      if (auctionEndUnix <= Math.floor(Date.now() / 1000) + 60) {
        alert('Auction end time must be at least 1 minute in the future.')
        return
      }

      if (auctionMode === 'sealed') {
        if (!SEALED_BID_VERIFIER_ADDRESS) {
          alert('Missing sealed bid verifier address. Set VITE_SEALED_BID_VERIFIER_ADDRESS.')
          return
        }
        const verifierAddr = normalizeStarknetAddress(SEALED_BID_VERIFIER_ADDRESS)
        if (sealedVerifierProbe.address !== verifierAddr || sealedVerifierProbe.ok === null) {
          const probe = await dojoManager.checkSealedVerifierCompatibility(verifierAddr).catch((error) => ({
            ok: false,
            reason: String(error?.message || error || 'Verifier probe failed'),
          }))
          sealedVerifierProbe = {
            address: verifierAddr,
            ok: Boolean(probe?.ok),
            reason: String(probe?.reason || ''),
          }
        }
        if (!sealedVerifierProbe.ok) {
          alert(
            `Sealed verifier misconfigured.\n\n` +
            `This auction would not be able to reveal a winner.\n` +
            `Verifier: ${verifierAddr}\n` +
            `Reason: ${sealedVerifierProbe.reason || 'Incompatible contract ABI'}\n\n` +
            `Please set a compatible VITE_SEALED_BID_VERIFIER_ADDRESS before creating sealed auctions.`
          )
          return
        }
        // Sealed timeline is fully derived from auction end.
        const nowUnix = Math.floor(Date.now() / 1000)
        const minEndUnix = nowUnix + SEALED_MIN_TOTAL_SECONDS
        if (auctionEndUnix < minEndUnix) {
          const minDate = new Date(minEndUnix * 1000)
          const minLocal = minDate.toLocaleString()
          const minUtc = minDate.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
          const shortBy = formatRemaining(minEndUnix - auctionEndUnix)
          const shouldAutoAdjust = confirm(
            `Sealed auction end is too soon by ${shortBy}.\n\n` +
            `Minimum required end:\n` +
            `- Local: ${minLocal}\n` +
            `- UTC: ${minUtc}\n\n` +
            'Auto-adjust end time to this minimum now?'
          )
          if (shouldAutoAdjust && auctionEndAtInput) {
            auctionEndAtInput.value = toDatetimeLocalValue(minEndUnix)
            syncSealedTimelineFromAuctionEnd()
            updateAuctionEndPreview()
          }
          return
        }
        const { commitEndUnix, revealEndUnix } = deriveSealedTimeline(auctionEndUnix, nowUnix)
        if (revealEndUnix < nowUnix + SEALED_MIN_TOTAL_SECONDS) {
          alert('Sealed auction end must be at least 8 minutes from now.')
          return
        }
        if (revealEndUnix < commitEndUnix + SEALED_MIN_REVEAL_SECONDS) {
          alert('Reveal end must be after commit end.')
          return
        }
        sealedAuctionConfig = {
          sealed: true,
          commitEndTimeUnix: commitEndUnix,
          revealEndTimeUnix: revealEndUnix,
          verifier: SEALED_BID_VERIFIER_ADDRESS,
        }
        auctionEndUnix = revealEndUnix
      }
    }

    submitPostBtn.disabled = true
    const previousBtnText = submitPostBtn.textContent
    submitPostBtn.textContent = isAuction ? 'Creating auction...' : 'Creando...'
    try {
      if (isAuction) {
        await postManager.createAuctionPost(imageUrl, caption, username, auctionEndUnix, () => {
          document.getElementById('modal').classList.remove('active')
          postForm.reset()
          clearPhoto()
          paidPostOptions.style.display = 'none'
          if (auctionPostOptions) auctionPostOptions.style.display = 'none'
          if (sealedAuctionOptions) sealedAuctionOptions.style.display = 'none'
          auctionModeRadios.forEach((r) => { r.checked = r.value === 'public' })
          if (isAuctionInput) isAuctionInput.value = 'false'
          submitPostBtn.disabled = false
          submitPostBtn.textContent = 'Create Post'
          updateWalletInfo().catch(() => {})
        }, sealedAuctionConfig)
      } else {
        await postManager.createPost(imageUrl, caption, username, size, isPaid, () => {
          document.getElementById('modal').classList.remove('active')
          postForm.reset()
          clearPhoto()
          paidPostOptions.style.display = 'none'
          submitPostBtn.disabled = false
          submitPostBtn.textContent = 'Create Post'
          updateWalletInfo().catch(() => {})
        })
      }
    } catch (error) {
      console.error('Error creating post:', error)
      alert('No se pudo crear el post: ' + (error?.message || error || 'Unknown error'))
      submitPostBtn.disabled = false
      if (isAuction) {
        submitPostBtn.textContent = `Create Auction Post (3x3 · ${AUCTION_POST_CREATION_FEE_STRK} STRK)`
      } else {
        submitPostBtn.textContent = isPaid ? `Create Paid Post (${PostManager.getPriceForPaidPost(size)} STRK)` : 'Create Post'
      }
    }
    } finally {
      createPostInFlight = false
    }
  })
  const faucetBtn = document.getElementById('faucet-btn')
  if (faucetBtn && IS_SEPOLIA) {
    // Faucet is local-only; hide in production deployments.
    faucetBtn.style.display = 'none'
  }

  if (faucetBtn && !IS_SEPOLIA) faucetBtn.addEventListener('click', async () => {
    if (!currentAccount) return
    faucetBtn.disabled = true
    faucetBtn.textContent = '...'
    try {
      const res = await fetch(FAUCET_URL + '/faucet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: currentAccount.address }),
      })
      const data = await res.json()
      if (data.ok) {
        showToast('¡1000 STRK recibidos!')
        await updateWalletInfo()
      } else {
        const msg = data.error || ''
        const addr = currentAccount?.address || ''
        if (msg.includes('pending') && addr) {
          alert('Katana no soporta el faucet por Node.\n\nEjecuta en terminal:\n./scripts/faucet.sh ' + addr)
        } else {
          alert(msg || 'Error en el faucet')
        }
      }
    } catch (e) {
      const addr = currentAccount?.address || ''
      if (addr) {
        alert('Faucet no disponible. Ejecuta en terminal:\n./scripts/faucet.sh ' + addr)
      } else {
        alert('Error: ' + (e.message || e))
      }
      console.error('Faucet error:', e)
    } finally {
      faucetBtn.disabled = false
      faucetBtn.textContent = '💧 Obtener STRK'
    }
  })

  // Social modal handlers
  setupSocialModalHandlers()

  // Post details modal handlers
  setupPostDetailsHandlers()
}

function setupPostDetailsHandlers() {
  const postDetailsModal = document.getElementById('postDetailsModal')
  const closePostDetailsBtn = document.getElementById('closePostDetails')
  const openInOwnerFeedBtn = document.getElementById('openInOwnerFeedBtn')
  const locateOnCanvasBtn = document.getElementById('locateOnCanvasBtn')
  const sellPostBtn = document.getElementById('sellPostBtn')
  const removeSaleBtn = document.getElementById('removeSaleBtn')
  const buyPostBtn = document.getElementById('buyPostBtn')
  const placeBidBtn = document.getElementById('placeBidBtn')
  const commitBidBtn = document.getElementById('commitBidBtn')
  const verifyProofBtn = document.getElementById('verifyProofBtn')
  const revealBidBtn = document.getElementById('revealBidBtn')
  const claimCommitRefundBtn = document.getElementById('claimCommitRefundBtn')
  const finalizeAuctionBtn = document.getElementById('finalizeAuctionBtn')
  const initializeSlotContentBtn = document.getElementById('initializeSlotContentBtn')
  const salePriceInput = document.getElementById('salePriceInput')
  const salePriceRow = document.getElementById('salePriceRow')
  const auctionBidInput = document.getElementById('auctionBidInput')
  const sealedBidInput = document.getElementById('sealedBidInput')
  const wonSlotImagePicker = document.getElementById('wonSlotImagePicker')
  const wonSlotCameraPicker = document.getElementById('wonSlotCameraPicker')
  const wonSlotModal = document.getElementById('wonSlotModal')
  const wonSlotCaptionInput = document.getElementById('wonSlotCaptionInput')
  const wonSlotPreview = document.getElementById('wonSlotPreview')
  const wonSlotPreviewImg = document.getElementById('wonSlotPreviewImg')
  const wonSlotCameraBtn = document.getElementById('wonSlotCameraBtn')
  const wonSlotGalleryBtn = document.getElementById('wonSlotGalleryBtn')
  const wonSlotPublishBtn = document.getElementById('wonSlotPublishBtn')
  const wonSlotCancelBtn = document.getElementById('wonSlotCancelBtn')
  const wonSlotWebcamModal = document.getElementById('wonSlotWebcamModal')
  const wonSlotWebcamVideo = document.getElementById('wonSlotWebcamVideo')
  const wonSlotWebcamCapture = document.getElementById('wonSlotWebcamCapture')
  const wonSlotWebcamCancel = document.getElementById('wonSlotWebcamCancel')

  let currentPost = null
  let wonSlotImageDataUrl = ''
  let wonSlotWebcamStream = null

  function closeWonSlotWebcam() {
    if (wonSlotWebcamStream) {
      wonSlotWebcamStream.getTracks().forEach((t) => t.stop())
      wonSlotWebcamStream = null
    }
    if (wonSlotWebcamModal) wonSlotWebcamModal.classList.remove('active')
  }

  function openWonSlotWebcam() {
    if (!wonSlotWebcamModal || !wonSlotWebcamVideo) {
      wonSlotCameraPicker?.click()
      return
    }

    wonSlotWebcamModal.classList.add('active')
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 393 }, height: { ideal: 852 } } })
      .then((stream) => {
        wonSlotWebcamStream = stream
        wonSlotWebcamVideo.srcObject = stream
      })
      .catch((err) => {
        console.error('Won slot webcam access error:', err)
        closeWonSlotWebcam()
        // Fallback where webcam API is blocked/unavailable
        wonSlotCameraPicker?.click()
      })
  }

  function resetWonSlotModal() {
    wonSlotImageDataUrl = ''
    if (wonSlotCaptionInput) wonSlotCaptionInput.value = ''
    if (wonSlotPreview) wonSlotPreview.style.display = 'none'
    if (wonSlotPreviewImg) wonSlotPreviewImg.src = ''
    if (wonSlotImagePicker) wonSlotImagePicker.value = ''
    if (wonSlotCameraPicker) wonSlotCameraPicker.value = ''
    if (wonSlotPublishBtn) wonSlotPublishBtn.disabled = true
  }

  function updateWonSlotPublishEnabled() {
    const hasCaption = Boolean(wonSlotCaptionInput?.value?.trim())
    const hasImage = Boolean(wonSlotImageDataUrl)
    if (wonSlotPublishBtn) wonSlotPublishBtn.disabled = !(hasCaption && hasImage)
  }

  async function setWonSlotImageFromFile(file) {
    if (!file || !file.type?.startsWith('image/')) return
    try {
      wonSlotImageDataUrl = await resizeImageToDataUrlWithMaxLength(file)
      if (wonSlotPreviewImg) wonSlotPreviewImg.src = wonSlotImageDataUrl
      if (wonSlotPreview) wonSlotPreview.style.display = 'flex'
      updateWonSlotPublishEnabled()
    } catch (error) {
      console.error('Won slot image process error:', error)
      alert('No se pudo procesar la imagen. Prueba con otra.')
    }
  }

  function openWonSlotModalForPost(post) {
    if (!wonSlotModal) return
    resetWonSlotModal()
    wonSlotModal.dataset.postId = String(post.id)
    wonSlotModal.classList.add('active')
  }

  function closeWonSlotModal() {
    if (!wonSlotModal) return
    wonSlotModal.classList.remove('active')
    delete wonSlotModal.dataset.postId
    closeWonSlotWebcam()
    resetWonSlotModal()
  }

  if (wonSlotCaptionInput) {
    wonSlotCaptionInput.addEventListener('input', updateWonSlotPublishEnabled)
  }
  if (wonSlotCancelBtn) {
    wonSlotCancelBtn.addEventListener('click', closeWonSlotModal)
  }
  if (wonSlotModal) {
    wonSlotModal.addEventListener('click', (e) => {
      if (e.target === wonSlotModal) closeWonSlotModal()
    })
  }

  if (wonSlotGalleryBtn) {
    wonSlotGalleryBtn.addEventListener('click', () => wonSlotImagePicker?.click())
  }
  if (wonSlotCameraBtn) {
    wonSlotCameraBtn.addEventListener('click', openWonSlotWebcam)
  }

  if (wonSlotImagePicker) {
    wonSlotImagePicker.addEventListener('change', (e) => setWonSlotImageFromFile(e.target.files?.[0]))
  }
  if (wonSlotCameraPicker) {
    wonSlotCameraPicker.addEventListener('change', (e) => setWonSlotImageFromFile(e.target.files?.[0]))
  }

  if (wonSlotWebcamCapture) {
    wonSlotWebcamCapture.addEventListener('click', () => {
      const video = wonSlotWebcamVideo
      if (!video?.srcObject || video.readyState < 2) return

      const canvasEl = document.createElement('canvas')
      canvasEl.width = 393
      canvasEl.height = 852
      const ctx = canvasEl.getContext('2d')
      const scale = Math.max(canvasEl.width / video.videoWidth, canvasEl.height / video.videoHeight)
      const w = video.videoWidth * scale
      const h = video.videoHeight * scale
      ctx.drawImage(video, (canvasEl.width - w) / 2, (canvasEl.height - h) / 2, w, h)

      const rawDataUrl = canvasEl.toDataURL('image/jpeg', 0.65)
      resizeImageToDataUrlWithMaxLength(rawDataUrl)
        .then((dataUrl) => {
          wonSlotImageDataUrl = dataUrl
          if (wonSlotPreviewImg) wonSlotPreviewImg.src = dataUrl
          if (wonSlotPreview) wonSlotPreview.style.display = 'flex'
          updateWonSlotPublishEnabled()
          closeWonSlotWebcam()
        })
        .catch(() => {
          wonSlotImageDataUrl = rawDataUrl
          if (wonSlotPreviewImg) wonSlotPreviewImg.src = rawDataUrl
          if (wonSlotPreview) wonSlotPreview.style.display = 'flex'
          updateWonSlotPublishEnabled()
          closeWonSlotWebcam()
        })
    })
  }

  if (wonSlotWebcamCancel) {
    wonSlotWebcamCancel.addEventListener('click', closeWonSlotWebcam)
  }
  if (wonSlotWebcamModal) {
    wonSlotWebcamModal.addEventListener('click', (e) => {
      if (e.target === wonSlotWebcamModal) closeWonSlotWebcam()
    })
  }

  if (wonSlotPublishBtn) wonSlotPublishBtn.addEventListener('click', async () => {
    const postId = Number(wonSlotModal?.dataset?.postId || 0)
    const caption = String(wonSlotCaptionInput?.value || '').trim()
    const imageDataUrl = wonSlotImageDataUrl

    if (!Number.isFinite(postId) || postId <= 0) {
      alert('Invalid slot reference. Reopen the slot and try again.')
      return
    }
    if (!imageDataUrl) {
      alert('Please choose an image first.')
      return
    }
    if (!caption) {
      alert('Caption is required.')
      return
    }

    try {
      closeWonSlotModal()
      postDetailsModal.classList.remove('active')
      await dojoManager.setWonSlotContent(postId, imageDataUrl, caption)
      await new Promise((resolve) => setTimeout(resolve, 5000))
      await postManager.loadPosts()
      await postManager.loadImages()
      canvas.setPosts(postManager.posts)
      await updateWalletInfo()
      showToast('Won slot published. Content is now locked.')
    } catch (error) {
      console.error('Error setting won slot content:', error)
      alert('Failed to publish slot content: ' + (error.message || 'Unknown error'))
    }
  })

  closePostDetailsBtn.addEventListener('click', () => {
    postDetailsModal.classList.remove('active')
    currentPost = null
    delete postDetailsModal.dataset.postId
  })

  if (openInOwnerFeedBtn) {
    openInOwnerFeedBtn.addEventListener('click', () => {
      if (!currentPost) return
      const targetPost = (postManager?.posts || []).find((p) => String(p?.id ?? '') === String(currentPost?.id ?? '')) || currentPost
      const ownerAddress = normalizeSocialAddress(
        postDetailsModal?.dataset?.ownerAddress || targetPost.current_owner || targetPost.created_by
      )
      if (!ownerAddress) return
      const ownerName = String(document.getElementById('postCurrentOwner')?.textContent || '').trim()
      postDetailsModal.classList.remove('active')
      renderOwnerFeed(ownerAddress, ownerName, String(targetPost.id || ''), targetPost)
    })
  }

  if (locateOnCanvasBtn) {
    locateOnCanvasBtn.addEventListener('click', () => {
      if (!currentPost) return
      closeOwnerFeedView()
      postDetailsModal.classList.remove('active')
      const size = Math.max(1, Number(currentPost.size || 1))
      const centerX = Number(currentPost.x_position || 0) + (canvas.postWidth * size) / 2
      const centerY = Number(currentPost.y_position || 0) + (canvas.postHeight * size) / 2
      canvas.centerOn(centerX, centerY, 0.3)
      canvas.highlightPost(Number(currentPost.id || 0), 2500)
    })
  }

  postDetailsModal.addEventListener('click', (e) => {
    if (e.target === postDetailsModal) {
      postDetailsModal.classList.remove('active')
      currentPost = null
      delete postDetailsModal.dataset.postId
    }
  })

  sellPostBtn.addEventListener('click', async () => {
    if (!currentPost) return

    const price = parseInt(salePriceInput?.value || '0')
    if (isNaN(price) || price <= 0) {
      alert('Invalid price. Enter a number greater than 0.')
      return
    }

    try {
      if (dojoManager) {
        postDetailsModal.classList.remove('active')
        
        await dojoManager.setPostPrice(currentPost.id, price)
        console.log(`✅ Price set to ${price} STRK for post ${currentPost.id}`)
        
        // Wait for Torii to index
        console.log('⏳ Waiting for Torii to index...')
        await new Promise(resolve => setTimeout(resolve, 5000))
        
        // Reload posts
        await postManager.loadPosts()
        await postManager.loadImages()
        canvas.setPosts(postManager.posts)
        await updateWalletInfo()
        console.log('✅ Posts reloaded')
      }
    } catch (error) {
      console.error('Error setting price:', error)
      alert('Failed to list post for sale: ' + (error.message || 'Unknown error'))
      postDetailsModal.classList.remove('active')
    }
  })

  removeSaleBtn.addEventListener('click', async () => {
    if (!currentPost) return

    try {
      if (dojoManager) {
        postDetailsModal.classList.remove('active')
        
        await dojoManager.setPostPrice(currentPost.id, 0)
        
        // Wait for Torii to index
        await new Promise(resolve => setTimeout(resolve, 5000))
        await postManager.loadPosts()
        await postManager.loadImages()
        canvas.setPosts(postManager.posts)
        await updateWalletInfo()
      }
    } catch (error) {
      console.error('Error removing from sale:', error)
      alert('Failed to remove post from sale: ' + (error.message || 'Unknown error'))
      postDetailsModal.classList.remove('active')
    }
  })

  buyPostBtn.addEventListener('click', async () => {
    if (!currentPost) return

    const price = Number(currentPost.sale_price || 0)
    const buyerAddress = currentAccount.address
    const sellerAddress = currentPost.current_owner
    const isUnbidSlotSale = Number(currentPost.post_kind) === 2 &&
      Boolean(currentPost.auction_slot?.finalized) &&
      !Boolean(currentPost.auction_slot?.has_bid) &&
      !Boolean(currentPost.auction_slot?.content_initialized) &&
      price === 1

    // Check if user has enough STRK
    const buyerBalance = await getChainBalance(buyerAddress)
    if (buyerBalance < price) {
      alert(`Insufficient balance! You have ${buyerBalance} STRK but need ${price} STRK`)
      return
    }

    const confirmText = isUnbidSlotSale
      ? `Buy this slot for ${price} STRK? After purchase you can publish your image and caption once.`
      : `Buy this post for ${price} STRK?`
    if (!confirm(confirmText)) {
      return
    }

    try {
      if (dojoManager) {
        const boughtPostId = Number(currentPost.id)
        postDetailsModal.classList.remove('active')

        await dojoManager.buyPostWithPayment(currentPost.id, sellerAddress, price)

        // Wait for Torii to index
        await new Promise(resolve => setTimeout(resolve, 5000))
        await postManager.loadPosts()
        await postManager.loadImages()
        canvas.setPosts(postManager.posts)
        await updateWalletInfo()

        if (isUnbidSlotSale) {
          const boughtSlot = postManager.posts.find((p) => Number(p.id) === boughtPostId)
          if (boughtSlot) {
            showPostDetails(boughtSlot, 'canvas')
            showToast('Slot purchased. Now publish your image and caption.')
          }
        }
      }
    } catch (error) {
      console.error('Error buying post:', error)
      const failLabel = isUnbidSlotSale ? 'Failed to buy slot' : 'Failed to buy post'
      alert(failLabel + ': ' + (error.message || 'Unknown error'))
      postDetailsModal.classList.remove('active')
    }
  })

  if (placeBidBtn) placeBidBtn.addEventListener('click', async () => {
    if (!currentPost || !dojoManager) return
    const normalizedAccount = normalizeSocialAddress(currentAccount?.address || '')
    const isAuctionCreator =
      normalizedAccount &&
      (
        normalizeSocialAddress(currentPost?.auction_group?.creator) === normalizedAccount ||
        normalizeSocialAddress(currentPost?.current_owner) === normalizedAccount ||
        normalizeSocialAddress(currentPost?.created_by) === normalizedAccount
      )
    if (isAuctionCreator) {
      alert('Creator cannot bid in own auction.')
      return
    }
    const bid = parseInt(auctionBidInput?.value || '0')
    if (!Number.isFinite(bid) || bid <= 0) {
      alert('Enter a valid bid amount.')
      return
    }

    try {
      postDetailsModal.classList.remove('active')
      await dojoManager.placeAuctionBid(currentPost.id, bid)
      await new Promise((resolve) => setTimeout(resolve, 5000))
      await postManager.loadPosts()
      await postManager.loadImages()
      canvas.setPosts(postManager.posts)
      await updateWalletInfo()
    } catch (error) {
      console.error('Error placing bid:', error)
      alert('Failed to place bid: ' + (error.message || 'Unknown error'))
      postDetailsModal.classList.remove('active')
    }
  })

  if (commitBidBtn) commitBidBtn.addEventListener('click', async () => {
    if (!currentPost || !dojoManager || !currentAccount) return
    const activePost = currentPost
    const normalizedAccount = normalizeSocialAddress(currentAccount?.address || '')
    const isAuctionCreator =
      normalizedAccount &&
      (
        normalizeSocialAddress(activePost?.auction_group?.creator) === normalizedAccount ||
        normalizeSocialAddress(activePost?.current_owner) === normalizedAccount ||
        normalizeSocialAddress(activePost?.created_by) === normalizedAccount
      )
    if (isAuctionCreator) {
      alert('Creator cannot bid in own auction.')
      return
    }
    const bid = parseInt(sealedBidInput?.value || '0')
    if (!Number.isFinite(bid) || bid <= 0) {
      alert('Enter a valid sealed bid amount.')
      return
    }
    const myAddr = normalizeSocialAddress(currentAccount.address || '')
    const existingCommit = (activePost?.auction_commits || []).find((c) => normalizeSocialAddress(c.bidder) === myAddr) || null
    const previousEscrow = Number(existingCommit?.escrow_amount || 0)
    const escrowAmount = bid
    const slotId = Number(activePost?.id || 0)
    const modalSlotId = Number(postDetailsModal?.dataset?.postId || 0)
    if (Number.isFinite(modalSlotId) && modalSlotId > 0 && modalSlotId !== slotId) {
      alert('Slot changed while modal was open. Reopen Post Details and try again.')
      return
    }
    if (existingCommit && escrowAmount <= previousEscrow) {
      alert(`Sealed bid update must increase above your current sealed bid (${previousEscrow} STRK).`)
      return
    }
    const additionalLock = Math.max(0, escrowAmount - previousEscrow)
    const confirmMessage = existingCommit
      ? `Update sealed bid for slot #${slotId} from ${previousEscrow} to ${escrowAmount} STRK?\nAdditional lock now: ${additionalLock} STRK.`
      : `Commit sealed bid for slot #${slotId}: ${escrowAmount} STRK?`
    if (!confirm(confirmMessage)) return
    const salt = randomSaltFelt()
    try {
      postDetailsModal.classList.remove('active')
      const commitResult = await dojoManager.commitAuctionBid(slotId, bid, salt, escrowAmount)
      saveSaltForSlot(slotId, salt)
      saveBidAmountForSlot(slotId, bid)
      const commitEndTime = Number(activePost?.auction_sealed_config?.commit_end_time || 0)
      const revealEndTime = Number(activePost?.auction_sealed_config?.reveal_end_time || 0)
      if (SEALED_RELAY_URL) {
        try {
          const scheduled = await scheduleSealedAutoReveal({
            slotPostId: commitResult?.slotId || slotId,
            groupId: commitResult?.groupId || activePost.auction_group_id || 0,
            bidder: currentAccount.address,
            bidAmount: commitResult?.bidAmount || bid,
            salt,
            commitEndTime,
            revealEndTime,
          })
          if (scheduled?.ok) {
            showToast(`Sealed bid committed (${escrowAmount} STRK). Auto-reveal scheduled.`)
          }
        } catch (relayError) {
          console.warn('Auto-reveal schedule failed:', relayError)
          showToast(`Sealed bid committed (${escrowAmount} STRK). Auto-reveal scheduling failed, retrying in background.`)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5000))
      await postManager.loadPosts()
      await postManager.loadImages()
      canvas.setPosts(postManager.posts)
      await updateWalletInfo()
      if (!SEALED_RELAY_URL) showToast(`Sealed bid committed (${escrowAmount} STRK)`)
    } catch (error) {
      console.error('Error committing sealed bid:', error)
      alert('Failed to commit bid: ' + (error.message || 'Unknown error'))
      postDetailsModal.classList.remove('active')
    }
  })

  if (revealBidBtn) revealBidBtn.addEventListener('click', async () => {
    if (!currentPost || !dojoManager || !currentAccount) return
    const bid = parseInt(sealedBidInput?.value || '0')
    if (!Number.isFinite(bid) || bid <= 0) {
      alert('Enter your bid amount to reveal.')
      return
    }
    const salt = getSaltForSlot(currentPost.id)
    if (!salt) {
      alert('No local salt found for this slot commit.')
      return
    }
    try {
      postDetailsModal.classList.remove('active')
      if (!SEALED_RELAY_URL) {
        throw new Error('Auto-reveal relay not configured. Set VITE_SEALED_RELAY_URL.')
      }
      const revealed = await requestSealedImmediateReveal({
        slotPostId: currentPost.id,
        groupId: Number(currentPost?.auction_group_id || currentPost?.auction_slot?.group_id || 0),
        bidder: currentAccount.address,
        bidAmount: bid,
        salt,
      })
      await new Promise((resolve) => setTimeout(resolve, 5000))
      await postManager.loadPosts()
      await postManager.loadImages()
      canvas.setPosts(postManager.posts)
      await updateWalletInfo()
      showToast(revealed?.txHash ? `Sealed bid revealed (${shortTxHash(revealed.txHash)})` : 'Sealed bid revealed')
    } catch (error) {
      console.error('Error revealing sealed bid:', error)
      alert('Failed to reveal bid: ' + (error.message || 'Unknown error'))
      postDetailsModal.classList.remove('active')
    }
  })

  if (claimCommitRefundBtn) claimCommitRefundBtn.addEventListener('click', async () => {
    if (!currentPost || !dojoManager) return
    try {
      postDetailsModal.classList.remove('active')
      await dojoManager.claimAuctionCommitRefund(currentPost.id)
      await new Promise((resolve) => setTimeout(resolve, 5000))
      await postManager.loadPosts()
      await postManager.loadImages()
      canvas.setPosts(postManager.posts)
      await updateWalletInfo()
      showToast('Commit refund claimed')
    } catch (error) {
      console.error('Error claiming commit refund:', error)
      alert('Failed to claim refund: ' + (error.message || 'Unknown error'))
      postDetailsModal.classList.remove('active')
    }
  })

  if (verifyProofBtn) verifyProofBtn.addEventListener('click', async () => {
    if (!currentPost) return
    const slotId = Number(currentPost?.id || 0)
    if (!Number.isFinite(slotId) || slotId <= 0) return
    if (!SEALED_RELAY_URL) {
      alert('ZK proof verification viewer requires relay URL configuration.')
      return
    }
    try {
      const jobs = await fetchSealedRelayJobs(true)
      const job = getRelayJobForSlot(jobs, slotId, currentAccount?.address || '')
      if (!job) {
        alert('No relay proof job found yet for this slot.')
        return
      }
      const z = job?.zkTrace || {}
      const lines = [
        `Job: ${job.id || 'n/a'}`,
        `Reveal stage: ${relayStageLabel(job.status, 'reveal')}`,
        `Proof scheduled after: ${formatRelayUnix(job?.revealAfterUnix)}`,
        `Finalize scheduled after: ${formatRelayUnix(job?.finalizeAfterUnix)}`,
        `Proof felts: ${Number(z?.proofFelts || 0) || 'n/a'}`,
        `Calldata hash: ${z?.proofCalldataHash || 'n/a'}`,
        `Witness hash: ${z?.witnessHash || 'n/a'}`,
        `Proof hash: ${z?.proofHash || 'n/a'}`,
        `VK hash: ${z?.vkHash || 'n/a'}`,
        `Public inputs hash: ${z?.publicInputsHash || 'n/a'}`,
        `Reveal tx: ${job?.revealTxHash || 'n/a'}`,
        `Finalize tx: ${job?.finalizeTxHash || 'n/a'}`,
        `Refund tx: ${job?.refundTxHash || 'n/a'}`,
      ]
      if (job?.status === 'scheduled' && !job?.zkTrace) {
        lines.push('')
        lines.push('Expected state: proof artifacts are generated after commit phase ends.')
      }
      alert(`Sealed Result Verification\n\n${lines.join('\n')}`)
    } catch (error) {
      console.error('Verify proof error:', error)
      alert('Could not verify proof details: ' + (error?.message || 'Unknown error'))
    }
  })

  if (initializeSlotContentBtn) initializeSlotContentBtn.addEventListener('click', () => {
    const fallbackPostId = Number(postDetailsModal?.dataset?.postId || 0)
    const fallbackPost = Number.isFinite(fallbackPostId) && fallbackPostId > 0
      ? postManager?.posts?.find((p) => Number(p.id) === fallbackPostId) || null
      : null

    const activePost = currentPost || fallbackPost
    if (!activePost || !dojoManager) {
      alert('Slot is not ready yet. Reopen and try again.')
      return
    }

    openWonSlotModalForPost(activePost)
  })

  // Store reference for showPostDetails
  window.postDetailsHandlers = {
    setCurrentPost: (post) => { currentPost = post }
  }
}

function showPostDetails(post, source = 'canvas') {
  const postDetailsModal = document.getElementById('postDetailsModal')
  const postCreator = document.getElementById('postCreator')
  const postCaption = document.getElementById('postCaption')
  const postCurrentOwner = document.getElementById('postCurrentOwner')
  const postSaleInfo = document.getElementById('postSaleInfo')
  const postAuctionInfo = document.getElementById('postAuctionInfo')
  const postOnchainRef = document.getElementById('postOnchainRef')
  const copyPostRefBtn = document.getElementById('copyPostRefBtn')
  const openPostVoyagerLink = document.getElementById('openPostVoyagerLink')
  const openInOwnerFeedBtn = document.getElementById('openInOwnerFeedBtn')
  const locateOnCanvasBtn = document.getElementById('locateOnCanvasBtn')
  const sellPostBtn = document.getElementById('sellPostBtn')
  const removeSaleBtn = document.getElementById('removeSaleBtn')
  const buyPostBtn = document.getElementById('buyPostBtn')
  const placeBidBtn = document.getElementById('placeBidBtn')
  const commitBidBtn = document.getElementById('commitBidBtn')
  const verifyProofBtn = document.getElementById('verifyProofBtn')
  const revealBidBtn = document.getElementById('revealBidBtn')
  const claimCommitRefundBtn = document.getElementById('claimCommitRefundBtn')
  const finalizeAuctionBtn = document.getElementById('finalizeAuctionBtn')
  const initializeSlotContentBtn = document.getElementById('initializeSlotContentBtn')
  const salePriceInput = document.getElementById('salePriceInput')
  const salePriceRow = document.getElementById('salePriceRow')
  const auctionBidRow = document.getElementById('auctionBidRow')
  const auctionBidInput = document.getElementById('auctionBidInput')
  const sealedBidRow = document.getElementById('sealedBidRow')
  const sealedBidInput = document.getElementById('sealedBidInput')

  // Set current post
  window.postDetailsHandlers.setCurrentPost(post)
  postDetailsModal.dataset.postId = String(post.id)
  postDetailsModal.dataset.ownerAddress = normalizeSocialAddress(post?.current_owner || post?.created_by || '')
  postDetailsModal.dataset.source = String(source || 'canvas')

  if (openInOwnerFeedBtn) {
    openInOwnerFeedBtn.style.display = source === 'owner-feed' ? 'none' : 'inline-block'
  }
  if (locateOnCanvasBtn) {
    locateOnCanvasBtn.style.display = source === 'canvas' ? 'none' : 'inline-block'
  }

  // Update content
  postCreator.textContent = post.creator_username || 'Unknown'
  postCaption.textContent = post.caption || 'No caption'

  const worldAddress = String(manifest?.world?.address || '')
  const postId = Number(post?.id || 0)
  const onchainRefRaw = `world:${worldAddress}|post_id:${postId}`
  const onchainRefDisplay = worldAddress
    ? `${worldAddress.slice(0, 10)}...${worldAddress.slice(-8)} · Post #${postId}`
    : `Post #${postId}`

  if (postOnchainRef) postOnchainRef.textContent = onchainRefDisplay
  if (copyPostRefBtn) {
    copyPostRefBtn.onclick = async () => {
      const ok = await copyToClipboard(onchainRefRaw)
      if (ok) showToast('Post ref copied')
      else alert('Could not copy post reference.')
    }
  }
  if (openPostVoyagerLink) {
    openPostVoyagerLink.href = worldAddress ? `https://voyager.online/contract/${worldAddress}` : '#'
  }

  const normalizeLocalAddress = (addr) => {
    if (!addr) return ''
    let addrStr = addr.toString().toLowerCase()
    if (addrStr.startsWith('0x')) addrStr = addrStr.slice(2)
    addrStr = addrStr.replace(/^0+/, '')
    return '0x' + addrStr
  }

  const ownerRaw = post.current_owner ? String(post.current_owner) : ''
  const ownerShort = ownerRaw
    ? ownerRaw.slice(0, 8) + '...' + ownerRaw.slice(-6)
    : 'Unknown'

  const ownerNormalized = normalizeLocalAddress(ownerRaw)
  let ownerDisplay = ownerShort

  // Try to resolve current owner username from known posts (created_by -> creator_username).
  const ownerProfilePost = postManager?.posts?.find((p) =>
    normalizeLocalAddress(p.created_by) === ownerNormalized && p.creator_username
  )
  if (ownerProfilePost?.creator_username) {
    ownerDisplay = ownerProfilePost.creator_username
  } else if (normalizeLocalAddress(currentAccount?.address) === ownerNormalized && currentUsername) {
    ownerDisplay = currentUsername
  }

  if (postCurrentOwner) postCurrentOwner.textContent = ownerDisplay

  // Normalize addresses for comparison (convert to lowercase hex strings and remove leading zeros)
  const normalizeAddress = (addr) => {
    if (!addr) return ''
    // Convert to string and lowercase
    let addrStr = addr.toString().toLowerCase()
    // Remove 0x prefix if present
    if (addrStr.startsWith('0x')) {
      addrStr = addrStr.slice(2)
    }
    // Remove leading zeros
    addrStr = addrStr.replace(/^0+/, '')
    // Add back 0x prefix
    return '0x' + addrStr
  }

  const postOwner = normalizeAddress(post.current_owner)
  const userAddress = normalizeAddress(currentAccount.address)
  const isOwner = postOwner === userAddress

  // Debug logging
  console.log('Post Details Debug:', {
    postId: post.id,
    postOwner: postOwner,
    userAddress: userAddress,
    isOwner: isOwner,
    salePrice: post.sale_price,
    rawPostOwner: post.current_owner,
    rawUserAddress: currentAccount.address
  })

  // Show/hide buttons based on ownership and sale status
  sellPostBtn.style.display = 'none'
  removeSaleBtn.style.display = 'none'
  buyPostBtn.style.display = 'none'
  buyPostBtn.textContent = '🛒 Buy Post'
  if (placeBidBtn) placeBidBtn.style.display = 'none'
  if (commitBidBtn) commitBidBtn.style.display = 'none'
  if (verifyProofBtn) verifyProofBtn.style.display = 'none'
  if (revealBidBtn) revealBidBtn.style.display = 'none'
  if (claimCommitRefundBtn) claimCommitRefundBtn.style.display = 'none'
  if (finalizeAuctionBtn) finalizeAuctionBtn.style.display = 'none'
  if (initializeSlotContentBtn) initializeSlotContentBtn.style.display = 'none'
  if (salePriceRow) salePriceRow.style.display = 'none'
  if (auctionBidRow) auctionBidRow.style.display = 'none'
  if (sealedBidRow) sealedBidRow.style.display = 'none'
  if (postAuctionInfo) {
    postAuctionInfo.style.display = 'none'
    postAuctionInfo.textContent = ''
  }

  const isAuctionSlot = Number(post.post_kind) === 2
  const isAuctionCenter = Number(post.post_kind) === 1
  const slot = post.auction_slot || null
  const group = post.auction_group || null

  if (isAuctionCenter) {
    postSaleInfo.textContent = 'Auction center (locked by creator)'
    postSaleInfo.style.color = '#9ecbff'
    if (postAuctionInfo) {
      postAuctionInfo.style.display = 'block'
      postAuctionInfo.style.color = '#9ecbff'
      postAuctionInfo.innerHTML = '<strong>Auction Center</strong><br/>This tile is permanent, non-transferable, and cannot be listed for sale.'
    }
  } else if (isAuctionSlot && slot && group) {
    const now = Math.floor(Date.now() / 1000)
    const sealedCfg = post.auction_sealed_config || null
    const isSealed = Boolean(sealedCfg?.sealed_mode)
    const normalizedAccount = normalizeSocialAddress(currentAccount?.address || '')
    const isAuctionCreator =
      normalizedAccount &&
      (
        normalizeSocialAddress(group.creator) === normalizedAccount ||
        normalizeSocialAddress(post.current_owner) === normalizedAccount ||
        normalizeSocialAddress(post.created_by) === normalizedAccount
      )
    const commitEndTs = Number(sealedCfg?.commit_end_time || group.end_time || 0)
    const revealEndTs = Number(sealedCfg?.reveal_end_time || group.end_time || 0)
    const endTs = isSealed ? revealEndTs : Number(group.end_time || 0)
    const ended = now >= endTs
    const myAddr = normalizeSocialAddress(currentAccount?.address || '')
    const myCommit = (post.auction_commits || []).find((c) => normalizeSocialAddress(c.bidder) === myAddr) || null

    if (postAuctionInfo) {
      const endDate = new Date(endTs * 1000)
      const endLocal = endDate.toLocaleString()
      const endUtc = endDate.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
      const remaining = Math.max(0, endTs - now)
      const remainDays = Math.floor(remaining / 86400)
      const remainHours = Math.floor((remaining % 86400) / 3600)
      const remainMinutes = Math.floor((remaining % 3600) / 60)
      const remainingLabel = remainDays > 0
        ? `${remainDays}d ${remainHours}h ${remainMinutes}m`
        : `${remainHours}h ${remainMinutes}m`
      let phaseLine = 'Mode: Public'
      if (isSealed) {
        if (now < commitEndTs) phaseLine = 'Mode: Sealed · Phase: Commit'
        else if (now < revealEndTs) phaseLine = 'Mode: Sealed · Phase: Reveal'
        else phaseLine = 'Mode: Sealed · Phase: Finalize'
      }
      const myCommitLine = isSealed && myCommit
        ? `<br/>My sealed bid: committed · revealed: ${myCommit.revealed ? 'Yes' : 'No'} · refunded: ${myCommit.refunded ? 'Yes' : 'No'}`
        : ''
      if (!isSealed) {
        const highest = Number(slot.highest_bid || 0)
        const bidder = slot.has_bid
          ? String(slot.highest_bidder || '').slice(0, 8) + '...' + String(slot.highest_bidder || '').slice(-6)
          : 'No bids yet'
        postAuctionInfo.innerHTML =
          '<strong>Auction Slot</strong><br/>' +
          phaseLine +
          '<br/>Highest bid: ' + highest + ' STRK' +
          '<br/>Highest bidder: ' + bidder +
          '<br/>Ends (local): ' + endLocal +
          '<br/>Ends (UTC): ' + endUtc +
          '<br/>Remaining: ' + remainingLabel +
          '<br/>Finalized: ' + (slot.finalized ? 'Yes' : 'No') +
          '<br/>Content published: ' + (slot.content_initialized ? 'Yes' : 'No') +
          (slot.finalized && slot.has_bid ? '<br/>Proceeds: paid to creator' : '')
      } else {
        const commitDate = new Date(commitEndTs * 1000)
        const revealDate = new Date(revealEndTs * 1000)
        const commitLocal = commitDate.toLocaleString()
        const revealLocal = revealDate.toLocaleString()
        const commitUtc = commitDate.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
        const revealUtc = revealDate.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
        const canShowWinner = Boolean(slot.finalized || now >= revealEndTs)
        const revealedWinner = slot.has_bid
          ? String(slot.highest_bidder || '').slice(0, 8) + '...' + String(slot.highest_bidder || '').slice(-6)
          : 'No revealed winner yet'
        postAuctionInfo.innerHTML =
          '<strong>Auction Slot (Sealed)</strong><br/>' +
          phaseLine +
          '<br/>Bids are private until reveal/finalize.' +
          '<br/>Commit closes (local): ' + commitLocal +
          '<br/>Commit closes (UTC): ' + commitUtc +
          '<br/>Reveal closes (local): ' + revealLocal +
          '<br/>Reveal closes (UTC): ' + revealUtc +
          '<br/>Auction ends (local): ' + endLocal +
          '<br/>Auction ends (UTC): ' + endUtc +
          '<br/>Remaining: ' + remainingLabel +
          '<br/>Revealed winner: ' + (canShowWinner ? revealedWinner : 'Hidden while sealed auction is active') +
          '<br/>Finalized: ' + (slot.finalized ? 'Yes' : 'No') +
          '<br/>Content published: ' + (slot.content_initialized ? 'Yes' : 'No') +
          myCommitLine +
          (slot.finalized && slot.has_bid ? '<br/>Settlement: winner paid clearing price; non-winners refunded' : '')
      }
      postAuctionInfo.style.display = 'block'
      postAuctionInfo.style.color = isSealed ? '#d7c2ff' : '#9ecbff'
      if (isSealed) {
        void enrichSealedProofStatus(post, postAuctionInfo, post?.id, verifyProofBtn)
      }
    }

    if (!slot.finalized) {
      if (!isSealed) {
        postSaleInfo.textContent = ended ? 'Auction ended. Finalize to settle winner.' : 'Auction in progress'
        postSaleInfo.style.color = '#9ecbff'
        if (ended) {
          postSaleInfo.textContent = 'Auction ended. Finalizing automatically...'
          postSaleInfo.style.color = '#9ecbff'
          void tryAutoFinalizeAuctionSlot(post, 'post-details')
        } else {
          if (isAuctionCreator) {
            postSaleInfo.textContent = 'Auction in progress. Creator cannot bid in own auction.'
            postSaleInfo.style.color = '#9ecbff'
          } else {
            if (auctionBidRow) auctionBidRow.style.display = 'block'
            if (auctionBidInput) auctionBidInput.value = String(Math.max(1, Number(slot.highest_bid || 0) + 1))
            if (placeBidBtn) placeBidBtn.style.display = 'inline-block'
          }
        }
      } else {
        const inCommit = now < commitEndTs
        const inReveal = now >= commitEndTs && now < revealEndTs
        if (inCommit) {
          postSaleInfo.textContent = isAuctionCreator
            ? 'Sealed auction: commit phase (creator cannot bid in own auction)'
            : 'Sealed auction: commit phase'
          postSaleInfo.style.color = '#9ecbff'
          if (!isAuctionCreator) {
            if (sealedBidRow) sealedBidRow.style.display = 'block'
            if (sealedBidInput && !sealedBidInput.value) {
              const previousEscrow = Number(myCommit?.escrow_amount || 0)
              sealedBidInput.value = String(Math.max(1, previousEscrow + (myCommit ? 1 : 0)))
            }
            if (commitBidBtn) {
              commitBidBtn.style.display = 'inline-block'
              commitBidBtn.textContent = myCommit ? 'Increase Sealed Bid' : 'Commit Sealed Bid'
            }
          }
        } else if (inReveal) {
          postSaleInfo.textContent = 'Sealed auction: reveal phase'
          postSaleInfo.style.color = '#9ecbff'
          if (sealedBidRow) sealedBidRow.style.display = 'block'
          if (sealedBidInput) sealedBidInput.value = ''
          if (revealBidBtn) revealBidBtn.style.display = 'none'
          if (myCommit && !myCommit.revealed) {
            postSaleInfo.textContent = 'Sealed auction: reveal phase (auto-reveal in progress)'
            void tryAutoRevealSealedCommit(post, 'post-details')
          } else if (!myCommit) {
            postSaleInfo.textContent = 'Sealed auction: reveal phase (commit closed; this wallet cannot place new bids now)'
          }
        } else {
          postSaleInfo.textContent = 'Sealed auction ended. Settling reveals and finalizing automatically...'
          postSaleInfo.style.color = '#9ecbff'
          void tryAutoFinalizeAuctionSlot(post, 'post-details')
        }
      }
    } else {
      const isCreatorOwner = isOwner && normalizeAddress(group.creator) === userAddress

      if (!slot.content_initialized) {
        if (slot.has_bid && isOwner) {
          postSaleInfo.textContent = 'You won this slot. Publish image + caption once to unlock normal trading.'
          postSaleInfo.style.color = '#9ecbff'
          if (initializeSlotContentBtn) initializeSlotContentBtn.style.display = 'inline-block'
        } else if (!slot.has_bid && isCreatorOwner) {
          postSaleInfo.innerHTML = '<strong>💰 FOR SALE:</strong> 1 STRK (auto-listed; cannot be removed by creator)'
          postSaleInfo.style.color = '#4CAF50'
        } else if (!slot.has_bid && isOwner) {
          postSaleInfo.textContent = 'You bought this unbid slot. Publish image + caption once to unlock normal trading.'
          postSaleInfo.style.color = '#9ecbff'
          if (initializeSlotContentBtn) initializeSlotContentBtn.style.display = 'inline-block'
        } else if (!slot.has_bid) {
          postSaleInfo.innerHTML = '<strong>💰 FOR SALE:</strong> 1 STRK'
          postSaleInfo.style.color = '#4CAF50'
          buyPostBtn.style.display = 'inline-block'
          buyPostBtn.textContent = '🧩 Buy Slot (1 STRK)'
        } else {
          postSaleInfo.textContent = 'Waiting for winner to publish final slot content.'
          postSaleInfo.style.color = '#666'
        }
      } else if (post.sale_price > 0) {
        postSaleInfo.innerHTML = '<strong>💰 FOR SALE:</strong> ' + post.sale_price + ' STRK'
        postSaleInfo.style.color = '#4CAF50'
        if (isOwner) removeSaleBtn.style.display = 'inline-block'
        else buyPostBtn.style.display = 'inline-block'
      } else {
        postSaleInfo.textContent = slot.has_bid ? 'Auction finalized (winner assigned, creator paid)' : 'Auction finalized (no bids)'
        postSaleInfo.style.color = '#666'
        if (isOwner) {
          sellPostBtn.style.display = 'inline-block'
          if (salePriceRow) salePriceRow.style.display = 'block'
          if (salePriceInput && !salePriceInput.value) salePriceInput.value = '10'
        }
      }

      if (isSealed && myCommit && !myCommit.refunded) {
        const isWinner = slot.has_bid && normalizeSocialAddress(slot.highest_bidder) === myAddr
        if (!isWinner) {
          if (claimCommitRefundBtn) claimCommitRefundBtn.style.display = 'none'
          void tryAutoClaimSealedRefund(post, 'post-details')
        }
      }
    }
  } else if (post.sale_price > 0) {
    postSaleInfo.innerHTML = '<strong>💰 FOR SALE:</strong> ' + post.sale_price + ' STRK'
    postSaleInfo.style.color = '#4CAF50'

    if (isOwner) {
      removeSaleBtn.style.display = 'inline-block'
    } else {
      buyPostBtn.style.display = 'inline-block'
    }
  } else {
    postSaleInfo.textContent = 'Not for sale'
    postSaleInfo.style.color = '#666'

    if (isOwner) {
      sellPostBtn.style.display = 'inline-block'
      if (salePriceRow) salePriceRow.style.display = 'block'
      if (salePriceInput && !salePriceInput.value) salePriceInput.value = '10'
    }
  }

  postDetailsModal.classList.add('active')
}

async function subscribeToPostUpdates(toriiClient) {
  const scheduleResubscribe = () => {
    if (postUpdatesRetryTimer) return
    const delayMs = Math.min(30000, 1000 * (2 ** Math.max(0, postUpdatesRetryCount)))
    postUpdatesRetryCount += 1
    postUpdatesRetryTimer = setTimeout(() => {
      postUpdatesRetryTimer = null
      void subscribeToPostUpdates(toriiClient)
    }, delayMs)
  }

  const clearSubscription = () => {
    if (!postUpdatesSubscription) return
    try { postUpdatesSubscription.cancel() } catch {}
    postUpdatesSubscription = null
  }

  const shouldAutoReconnect = (err) => {
    const msg = String(err?.message || err || '').toLowerCase()
    return (
      msg.includes('input stream') ||
      msg.includes('networkerror') ||
      msg.includes('stream error') ||
      msg.includes('transport') ||
      msg.includes('unavailable')
    )
  }

  if (postUpdatesSubscription) return

  try {
    console.log('Setting up subscription for Post entities...');
    
    // SDK builds query automatically - don't call .build()
    const query = new ToriiQueryBuilder()
      .withClause(KeysClause(['di-Post'], [], 'VariableLen').build());
    
    const subscription = await toriiClient.subscribeEntityQuery({
      query: query,
      callback: async ({ data, error }) => {
        if (data) {
          console.log('🔔 New post detected, reloading...')
          await postManager.loadPosts()
          rememberUsersFromPosts(postManager.posts)
          await postManager.loadImages()
          canvas.setPosts(postManager.posts)
          await autoRevealPendingSealedCommits('subscription')
          await autoFinalizeEndedAuctionSlots('subscription')
          await autoClaimPendingSealedRefunds('subscription')
          if (activeOwnerFeedAddress) renderOwnerFeed(activeOwnerFeedAddress, activeOwnerFeedUsername)
        }
        if (error) {
          if (shouldAutoReconnect(error)) {
            console.warn('Post updates stream interrupted. Reconnecting...')
            clearSubscription()
            scheduleResubscribe()
          } else {
            console.error('Subscription error:', error)
          }
        }
      },
    })

    postUpdatesSubscription = subscription
    postUpdatesRetryCount = 0
    if (postUpdatesRetryTimer) {
      clearTimeout(postUpdatesRetryTimer)
      postUpdatesRetryTimer = null
    }
    
    if (!postUpdatesBeforeUnloadBound) {
      postUpdatesBeforeUnloadBound = true
      window.addEventListener('beforeunload', () => {
        if (postUpdatesRetryTimer) {
          clearTimeout(postUpdatesRetryTimer)
          postUpdatesRetryTimer = null
        }
        if (automationTickTimer) {
          clearInterval(automationTickTimer)
          automationTickTimer = null
        }
        clearSubscription()
      })
    }
    
    console.log('✓ Subscribed to Post entity updates')
  } catch (error) {
    console.warn('Failed to subscribe to updates:', error?.message || error)
    if (shouldAutoReconnect(error)) {
      scheduleResubscribe()
    }
    // Non-fatal error, app can still work without subscriptions.
  }
}

let activeOwnerFeedAddress = ''
let activeOwnerFeedUsername = ''

function sortPostsNewestFirst(posts = []) {
  const parsePostId = (value) => {
    const raw = String(value ?? '').trim()
    if (!raw) return 0n
    try {
      return BigInt(raw)
    } catch {
      return 0n
    }
  }

  return [...posts].sort((a, b) => {
    const aTime = Date.parse(a?.created_at || '')
    const bTime = Date.parse(b?.created_at || '')
    const aSafe = Number.isFinite(aTime) ? aTime : 0
    const bSafe = Number.isFinite(bTime) ? bTime : 0
    if (bSafe !== aSafe) return bSafe - aSafe

    const aId = parsePostId(a?.id)
    const bId = parsePostId(b?.id)
    if (bId > aId) return 1
    if (bId < aId) return -1
    return 0
  })
}

function dedupePostsById(posts = []) {
  const byId = new Map()
  const normalizePostId = (value) => String(value ?? '').trim()
  for (const post of posts) {
    const id = normalizePostId(post?.id)
    if (!id || id === '0') continue
    if (!byId.has(id)) byId.set(id, post)
  }
  return [...byId.values()]
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function drawOwnerFeedPostCanvas(canvasEl, post) {
  if (!canvasEl) return

  const baseW = 393
  const baseH = 852
  // Keep a consistent preview size in owner feed so larger on-chain tiles
  // (2x2, 3x3, etc.) do not look squashed in the vertical list.
  const width = baseW
  const height = baseH

  canvasEl.width = width
  canvasEl.height = height

  const ctx = canvasEl.getContext('2d')
  if (!ctx) return

  if (!post) {
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, width, height)
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 2
    ctx.strokeRect(0, 0, width, height)
    ctx.fillStyle = '#777'
    ctx.font = '16px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('Post unavailable', width / 2, height / 2)
    ctx.textAlign = 'left'
    return
  }

  const isAuctionSlot = Number(post.post_kind) === 2
  const hasSlotState = Boolean(post.auction_slot)
  const isFinalizedSlot = Boolean(post.auction_slot?.finalized)
  const showAuctionPlaceholder = isAuctionSlot && hasSlotState && !isFinalizedSlot

  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#1a1a1a'
  ctx.fillRect(0, 0, width, height)

  if (showAuctionPlaceholder) ctx.strokeStyle = '#38b6ff'
  else if (Number(post.sale_price || 0) > 0) ctx.strokeStyle = '#4CAF50'
  else if (Boolean(post.is_paid)) ctx.strokeStyle = '#FFD700'
  else ctx.strokeStyle = '#333'
  ctx.lineWidth = 2
  ctx.strokeRect(0, 0, width, height)

  if (!showAuctionPlaceholder && post.imageElement && post.imageElement.complete) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, width, height)
    ctx.clip()

    const imgAspect = post.imageElement.width / post.imageElement.height
    const postAspect = width / height

    // Owner feed uses contain mode: show full image without cropping.
    let drawWidth, drawHeight, offsetX, offsetY
    if (imgAspect > postAspect) {
      drawWidth = width
      drawHeight = width / imgAspect
      offsetX = 0
      offsetY = (height - drawHeight) / 2
    } else {
      drawHeight = height
      drawWidth = height * imgAspect
      offsetX = (width - drawWidth) / 2
      offsetY = 0
    }

    ctx.drawImage(post.imageElement, offsetX, offsetY, drawWidth, drawHeight)
    ctx.restore()

    if (post.creator_username) {
      const ownerHeight = 50
      const gradient = ctx.createLinearGradient(0, 0, 0, ownerHeight)
      gradient.addColorStop(0, 'rgba(0, 0, 0, 0.7)')
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, width, ownerHeight)

      ctx.fillStyle = '#fff'
      ctx.font = 'bold 14px sans-serif'
      ctx.fillText(String(post.creator_username), 12, 25)
    }

    if (post.caption) {
      const captionHeight = 80
      const gradient = ctx.createLinearGradient(0, height - captionHeight, 0, height)
      gradient.addColorStop(0, 'rgba(0, 0, 0, 0)')
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0.8)')
      ctx.fillStyle = gradient
      ctx.fillRect(0, height - captionHeight, width, captionHeight)

      ctx.fillStyle = '#fff'
      ctx.font = '14px sans-serif'
      ctx.fillText(String(post.caption).substring(0, 50), 10, height - 20)
    }

    if (Number(post.sale_price || 0) > 0) {
      const badgeWidth = 120
      const badgeHeight = 35
      const badgeX = width - badgeWidth - 10
      const badgeY = 10
      ctx.fillStyle = 'rgba(76, 175, 80, 0.9)'
      ctx.fillRect(badgeX, badgeY, badgeWidth, badgeHeight)

      ctx.fillStyle = '#fff'
      ctx.font = 'bold 12px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('FOR SALE', badgeX + badgeWidth / 2, badgeY + 13)
      ctx.font = '10px sans-serif'
      ctx.fillText(`${post.sale_price} STRK`, badgeX + badgeWidth / 2, badgeY + 26)
      ctx.textAlign = 'left'
    }
  } else {
    ctx.fillStyle = '#2a2a2a'
    ctx.fillRect(10, 10, width - 20, height - 20)

    if (showAuctionPlaceholder) {
      const endTs = Number(post.auction_group?.end_time || 0)
      const now = Math.floor(Date.now() / 1000)
      const remaining = Math.max(0, endTs - now)
      const h = Math.floor(remaining / 3600)
      const m = Math.floor((remaining % 3600) / 60)
      const isSealed = Boolean(post?.auction_sealed_config?.sealed_mode)
      const label = isSealed ? 'SEALED SLOT' : 'PUBLIC SLOT'

      ctx.fillStyle = isSealed ? '#d7c2ff' : '#9ecbff'
      ctx.textAlign = 'center'
      ctx.font = 'bold 16px sans-serif'
      ctx.fillText(label, width / 2, 70)
      ctx.font = '13px sans-serif'
      if (isSealed) {
        ctx.fillText('Bids hidden until reveal', width / 2, 105)
      } else {
        const highest = Number(post.auction_slot?.highest_bid || 0)
        ctx.fillText(`Highest: ${highest} STRK`, width / 2, 105)
      }
      ctx.fillText(`Ends in: ${h}h ${m}m`, width / 2, 128)
      ctx.textAlign = 'left'
    } else {
      ctx.fillStyle = '#666'
      ctx.font = '16px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(String(post.caption || 'Loading...'), width / 2, height / 2)
      ctx.textAlign = 'left'
    }
  }
}

function drawOwnerFeedPostDataUrl(post) {
  const offscreen = document.createElement('canvas')
  drawOwnerFeedPostCanvas(offscreen, post)
  return offscreen.toDataURL('image/png')
}

function renderOwnerFeed(ownerAddress, ownerUsername = '', focusPostId = '', focusPost = null) {
  const feedView = document.getElementById('ownerFeedView')
  const feedList = document.getElementById('ownerFeedList')
  const titleEl = document.getElementById('ownerFeedTitle')
  const subtitleEl = document.getElementById('ownerFeedSubtitle')
  if (!feedView || !feedList) return

  const normalizedOwner = normalizeSocialAddress(ownerAddress)
  if (!normalizedOwner) return

  if (!socialState.loaded) {
    ensureSocialDataLoaded()
      .then(() => {
        if (activeOwnerFeedAddress === normalizedOwner) {
          renderOwnerFeed(normalizedOwner, ownerUsername, focusPostId, focusPost)
        }
      })
      .catch(() => {})
  }

  const knownUsername = String(socialState.usernameByAddress.get(normalizedOwner) || '').trim()
  const displayName = String(ownerUsername || '').trim() || knownUsername || `${normalizedOwner.slice(0, 8)}...${normalizedOwner.slice(-6)}`
  const ownerPosts = sortPostsNewestFirst(
    dedupePostsById((postManager?.posts || []).filter((post) =>
      normalizeSocialAddress(post?.current_owner) === normalizedOwner
    ))
  )
  const { following, followers } = getSocialFollowersFollowing(normalizedOwner)

  if (titleEl) titleEl.textContent = displayName
  if (subtitleEl) {
    subtitleEl.textContent = `${ownerPosts.length} posts · ${following.length} following · ${followers.length} followers`
  }
  feedView.classList.add('active')

  if (!ownerPosts.length) {
    feedList.innerHTML = '<p class="owner-feed-empty">No posts owned by this user yet.</p>'
  } else {
    feedList.innerHTML = ownerPosts.map((post) => {
      return `
        <article class="owner-post-card" data-post-id="${String(post.id)}"> 
          <img class="owner-post-render" alt="Post preview" />
        </article>
      `
    }).join('')

    const postById = new Map(ownerPosts.map((p) => [String(p.id), p]))
    const cards = feedList.querySelectorAll('.owner-post-card')
    cards.forEach((card) => {
      const postId = String(card.getAttribute('data-post-id') || '')
      const post = postById.get(postId) || null
      const imgEl = card.querySelector('.owner-post-render')
      if (!imgEl) return
      imgEl.src = drawOwnerFeedPostDataUrl(post)

      if (post) {
        card.style.cursor = 'pointer'
        card.onclick = () => {
          showPostDetails(post, 'owner-feed')
        }
      }
    })

    const focusPostIdStr = String(focusPostId || '').trim()
    if (focusPostIdStr) {
      let focusedCard = null
      const cardsList = [...feedList.querySelectorAll('.owner-post-card')]
      focusedCard = cardsList.find((card) => String(card.getAttribute('data-post-id') || '').trim() === focusPostIdStr) || null

      if (!focusedCard && focusPost) {
        const targetX = String(focusPost.x_position ?? '')
        const targetY = String(focusPost.y_position ?? '')
        const targetSize = String(focusPost.size ?? '1')
        focusedCard = cardsList.find((card) => {
          const postId = String(card.getAttribute('data-post-id') || '')
          const p = postById.get(postId)
          if (!p) return false
          return String(p.x_position ?? '') === targetX &&
            String(p.y_position ?? '') === targetY &&
            String(p.size ?? '1') === targetSize
        }) || null
      }

      if (focusedCard) {
        focusedCard.classList.add('owner-post-card-focused')
        requestAnimationFrame(() => {
          focusedCard.scrollIntoView({ behavior: 'smooth', block: 'center' })
        })
        setTimeout(() => focusedCard.classList.remove('owner-post-card-focused'), 1600)
      }
    }
  }


  activeOwnerFeedAddress = normalizedOwner
  activeOwnerFeedUsername = displayName
}

function closeOwnerFeedView() {
  const feedView = document.getElementById('ownerFeedView')
  if (feedView) feedView.classList.remove('active')
  activeOwnerFeedAddress = ''
  activeOwnerFeedUsername = ''
}

function openOwnerFeedFromSocial(address, username) {
  closeSocialModalById('followersModal')
  closeSocialModalById('followingModal')
  renderOwnerFeed(address, username)
}

function renderSocialUserRows(container, users, actionLabel = '', actionHandler = null, profileClickHandler = null) {
  if (!container) return

  if (!users.length) {
    container.innerHTML = '<p class="social-empty">No users found.</p>'
    return
  }

  container.innerHTML = users.map((user) => {
    const safeAddress = String(user.address || '')
    const safeName = String(user.username || safeAddress)
    return `
      <div class="social-row" data-address="${safeAddress}">
        <div class="social-user-text">
          <button type="button" class="social-user-link">${safeName}</button>
          <span>${safeAddress}</span>
        </div>
        ${actionLabel ? `<button type="button" class="social-action-btn">${actionLabel}</button>` : ''}
      </div>
    `
  }).join('')

  if (actionLabel && actionHandler) {
    const rows = container.querySelectorAll('.social-row')
    rows.forEach((row) => {
      const btn = row.querySelector('.social-action-btn')
      if (!btn) return
      btn.onclick = () => actionHandler(row.getAttribute('data-address') || '')
    })
  }

  if (profileClickHandler) {
    const rows = container.querySelectorAll('.social-row')
    rows.forEach((row) => {
      const linkBtn = row.querySelector('.social-user-link')
      if (!linkBtn) return
      linkBtn.onclick = () => {
        const addr = row.getAttribute('data-address') || ''
        profileClickHandler(addr, linkBtn.textContent || '')
      }
    })
  }
}

function closeSocialModalById(modalId) {
  const modal = document.getElementById(modalId)
  if (modal) modal.classList.remove('active')
}

async function openFollowersModal() {
  const me = normalizeSocialAddress(currentAccount?.address)
  if (!me) return
  await ensureSocialDataLoaded().catch(() => {})

  const followersModal = document.getElementById('followersModal')
  const followersList = document.getElementById('followersList')
  const { followers, usernames } = getSocialFollowersFollowing(me)
  const users = followers.map((addr) => ({
    address: addr,
    username: usernames[addr] || (addr.slice(0, 8) + '...' + addr.slice(-6)),
  }))

  renderSocialUserRows(followersList, users, '', null, (addr, name) => openOwnerFeedFromSocial(addr, name))
  followersModal?.classList.add('active')
}

function renderFollowingModal(term = '') {
  const me = normalizeSocialAddress(currentAccount?.address)
  if (!me) return

  const followingListEl = document.getElementById('followingList')
  const searchResultsEl = document.getElementById('followingSearchResults')
  const { following, usernames } = getSocialFollowersFollowing(me)

  const followingUsers = following.map((addr) => ({
    address: addr,
    username: usernames[addr] || (addr.slice(0, 8) + '...' + addr.slice(-6)),
  }))
  renderSocialUserRows(followingListEl, followingUsers, 'Unfollow', async (target) => {
    try {
      const ok = await unfollowUserLocally(target)
      if (!ok) {
        showToast('Cannot unfollow this user')
        return
      }

      showToast('Unfollowed user')
      renderFollowingModal(term)
      await updateWalletInfo()
    } catch (error) {
      alert('Failed to unfollow: ' + (error?.message || 'Unknown error'))
    }
  }, (addr, name) => openOwnerFeedFromSocial(addr, name))

  const q = String(term || '').trim().toLowerCase()
  const knownUsers = getKnownUsersForSearch()
  const filtered = q
    ? knownUsers.filter((u) => u.address.toLowerCase().includes(q) || u.username.toLowerCase().includes(q))
    : knownUsers

  const decorated = filtered.map((u) => ({
    ...u,
    isFollowing: following.includes(normalizeSocialAddress(u.address)),
  }))

  if (!searchResultsEl) return
  if (!decorated.length) {
    searchResultsEl.innerHTML = '<p class="social-empty">No matches. You can paste a wallet address (0x...) and follow directly.</p>'
  } else {
    searchResultsEl.innerHTML = decorated.map((user) => `
      <div class="social-row" data-address="${user.address}">
        <div class="social-user-text">
          <button type="button" class="social-user-link">${user.username}</button>
          <span>${user.address}</span>
        </div>
        <button type="button" class="social-action-btn">${user.isFollowing ? 'Unfollow' : 'Follow'}</button>
      </div>
    `).join('')
  }

  searchResultsEl.querySelectorAll('.social-row').forEach((row) => {
    const linkBtn = row.querySelector('.social-user-link')
    if (linkBtn) {
      linkBtn.onclick = () => openOwnerFeedFromSocial(row.getAttribute('data-address') || '', linkBtn.textContent || '')
    }

    const btn = row.querySelector('.social-action-btn')
    if (!btn) return
    btn.onclick = async () => {
      const target = row.getAttribute('data-address') || ''
      const isFollowing = btn.textContent === 'Unfollow'

      try {
        if (isFollowing) {
          const ok = await unfollowUserLocally(target)
          if (!ok) {
            showToast('Cannot unfollow this user')
            return
          }
          showToast('Unfollowed user')
        } else {
          const ok = await followUserLocally(target)
          if (!ok) {
            showToast('Cannot follow this user')
            return
          }
          showToast('Now following user')
        }

        renderFollowingModal(term)
        await updateWalletInfo()
      } catch (error) {
        const action = isFollowing ? 'unfollow' : 'follow'
        alert(`Failed to ${action}: ` + (error?.message || 'Unknown error'))
      }
    }
  })

  if (q.startsWith('0x') && q.length > 8) {
    const normalized = normalizeSocialAddress(q)
    const exists = decorated.some((u) => normalizeSocialAddress(u.address) === normalized)
    if (!exists && normalized !== me) {
      const quickFollow = document.createElement('div')
      quickFollow.className = 'social-row'
      quickFollow.innerHTML = `
        <div class="social-user-text">
          <button type="button" class="social-user-link">${normalized.slice(0, 8)}...${normalized.slice(-6)}</button>
          <span>${normalized}</span>
        </div>
        <button type="button" class="social-action-btn">Follow</button>
      `
      quickFollow.querySelector('.social-user-link')?.addEventListener('click', () => {
        openOwnerFeedFromSocial(normalized, `${normalized.slice(0, 8)}...${normalized.slice(-6)}`)
      })
      quickFollow.querySelector('.social-action-btn')?.addEventListener('click', async () => {
        try {
          const ok = await followUserLocally(normalized)
          if (!ok) {
            showToast('Cannot follow this user')
            return
          }
          showToast('Now following user')
          renderFollowingModal(term)
          await updateWalletInfo()
        } catch (error) {
          alert('Failed to follow: ' + (error?.message || 'Unknown error'))
        }
      })
      searchResultsEl.appendChild(quickFollow)
    }
  }
}

async function openFollowingModal() {
  const followingModal = document.getElementById('followingModal')
  const searchInput = document.getElementById('followingSearchInput')

  await ensureSocialDataLoaded().catch(() => {})
  renderFollowingModal('')
  if (searchInput) {
    searchInput.value = ''
    searchInput.oninput = () => renderFollowingModal(searchInput.value)
  }

  followingModal?.classList.add('active')
}

function setupSocialModalHandlers() {
  const followersModal = document.getElementById('followersModal')
  const followingModal = document.getElementById('followingModal')
  const closeFollowersBtn = document.getElementById('closeFollowersBtn')
  const closeFollowingBtn = document.getElementById('closeFollowingBtn')
  const closeOwnerFeedBtn = document.getElementById('closeOwnerFeedBtn')

  closeFollowersBtn?.addEventListener('click', () => closeSocialModalById('followersModal'))
  closeFollowingBtn?.addEventListener('click', () => closeSocialModalById('followingModal'))
  closeOwnerFeedBtn?.addEventListener('click', () => closeOwnerFeedView())

  followersModal?.addEventListener('click', (e) => {
    if (e.target === followersModal) closeSocialModalById('followersModal')
  })
  followingModal?.addEventListener('click', (e) => {
    if (e.target === followingModal) closeSocialModalById('followingModal')
  })
}

async function updateWalletInfo() {
  const walletInfo = document.getElementById('wallet-info')
  if (!currentAccount) return
  const addr = normalizeStarknetAddress(currentAccount.address)
  const shortAddr = addr.slice(0, 8) + '...' + addr.slice(-6)
  // Avoid repaint flicker: only render fallback when wallet info is still empty.
  if (!String(walletInfo.innerHTML || '').trim()) {
    walletInfo.innerHTML = `<span style="color: #4CAF50;">● ${currentUsername || shortAddr}</span>`
  }
  try {
    const balance = await withTimeout(getChainBalance(currentAccount.address), 7000, 'wallet balance').catch(() => null)
    const swapBtcBalance = (hasYieldInManifest && YIELD_DUAL_POOL_ENABLED)
      ? await withTimeout(
        dojoManager.getTokenBalance(currentAccount.address, SEPOLIA_BTC_SWAP_TOKEN, 8),
        7000,
        'swap btc balance',
      ).catch(() => 0)
      : 0
    // Don't block wallet rendering on social indexing/network.
    if (!socialState.loaded) {
      const now = Date.now()
      // Keep retrying social hydration, but don't trigger tight loops that
      // constantly re-render wallet info and cause visible blinking.
      if (now - lastSocialRevalidationKickAt > 15000) {
        lastSocialRevalidationKickAt = now
        scheduleSocialRevalidation(0)
      }
    }
    const me = normalizeSocialAddress(currentAccount.address)
    const { following, followers } = getSocialFollowersFollowing(me)
    const num = Number(balance ?? 0)
    const balanceStr = Number.isFinite(num) ? num.toFixed(2) : '0.00'
    let yieldState = null
    if (hasYieldInManifest) {
      const fetchedYieldState = await withTimeout(
        dojoManager.queryYieldState(currentAccount.address),
        7000,
        'yield state',
      ).catch(() => null)
      // Keep previous known-good state only if the fetch actually fails.
      yieldState = fetchedYieldState || cachedYieldState || null
    }
    if (yieldState) cachedYieldState = yieldState
    const activeSymbol = String(yieldState?.pool_token_symbol || (yieldState?.use_btc_mode ? 'WBTC' : 'STRK') || 'STRK').toUpperCase() === 'WBTC'
      ? 'WBTC'
      : 'STRK'
    const starkzapPosition = (starkzapManager && IS_SEPOLIA)
      ? await withTimeout(starkzapManager.getPoolPosition(activeSymbol), 7000, 'starkzap position').catch(() => null)
      : null
    const principalNum = yieldState ? Number(yieldState.principal_strk || 0) : 0
    const queuedNum = yieldState ? Number(yieldState.queued_exit_strk || 0) : 0
    const lockedTotalStr = (principalNum + queuedNum).toFixed(2)
    const earningsStr = '0.000000'
    const queuedExitNum = queuedNum
    const queuedExitStr = Number.isFinite(queuedExitNum) ? queuedExitNum.toFixed(2) : '0.00'
    const hasPrincipal = yieldState && Number(yieldState.principal_strk || 0) > 0
    const hasQueue = yieldState && Number(yieldState.queued_exit_strk || 0) > 0
    const yieldDepositBtnLabel = '🔒 Stake'
    let yieldWithdrawBtnLabel = '💰 Unstake'
    const yieldClaimBtnLabel = '✨ Claim'
    const poolSymbol = yieldState ? String(yieldState.pool_token_symbol || (yieldState.use_btc_mode ? 'WBTC' : 'STRK')) : 'STRK'
    const position = starkzapPosition?.position || null
    let stakedLabel = position ? position.staked.toFormatted(true) : `${lockedTotalStr} ${poolSymbol}`
    let rewardsLabel = position ? position.rewards.toFormatted(true) : `${earningsStr} ${poolSymbol}`
    let totalLabel = position ? position.total.toFormatted(true) : `${lockedTotalStr} ${poolSymbol}`
    let unpoolingLabel = position && !position.unpooling.isZero()
      ? position.unpooling.toFormatted(true)
      : null
    let unpoolAtLabel = position?.unpoolTime ? new Date(position.unpoolTime).toLocaleString() : ''
    if (position && !position.unpooling.isZero()) {
      const readyToExit = position?.unpoolTime
        ? new Date(position.unpoolTime).getTime() <= Date.now()
        : false
      if (readyToExit) {
        unpoolAtLabel = 'Ready now (press Unstake STRK)'
        yieldWithdrawBtnLabel = '💰 Complete Exit'
      }
    }
    const commissionLabel = Number.isFinite(Number(starkzapPosition?.commissionPercent))
      ? Number(starkzapPosition?.commissionPercent).toFixed(2)
      : '0.00'
    const yieldModeLabel = `${poolSymbol} real staking`
    const btcSymbol = BTC_TRACK_SYMBOL
    const btcWalletBalance = Number(swapBtcBalance || 0)
    const isBtcPoolActive = String(poolSymbol || '').toUpperCase() === 'WBTC'
    // AVNU is source-of-truth for STRK staking status in Sepolia.
    // Always prefer AVNU values to avoid cross-source inconsistencies.
    if (IS_SEPOLIA && dojoManager?.getAvnuUserStakingByToken) {
      const avnuStrkPosition = await withTimeout(
        dojoManager.getAvnuUserStakingByToken(PAYMENT_TOKEN_ADDRESS, currentAccount.address),
        6000,
        'avnu strk staking position',
      ).catch(() => null)
      if (avnuStrkPosition) {
        const avnuStaked = Number(avnuStrkPosition.amountFormatted || 0)
        const avnuRewards = Number(avnuStrkPosition.rewardsFormatted || 0)
        const avnuUnpool = Number(avnuStrkPosition.unpoolFormatted || 0)
        stakedLabel = `${avnuStaked.toFixed(6)} STRK`
        rewardsLabel = `${avnuRewards.toFixed(6)} STRK`
        totalLabel = `${(avnuStaked + avnuRewards).toFixed(6)} STRK`
        if (avnuUnpool > 0) {
          unpoolingLabel = `${avnuUnpool.toFixed(6)} STRK`
          const readyToExit = avnuStrkPosition.unpoolTime && new Date(avnuStrkPosition.unpoolTime).getTime() <= Date.now()
          if (readyToExit) {
            unpoolAtLabel = 'Ready now (press Unstake STRK)'
            yieldWithdrawBtnLabel = '💰 Complete Exit'
          } else {
            unpoolAtLabel = avnuStrkPosition.unpoolTime ? new Date(avnuStrkPosition.unpoolTime).toLocaleString() : unpoolAtLabel
          }
        } else {
          unpoolingLabel = null
          unpoolAtLabel = ''
        }
      }
    }

    const btcStakedLabel = isBtcPoolActive ? stakedLabel : `0.000000 ${btcSymbol}`
    const btcRewardsLabel = isBtcPoolActive ? rewardsLabel : `0.000000 ${btcSymbol}`
    walletInfo.innerHTML = `
      <div class="wallet-box">
        <div class="wallet-top-row">
          <div class="wallet-stats">
            <button id="following-count-btn" class="wallet-stat-btn" type="button">Following ${following.length}</button>
            <button id="followers-count-btn" class="wallet-stat-btn" type="button">Followers ${followers.length}</button>
          </div>
          <div class="wallet-main">
            <div class="wallet-user-row">
              <button id="wallet-user-btn" class="wallet-user-btn" type="button" title="Open my feed">● ${currentUsername || shortAddr}</button>
              <button id="wallet-logout-btn" class="wallet-logout-btn" type="button" aria-label="Logout" title="Logout">⏻</button>
            </div>
            <span class="wallet-balance">💰 ${balanceStr} STRK</span>
            ${hasYieldInManifest ? `<span class="wallet-balance">₿ ${btcWalletBalance.toFixed(8)} ${btcSymbol}</span>` : ''}
            ${hasYieldInManifest ? `<span class="wallet-yield-line">🔒 Staked ${stakedLabel} · ✨ Rewards ${rewardsLabel}${unpoolingLabel ? ` · ⏳ Unpooling ${unpoolingLabel}` : ''}${unpoolAtLabel ? ` · Exit at ${unpoolAtLabel}` : ''}</span>` : ''}
            ${hasYieldInManifest ? `<span class="wallet-yield-line">🔒 Staked ${btcStakedLabel} · ✨ Rewards ${btcRewardsLabel}</span>` : ''}
          </div>
        </div>
        ${hasYieldInManifest ? `<div class="wallet-yield-actions">
          <button id="wallet-yield-deposit-btn" class="wallet-stat-btn" type="button" title="Smart stake STRK/WBTC">${yieldDepositBtnLabel}</button>
          <button id="wallet-yield-withdraw-btn" class="wallet-stat-btn" type="button" title="Return staked funds to balance">${yieldWithdrawBtnLabel}</button>
          <button id="wallet-yield-claim-btn" class="wallet-stat-btn" type="button" title="Claim rewards">${yieldClaimBtnLabel}</button>
        </div>` : ''}
        <div class="wallet-transfer-actions">
          <button id="wallet-send-strk-btn" class="wallet-stat-btn" type="button" title="Send STRK">⇄ Send STRK</button>
          <button id="wallet-swap-btn" class="wallet-stat-btn" type="button" title="Swap STRK/WBTC">⇄ Swap STRK/WBTC</button>
        </div>
        <div class="wallet-address-row" title="${addr}">
          <span class="wallet-address">${addr}</span>
          <button id="copy-address-btn" class="wallet-copy-btn" type="button" title="Copiar address">📋</button>
        </div>
      </div>
    `

    const copyBtn = document.getElementById('copy-address-btn')
    if (copyBtn) {
      copyBtn.onclick = async () => {
        const ok = await copyToClipboard(addr)
        if (ok) {
          showToast('Address copiada')
        } else {
          alert('No se pudo copiar. Mantén pulsado el texto y copia manualmente.')
        }
      }
    }

    const followingBtn = document.getElementById('following-count-btn')
    if (followingBtn) {
      if (window.matchMedia('(max-width: 640px)').matches) {
        followingBtn.textContent = `↗ ${following.length}`
        followingBtn.title = `Following ${following.length}`
      }
      followingBtn.onclick = async () => { await openFollowingModal() }
    }

    const followersBtn = document.getElementById('followers-count-btn')
    if (followersBtn) {
      if (window.matchMedia('(max-width: 640px)').matches) {
        followersBtn.textContent = `↙ ${followers.length}`
        followersBtn.title = `Followers ${followers.length}`
      }
      followersBtn.onclick = async () => { await openFollowersModal() }
    }

    const walletUserBtn = document.getElementById('wallet-user-btn')
    if (walletUserBtn) {
      walletUserBtn.onclick = () => {
        const me = normalizeSocialAddress(currentAccount?.address)
        if (!me) return
        renderOwnerFeed(me, String(currentUsername || '').trim())
      }
    }

    const walletLogoutBtn = document.getElementById('wallet-logout-btn')
    if (walletLogoutBtn) {
      walletLogoutBtn.onclick = () => logout()
    }
    const walletSendStrkBtn = document.getElementById('wallet-send-strk-btn')
    if (walletSendStrkBtn) {
      walletSendStrkBtn.onclick = () => {
        window.dispatchEvent(new Event('starkwall:open-send-strk'))
      }
    }
    const walletSwapBtn = document.getElementById('wallet-swap-btn')
    if (walletSwapBtn) {
      walletSwapBtn.onclick = () => {
        window.dispatchEvent(new Event('starkwall:open-swap-strk-wbtc'))
      }
    }
    const walletYieldDepositBtn = document.getElementById('wallet-yield-deposit-btn')
    if (walletYieldDepositBtn) {
      walletYieldDepositBtn.onclick = async () => {
        try {
          await runExclusiveYieldAction('stake', async () => runWithBusyButton(walletYieldDepositBtn, {
            idleText: yieldDepositBtnLabel,
            busyText: 'Opening...',
            pendingToast: 'Preparing stake flow...',
            pendingAfterMs: 1500,
          }, async () => handleYieldPrimaryAction()))
        } catch (error) {
          console.error('Yield deposit modal error:', error)
          alert('Stake flow failed. Check balance and retry.')
        }
      }
    }

    const walletYieldWithdrawBtn = document.getElementById('wallet-yield-withdraw-btn')
    if (walletYieldWithdrawBtn) {
      walletYieldWithdrawBtn.onclick = async () => {
        try {
          const preferred = String((cachedYieldState?.pool_token_symbol || 'STRK')).toUpperCase() === 'WBTC' ? 'WBTC' : 'STRK'
          const selectedSymbol = await askYieldToken('Unstake', preferred)
          if (!selectedSymbol) return
          await runExclusiveYieldAction('unstake', async () => runWithBusyButton(walletYieldWithdrawBtn, {
            idleText: yieldWithdrawBtnLabel,
            busyText: 'Unstaking...',
            pendingToast: 'Confirm unstake in wallet. Waiting for chain confirmation...',
          }, async () => {
            const activeSymbol = selectedSymbol
            let providerPath = 'dojo'
            let txHash = ''
            console.info('[Unstake] Start', {
              user: currentAccount.address,
              symbol: activeSymbol,
            })
            if (IS_SEPOLIA && activeSymbol === 'STRK' && dojoManager?.unstakeStrkViaAvnu) {
              try {
                const avnuRes = await dojoManager.unstakeStrkViaAvnu()
                txHash = String(avnuRes?.txHash || '')
                providerPath = 'avnu-staking'
                if (avnuRes?.action === 'pending') {
                  const when = avnuRes?.unpoolTimeMs ? new Date(avnuRes.unpoolTimeMs).toLocaleString() : 'later'
                  showToast(`STRK unstake in cooldown. Available at ${when}.`)
                  await updateWalletInfo()
                  return
                }
                addActivityEvent({
                  actionType: avnuRes?.action === 'exit' ? 'unstake_exit' : 'unstake_intent',
                  token: activeSymbol,
                  amount: 0,
                  providerPath,
                  txHash,
                  status: 'success',
                })
                if (avnuRes?.action === 'intent') {
                  showToast(`Unstake requested for ${activeSymbol}. Complete after cooldown.${txHash ? ` ${shortTxHash(txHash)}` : ''}`)
                } else {
                  showToast(`${activeSymbol} returned to wallet balance.${txHash ? ` ${shortTxHash(txHash)}` : ''}`)
                }
                await updateWalletInfo()
                return
              } catch (avnuUnstakeError) {
                const msg = String(avnuUnstakeError?.message || avnuUnstakeError || '')
                if (/no staked or unpooling strk position found/i.test(msg)) {
                  console.info('[Unstake] AVNU has no STRK position; trying Starkzap/Dojo fallback path')
                } else {
                  throw avnuUnstakeError
                }
              }
            }
            if (starkzapManager && IS_SEPOLIA) {
              try {
                const latest = await dojoManager.queryYieldState(currentAccount.address).catch(() => cachedYieldState || null)
                const principal = Number(latest?.principal_strk || 0)
                const res = await starkzapManager.unstake(activeSymbol, principal > 0 ? principal : null)
                txHash = String(res?.tx?.hash || '')
                providerPath = 'starkzap'
                console.info('[Unstake] Starkzap success', {
                  user: currentAccount.address,
                  symbol: activeSymbol,
                  action: res.action,
                  principal,
                  txHash,
                })
                addActivityEvent({
                  actionType: res.action === 'exit' ? 'unstake_exit' : 'unstake_intent',
                  token: activeSymbol,
                  amount: principal > 0 ? principal : Number(res?.position?.staked?.toFormatted?.() || 0),
                  providerPath,
                  txHash,
                  status: 'success',
                })
                if (res.action === 'intent') {
                  showToast(`Unstake requested for ${activeSymbol}. Complete after cooldown.${txHash ? ` ${shortTxHash(txHash)}` : ''}`)
                } else {
                  showToast(`${activeSymbol} returned to wallet balance.${txHash ? ` ${shortTxHash(txHash)}` : ''}`)
                }
                await updateWalletInfo()
                return
              } catch (starkzapError) {
                console.error('[Unstake] Starkzap failed message:', starkzapError?.message || String(starkzapError))
                console.error('[Unstake] Starkzap failed; fallback to Dojo', {
                  user: currentAccount.address,
                  symbol: activeSymbol,
                  error: errorInfo(starkzapError),
                })
                if (isControllerInitError(starkzapError)) {
                  showToast('Controller did not open correctly (popup/cookies). Using standard unstake flow...')
                } else {
                  showToast('Starkzap unstake failed. Falling back to standard unstake flow...')
                }
                providerPath = 'dojo-fallback'
              }
            }

            const desiredBtcMode = activeSymbol === 'WBTC'
            const beforeSwitchState = await dojoManager.queryYieldState(currentAccount.address).catch(() => cachedYieldState || null)
            const currentPoolSymbol = String(
              beforeSwitchState?.pool_token_symbol || (beforeSwitchState?.use_btc_mode ? 'WBTC' : 'STRK') || 'STRK',
            ).toUpperCase() === 'WBTC' ? 'WBTC' : 'STRK'
            const hasActiveBeforeSwitch = Number(beforeSwitchState?.principal_strk || 0) > 0 || Number(beforeSwitchState?.queued_exit_strk || 0) > 0
            if (currentPoolSymbol !== activeSymbol && hasActiveBeforeSwitch) {
              throw new Error(`Active ${currentPoolSymbol} position detected. Withdraw before switching pool.`)
            }
            if (currentPoolSymbol !== activeSymbol) {
              await dojoManager.yieldSetBtcMode(desiredBtcMode).catch(() => {})
            }
            const latest = await dojoManager.queryYieldState(currentAccount.address).catch(() => cachedYieldState || null)
            const principal = Number(latest?.principal_strk || 0)
            const queuedExit = Number(latest?.queued_exit_strk || 0)
            if (principal > 0) {
              const tx = await dojoManager.yieldWithdraw(principal)
              txHash = String(tx?.transaction_hash || '')
              console.info('[Unstake] Dojo withdraw success', {
                user: currentAccount.address,
                principal,
                txHash,
              })
              addActivityEvent({
                actionType: 'unstake_intent',
                token: activeSymbol,
                amount: principal,
                providerPath,
                txHash,
                status: 'success',
              })
              showToast(`Unstake requested: ${principal.toFixed(2)} ${activeSymbol}${txHash ? ` · ${shortTxHash(txHash)}` : ''}`)
              await updateWalletInfo()
              return
            }
            if (queuedExit > 0) {
              const beforeBalance = await getChainBalance(currentAccount.address).catch(() => null)
              const tx = await dojoManager.yieldProcessExitQueue(currentAccount.address)
              txHash = String(tx?.transaction_hash || '')
              console.info('[Unstake] Dojo queue processing success', {
                user: currentAccount.address,
                queuedExit,
                txHash,
              })
              const afterBalance = await getChainBalance(currentAccount.address).catch(() => null)
              const delta = Number(afterBalance ?? 0) - Number(beforeBalance ?? 0)
              addActivityEvent({
                actionType: 'unstake_exit',
                token: activeSymbol,
                amount: Math.max(0, delta || 0),
                providerPath,
                txHash,
                status: 'success',
              })
              if (delta > 0.0000001) {
                showToast(`Returned to balance: +${delta.toFixed(4)} ${activeSymbol}${txHash ? ` · ${shortTxHash(txHash)}` : ''}`)
              } else {
                showToast(`Unstake queued/cooldown active. Try again in a bit.${txHash ? ` · ${shortTxHash(txHash)}` : ''}`)
              }
              await updateWalletInfo()
              return
            }
            showToast('No staked or unstaking funds to return.')
          }))
        } catch (error) {
          console.error('Yield withdraw error:', error)
          addActivityEvent({
            actionType: 'unstake',
            token: String((cachedYieldState?.pool_token_symbol || 'STRK')).toUpperCase() === 'WBTC' ? 'WBTC' : 'STRK',
            amount: 0,
            providerPath: 'unknown',
            txHash: '',
            status: 'failed',
            errorMessage: String(error?.message || 'Unknown error'),
          })
          alert('Return-to-balance action failed. Try again in a moment.')
        }
      }
    }

    const walletYieldClaimBtn = document.getElementById('wallet-yield-claim-btn')
    if (walletYieldClaimBtn) {
      walletYieldClaimBtn.onclick = async () => {
        try {
          const preferred = String((cachedYieldState?.pool_token_symbol || 'STRK')).toUpperCase() === 'WBTC' ? 'WBTC' : 'STRK'
          const selectedSymbol = await askYieldToken('Claim rewards', preferred)
          if (!selectedSymbol) return
          await runExclusiveYieldAction('claim', async () => runWithBusyButton(walletYieldClaimBtn, {
            idleText: yieldClaimBtnLabel,
            busyText: 'Claiming...',
            pendingToast: 'Confirm claim in wallet. Waiting for chain confirmation...',
          }, async () => {
            const activeSymbol = selectedSymbol
            const desiredBtcMode = activeSymbol === 'WBTC'
            const beforeSwitchState = await dojoManager.queryYieldState(currentAccount.address).catch(() => cachedYieldState || null)
            const currentPoolSymbol = String(
              beforeSwitchState?.pool_token_symbol || (beforeSwitchState?.use_btc_mode ? 'WBTC' : 'STRK') || 'STRK',
            ).toUpperCase() === 'WBTC' ? 'WBTC' : 'STRK'
            const hasActiveBeforeSwitch = Number(beforeSwitchState?.principal_strk || 0) > 0 || Number(beforeSwitchState?.queued_exit_strk || 0) > 0
            if (currentPoolSymbol !== activeSymbol && hasActiveBeforeSwitch) {
              throw new Error(`Active ${currentPoolSymbol} position detected. Withdraw before switching pool.`)
            }
            if (currentPoolSymbol !== activeSymbol) {
              await dojoManager.yieldSetBtcMode(desiredBtcMode).catch(() => {})
            }
            const beforeState = await dojoManager.queryYieldState(currentAccount.address).catch(() => cachedYieldState || null)
            const beforePending = Number(beforeState?.pending_strk || 0)
            console.info('[Claim] Start', {
              user: currentAccount.address,
              symbol: activeSymbol,
              beforePending,
              beforePrincipal: Number(beforeState?.principal_strk || 0),
            })
            if (!Number.isFinite(beforePending) || beforePending <= 0) {
              console.info('[Claim] Skipped: no claimable rewards', {
                user: currentAccount.address,
                symbol: activeSymbol,
                beforePending,
              })
              addActivityEvent({
                actionType: 'claim',
                token: activeSymbol,
                amount: 0,
                providerPath: 'none',
                txHash: '',
                status: 'skipped',
                errorMessage: 'No claimable rewards yet.',
              })
              showToast(`No claimable ${activeSymbol} rewards yet. No transaction sent.`)
              return
            }
            const beforeBalance = await getChainBalance(currentAccount.address).catch(() => null)
            let txHash = ''
            let providerPath = 'dojo'
            if (starkzapManager && IS_SEPOLIA) {
              try {
                const res = await starkzapManager.claimRewards(activeSymbol)
                txHash = String(res?.tx?.hash || '')
                providerPath = 'starkzap'
              } catch (starkzapError) {
                console.error('[Claim] Starkzap failed message:', starkzapError?.message || String(starkzapError))
                console.warn('Starkzap claim failed, falling back to Dojo claim:', starkzapError)
                if (isControllerInitError(starkzapError)) {
                  showToast('Controller did not open correctly (popup/cookies). Using standard claim flow...')
                } else {
                  showToast('Starkzap claim failed. Falling back to standard claim flow...')
                }
                const tx = await dojoManager.claimPoolRewards()
                txHash = String(tx?.transaction_hash || '')
                providerPath = 'dojo-fallback'
              }
            } else {
              const tx = await dojoManager.claimPoolRewards()
              txHash = String(tx?.transaction_hash || '')
            }
            console.info('[Claim] Transaction submitted', {
              user: currentAccount.address,
              symbol: activeSymbol,
              txHash,
            })
            const afterState = await dojoManager.queryYieldState(currentAccount.address).catch(() => cachedYieldState || null)
            const afterPending = Number(afterState?.pending_strk || 0)
            const claimedByState = Math.max(0, beforePending - Math.max(0, afterPending))
            const afterBalance = await getChainBalance(currentAccount.address).catch(() => null)
            const deltaBalance = Number(afterBalance ?? 0) - Number(beforeBalance ?? 0)
            const txLabel = shortTxHash(txHash)
            console.info('[Claim] Result', {
              user: currentAccount.address,
              symbol: activeSymbol,
              txHash,
              beforePending,
              afterPending,
              claimedByState,
              beforeBalance: Number(beforeBalance ?? 0),
              afterBalance: Number(afterBalance ?? 0),
              deltaBalance,
            })
            if (claimedByState > 0.0000001 || deltaBalance > 0.0000001) {
              const amount = Math.max(claimedByState, deltaBalance)
              addActivityEvent({
                actionType: 'claim',
                token: activeSymbol,
                amount,
                providerPath,
                txHash,
                status: 'success',
              })
              showToast(`Claim confirmed +${amount.toFixed(6)} ${activeSymbol}${txLabel ? ` · ${txLabel}` : ''}`)
            } else {
              addActivityEvent({
                actionType: 'claim',
                token: activeSymbol,
                amount: 0,
                providerPath,
                txHash,
                status: 'success',
              })
              showToast(`Claim tx confirmed${txLabel ? ` · ${txLabel}` : ''}, but no balance/reward delta yet.`)
            }
            await updateWalletInfo()
          }))
        } catch (error) {
          console.error('Yield claim error:', error)
          addActivityEvent({
            actionType: 'claim',
            token: String((cachedYieldState?.pool_token_symbol || 'STRK')).toUpperCase() === 'WBTC' ? 'WBTC' : 'STRK',
            amount: 0,
            providerPath: 'unknown',
            txHash: '',
            status: 'failed',
            errorMessage: String(error?.message || 'Unknown error'),
          })
          alert('Claim rewards failed. Try again in a moment.')
        }
      }
    }

  } catch (error) {
    console.error('Error updating wallet info:', error)
    const shortAddr = currentAccount ? (String(currentAccount.address).slice(0, 6) + '...' + String(currentAccount.address).slice(-4)) : ''
    walletInfo.innerHTML = `<span style="color: #4CAF50;">● ${currentUsername || shortAddr}</span>`
  }
}


// Inicializar cuando el DOM esté listo
function initApp() {
  try {
    const btn = document.getElementById('connect-wallet')
    if (btn) btn.addEventListener('click', connectWallet)
    tryRestoreSessionOnLoad().catch((e) => console.warn('Session restore:', e))
  } catch (e) {
    console.error('Init error:', e)
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp)
} else {
  initApp()
}