import { SpiralLayout } from './spiralLayout.js'

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
  }

  async loadPosts() {
    let data = [];

    if (this.useDojo) {
      // Load posts from Dojo
      console.log('Loading posts from Dojo...');
      data = await this.dojoManager.queryAllPosts();
      console.log('Loaded posts from Dojo:', data);
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

    this.posts = data

    // Load existing positions into layout
    this.layout.loadExistingPosts(this.posts)

    // Load images
    await this.loadImages()

    this.canvas.setPosts(this.posts)
  }

  async loadImages() {
    const imagePromises = this.posts.map(post => {
      return new Promise((resolve) => {
        if (this.imageCache.has(post.image_url)) {
          post.imageElement = this.imageCache.get(post.image_url)
          resolve()
          return
        }

        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => {
          post.imageElement = img
          this.imageCache.set(post.image_url, img)
          this.canvas.render()
          resolve()
        }
        img.onerror = () => {
          console.error('Failed to load image:', post.image_url)
          resolve()
        }
        img.src = post.image_url
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
    // Position: always random among adjacent slots (free and paid). Only size is chosen for paid.
    let position

    if (this.posts.length === 0) {
      // First post - place at origin
      console.log('Creating first post at origin (0, 0)')
      position = { x: 0, y: 0 }
    } else {
      // Find adjacent position (for size > 1 we need a slot that fits the whole block; TODO when implementing paid)
      position = this.getAdjacentPosition(size)

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
        
        // Center on the new post
        const newPost = this.posts[this.posts.length - 1];
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
        console.error('❌ Error creating post on-chain:', error);
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

  getAdjacentPosition(size = 1) {
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

    const randomIndex = Math.floor(Math.random() * availablePositions.length)
    const selectedPosition = availablePositions[randomIndex]
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