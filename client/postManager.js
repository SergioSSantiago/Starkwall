import { SpiralLayout } from './spiralLayout.js'
import { IS_SEPOLIA, NETWORK, TORII_URL } from './config.js'

/**
 * Free post: size always 1, position random among adjacent slots.
 * Paid post: user chooses size (2, 3, 4...) → bigger tile (2x2, 3x3, 4x4);
 * position is still random adjacent (no choosing position). Price is exponential in size.
 */
export class PostManager {
  constructor(canvas, dojoManager = null) {
    this.canvas = canvas
    this.layout = new SpiralLayout(canvas.postWidth, canvas.postHeight)
    this.posts = []
    this.imageCache = new Map()
    this.dojoManager = dojoManager // Optional Dojo integration
    this.useDojo = !!dojoManager
    const toriiScope = String(TORII_URL || '').toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/[^a-z0-9._-]/g, '_')
    this.cacheKey = `starkwall_posts_cache_v2_${String(NETWORK || 'unknown').toLowerCase()}_${toriiScope || 'default'}`
    this.postsCacheEnabled = !IS_SEPOLIA
    this.clearLegacyCachesIfNeeded()
  }

  savePostsToCache() {
    if (!this.postsCacheEnabled) return
    try {
      const serializable = (this.posts || []).map((post) => {
        const { imageElement, ...rest } = post || {}
        return rest
      })
      localStorage.setItem(this.cacheKey, JSON.stringify(serializable))
    } catch (e) {
      console.warn('Posts cache save failed:', e?.message || e)
    }
  }

  loadPostsFromCache() {
    if (!this.postsCacheEnabled) return false
    try {
      const raw = localStorage.getItem(this.cacheKey)
      if (!raw) return false
      const cached = JSON.parse(raw)
      if (!Array.isArray(cached) || cached.length === 0) return false
      this.posts = cached
      this.layout.loadExistingPosts(this.posts)
      this.canvas.setPosts(this.posts)
      // Warm images asynchronously; UI remains interactive.
      this.loadImages().then(() => this.canvas.setPosts(this.posts)).catch(() => {})
      return true
    } catch (e) {
      console.warn('Posts cache load failed:', e?.message || e)
      return false
    }
  }

  clearLegacyCachesIfNeeded() {
    if (typeof localStorage === 'undefined') return
    try {
      // In Sepolia we prefer source-of-truth data from Torii and avoid stale local walls.
      if (IS_SEPOLIA) {
        for (const key of Object.keys(localStorage)) {
          if (key === 'starkwall_posts_cache_v1' || key.startsWith('starkwall_posts_cache_v2_')) {
            localStorage.removeItem(key)
          }
        }
      }
    } catch (e) {
      console.warn('Posts cache cleanup failed:', e?.message || e)
    }
  }

  async loadPosts() {
    let data = [];

    if (this.useDojo) {
      // Load posts from Dojo
      console.log('Loading posts from Dojo...');
      try {
        data = await this.dojoManager.queryAllPosts();
        console.log('Loaded posts from Dojo:', data);
      } catch (error) {
        console.warn('Post query failed, keeping previous posts:', error?.message || error);
        data = this.posts;
      }
    } else {
      // Use mock data
      data = [
        {
          id: 1,
          image_url: 'https://picsum.photos/id/1011/400/400',
          caption: 'Sunrise over the mountains',
          x_position: 0,
          y_position: 0,
          size: 1,
          is_paid: false,
          created_at: '2024-06-07T10:15:00Z',
          created_by: 'alice',
          creator_username: 'alice',
          current_owner: 'alice',
          sale_price: 0,
        },
        {
          id: 2,
          image_url: 'https://picsum.photos/id/1025/400/400',
          caption: 'Playful puppy',
          x_position: 393,
          y_position: 0,
          size: 1,
          is_paid: true,
          created_at: '2024-06-07T10:25:00Z',
          created_by: 'bob',
          creator_username: 'bob',
          current_owner: 'pepe',
          sale_price: 0,
        },
        {
          id: 3,
          image_url: 'https://picsum.photos/id/1042/400/400',
          caption: 'City skyline at dusk',
          x_position: 0,
          y_position: 852,
          size: 1,
          is_paid: false,
          created_at: '2024-06-07T10:35:00Z',
          created_by: 'carol',
          creator_username: 'carol',
          current_owner: 'carol',
          sale_price: 0,
        },
        {
          id: 4,
          image_url: 'https://picsum.photos/id/1056/400/400',
          caption: 'Forest trail',
          x_position: 393,
          y_position: 852,
          size: 1,
          is_paid: false,
          created_at: '2024-06-07T10:45:00Z',
          created_by: 'dave',
          creator_username: 'dave',
          current_owner: 'dave',
          sale_price: 0,
        }
      ];
    }

    // Prevent temporary Torii/RPC outages from wiping the canvas.
    if (this.useDojo && this.posts.length > 0 && (!Array.isArray(data) || data.length === 0)) {
      console.warn('Received empty post set; preserving previously loaded posts.');
      data = this.posts;
    }

    this.posts = data

    // Load existing positions into layout
    this.layout.loadExistingPosts(this.posts)

    // Load images
    await this.loadImages()

    this.canvas.setPosts(this.posts)
    this.savePostsToCache()
  }

  async loadImages() {
    const imagePromises = this.posts.map(post => {
      return new Promise((resolve) => {
        const isAuctionSlot = Number(post.post_kind) === 2
        const hasSlotState = Boolean(post.auction_slot)
        const isFinalizedSlot = Boolean(post.auction_slot?.finalized)

        // Only force placeholder when slot state explicitly says "not finalized".
        // If slot state is temporarily missing, allow media loading from Post data.
        if (isAuctionSlot && hasSlotState && !isFinalizedSlot) {
          post.imageElement = null
          resolve()
          return
        }

        const imageUrl = String(post.image_url || '')
        const isLoadableUrl = imageUrl.startsWith('http://') || imageUrl.startsWith('https://') || imageUrl.startsWith('data:image/')
        if (!isLoadableUrl) {
          post.imageElement = null
          resolve()
          return
        }

        if (this.imageCache.has(imageUrl)) {
          post.imageElement = this.imageCache.get(imageUrl)
          resolve()
          return
        }

        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => {
          post.imageElement = img
          this.imageCache.set(imageUrl, img)
          this.canvas.render()
          resolve()
        }
        img.onerror = () => {
          console.error('Failed to load image:', imageUrl)
          post.imageElement = null
          resolve()
        }
        img.src = imageUrl
      })
    })

    await Promise.all(imagePromises)
  }

  /**
   * Price for a paid post (STRK). Minimum 1 STRK for 2x2, then exponential.
   * Formula: 4^(size-2) → 2x2=1, 3x3=4, 4x4=16, 5x5=64 STRK...
   */
  static getPriceForPaidPost(size, multiplier = 4) {
    if (size < 2) return 0
    return Math.max(1, Math.floor(multiplier ** (size - 2)))
  }

  async createPost(imageUrl, caption, creatorUsername, size = 1, isPaid = false, onSuccess = null) {
    // Refresh local state before picking a position to avoid overlaps from stale data.
    if (this.useDojo) {
      await this.loadPosts()
    }

    // Position: always random among adjacent slots (free and paid). Only size is chosen for paid.
    let position

    if (this.posts.length === 0) {
      if (this.useDojo && this.dojoManager?.getPostCounter) {
        const onchainCount = await this.dojoManager.getPostCounter().catch(() => 0)
        if (Number(onchainCount) > 0) {
          throw new Error('Indexer sync delay detected. Posts exist onchain; wait a few seconds and retry.')
        }
      }
      // First post - place at origin
      console.log('Creating first post at origin (0, 0)')
      position = { x: 0, y: 0 }
    } else {
      // Find adjacent position (for size > 1 we need a slot that fits the whole block; TODO when implementing paid)
      const oldestPost = this.posts.reduce((oldest, p) => {
        if (!oldest) return p
        return Number(p.id) < Number(oldest.id) ? p : oldest
      }, null)
      const anchor = oldestPost
        ? { x: Number(oldestPost.x_position || 0), y: Number(oldestPost.y_position || 0) }
        : { x: 0, y: 0 }
      position = this.getAdjacentPosition(size, anchor)

      if (!position) {
        console.error('No available adjacent positions')
        return null
      }
    }

    console.log('Creating post at position:', position, 'size:', size)

    if (this.useDojo) {
      // Create post on-chain via Dojo
      try {
        console.log('🎨 Creating post on-chain at position: x=%d, y=%d, size: %d by user: %s', position.x, position.y, size, creatorUsername);
        const tx = await this.dojoManager.createPost(
          imageUrl,
          caption,
          creatorUsername,
          position.x,
          position.y,
          size,
          isPaid
        );
        
        console.log('✅ Post created! Transaction:', tx.transaction_hash);
        
        // Cerrar modal en el siguiente tick (antes de esperar Torii) para que se pinte el cierre
        if (typeof onSuccess === 'function') {
          setTimeout(() => {
            try { onSuccess(); } catch (e) { console.error('onSuccess callback error:', e); }
          }, 0);
        }
        
        // Wait a moment for Torii to index
        console.log('⏳ Waiting 5 seconds for Torii to index...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Reload posts from chain
        console.log('🔄 Reloading posts...');
        await this.loadPosts();
        await this.loadImages();
        this.canvas.setPosts(this.posts);
        
        console.log('✅ Posts reloaded! Total posts:', this.posts.length);
        
        // Center on the actual created post (list ordering from Torii is not guaranteed).
        const newPost =
          this.posts.find((p) =>
            Number(p.x_position) === Number(position.x) &&
            Number(p.y_position) === Number(position.y) &&
            Number(p.size) === Number(size)
          ) ||
          this.posts.find((p) =>
            Number(p.x_position) === Number(position.x) &&
            Number(p.y_position) === Number(position.y)
          ) ||
          this.posts.reduce((latest, p) => {
            if (!latest) return p;
            return Number(p.id) > Number(latest.id) ? p : latest;
          }, null);
        if (newPost) {
          console.log('📍 Centering on new post:', newPost.id);
          const centerX = newPost.x_position + this.canvas.postWidth / 2;
          const centerY = newPost.y_position + this.canvas.postHeight / 2;
          this.canvas.centerOn(centerX, centerY, 0.8);
          
          // Highlight the new post
          this.canvas.highlightPost(newPost.id, 3000);
          
          // Show toast with position (si existe helper global)
          if (typeof globalThis.showToast === 'function') {
            globalThis.showToast(`✅ Post creado en posición (${newPost.x_position}, ${newPost.y_position})`);
          }
        }
        
        return newPost;
      } catch (error) {
        const msg = String(error?.message || error || '')
        console.error('❌ Error creating post on-chain:', error);

        // Cartridge Controller can sometimes report a failed deploy step even when the
        // post creation actually succeeded (e.g. 'contract already deployed at address').
        // Avoid a false-negative error: resync from Torii and see if the post exists.
        if (msg.toLowerCase().includes('already deployed at address')) {
          console.warn('Detected already-deployed controller error; resyncing from Torii...')

          if (typeof onSuccess === 'function') {
            setTimeout(() => {
              try { onSuccess(); } catch (e) { console.error('onSuccess callback error:', e); }
            }, 0);
          }

          await new Promise((resolve) => setTimeout(resolve, 6000));
          await this.loadPosts();
          await this.loadImages();
          this.canvas.setPosts(this.posts);

          const newPost =
            this.posts.find((p) =>
              Number(p.x_position) === Number(position.x) &&
              Number(p.y_position) === Number(position.y) &&
              Number(p.size) === Number(size)
            ) ||
            this.posts.find((p) =>
              Number(p.x_position) === Number(position.x) &&
              Number(p.y_position) === Number(position.y)
            ) ||
            null;

          if (newPost) {
            console.log('✅ Post found after resync:', newPost.id);
            const centerX = newPost.x_position + this.canvas.postWidth / 2;
            const centerY = newPost.y_position + this.canvas.postHeight / 2;
            this.canvas.centerOn(centerX, centerY, 0.8);
            this.canvas.highlightPost(newPost.id, 3000);
            if (typeof globalThis.showToast === 'function') {
              globalThis.showToast('Post creado (sincronizado)');
            }
            return newPost;
          }

          alert('El post puede haberse creado. Si no lo ves, espera unos segundos y recarga.');
          return null;
        }

        // Fresh world reset edge-case:
        // Torii can briefly return 0 posts, UI picks origin, and chain reverts because post #1
        // already exists at (0,0). Retry once on a deterministic adjacent tile.
        const triedOrigin = Number(position?.x) === 0 && Number(position?.y) === 0
        const shouldRetryAdjacent =
          !isPaid &&
          Number(size) === 1 &&
          triedOrigin &&
          msg.toLowerCase().includes('transaction execution error')

        if (shouldRetryAdjacent) {
          try {
            await new Promise((resolve) => setTimeout(resolve, 2000))
            await this.loadPosts()

            const originExists = this.posts.some(
              (p) => Number(p.x_position) === 0 && Number(p.y_position) === 0
            )

            if (originExists) {
              const fallbackPositions = [
                { x: this.canvas.postWidth, y: 0 },
                { x: 0, y: this.canvas.postHeight },
                { x: this.canvas.postWidth, y: this.canvas.postHeight },
              ]

              for (const fallback of fallbackPositions) {
                if (this.isBlockOccupied(fallback.x, fallback.y, 1)) continue
                try {
                  console.warn('Retrying create_post on adjacent fallback:', fallback)
                  await this.dojoManager.createPost(
                    imageUrl,
                    caption,
                    creatorUsername,
                    fallback.x,
                    fallback.y,
                    1,
                    false
                  )
                  await new Promise((resolve) => setTimeout(resolve, 4000))
                  await this.loadPosts()
                  await this.loadImages()
                  this.canvas.setPosts(this.posts)
                  const created = this.posts.find(
                    (p) => Number(p.x_position) === fallback.x && Number(p.y_position) === fallback.y
                  )
                  if (created) return created
                  break
                } catch (retryErr) {
                  console.warn('Fallback create_post failed:', retryErr?.message || retryErr)
                }
              }
            }
          } catch (syncErr) {
            console.warn('Post retry sync failed:', syncErr?.message || syncErr)
          }
        }

        // General overlap retry: Torii/indexing lag or concurrent creations can pick
        // a coordinate that became occupied between selection and execution.
        const isOverlapError = msg.toLowerCase().includes('post overlaps an occupied area')
        if (isOverlapError) {
          const attempted = new Set([`${Number(position?.x) || 0},${Number(position?.y) || 0}`])
          for (let attempt = 0; attempt < 6; attempt++) {
            try {
              await new Promise((resolve) => setTimeout(resolve, 1200))
              await this.loadPosts()

              const oldestPost = this.posts.reduce((oldest, p) => {
                if (!oldest) return p
                return Number(p.id) < Number(oldest.id) ? p : oldest
              }, null)
              const anchor = oldestPost
                ? { x: Number(oldestPost.x_position || 0), y: Number(oldestPost.y_position || 0) }
                : { x: 0, y: 0 }

              let nextPos = null
              for (let pick = 0; pick < 10; pick++) {
                const candidate = this.getAdjacentPosition(size, anchor)
                if (!candidate) break
                const key = `${Number(candidate.x) || 0},${Number(candidate.y) || 0}`
                if (attempted.has(key)) continue
                attempted.add(key)
                nextPos = candidate
                break
              }
              if (!nextPos) break

              console.warn('Retrying create_post after overlap at:', nextPos)
              await this.dojoManager.createPost(
                imageUrl,
                caption,
                creatorUsername,
                nextPos.x,
                nextPos.y,
                size,
                isPaid
              )

              if (typeof onSuccess === 'function') {
                setTimeout(() => {
                  try { onSuccess() } catch (e) { console.error('onSuccess callback error:', e) }
                }, 0)
              }

              await new Promise((resolve) => setTimeout(resolve, 4500))
              await this.loadPosts()
              await this.loadImages()
              this.canvas.setPosts(this.posts)

              const created =
                this.posts.find((p) =>
                  Number(p.x_position) === Number(nextPos.x) &&
                  Number(p.y_position) === Number(nextPos.y) &&
                  Number(p.size) === Number(size)
                ) ||
                this.posts.find((p) =>
                  Number(p.x_position) === Number(nextPos.x) &&
                  Number(p.y_position) === Number(nextPos.y)
                ) ||
                null

              if (created) return created
            } catch (retryErr) {
              const retryMsg = String(retryErr?.message || retryErr || '').toLowerCase()
              if (!retryMsg.includes('post overlaps an occupied area')) {
                throw retryErr
              }
            }
          }
        }

        alert('Failed to create post: ' + (error.message || 'Unknown error'));
        throw error;
      }
    } else {
      // Create post locally (mock mode)
      console.log('📝 Creating post locally (mock mode) at position: x=%d, y=%d by user: %s', position.x, position.y, creatorUsername);
      const newPost = {
        id: Math.max(...this.posts.map(p => p.id), 0) + 1,
        image_url: imageUrl,
        caption: caption,
        x_position: position.x,
        y_position: position.y,
        size: 1, // Always size 1
        is_paid: isPaid,
        created_at: new Date().toISOString(),
        created_by: 'user',
        creator_username: creatorUsername,
        current_owner: 'user',
        sale_price: 0
      }

      // Load the image for the new post
      await new Promise((resolve) => {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => {
          newPost.imageElement = img
          this.imageCache.set(newPost.image_url, img)
          resolve()
        }
        img.onerror = () => {
          console.error('Failed to load image:', newPost.image_url)
          resolve()
        }
        img.src = newPost.image_url
      })

      this.posts.push(newPost)
      this.layout.addExistingPost(newPost.x_position, newPost.y_position, newPost.size)
      this.canvas.setPosts(this.posts)

      // Center on the new post
      this.canvas.centerOn(
        newPost.x_position + this.canvas.postWidth / 2,
        newPost.y_position + this.canvas.postHeight / 2,
        0.8
      )

      if (typeof onSuccess === 'function') onSuccess()
      return newPost
    }
  }


  async createAuctionPost(imageUrl, caption, creatorUsername, endTimeUnix, onSuccess = null, auctionConfig = null) {
    // Always re-sync before selecting the 3x3 block to prevent stale overlaps.
    await this.loadPosts()

    let blockTopLeft

    if (this.posts.length === 0) {
      blockTopLeft = { x: 0, y: 0 }
    } else {
      const oldestPost = this.posts.reduce((oldest, p) => {
        if (!oldest) return p
        return Number(p.id) < Number(oldest.id) ? p : oldest
      }, null)
      const anchor = oldestPost
        ? { x: Number(oldestPost.x_position || 0), y: Number(oldestPost.y_position || 0) }
        : { x: 0, y: 0 }
      blockTopLeft = this.getAdjacentPosition(3, anchor)
      if (!blockTopLeft) {
        throw new Error('No available adjacent space for a 3x3 auction post.')
      }
    }

    // Contract expects center coordinates; getAdjacentPosition(3) returns top-left of the 3x3 block.
    const centerPosition = {
      x: blockTopLeft.x + this.canvas.postWidth,
      y: blockTopLeft.y + this.canvas.postHeight,
    }

    if (!this.useDojo) {
      throw new Error('Auction posts require Dojo mode')
    }

    try {
      const tx = auctionConfig?.sealed
        ? await this.dojoManager.createAuctionPost3x3Sealed(
            imageUrl,
            caption,
            creatorUsername,
            centerPosition.x,
            centerPosition.y,
            Number(auctionConfig?.commitEndTimeUnix || 0),
            Number(auctionConfig?.revealEndTimeUnix || 0),
            String(auctionConfig?.verifier || ''),
          )
        : await this.dojoManager.createAuctionPost3x3(
            imageUrl,
            caption,
            creatorUsername,
            centerPosition.x,
            centerPosition.y,
            endTimeUnix,
          )

      if (typeof onSuccess === 'function') {
        setTimeout(() => {
          try { onSuccess() } catch (e) { console.error('onSuccess callback error:', e) }
        }, 0)
      }

      await new Promise((resolve) => setTimeout(resolve, 6000))
      await this.loadPosts()
      await this.loadImages()
      this.canvas.setPosts(this.posts)

      const centerPost = this.posts.find((p) =>
        Number(p.x_position) === Number(centerPosition.x) &&
        Number(p.y_position) === Number(centerPosition.y) &&
        Number(p.post_kind) === 1
      )

      if (centerPost) {
        const centerX = centerPost.x_position + this.canvas.postWidth / 2
        const centerY = centerPost.y_position + this.canvas.postHeight / 2
        this.canvas.centerOn(centerX, centerY, 0.8)
        this.canvas.highlightPost(centerPost.id, 3000)
      }

      return tx
    } catch (error) {
      console.error('❌ Error creating auction post on-chain:', error)
      throw error
    }
  }

  getAdjacentPosition(size = 1, anchor = { x: 0, y: 0 }) {
    const postWidth = this.canvas.postWidth
    const postHeight = this.canvas.postHeight
    const blockW = postWidth * size
    const blockH = postHeight * size

    // Collect candidate positions: adjacent to existing posts (edges of the grid)
    const possiblePositions = []

    this.posts.forEach(post => {
      const postRight = post.x_position + (post.size || 1) * postWidth
      const postBottom = post.y_position + (post.size || 1) * postHeight
      // One tile in each direction (for size 1); for size > 1 we push the block beside the post
      possiblePositions.push(
        { x: post.x_position, y: post.y_position - blockH, direction: 'top' },
        { x: post.x_position, y: postBottom, direction: 'bottom' },
        { x: post.x_position - blockW, y: post.y_position, direction: 'left' },
        { x: postRight, y: post.y_position, direction: 'right' }
      )
    })

    // Dedupe by "x,y" and filter: non-negative, block not occupied, block adjacent to at least one post
    const seen = new Set()
    const availablePositions = possiblePositions.filter(pos => {
      const key = `${pos.x},${pos.y}`
      if (seen.has(key)) return false
      seen.add(key)
      const isNonNegative = pos.x >= 0 && pos.y >= 0
      const blockFree = !this.isBlockOccupied(pos.x, pos.y, size)
      return isNonNegative && blockFree
    })

    if (availablePositions.length === 0) {
      console.log('⚠️ No available adjacent positions found (all occupied or would be negative)')
      return null
    }

    // Prefer nearby candidates to keep new content in the main historical cluster.
    const ax = Number(anchor?.x || 0)
    const ay = Number(anchor?.y || 0)
    const ranked = [...availablePositions].sort((a, b) => {
      const da = Math.abs(a.x - ax) + Math.abs(a.y - ay)
      const db = Math.abs(b.x - ax) + Math.abs(b.y - ay)
      return da - db
    })
    const candidatePool = ranked.slice(0, Math.min(20, ranked.length))
    const randomIndex = Math.floor(Math.random() * candidatePool.length)
    const selectedPosition = candidatePool[randomIndex]
    console.log('✅ Selected adjacent position: x=%d, y=%d (direction: %s, size: %d)', 
      selectedPosition.x, selectedPosition.y, selectedPosition.direction, size)
    return selectedPosition
  }

  isPositionOccupied(x, y) {
    return this.posts.some(post => {
      const pw = this.canvas.postWidth * (post.size || 1)
      const ph = this.canvas.postHeight * (post.size || 1)
      return x >= post.x_position && x < post.x_position + pw &&
             y >= post.y_position && y < post.y_position + ph
    })
  }

  /** Returns true if the block [x, x+size*W) x [y, y+size*H) overlaps any existing post */
  isBlockOccupied(x, y, size) {
    const postWidth = this.canvas.postWidth
    const postHeight = this.canvas.postHeight
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        if (this.isPositionOccupied(x + i * postWidth, y + j * postHeight)) return true
      }
    }
    return false
  }

  async subscribeToChanges() {
/*     supabase
      .channel('posts')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, async (payload) => {
        if (!this.posts.find(p => p.id === payload.new.id)) {
          const newPost = payload.new

          // Load image
          await new Promise((resolve) => {
            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.onload = () => {
              newPost.imageElement = img
              this.imageCache.set(newPost.image_url, img)
              resolve()
            }
            img.onerror = () => resolve()
            img.src = newPost.image_url
          })

          this.posts.push(newPost)
          this.layout.addExistingPost(newPost.x_position, newPost.y_position, newPost.size || 1)
          this.canvas.setPosts(this.posts)
        }
      })
      .subscribe() */
  }
}