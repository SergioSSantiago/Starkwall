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

let canvas, postManager, dojoManager, controller, currentUsername, currentAccount
let mockStrkBalances = {} // Map of address -> balance

// Initialize controller once on page load
controller = new Controller(controllerOpts)

// Helper to get/set balance
function getBalance(address) {
  const normalizedAddress = address.toString().toLowerCase()
  if (!mockStrkBalances[normalizedAddress]) {
    mockStrkBalances[normalizedAddress] = 1000 // Default starting balance
  }
  return mockStrkBalances[normalizedAddress]
}

function setBalance(address, amount) {
  const normalizedAddress = address.toString().toLowerCase()
  mockStrkBalances[normalizedAddress] = amount
}

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
    currentAccount = await controller.connect()
    console.log('✓ Wallet connected:', currentAccount.address)
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
    dojoManager = new DojoManager(currentAccount, manifest, toriiClient)
    postManager = new PostManager(canvas, dojoManager)
    
    // Setup UI handlers
    setupUIHandlers()
    
    // Setup post click handler for marketplace
    canvas.setPostClickHandler((post) => showPostDetails(post))
    
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
    
    // Show wallet username and balance
    await updateWalletInfo()
    
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
      await updateWalletInfo() // Update balance after creating post
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

  // Post details modal handlers
  setupPostDetailsHandlers()
}

function setupPostDetailsHandlers() {
  const postDetailsModal = document.getElementById('postDetailsModal')
  const closePostDetailsBtn = document.getElementById('closePostDetails')
  const sellPostBtn = document.getElementById('sellPostBtn')
  const removeSaleBtn = document.getElementById('removeSaleBtn')
  const buyPostBtn = document.getElementById('buyPostBtn')

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

    const priceStr = prompt('Enter sale price (in STRK):', '10')
    if (!priceStr) return

    const price = parseInt(priceStr)
    if (isNaN(price) || price <= 0) {
      alert('Invalid price')
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
    const buyerBalance = getBalance(buyerAddress)
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
        
        await dojoManager.buyPost(currentPost.id)
        
        // Transfer STRK from buyer to seller (prototype)
        const newBuyerBalance = buyerBalance - price
        setBalance(buyerAddress, newBuyerBalance)
        console.log(`💸 Buyer paid ${price} STRK. New balance: ${newBuyerBalance} STRK`)
        
        const sellerBalance = getBalance(sellerAddress)
        const newSellerBalance = sellerBalance + price
        setBalance(sellerAddress, newSellerBalance)
        console.log(`💰 Seller received ${price} STRK. New balance: ${newSellerBalance} STRK`)
        
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
  const postSaleInfo = document.getElementById('postSaleInfo')
  const sellPostBtn = document.getElementById('sellPostBtn')
  const removeSaleBtn = document.getElementById('removeSaleBtn')
  const buyPostBtn = document.getElementById('buyPostBtn')

  // Set current post
  window.postDetailsHandlers.setCurrentPost(post)

  // Update content
  postCreator.textContent = post.creator_username || 'Unknown'
  postCaption.textContent = post.caption || 'No caption'

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
  
  try {
    // Get balance for current user
    const balance = getBalance(currentAccount.address)
    console.log('💰 Wallet balance:', balance, 'STRK')
    
    walletInfo.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
        <span style="color: #4CAF50;">● ${currentUsername || currentAccount.address.slice(0, 6) + '...' + currentAccount.address.slice(-4)}</span>
        <span style="color: #FFD700; font-size: 12px;">💰 ${balance.toFixed(2)} STRK</span>
      </div>
    `
  } catch (error) {
    console.error('Error updating wallet info:', error)
    // Fallback to just showing username
    walletInfo.innerHTML = `<span style="color: #4CAF50;">● ${currentUsername || currentAccount.address.slice(0, 6) + '...' + currentAccount.address.slice(-4)}</span>`
  }
}

// Setup connect button
document.getElementById('connect-wallet').addEventListener('click', connectWallet)