export class SpiralLayout {
    constructor(postWidth, postHeight) {
      this.postWidth = postWidth
      this.postHeight = postHeight
      this.occupiedPositions = new Map()
    }
  
    addExistingPost(x, y, size = 1) {
      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
          const key = `${x + i * this.postWidth},${y + j * this.postHeight}`
          this.occupiedPositions.set(key, true)
        }
      }
    }
  
    isOccupied(x, y, size = 1) {
      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
          const key = `${x + i * this.postWidth},${y + j * this.postHeight}`
          if (this.occupiedPositions.has(key)) {
            return true
          }
        }
      }
      return false
    }
  
    getNextPosition(size = 1) {
      // If no posts exist, start at origin
      if (this.occupiedPositions.size === 0) {
        const position = { x: 0, y: 0 }
        this.addExistingPost(0, 0, size)
        return position
      }
  
      // Use spiral pattern starting from center
      const maxRadius = 100
      let angle = 0
      const angleStep = Math.PI / 6 // 30 degrees
  
      for (let radius = 1; radius <= maxRadius; radius++) {
        const positionsToCheck = []
  
        // Generate positions in a spiral
        const steps = radius * 8
        for (let i = 0; i < steps; i++) {
          angle = (i / steps) * Math.PI * 2 + (radius * 0.5)
  
          // Archimedes spiral: r = a + b*θ
          const spiralRadius = radius * 0.8
          const x = Math.round(Math.cos(angle) * spiralRadius) * this.postWidth
          const y = Math.round(Math.sin(angle) * spiralRadius) * this.postHeight
  
          // Check if this position is available for the given size
          if (!this.isOccupied(x, y, size)) {
            positionsToCheck.push({ x, y })
          }
        }
  
        // If we found valid positions, pick one randomly
        if (positionsToCheck.length > 0) {
          const position = positionsToCheck[Math.floor(Math.random() * positionsToCheck.length)]
          this.addExistingPost(position.x, position.y, size)
          return position
        }
      }
  
      // Fallback: find any adjacent position
      return this.findAdjacentPosition(size)
    }
  
    findAdjacentPosition(size = 1) {
      const occupied = Array.from(this.occupiedPositions.keys())
  
      // Shuffle occupied positions for randomness
      for (let i = occupied.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[occupied[i], occupied[j]] = [occupied[j], occupied[i]]
      }
  
      const directions = [
        { dx: 1, dy: 0 },   // right
        { dx: -1, dy: 0 },  // left
        { dx: 0, dy: 1 },   // down
        { dx: 0, dy: -1 },  // up
        { dx: 1, dy: 1 },   // diagonal
        { dx: -1, dy: 1 },
        { dx: 1, dy: -1 },
        { dx: -1, dy: -1 }
      ]
  
      // Shuffle directions
      for (let i = directions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[directions[i], directions[j]] = [directions[j], directions[i]]
      }
  
      for (const posKey of occupied) {
        const [x, y] = posKey.split(',').map(Number)
  
        for (const dir of directions) {
          const newX = x + (dir.dx * this.postWidth * size)
          const newY = y + (dir.dy * this.postHeight * size)
  
          if (!this.isOccupied(newX, newY, size)) {
            this.addExistingPost(newX, newY, size)
            return { x: newX, y: newY }
          }
        }
      }
  
      // Ultimate fallback
      const fallbackX = Math.floor(Math.random() * 20 - 10) * this.postWidth
      const fallbackY = Math.floor(Math.random() * 20 - 10) * this.postHeight
      this.addExistingPost(fallbackX, fallbackY, size)
      return { x: fallbackX, y: fallbackY }
    }
  
    loadExistingPosts(posts) {
      posts.forEach(post => {
        this.addExistingPost(post.x_position, post.y_position, post.size || 1)
      })
    }
  }