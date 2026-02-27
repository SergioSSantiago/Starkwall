import './style.css'
import { InfiniteCanvas } from './canvas.js'
import { PostManager } from './postManager.js'
import { DojoManager } from './dojoManager.js'
import Controller from '@cartridge/controller'
import { init as initDojo, KeysClause, ToriiQueryBuilder } from '@dojoengine/sdk'
import controllerOpts from './controller.js'
import manifest from './manifest.js'
import { DOMAIN_CHAIN_ID, TORII_URL, IS_SEPOLIA, FAUCET_URL } from './config.js'

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
let socialOnchainAvailable = hasOnchainSocialInManifest
let socialOnchainWarned = false

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
  mergeFallbackIntoSocialState()
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

function updateMobileSocialButtons(followingCount = 0, followersCount = 0) {
  const mobileFollowingBtn = document.getElementById('mobileFollowingBtn')
  if (mobileFollowingBtn) mobileFollowingBtn.textContent = `Following ${Number(followingCount) || 0}`

  const mobileFollowersBtn = document.getElementById('mobileFollowersBtn')
  if (mobileFollowersBtn) mobileFollowersBtn.textContent = `Followers ${Number(followersCount) || 0}`
}

function syncMobileSocialButtonsFromState() {
  const me = normalizeSocialAddress(currentAccount?.address)
  if (!me) {
    updateMobileSocialButtons(0, 0)
    return
  }
  const { following, followers } = getSocialFollowersFollowing(me)
  updateMobileSocialButtons(following.length, followers.length)
}

function scheduleSocialRevalidation(delayMs = 800) {
  if (socialRevalidationTimer) clearTimeout(socialRevalidationTimer)
  socialRevalidationTimer = setTimeout(async () => {
    socialRevalidationTimer = null
    await refreshSocialData().catch(() => {})
    await updateWalletInfo().catch(() => {})
    syncMobileSocialButtonsFromState()

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

  const toriiClient = await initDojo({
    client: {
      worldAddress: manifest.world.address,
      toriiUrl: TORII_URL,
    },
    domain: DOMAIN_SEPARATOR,
  })
  console.log('✓ Torii client initialized')

  canvas = new InfiniteCanvas(canvasElement)
  dojoManager = new DojoManager(currentAccount, manifest, toriiClient)
  postManager = new PostManager(canvas, dojoManager)

  setupUIHandlers()
  canvas.setPostClickHandler((post) => showPostDetails(post, 'canvas'))

  connectStatus.textContent = 'Loading posts...'
  await postManager.loadPosts()
  rememberUsersFromPosts(postManager.posts)
  await refreshSocialData().catch(() => {})

  // Keep wallet connect flow read-only: do not auto-send profile tx here.
  // Some wallets/sessions may still resolve stale policies/contracts and fail on connect.

  console.log('✓ Loaded', postManager.posts.length, 'posts')

  if (postManager.posts.length > 0) {
    const firstPost = postManager.posts[0]
    canvas.centerOn(firstPost.x_position, firstPost.y_position, 0.3)
  } else {
    canvas.centerOn(0, 0, 0.3)
  }

  await subscribeToPostUpdates(toriiClient)
  console.log('✓ Subscribed to updates')

  document.getElementById('loading-screen').style.display = 'none'
  connectScreen.style.display = 'none'
  canvasElement.style.display = 'block'
  controlsElement.style.display = 'flex'
  connectButton.disabled = false
  connectButton.textContent = '🎮 Connect Wallet'

  await updateWalletInfo()
  const logoutBtn = document.getElementById('logout-btn')
  if (logoutBtn) logoutBtn.onclick = () => logout()
  console.log('✓ App ready!')
}

// Cartridge Controller helper.
//
// Cartridge Controller uses a keychain iframe (not a browser extension). In Firefox,
// strict tracking/cookie settings can block iframe storage and make Controller init
// fail early. We lazy-init and provide a clearer message in connect flow.
let controllerInitError = null

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

async function tryAutoFinalizeAuctionSlot(post, source = 'auto') {
  if (!dojoManager || !postManager || !post) return false

  const isAuctionSlot = Number(post.post_kind) === 2
  const slot = post.auction_slot || null
  const group = post.auction_group || null
  if (!isAuctionSlot || !slot || !group || slot.finalized) return false

  const now = Math.floor(Date.now() / 1000)
  const ended = now >= Number(group.end_time || 0)
  if (!ended) return false

  const slotId = Number(post.id)
  if (!Number.isFinite(slotId) || autoFinalizingSlots.has(slotId)) return false

  autoFinalizingSlots.add(slotId)
  try {
    console.log(`⏱️ Auto-finalizing slot ${slotId} (source: ${source})`)
    await dojoManager.finalizeAuctionSlot(slotId)
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
    if (!slot || !group || slot.finalized) return false
    const now = Math.floor(Date.now() / 1000)
    return now >= Number(group.end_time || 0)
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
    const account = await c.connect()
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
    const account = await c.probe()
    if (account) {
      await enterApp(account)
      return
    }
  } catch (e) {
    console.warn('probe() restore failed:', e?.message || e)
  }

  showConnect()
}

function setupUIHandlers() {
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

  const addPostBtn = document.getElementById('addPost')
  const addPaidPostBtn = document.getElementById('addPaidPost')
  const addAuctionPostBtn = document.getElementById('addAuctionPost')
  const sendStrkBtn = document.getElementById('sendStrkBtn')
  const cancelPostBtn = document.getElementById('cancelPost')

  const sendStrkModal = document.getElementById('sendStrkModal')
  const sendStrkForm = document.getElementById('sendStrkForm')
  const sendStrkRecipient = document.getElementById('sendStrkRecipient')
  const sendStrkAmount = document.getElementById('sendStrkAmount')
  const cancelSendStrkBtn = document.getElementById('cancelSendStrkBtn')
  const confirmSendStrkBtn = document.getElementById('confirmSendStrkBtn')

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
    const raw = String(auctionEndAtInput?.value || '')
    const endMs = Date.parse(raw)
    if (!raw || !Number.isFinite(endMs)) {
      auctionEndPreview.textContent = 'Displayed in your local timezone and UTC.'
      return
    }

    const endDate = new Date(endMs)
    const localLabel = endDate.toLocaleString()
    const utcLabel = endDate.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    const remaining = formatRemaining(Math.floor((endMs - Date.now()) / 1000))
    auctionEndPreview.textContent = `Ends (local): ${localLabel} | Ends (UTC): ${utcLabel} | Remaining: ${remaining}`
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
    } else if (!isPaid) {
      submitPostBtn.textContent = 'Create Post'
      if (auctionEndPreview) auctionEndPreview.textContent = 'Displayed in your local timezone and UTC.'
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

  if (sendStrkBtn) {
    sendStrkBtn.addEventListener('click', openSendStrkModal)
  }

  if (cancelSendStrkBtn) {
    cancelSendStrkBtn.addEventListener('click', closeSendStrkModal)
  }

  if (sendStrkModal) {
    sendStrkModal.addEventListener('click', (e) => {
      if (e.target === sendStrkModal) closeSendStrkModal()
    })
  }

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
    if (isAuction) {
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
          if (isAuctionInput) isAuctionInput.value = 'false'
          submitPostBtn.disabled = false
          submitPostBtn.textContent = 'Create Post'
          updateWalletInfo().catch(() => {})
        })
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

  const mobileMyFeedBtn = document.getElementById('mobileMyFeedBtn')
  const mobileFollowingBtn = document.getElementById('mobileFollowingBtn')
  const mobileFollowersBtn = document.getElementById('mobileFollowersBtn')

  if (mobileMyFeedBtn) {
    mobileMyFeedBtn.onclick = () => {
      const me = normalizeSocialAddress(currentAccount?.address)
      if (!me) return
      renderOwnerFeed(me, String(currentUsername || '').trim())
    }
  }
  if (mobileFollowingBtn) {
    mobileFollowingBtn.onclick = async () => { await openFollowingModal() }
  }
  if (mobileFollowersBtn) {
    mobileFollowersBtn.onclick = async () => { await openFollowersModal() }
  }

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
  const finalizeAuctionBtn = document.getElementById('finalizeAuctionBtn')
  const initializeSlotContentBtn = document.getElementById('initializeSlotContentBtn')
  const salePriceInput = document.getElementById('salePriceInput')
  const salePriceRow = document.getElementById('salePriceRow')
  const auctionBidInput = document.getElementById('auctionBidInput')
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
  const finalizeAuctionBtn = document.getElementById('finalizeAuctionBtn')
  const initializeSlotContentBtn = document.getElementById('initializeSlotContentBtn')
  const salePriceInput = document.getElementById('salePriceInput')
  const salePriceRow = document.getElementById('salePriceRow')
  const auctionBidRow = document.getElementById('auctionBidRow')
  const auctionBidInput = document.getElementById('auctionBidInput')

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
  if (finalizeAuctionBtn) finalizeAuctionBtn.style.display = 'none'
  if (initializeSlotContentBtn) initializeSlotContentBtn.style.display = 'none'
  if (salePriceRow) salePriceRow.style.display = 'none'
  if (auctionBidRow) auctionBidRow.style.display = 'none'
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
    const ended = now >= Number(group.end_time || 0)

    if (postAuctionInfo) {
      const highest = Number(slot.highest_bid || 0)
      const bidder = slot.has_bid
        ? String(slot.highest_bidder || '').slice(0, 8) + '...' + String(slot.highest_bidder || '').slice(-6)
        : 'No bids yet'
      const endTs = Number(group.end_time || 0)
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
      postAuctionInfo.innerHTML = '<strong>Auction Slot</strong><br/>Highest bid: ' + highest + ' STRK<br/>Highest bidder: ' + bidder + '<br/>Ends (local): ' + endLocal + '<br/>Ends (UTC): ' + endUtc + '<br/>Remaining: ' + remainingLabel + '<br/>Finalized: ' + (slot.finalized ? 'Yes' : 'No') + '<br/>Content published: ' + (slot.content_initialized ? 'Yes' : 'No') + (slot.finalized && slot.has_bid ? '<br/>Proceeds: paid to creator' : '')
      postAuctionInfo.style.display = 'block'
      postAuctionInfo.style.color = '#9ecbff'
    }

    if (!slot.finalized) {
      postSaleInfo.textContent = ended ? 'Auction ended. Finalize to settle winner.' : 'Auction in progress'
      postSaleInfo.style.color = '#9ecbff'
      if (ended) {
        postSaleInfo.textContent = 'Auction ended. Finalizing automatically...'
        postSaleInfo.style.color = '#9ecbff'
        void tryAutoFinalizeAuctionSlot(post, 'post-details')
      } else {
        if (auctionBidRow) auctionBidRow.style.display = 'block'
        if (auctionBidInput) auctionBidInput.value = String(Math.max(1, Number(slot.highest_bid || 0) + 1))
        if (placeBidBtn) placeBidBtn.style.display = 'inline-block'
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
          if (activeOwnerFeedAddress) renderOwnerFeed(activeOwnerFeedAddress, activeOwnerFeedUsername)
        }
        if (error) {
          console.error('Subscription error:', error)
        }
      },
    })
    
    window.addEventListener('beforeunload', () => {
      if (subscription) {
        subscription.cancel()
      }
    })
    
    console.log('✓ Subscribed to Post entity updates')
  } catch (error) {
    console.warn('Failed to subscribe to updates:', error)
    // Non-fatal error, app can still work without subscriptions
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
      const highest = Number(post.auction_slot?.highest_bid || 0)
      const endTs = Number(post.auction_group?.end_time || 0)
      const now = Math.floor(Date.now() / 1000)
      const remaining = Math.max(0, endTs - now)
      const h = Math.floor(remaining / 3600)
      const m = Math.floor((remaining % 3600) / 60)

      ctx.fillStyle = '#9ecbff'
      ctx.textAlign = 'center'
      ctx.font = 'bold 16px sans-serif'
      ctx.fillText('AUCTION SLOT', width / 2, 70)
      ctx.font = '13px sans-serif'
      ctx.fillText(`Highest: ${highest} STRK`, width / 2, 105)
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

  const displayName = String(ownerUsername || '').trim() || `${normalizedOwner.slice(0, 8)}...${normalizedOwner.slice(-6)}`
  const ownerPosts = sortPostsNewestFirst(
    dedupePostsById((postManager?.posts || []).filter((post) =>
      normalizeSocialAddress(post?.current_owner) === normalizedOwner
    ))
  )

  if (titleEl) titleEl.textContent = `${displayName} · Posts`
  if (subtitleEl) subtitleEl.textContent = normalizedOwner
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
  const ownerFeedToCanvasBtn = document.getElementById('ownerFeedToCanvasBtn')

  closeFollowersBtn?.addEventListener('click', () => closeSocialModalById('followersModal'))
  closeFollowingBtn?.addEventListener('click', () => closeSocialModalById('followingModal'))
  closeOwnerFeedBtn?.addEventListener('click', () => closeOwnerFeedView())
  ownerFeedToCanvasBtn?.addEventListener('click', () => closeOwnerFeedView())

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
  try {
    const balance = await getChainBalance(currentAccount.address)
    await ensureSocialDataLoaded().catch(() => {})
    const me = normalizeSocialAddress(currentAccount.address)
    const { following, followers } = getSocialFollowersFollowing(me)
    const num = Number(balance)
    const balanceStr = Number.isFinite(num) ? num.toFixed(2) : '0.00'
    const addr = normalizeStarknetAddress(currentAccount.address)
    const shortAddr = addr.slice(0, 8) + '...' + addr.slice(-6)
    walletInfo.innerHTML = `
      <div class="wallet-box">
        <div class="wallet-top-row">
          <div class="wallet-stats">
            <button id="following-count-btn" class="wallet-stat-btn" type="button">Following ${following.length}</button>
            <button id="followers-count-btn" class="wallet-stat-btn" type="button">Followers ${followers.length}</button>
          </div>
          <div class="wallet-main">
            <span class="wallet-user">● ${currentUsername || shortAddr}</span>
            <span class="wallet-balance">💰 ${balanceStr} STRK</span>
          </div>
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
      followingBtn.onclick = async () => { await openFollowingModal() }
    }

    const followersBtn = document.getElementById('followers-count-btn')
    if (followersBtn) {
      followersBtn.onclick = async () => { await openFollowersModal() }
    }

    updateMobileSocialButtons(following.length, followers.length)
  } catch (error) {
    console.error('Error updating wallet info:', error)
    const shortAddr = currentAccount ? (String(currentAccount.address).slice(0, 6) + '...' + String(currentAccount.address).slice(-4)) : ''
    walletInfo.innerHTML = `<span style="color: #4CAF50;">● ${currentUsername || shortAddr}</span>`
    syncMobileSocialButtonsFromState()
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