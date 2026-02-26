export class InfiniteCanvas {
    constructor(canvasElement) {
      this.canvas = canvasElement
      this.ctx = canvasElement.getContext('2d')
  
      // iPhone 16 dimensions: 393x852 points (logical pixels)
      this.postWidth = 393
      this.postHeight = 852
  
      // Camera properties
      this.camera = {
        x: 0,
        y: 0,
        zoom: 0.3
      }
  
      // Allow further zoom-out to view larger areas of the canvas at once.
      this.minZoom = 0.02
      this.maxZoom = 1.0
  
      // Pan state
      this.isPanning = false
      this.lastMousePos = { x: 0, y: 0 }
  
      this.posts = []
      this.highlightedPostId = null
      this.highlightUntil = 0

      this.setupCanvas()
      this.setupEventListeners()
    }
  
    setupCanvas() {
      this.resize()
      window.addEventListener('resize', () => this.resize())
    }
  
    resize() {
      this.canvas.width = window.innerWidth
      this.canvas.height = window.innerHeight
      this.render()
    }
  
    setupEventListeners() {
      // Mouse events
      this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e))
      this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e))
      this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e))
      this.canvas.addEventListener('mouseleave', () => this.onMouseUp())
      this.canvas.addEventListener('wheel', (e) => this.onWheel(e))
      this.canvas.addEventListener('click', (e) => this.onClick(e))
  
      // Touch events
      this.canvas.addEventListener('touchstart', (e) => this.onTouchStart(e))
      this.canvas.addEventListener('touchmove', (e) => this.onTouchMove(e))
      this.canvas.addEventListener('touchend', () => this.onTouchEnd())
  
      // Pinch zoom
      this.touchDistance = 0
      this.canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
          this.touchDistance = this.getTouchDistance(e.touches)
        }
      })
  
      this.canvas.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2) {
          e.preventDefault()
          const newDistance = this.getTouchDistance(e.touches)
          const scale = newDistance / this.touchDistance
          this.zoom(scale, this.canvas.width / 2, this.canvas.height / 2)
          this.touchDistance = newDistance
        }
      })
    }
  
    getTouchDistance(touches) {
      const dx = touches[0].clientX - touches[1].clientX
      const dy = touches[0].clientY - touches[1].clientY
      return Math.sqrt(dx * dx + dy * dy)
    }
  
    onMouseDown(e) {
      this.isPanning = true
      this.panStartPos = { x: e.clientX, y: e.clientY }
      this.lastMousePos = { x: e.clientX, y: e.clientY }
      this.hasPanned = false
      this.canvas.style.cursor = 'grabbing'
    }
  
    onMouseMove(e) {
      if (!this.isPanning) return
  
      const dx = e.clientX - this.lastMousePos.x
      const dy = e.clientY - this.lastMousePos.y
  
      // If moved more than 5 pixels, consider it a pan
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        this.hasPanned = true
      }

      this.camera.x += dx / this.camera.zoom
      this.camera.y += dy / this.camera.zoom
  
      this.lastMousePos = { x: e.clientX, y: e.clientY }
      this.render()
    }
  
    onMouseUp(e) {
      this.isPanning = false
      this.canvas.style.cursor = 'grab'
    }

    onClick(e) {
      // Don't trigger click if user was panning
      if (this.hasPanned) {
        this.hasPanned = false
        return
      }

      const post = this.getPostAtPosition(e.clientX, e.clientY)
      if (post && this.onPostClick) {
        this.onPostClick(post)
      }
    }

    getPostAtPosition(clientX, clientY) {
      // Convert screen coordinates to world coordinates
      const worldX = (clientX - this.canvas.width / 2) / this.camera.zoom - this.camera.x
      const worldY = (clientY - this.canvas.height / 2) / this.camera.zoom - this.camera.y

      // Check each post
      for (const post of this.posts) {
        const size = post.size || 1
        const width = this.postWidth * size
        const height = this.postHeight * size

        if (worldX >= post.x_position && worldX <= post.x_position + width &&
            worldY >= post.y_position && worldY <= post.y_position + height) {
          return post
        }
      }

      return null
    }

    setPostClickHandler(handler) {
      this.onPostClick = handler
    }
  
    onTouchStart(e) {
      if (e.touches.length === 1) {
        this.isPanning = true
        this.lastMousePos = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      }
    }
  
    onTouchMove(e) {
      if (this.isPanning && e.touches.length === 1) {
        const dx = e.touches[0].clientX - this.lastMousePos.x
        const dy = e.touches[0].clientY - this.lastMousePos.y
  
        this.camera.x += dx / this.camera.zoom
        this.camera.y += dy / this.camera.zoom
  
        this.lastMousePos = { x: e.touches[0].clientX, y: e.touches[0].clientY }
        this.render()
      }
    }
  
    onTouchEnd() {
      this.isPanning = false
    }
  
    onWheel(e) {
      e.preventDefault()
  
      const zoomIntensity = 0.1
      const wheel = e.deltaY < 0 ? 1 : -1
      const zoom = Math.exp(wheel * zoomIntensity)
  
      this.zoom(zoom, e.clientX, e.clientY)
    }
  
    zoom(scale, centerX, centerY) {
      const newZoom = this.camera.zoom * scale
  
      if (newZoom < this.minZoom || newZoom > this.maxZoom) return
  
      const worldX = (centerX - this.canvas.width / 2) / this.camera.zoom - this.camera.x
      const worldY = (centerY - this.canvas.height / 2) / this.camera.zoom - this.camera.y
  
      this.camera.zoom = newZoom
  
      this.camera.x = (centerX - this.canvas.width / 2) / this.camera.zoom - worldX
      this.camera.y = (centerY - this.canvas.height / 2) / this.camera.zoom - worldY
  
      this.render()
    }
  
    worldToScreen(x, y) {
      return {
        x: (x + this.camera.x) * this.camera.zoom + this.canvas.width / 2,
        y: (y + this.camera.y) * this.camera.zoom + this.canvas.height / 2
      }
    }
  
    setPosts(posts) {
      this.posts = posts
      this.render()
    }
  
    render() {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  
      // Draw background
      this.ctx.fillStyle = '#0a0a0a'
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
  
      // Draw grid
      this.drawGrid()
  
      // Draw posts
      this.posts.forEach(post => this.drawPost(post))
      
      // Draw highlight for newly created post
      if (this.highlightedPostId && Date.now() < this.highlightUntil) {
        const highlightedPost = this.posts.find(p => p.id === this.highlightedPostId)
        if (highlightedPost) {
          this.drawHighlight(highlightedPost)
        }
      } else if (this.highlightedPostId) {
        // Clear highlight after timeout
        this.highlightedPostId = null
      }
    }
  
    drawGrid() {
      const gridSize = this.postWidth
      const screenBounds = this.getScreenBounds()
  
      this.ctx.strokeStyle = '#1a1a1a'
      this.ctx.lineWidth = 1
  
      const startX = Math.floor(screenBounds.minX / gridSize) * gridSize
      const startY = Math.floor(screenBounds.minY / gridSize) * gridSize
      const endX = Math.ceil(screenBounds.maxX / gridSize) * gridSize
      const endY = Math.ceil(screenBounds.maxY / gridSize) * gridSize
  
      // Vertical lines
      for (let x = startX; x <= endX; x += gridSize) {
        const screen = this.worldToScreen(x, 0)
        this.ctx.beginPath()
        this.ctx.moveTo(screen.x, 0)
        this.ctx.lineTo(screen.x, this.canvas.height)
        this.ctx.stroke()
      }
  
      // Horizontal lines
      for (let y = startY; y <= endY; y += gridSize) {
        const screen = this.worldToScreen(0, y)
        this.ctx.beginPath()
        this.ctx.moveTo(0, screen.y)
        this.ctx.lineTo(this.canvas.width, screen.y)
        this.ctx.stroke()
      }
    }
  
    getScreenBounds() {
      const topLeft = {
        x: -this.camera.x - (this.canvas.width / 2) / this.camera.zoom,
        y: -this.camera.y - (this.canvas.height / 2) / this.camera.zoom
      }
      const bottomRight = {
        x: -this.camera.x + (this.canvas.width / 2) / this.camera.zoom,
        y: -this.camera.y + (this.canvas.height / 2) / this.camera.zoom
      }
  
      return {
        minX: topLeft.x,
        minY: topLeft.y,
        maxX: bottomRight.x,
        maxY: bottomRight.y
      }
    }
  
    drawPost(post) {
      const size = post.size || 1
      const width = this.postWidth * size
      const height = this.postHeight * size
  
      const screen = this.worldToScreen(post.x_position, post.y_position)
      const screenWidth = width * this.camera.zoom
      const screenHeight = height * this.camera.zoom

      const isAuctionSlot = Number(post.post_kind) === 2
      const hasSlotState = Boolean(post.auction_slot)
      const isFinalizedSlot = Boolean(post.auction_slot?.finalized)
      // Show slot placeholder only when we explicitly know slot is still active.
      const showAuctionPlaceholder = isAuctionSlot && hasSlotState && !isFinalizedSlot
  
      // Check if post is visible
      if (screen.x + screenWidth < 0 || screen.x > this.canvas.width ||
          screen.y + screenHeight < 0 || screen.y > this.canvas.height) {
        return
      }
  
      // Draw post background
      this.ctx.fillStyle = '#1a1a1a'
      this.ctx.fillRect(screen.x, screen.y, screenWidth, screenHeight)
  
      // Draw border (blue for active auction slots, green if for sale, gold if paid, default gray)
      if (showAuctionPlaceholder) {
        this.ctx.strokeStyle = '#38b6ff'
      } else if (post.sale_price > 0) {
        this.ctx.strokeStyle = '#4CAF50' // Green for sale
      } else if (post.is_paid) {
        this.ctx.strokeStyle = '#FFD700' // Gold for paid
      } else {
        this.ctx.strokeStyle = '#333' // Default gray
      }
      this.ctx.lineWidth = 2
      this.ctx.strokeRect(screen.x, screen.y, screenWidth, screenHeight)
  
      // Draw image if available and loaded
      if (!showAuctionPlaceholder && post.imageElement && post.imageElement.complete) {
        // Save context state and clip to post boundaries
        this.ctx.save()
        this.ctx.beginPath()
        this.ctx.rect(screen.x, screen.y, screenWidth, screenHeight)
        this.ctx.clip()

        const imgAspect = post.imageElement.width / post.imageElement.height
        const postAspect = width / height
  
        let drawWidth, drawHeight, offsetX, offsetY
  
        // Use "cover" behavior - image fills entire post, cropping if needed
        if (imgAspect > postAspect) {
          // Image is wider than post - fit by height, crop sides
          drawHeight = height
          drawWidth = height * imgAspect
          offsetX = (width - drawWidth) / 2
          offsetY = 0
        } else {
          // Image is taller than post - fit by width, crop top/bottom
          drawWidth = width
          drawHeight = width / imgAspect
          offsetX = 0
          offsetY = (height - drawHeight) / 2
        }
  
        this.ctx.drawImage(
          post.imageElement,
          screen.x + offsetX * this.camera.zoom,
          screen.y + offsetY * this.camera.zoom,
          drawWidth * this.camera.zoom,
          drawHeight * this.camera.zoom
        )

        this.ctx.restore()

        // Draw creator username overlay at the top (like Instagram)
        if (post.creator_username && this.camera.zoom > 0.3) {
          const ownerHeight = 50 * this.camera.zoom
          const gradient = this.ctx.createLinearGradient(
            screen.x, screen.y,
            screen.x, screen.y + ownerHeight
          )
          gradient.addColorStop(0, 'rgba(0, 0, 0, 0.7)')
          gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
  
          this.ctx.fillStyle = gradient
          this.ctx.fillRect(screen.x, screen.y, screenWidth, ownerHeight)
  
          this.ctx.fillStyle = '#fff'
          this.ctx.font = `bold ${14 * this.camera.zoom}px sans-serif`
          this.ctx.fillText(
            post.creator_username,
            screen.x + 12 * this.camera.zoom,
            screen.y + 25 * this.camera.zoom
          )
        }
  
        // Draw caption overlay
        if (post.caption && this.camera.zoom > 0.3) {
          const captionHeight = 80 * this.camera.zoom
          const gradient = this.ctx.createLinearGradient(
            screen.x, screen.y + screenHeight - captionHeight,
            screen.x, screen.y + screenHeight
          )
          gradient.addColorStop(0, 'rgba(0, 0, 0, 0)')
          gradient.addColorStop(1, 'rgba(0, 0, 0, 0.8)')
  
          this.ctx.fillStyle = gradient
          this.ctx.fillRect(screen.x, screen.y + screenHeight - captionHeight, screenWidth, captionHeight)
  
          this.ctx.fillStyle = '#fff'
          this.ctx.font = `${14 * this.camera.zoom}px sans-serif`
          this.ctx.fillText(
            post.caption.substring(0, 50),
            screen.x + 10 * this.camera.zoom,
            screen.y + screenHeight - 20 * this.camera.zoom
          )
        }

        // Draw "FOR SALE" badge if post is for sale
        if (post.sale_price > 0 && this.camera.zoom > 0.2) {
          const badgeWidth = 120 * this.camera.zoom
          const badgeHeight = 35 * this.camera.zoom
          const badgeX = screen.x + screenWidth - badgeWidth - 10 * this.camera.zoom
          const badgeY = screen.y + 10 * this.camera.zoom

          // Badge background
          this.ctx.fillStyle = 'rgba(76, 175, 80, 0.9)'
          this.ctx.fillRect(badgeX, badgeY, badgeWidth, badgeHeight)

          // Badge text
          this.ctx.fillStyle = '#fff'
          this.ctx.font = `bold ${12 * this.camera.zoom}px sans-serif`
          this.ctx.textAlign = 'center'
          this.ctx.fillText(
            'FOR SALE',
            badgeX + badgeWidth / 2,
            badgeY + 13 * this.camera.zoom
          )
          
          // Price text
          this.ctx.font = `${10 * this.camera.zoom}px sans-serif`
          this.ctx.fillText(
            `${post.sale_price} STRK`,
            badgeX + badgeWidth / 2,
            badgeY + 26 * this.camera.zoom
          )
          this.ctx.textAlign = 'left'
        }
      } else {
        // Draw placeholder
        this.ctx.fillStyle = '#2a2a2a'
        this.ctx.fillRect(screen.x + 10, screen.y + 10, screenWidth - 20, screenHeight - 20)

        if (showAuctionPlaceholder) {
          const highest = Number(post.auction_slot?.highest_bid || 0)
          const endTs = Number(post.auction_group?.end_time || 0)
          const now = Math.floor(Date.now() / 1000)
          const remaining = Math.max(0, endTs - now)
          const h = Math.floor(remaining / 3600)
          const m = Math.floor((remaining % 3600) / 60)

          if (this.camera.zoom > 0.18) {
            this.ctx.fillStyle = '#9ecbff'
            this.ctx.textAlign = 'center'
            this.ctx.font = `bold ${16 * this.camera.zoom}px sans-serif`
            this.ctx.fillText('AUCTION SLOT', screen.x + screenWidth / 2, screen.y + 70 * this.camera.zoom)

            this.ctx.font = `${13 * this.camera.zoom}px sans-serif`
            this.ctx.fillText(`Highest: ${highest} STRK`, screen.x + screenWidth / 2, screen.y + 105 * this.camera.zoom)
            this.ctx.fillText(`Ends in: ${h}h ${m}m`, screen.x + screenWidth / 2, screen.y + 128 * this.camera.zoom)
            this.ctx.textAlign = 'left'
          }
        } else if (this.camera.zoom > 0.2) {
          this.ctx.fillStyle = '#666'
          this.ctx.font = `${16 * this.camera.zoom}px sans-serif`
          this.ctx.textAlign = 'center'
          this.ctx.fillText(
            post.caption || 'Loading...',
            screen.x + screenWidth / 2,
            screen.y + screenHeight / 2
          )
          this.ctx.textAlign = 'left'
        }
      }
    }
  
    drawHighlight(post) {
      const size = post.size || 1
      const width = this.postWidth * size
      const height = this.postHeight * size
      const screen = this.worldToScreen(post.x_position, post.y_position)
      const screenWidth = width * this.camera.zoom
      const screenHeight = height * this.camera.zoom

      // Pulsing glow effect
      const time = Date.now() - (this.highlightUntil - 3000)
      const pulse = Math.sin(time / 200) * 0.5 + 0.5 // 0 to 1
      const alpha = 0.8 * (1 - time / 3000) // Fade out over 3 seconds

      // Outer glow
      const glowSize = 10 + pulse * 5
      const gradient = this.ctx.createRadialGradient(
        screen.x + screenWidth / 2,
        screen.y + screenHeight / 2,
        0,
        screen.x + screenWidth / 2,
        screen.y + screenHeight / 2,
        screenWidth / 2 + glowSize
      )
      gradient.addColorStop(0, `rgba(0, 255, 255, ${alpha * 0.6})`)
      gradient.addColorStop(0.5, `rgba(0, 255, 255, ${alpha * 0.3})`)
      gradient.addColorStop(1, 'rgba(0, 255, 255, 0)')

      this.ctx.fillStyle = gradient
      this.ctx.fillRect(
        screen.x - glowSize,
        screen.y - glowSize,
        screenWidth + glowSize * 2,
        screenHeight + glowSize * 2
      )

      // Bright border
      this.ctx.strokeStyle = `rgba(0, 255, 255, ${alpha})`
      this.ctx.lineWidth = 4 + pulse * 2
      this.ctx.strokeRect(screen.x, screen.y, screenWidth, screenHeight)
    }

    highlightPost(postId, durationMs = 3000) {
      this.highlightedPostId = postId
      this.highlightUntil = Date.now() + durationMs
      // Keep rendering to show animation
      const startTime = Date.now()
      const animate = () => {
        if (Date.now() < this.highlightUntil) {
          this.render()
          requestAnimationFrame(animate)
        } else {
          this.render() // Final render to clear highlight
        }
      }
      animate()
    }

    centerOn(x, y, zoom = this.camera.zoom) {
      this.camera.x = -x
      this.camera.y = -y
      this.camera.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom))
      this.render()
    }
  }
  