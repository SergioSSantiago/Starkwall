import './style.css'
import { InfiniteCanvas } from './canvas.js'
import { PostManager } from './postManager.js'

const canvasElement = document.getElementById('canvas')
const canvas = new InfiniteCanvas(canvasElement)
const postManager = new PostManager(canvas)

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

async function init() {
  await postManager.loadPosts()
  await postManager.subscribeToChanges()

  if (postManager.posts.length > 0) {
    const firstPost = postManager.posts[0]
    canvas.centerOn(firstPost.x_position, firstPost.y_position, 0.3)
  }
}

addPostBtn.addEventListener('click', () => {
  postSizeInput.value = '1'
  isPaidInput.value = 'false'
  modal.classList.add('active')
  imageUrlInput.focus()
})

addPaidPostBtn.addEventListener('click', () => {
  postSizeInput.value = '2'
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
    await postManager.createPost(imageUrl, caption, size, isPaid)
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

init()