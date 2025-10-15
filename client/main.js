import './style.css'
import { InfiniteCanvas } from './canvas.js'
import { PostManager } from './postManager.js'
import { DojoManager } from './dojoManager.js'
import Controller from '@cartridge/controller'
import { init as initDojo, KeysClause, ToriiQueryBuilder } from '@dojoengine/sdk'
import controllerOpts from './controller.js'
import manifest from '../contracts/manifest_dev.json' assert { type: 'json' }

const DOMAIN_SEPARATOR = {
  name: 'di',
  version: '1.0',
  chainId: 'KATANA',
  revision: '1',
}

let canvas, postManager, dojoManager, controller, currentUsername

// Initialize controller once on page load
controller = new Controller(controllerOpts)

async function connectWallet() {
  const connectScreen = document.getElementById('connect-screen')
  const connectStatus = document.getElementById('connect-status')
  const connectButton = document.getElementById('connect-wallet')
  const canvasElement = document.getElementById('canvas')
  const controlsElement = document.getElementById('controls')
  const walletInfo = document.getElementById('wallet-info')
  
  try {
    connectButton.disabled = true
    connectButton.textContent = '⏳ Connecting...'
    connectStatus.textContent = 'Opening Cartridge Controller...'
    connectStatus.style.color = '#4CAF50'
    
    console.log('Connecting to wallet...')
    const account = await controller.connect()
    console.log('✓ Wallet connected:', account.address)
    currentUsername = await controller.username()
    console.log('✓ Username:', currentUsername)
    
    connectStatus.textContent = 'Wallet connected! Loading blockchain...'
    
    // Initialize Dojo
    const toriiClient = await initDojo({
      client: {
        worldAddress: manifest.world.address,
        toriiUrl: 'http://localhost:8080',
      },
      domain: DOMAIN_SEPARATOR,
    })
    console.log('✓ Torii client initialized')
    
    // Initialize canvas and managers
    canvas = new InfiniteCanvas(canvasElement)
    dojoManager = new DojoManager(account, manifest, toriiClient)
    postManager = new PostManager(canvas, dojoManager)
    
    // Setup UI handlers
    setupUIHandlers()
    
    // Load posts
    connectStatus.textContent = 'Loading posts...'
    await postManager.loadPosts()
    console.log('✓ Loaded', postManager.posts.length, 'posts')
    
    if (postManager.posts.length > 0) {
      const firstPost = postManager.posts[0]
      canvas.centerOn(firstPost.x_position, firstPost.y_position, 0.3)
    } else {
      canvas.centerOn(0, 0, 0.3)
    }
    
    // Subscribe to updates
    await subscribeToPostUpdates(toriiClient)
    console.log('✓ Subscribed to updates')
    
    // Show UI
    connectScreen.style.display = 'none'
    canvasElement.style.display = 'block'
    controlsElement.style.display = 'flex'
    
    // Show wallet username
    walletInfo.innerHTML = `<span style="color: #4CAF50;">● ${currentUsername || account.address.slice(0, 6) + '...' + account.address.slice(-4)}</span>`
    
    console.log('✓ App ready!')
    
  } catch (error) {
    console.error('Connection error:', error)
    connectButton.disabled = false
    connectButton.textContent = '🎮 Connect Wallet'
    connectStatus.innerHTML = `
      <span style="color: #f44336;">❌ ${error.message || 'Connection failed'}</span><br>
      <small>Check console for details</small>
    `
  }
}

function setupUIHandlers() {
  const modal = document.getElementById('modal')
  const postForm = document.getElementById('postForm')
  const imageUrlInput = document.getElementById('imageUrl')
  const captionInput = document.getElementById('caption')
  const postSizeInput = document.getElementById('postSize')
  const isPaidInput = document.getElementById('isPaid')
  
  const addPostBtn = document.getElementById('addPost')
  const addPaidPostBtn = document.getElementById('addPaidPost')
  const resetViewBtn = document.getElementById('resetView')
  const cancelPostBtn = document.getElementById('cancelPost')
  
  addPostBtn.addEventListener('click', () => {
    postSizeInput.value = '1'
    isPaidInput.value = 'false'
    modal.classList.add('active')
    imageUrlInput.focus()
  })

  addPaidPostBtn.addEventListener('click', () => {
    postSizeInput.value = '1'
    isPaidInput.value = 'true'
    modal.classList.add('active')
    imageUrlInput.focus()
  })

  cancelPostBtn.addEventListener('click', () => {
    modal.classList.remove('active')
    postForm.reset()
  })

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.remove('active')
      postForm.reset()
    }
  })

  postForm.addEventListener('submit', async (e) => {
    e.preventDefault()

    const imageUrl = imageUrlInput.value
    const caption = captionInput.value
    const size = parseInt(postSizeInput.value)
    const isPaid = isPaidInput.value === 'true'

    try {
      await postManager.createPost(imageUrl, caption, currentUsername, size, isPaid)
      modal.classList.remove('active')
      postForm.reset()
    } catch (error) {
      console.error('Error creating post:', error)
      alert('Failed to create post. Please try again.')
    }
  })

  resetViewBtn.addEventListener('click', () => {
    if (postManager.posts.length > 0) {
      const firstPost = postManager.posts[0]
      canvas.centerOn(firstPost.x_position, firstPost.y_position, 0.3)
    } else {
      canvas.centerOn(0, 0, 0.3)
    }
  })
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

// Setup connect button
document.getElementById('connect-wallet').addEventListener('click', connectWallet)