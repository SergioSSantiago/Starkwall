# Frontend Integration with Dojo

## Overview

The frontend now supports both **mock data mode** (default) and **Dojo mode** (on-chain posts). This guide explains how to integrate Dojo with your existing canvas application.

## Prerequisites

1. Contracts deployed to Katana
2. Torii indexer running
3. Controller wallet connected

## Integration Steps

### Option 1: Update `index.html` (Recommended)

Replace the existing Dojo integration script in `index.html` with this updated version:

```html
<script type="module">
  import Controller from "@cartridge/controller";
  import { init } from "@dojoengine/sdk";

  import controllerOpts from "./controller.js";
  import { DojoManager } from "./dojoManager.js";
  import { InfiniteCanvas } from "./canvas.js";
  import { PostManager } from "./postManager.js";

  import manifest from "../contracts/manifest_dev.json" assert { type: "json" };

  const DOMAIN_SEPERATOR = {
    name: "di",
    version: "1.0",
    chainId: "KATANA",
    revision: "1",
  };

  let canvas, postManager;

  // Initialize canvas with mock data
  function initMockMode() {
    const canvasElement = document.getElementById("canvas");
    canvas = new InfiniteCanvas(canvasElement);
    postManager = new PostManager(canvas); // No Dojo manager = mock mode

    initUI();
    postManager.loadPosts().then(() => {
      if (postManager.posts.length > 0) {
        const firstPost = postManager.posts[0];
        canvas.centerOn(firstPost.x_position, firstPost.y_position, 0.3);
      }
    });
  }

  // Initialize canvas with Dojo
  async function initDojoMode(account) {
    const toriiClient = await init({
      client: {
        worldAddress: manifest.world.address,
        toriiUrl: "http://localhost:8080",
      },
      domain: DOMAIN_SEPERATOR,
    });

    const canvasElement = document.getElementById("canvas");
    canvas = new InfiniteCanvas(canvasElement);

    const dojoManager = new DojoManager(account, manifest, toriiClient);
    postManager = new PostManager(canvas, dojoManager); // With Dojo manager

    initUI();

    // Load posts from chain
    await postManager.loadPosts();

    if (postManager.posts.length > 0) {
      const firstPost = postManager.posts[0];
      canvas.centerOn(firstPost.x_position, firstPost.y_position, 0.3);
    }

    // Subscribe to new posts
    const subscription = await toriiClient.subscribeEntityQuery({
      query: {
        Keys: {
          keys: [],
          pattern_matching: "VariableLen",
          models: ["di-Post"],
        },
      },
      callback: async ({ data, error }) => {
        if (data) {
          console.log("New post data:", data);
          await postManager.loadPosts();
          await postManager.loadImages();
          canvas.setPosts(postManager.posts);
        }
        if (error) {
          console.error("Subscription error:", error);
        }
      },
    });

    window.addEventListener("beforeunload", () => {
      if (subscription) {
        subscription.cancel();
      }
    });
  }

  function initUI() {
    const modal = document.getElementById("modal");
    const postForm = document.getElementById("postForm");
    const imageUrlInput = document.getElementById("imageUrl");
    const captionInput = document.getElementById("caption");
    const postSizeInput = document.getElementById("postSize");
    const isPaidInput = document.getElementById("isPaid");

    const addPostBtn = document.getElementById("addPost");
    const addPaidPostBtn = document.getElementById("addPaidPost");
    const resetViewBtn = document.getElementById("resetView");
    const cancelPostBtn = document.getElementById("cancelPost");

    addPostBtn.addEventListener("click", () => {
      postSizeInput.value = "1";
      isPaidInput.value = "false";
      modal.classList.add("active");
      imageUrlInput.focus();
    });

    addPaidPostBtn.addEventListener("click", () => {
      postSizeInput.value = "1";
      isPaidInput.value = "true";
      modal.classList.add("active");
      imageUrlInput.focus();
    });

    cancelPostBtn.addEventListener("click", () => {
      modal.classList.remove("active");
      postForm.reset();
    });

    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.classList.remove("active");
        postForm.reset();
      }
    });

    postForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      const imageUrl = imageUrlInput.value;
      const caption = captionInput.value;
      const size = parseInt(postSizeInput.value);
      const isPaid = isPaidInput.value === "true";

      try {
        await postManager.createPost(imageUrl, caption, size, isPaid);
        modal.classList.remove("active");
        postForm.reset();
      } catch (error) {
        console.error("Error creating post:", error);
        alert("Failed to create post. Please try again.");
      }
    });

    resetViewBtn.addEventListener("click", () => {
      if (postManager.posts.length > 0) {
        const firstPost = postManager.posts[0];
        canvas.centerOn(firstPost.x_position, firstPost.y_position, 0.3);
      } else {
        canvas.centerOn(0, 0, 0.3);
      }
    });
  }

  // Start in mock mode by default
  initMockMode();

  // Optional: Add a connect button to switch to Dojo mode
  const controller = new Controller(controllerOpts);

  // You can add a connect button to your HTML:
  // <button id="connect-wallet">Connect Wallet</button>

  const connectBtn = document.getElementById("connect-wallet");
  if (connectBtn) {
    connectBtn.onclick = async () => {
      try {
        const account = await controller.connect();
        connectBtn.textContent = "Connected";
        connectBtn.style.backgroundColor = "#4CAF50";

        // Switch to Dojo mode
        await initDojoMode(account);
      } catch (error) {
        console.error("Failed to connect:", error);
        connectBtn.textContent = "Connection Failed";
        connectBtn.style.backgroundColor = "#f44336";
      }
    };
  }
</script>
```

### Option 2: Update `main.js`

Alternatively, you can create a new `main.js` that includes Dojo support:

```javascript
import "./style.css";
import { InfiniteCanvas } from "./canvas.js";
import { PostManager } from "./postManager.js";
import { DojoManager } from "./dojoManager.js";
import Controller from "@cartridge/controller";
import { init } from "@dojoengine/sdk";
import controllerOpts from "./controller.js";
import manifest from "../contracts/manifest_dev.json" assert { type: "json" };

// Configuration
const USE_DOJO = false; // Set to true to use Dojo, false for mock data

const DOMAIN_SEPERATOR = {
  name: "di",
  version: "1.0",
  chainId: "KATANA",
  revision: "1",
};

async function initApp() {
  const canvasElement = document.getElementById("canvas");
  const canvas = new InfiniteCanvas(canvasElement);

  let postManager;

  if (USE_DOJO) {
    // Connect to wallet and Dojo
    const controller = new Controller(controllerOpts);
    const account = await controller.connect();

    const toriiClient = await init({
      client: {
        worldAddress: manifest.world.address,
        toriiUrl: "http://localhost:8080",
      },
      domain: DOMAIN_SEPERATOR,
    });

    const dojoManager = new DojoManager(account, manifest, toriiClient);
    postManager = new PostManager(canvas, dojoManager);
  } else {
    // Use mock data
    postManager = new PostManager(canvas);
  }

  // Setup UI... (rest of your UI code)

  await postManager.loadPosts();
  // ...
}

initApp();
```

## File Structure

After integration, your client folder should contain:

```
client/
├── canvas.js           # Canvas rendering
├── postManager.js      # Post management (mock + Dojo)
├── dojoManager.js      # Dojo blockchain interactions (NEW)
├── utils.js            # ByteArray utilities (NEW)
├── controller.js       # Controller configuration (UPDATED)
├── spiralLayout.js     # Layout logic
├── main.js            # Main entry point (UPDATED)
├── index.html         # HTML with Dojo script (UPDATED)
└── style.css          # Styles
```

## Testing

### 1. Test Mock Mode (Default)

Just run the app as normal:

```bash
cd client
npm run dev
```

### 2. Test Dojo Mode

1. Start Katana:

```bash
cd contracts
katana --disable-fee
```

2. Deploy contracts:

```bash
sozo migrate apply
```

3. Start Torii:

```bash
torii --world <WORLD_ADDRESS>
```

4. Update `USE_DOJO = true` or connect wallet via UI

5. Run the app:

```bash
cd client
npm run dev
```

## Key Features

### Mock Mode

- ✅ Uses predefined mock posts
- ✅ Creates posts locally
- ✅ No blockchain required
- ✅ Instant feedback

### Dojo Mode

- ✅ Reads posts from blockchain via Torii
- ✅ Creates posts on-chain
- ✅ Real-time subscriptions to new posts
- ✅ Wallet integration via Controller

## Troubleshooting

### Posts not loading from Dojo

- Check Torii is running: `http://localhost:8080`
- Verify world address in manifest
- Check console for errors

### ByteArray conversion errors

- Ensure strings are UTF-8 encoded
- Check Cairo ByteArray format in utils.js

### Transaction failures

- Verify Katana is running
- Check account has funds
- Ensure contract is deployed

## Next Steps

1. Add post ownership transfer functionality
2. Implement post deletion/burning
3. Add filtering by owner
4. Create post marketplace
