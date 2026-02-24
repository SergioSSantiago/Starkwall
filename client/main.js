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
  canvas.setPostClickHandler((post) => showPostDetails(post))

  connectStatus.textContent = 'Loading posts...'
  await postManager.loadPosts()
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

// Exponer toast para otros módulos (postManager.js)
globalThis.showToast = showToast

/** Límite del contrato: cada ByteArray puede tener como mucho 300 "chunks" de 31 bytes = 9300 bytes. */
const CONTRACT_MAX_BYTES_PER_FIELD = 300 * 31

/** Redimensiona y comprime una imagen hasta que quepa en el contrato (data URL <= CONTRACT_MAX_BYTES_PER_FIELD). */
function resizeImageToDataUrlWithMaxLength(fileOrDataUrl, maxBytes = CONTRACT_MAX_BYTES_PER_FIELD - 200) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src)
      const canvas = document.createElement('canvas')
      const tries = [
        { w: 393, h: 852, q: 0.5 },
        { w: 280, h: 606, q: 0.45 },
        { w: 200, h: 434, q: 0.4 },
        { w: 150, h: 325, q: 0.35 },
        { w: 120, h: 260, q: 0.3 }
      ]
      for (const { w, h, q } of tries) {
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, w, h)
        const dataUrl = canvas.toDataURL('image/jpeg', q)
        if (dataUrl.length <= maxBytes) {
          resolve(dataUrl)
          return
        }
      }
      const last = tries[tries.length - 1]
      canvas.width = last.w
      canvas.height = last.h
      canvas.getContext('2d').drawImage(img, 0, 0, last.w, last.h)
      resolve(canvas.toDataURL('image/jpeg', 0.25))
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
  const photoPreview = document.getElementById('photoPreview')
  const photoPlaceholder = document.getElementById('photoPlaceholder')
  const photoPreviewImg = document.getElementById('photoPreviewImg')
  const btnChoosePhoto = document.getElementById('btnChoosePhoto')
  const btnGallery = document.getElementById('btnGallery')
  const removePhotoBtn = document.getElementById('removePhoto')
  const submitPostBtn = document.getElementById('submitPostBtn')
  const paidPostOptions = document.getElementById('paidPostOptions')
  const paidPostPriceEl = document.getElementById('paidPostPrice')
  const postSizeRadios = document.querySelectorAll('input[name="postSizeRadio"]')

  const addPostBtn = document.getElementById('addPost')
  const addPaidPostBtn = document.getElementById('addPaidPost')
  const cancelPostBtn = document.getElementById('cancelPost')

  function updatePaidPriceLabel() {
    const size = parseInt(postSizeInput.value) || 2
    const price = PostManager.getPriceForPaidPost(size)
    paidPostPriceEl.textContent = `${price} STRK`
    if (isPaidInput.value === 'true') {
      submitPostBtn.textContent = `Create Paid Post (${price} STRK)`
    }
  }

  const webcamModal = document.getElementById('webcamModal')
  const webcamVideo = document.getElementById('webcamVideo')
  const webcamCaptureBtn = document.getElementById('webcamCapture')
  const webcamCancelBtn = document.getElementById('webcamCancel')
  let webcamStream = null

  function setPhotoFromDataUrl(dataUrl) {
    if (!dataUrl) return
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
  removePhotoBtn.addEventListener('click', clearPhoto)
  // En desktop ya no usamos el input con capture; Cámara abre la webcam
  // (imageFileCameraInput se mantiene por si en móvil quieres priorizar cámara nativa)

  addPostBtn.addEventListener('click', () => {
    postSizeInput.value = '1'
    isPaidInput.value = 'false'
    paidPostOptions.style.display = 'none'
    submitPostBtn.textContent = 'Create Post'
    clearPhoto()
    modal.classList.add('active')
  })

  addPaidPostBtn.addEventListener('click', () => {
    postSizeInput.value = '2'
    isPaidInput.value = 'true'
    paidPostOptions.style.display = 'block'
    postSizeRadios.forEach((r) => { r.checked = r.value === '2' })
    updatePaidPriceLabel()
    clearPhoto()
    modal.classList.add('active')
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
    submitPostBtn.textContent = 'Create Post'
  })

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.remove('active')
      postForm.reset()
      clearPhoto()
      paidPostOptions.style.display = 'none'
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

    if (!imageUrl) {
      alert('Elige una foto para tu post.')
      return
    }

    if (isPaid) {
      if (!currentAccount) return
      const price = PostManager.getPriceForPaidPost(size)
      // Siempre leer balance actual de storage, restar coste y guardar (nunca usar un balance “viejo”).
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

    submitPostBtn.disabled = true
    const previousBtnText = submitPostBtn.textContent
    submitPostBtn.textContent = 'Creando...'
    try {
      await postManager.createPost(imageUrl, caption, username, size, isPaid, () => {
        // Cerrar modal en cuanto el post se haya creado (callback desde postManager)
        document.getElementById('modal').classList.remove('active')
        postForm.reset()
        clearPhoto()
        paidPostOptions.style.display = 'none'
        submitPostBtn.disabled = false
        submitPostBtn.textContent = 'Create Post'
        updateWalletInfo().catch(() => {})
      })
    } catch (error) {
      console.error('Error creating post:', error)
      alert('No se pudo crear el post: ' + (error?.message || error || 'Unknown error'))
      submitPostBtn.disabled = false
      submitPostBtn.textContent = isPaid ? `Create Paid Post (${PostManager.getPriceForPaidPost(size)} STRK)` : 'Create Post'
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

  // Post details modal handlers
  setupPostDetailsHandlers()
}

function setupPostDetailsHandlers() {
  const postDetailsModal = document.getElementById('postDetailsModal')
  const closePostDetailsBtn = document.getElementById('closePostDetails')
  const sellPostBtn = document.getElementById('sellPostBtn')
  const removeSaleBtn = document.getElementById('removeSaleBtn')
  const buyPostBtn = document.getElementById('buyPostBtn')
  const salePriceInput = document.getElementById('salePriceInput')
  const salePriceRow = document.getElementById('salePriceRow')

  let currentPost = null

  closePostDetailsBtn.addEventListener('click', () => {
    postDetailsModal.classList.remove('active')
    currentPost = null
  })

  postDetailsModal.addEventListener('click', (e) => {
    if (e.target === postDetailsModal) {
      postDetailsModal.classList.remove('active')
      currentPost = null
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

    const price = currentPost.sale_price
    const buyerAddress = currentAccount.address
    const sellerAddress = currentPost.current_owner

    // Check if user has enough STRK
    const buyerBalance = await getChainBalance(buyerAddress)
    if (buyerBalance < price) {
      alert(`Insufficient balance! You have ${buyerBalance} STRK but need ${price} STRK`)
      return
    }

    if (!confirm(`Buy this post for ${price} STRK?`)) {
      return
    }

    try {
      if (dojoManager) {
        postDetailsModal.classList.remove('active')
        
        await dojoManager.buyPostWithPayment(currentPost.id, sellerAddress, price)
        
        // Wait for Torii to index
        await new Promise(resolve => setTimeout(resolve, 5000))
        await postManager.loadPosts()
        await postManager.loadImages()
        canvas.setPosts(postManager.posts)
        await updateWalletInfo()
      }
    } catch (error) {
      console.error('Error buying post:', error)
      alert('Failed to buy post: ' + (error.message || 'Unknown error'))
      postDetailsModal.classList.remove('active')
    }
  })

  // Store reference for showPostDetails
  window.postDetailsHandlers = {
    setCurrentPost: (post) => { currentPost = post }
  }
}

function showPostDetails(post) {
  const postDetailsModal = document.getElementById('postDetailsModal')
  const postCreator = document.getElementById('postCreator')
  const postCaption = document.getElementById('postCaption')
  const postCurrentOwner = document.getElementById('postCurrentOwner')
  const postSaleInfo = document.getElementById('postSaleInfo')
  const sellPostBtn = document.getElementById('sellPostBtn')
  const removeSaleBtn = document.getElementById('removeSaleBtn')
  const buyPostBtn = document.getElementById('buyPostBtn')
  const salePriceInput = document.getElementById('salePriceInput')
  const salePriceRow = document.getElementById('salePriceRow')

  // Set current post
  window.postDetailsHandlers.setCurrentPost(post)

  // Update content
  postCreator.textContent = post.creator_username || 'Unknown'
  postCaption.textContent = post.caption || 'No caption'

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
  if (salePriceRow) salePriceRow.style.display = 'none'

  if (post.sale_price > 0) {
    postSaleInfo.innerHTML = `<strong>💰 FOR SALE:</strong> ${post.sale_price} STRK`
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
      console.log('✅ Showing sell button for owned post')
      sellPostBtn.style.display = 'inline-block'
      if (salePriceRow) salePriceRow.style.display = 'block'
      if (salePriceInput && !salePriceInput.value) salePriceInput.value = '10'
    } else {
      console.log('❌ Not owner - buttons hidden')
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
          await postManager.loadImages()
          canvas.setPosts(postManager.posts)
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

async function updateWalletInfo() {
  const walletInfo = document.getElementById('wallet-info')
  if (!currentAccount) return
  try {
    const balance = await getChainBalance(currentAccount.address)
    const num = Number(balance)
    const balanceStr = Number.isFinite(num) ? num.toFixed(2) : '0.00'
    const addr = String(currentAccount.address)
    const shortAddr = addr.slice(0, 6) + '...' + addr.slice(-4)
    walletInfo.innerHTML = `
      <div class="wallet-box">
        <span class="wallet-user">● ${currentUsername || shortAddr}</span>
        <span class="wallet-balance">💰 ${balanceStr} STRK</span>
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