import { SpiralLayout } from './spiralLayout.js'

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
          current_owner: 'alice',
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
          current_owner: 'pepe',
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
          current_owner: 'carol',
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
          current_owner: 'dave',
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

  async createPost(imageUrl, caption, size = 1, isPaid = false) {
    // Get position for new post
    let position
    
    if (this.posts.length === 0) {
      // First post - place at origin
      console.log('Creating first post at origin (0, 0)')
      position = { x: 0, y: 0 }
    } else {
      // Find adjacent position to existing posts
      position = this.getAdjacentPosition()
      
      if (!position) {
        console.error('No available adjacent positions')
        return null
      }
    }

    console.log('Creating post at position:', position)

    if (this.useDojo) {
      // Create post on-chain via Dojo
      try {
        console.log('🎨 Creating post on-chain at position: x=%d, y=%d', position.x, position.y);
        const tx = await this.dojoManager.createPost(
          imageUrl,
          caption,
          position.x,
          position.y,
          isPaid
        );
        
        console.log('✅ Post created! Transaction:', tx.transaction_hash);
        
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
          this.canvas.centerOn(
            newPost.x_position + this.canvas.postWidth / 2,
            newPost.y_position + this.canvas.postHeight / 2,
            0.8
          );
        }
        
        return newPost;
      } catch (error) {
        console.error('❌ Error creating post on-chain:', error);
        alert('Failed to create post: ' + (error.message || 'Unknown error'));
        throw error;
      }
    } else {
      // Create post locally (mock mode)
      console.log('📝 Creating post locally (mock mode) at position: x=%d, y=%d', position.x, position.y);
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
        current_owner: 'user'
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

      return newPost
    }
  }

  getAdjacentPosition() {
    const postWidth = this.canvas.postWidth
    const postHeight = this.canvas.postHeight
    
    // Collect all possible adjacent positions
    const possiblePositions = []
    
    this.posts.forEach(post => {
      const adjacentPositions = [
        { x: post.x_position, y: post.y_position - postHeight, direction: 'top' },
        { x: post.x_position, y: post.y_position + postHeight, direction: 'bottom' },
        { x: post.x_position - postWidth, y: post.y_position, direction: 'left' },
        { x: post.x_position + postWidth, y: post.y_position, direction: 'right' }
      ]
      
      possiblePositions.push(...adjacentPositions)
    })
    
    // Filter out positions that are already occupied or have negative coordinates
    const availablePositions = possiblePositions.filter(pos => {
      const isNonNegative = pos.x >= 0 && pos.y >= 0
      const isNotOccupied = !this.isPositionOccupied(pos.x, pos.y)
      
      if (!isNonNegative) {
        console.log('🚫 Filtered out negative position: x=%d, y=%d (direction: %s)', pos.x, pos.y, pos.direction)
      }
      
      return isNonNegative && isNotOccupied
    })
    
    if (availablePositions.length === 0) {
      console.log('⚠️ No available adjacent positions found (all occupied or would be negative)')
      return null
    }
    
    // Pick a random available position
    const randomIndex = Math.floor(Math.random() * availablePositions.length)
    const selectedPosition = availablePositions[randomIndex]
    console.log('✅ Selected adjacent position: x=%d, y=%d (direction: %s, %d options available)', 
      selectedPosition.x, selectedPosition.y, selectedPosition.direction, availablePositions.length)
    return selectedPosition
  }

  isPositionOccupied(x, y) {
    return this.posts.some(post => 
      post.x_position === x && post.y_position === y
    )
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