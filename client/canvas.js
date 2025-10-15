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
  
      this.minZoom = 0.1
      this.maxZoom = 1.0
  
      // Pan state
      this.isPanning = false
      this.lastMousePos = { x: 0, y: 0 }
  
      this.posts = []
  
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
      this.canvas.addEventListener('mouseup', () => this.onMouseUp())
      this.canvas.addEventListener('mouseleave', () => this.onMouseUp())
      this.canvas.addEventListener('wheel', (e) => this.onWheel(e))
  
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
      this.lastMousePos = { x: e.clientX, y: e.clientY }
      this.canvas.style.cursor = 'grabbing'
    }
  
    onMouseMove(e) {
      if (!this.isPanning) return
  
      const dx = e.clientX - this.lastMousePos.x
      const dy = e.clientY - this.lastMousePos.y
  
      this.camera.x += dx / this.camera.zoom
      this.camera.y += dy / this.camera.zoom
  
      this.lastMousePos = { x: e.clientX, y: e.clientY }
      this.render()
    }
  
    onMouseUp() {
      this.isPanning = false
      this.canvas.style.cursor = 'grab'
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
  
      // Check if post is visible
      if (screen.x + screenWidth < 0 || screen.x > this.canvas.width ||
          screen.y + screenHeight < 0 || screen.y > this.canvas.height) {
        return
      }
  
      // Draw post background
      this.ctx.fillStyle = '#1a1a1a'
      this.ctx.fillRect(screen.x, screen.y, screenWidth, screenHeight)
  
      // Draw border
      this.ctx.strokeStyle = post.is_paid ? '#FFD700' : '#333'
      this.ctx.lineWidth = 2
      this.ctx.strokeRect(screen.x, screen.y, screenWidth, screenHeight)
  
      // Draw image if available and loaded
      if (post.imageElement && post.imageElement.complete) {
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
      } else {
        // Draw placeholder
        this.ctx.fillStyle = '#2a2a2a'
        this.ctx.fillRect(screen.x + 10, screen.y + 10, screenWidth - 20, screenHeight - 20)
  
        if (this.camera.zoom > 0.2) {
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
  
    centerOn(x, y, zoom = this.camera.zoom) {
      this.camera.x = -x
      this.camera.y = -y
      this.camera.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom))
      this.render()
    }
  }
  