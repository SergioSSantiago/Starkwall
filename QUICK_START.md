# Quick Start - Running with Blockchain

Follow these steps to run your app with on-chain posts that persist after reload.

## Prerequisites

### Required Software

- ✅ Dojo installed (`dojoup`)
- ✅ Node.js and npm installed
- ✅ Chrome or Brave browser

### Install Cartridge Controller

**IMPORTANT:** You need the Cartridge Controller browser extension to connect your wallet!

1. **Install the extension:**

   - **Chrome**: Visit [Chrome Web Store - Cartridge Controller](https://chrome.google.com/webstore)
   - **Brave**: Same as Chrome
   - Or visit: https://cartridge.gg/controller

2. **Create an account (first time):**

   - Click the extension icon
   - Click "Create Account"
   - Choose a username
   - Set a password
   - Save your recovery phrase!

3. **Verify installation:**
   - You should see the Cartridge icon in your browser toolbar
   - Click it to ensure it opens

## Step-by-Step Setup

### 1. Start Katana (Local Blockchain) - Terminal 1

Open a terminal and run:

```bash
cd /Users/manu/Documents/dojo-intro/contracts
katana --disable-fee
```

**Keep this running!** You should see:

```
KATANA DEVNET RUNNING
...
```

### 2. Deploy Contracts - Terminal 2

Open a **new terminal** and run:

```bash
cd /Users/manu/Documents/dojo-intro/contracts

# Build contracts
sozo build

# Deploy to Katana
sozo migrate apply
```

**Important:** Copy the `WORLD_ADDRESS` from the output. It will look like:

```
World address: 0x...
```

### 3. Start Torii (Indexer) - Terminal 3

Open a **new terminal** and run:

```bash
cd /Users/manu/Documents/dojo-intro/contracts

# Replace <WORLD_ADDRESS> with the address from step 2
torii --world <WORLD_ADDRESS>
```

Example:

```bash
torii --world 0x05d3a9dacfe0969bc6c8c1f0eae8a44e44f6fb91ec60c5ad665b4f402c5a39a9
```

**Keep this running!** You should see:

```
Starting torii...
```

### 4. Start Frontend - Terminal 4

Open a **new terminal** and run:

```bash
cd /Users/manu/Documents/dojo-intro/client
npm run dev
```

Open your browser to: `http://localhost:5173`

### 5. Connect Wallet

When the page loads:

1. **Cartridge Controller popup** will appear
2. Click **"Connect"** or **"Create Account"**
3. If creating new account, set a username and password
4. The wallet will connect automatically

### 6. Create Your First Post!

1. Click **"Add Post"** button
2. Enter:
   - **Image URL:** Any image URL (e.g., `https://picsum.photos/400/400`)
   - **Caption:** Your post caption
3. Click **"Create Post"**
4. **Controller will ask you to approve** the transaction
5. Click **"Approve"** in the popup
6. Wait 2-3 seconds for the transaction to complete
7. **Post appears on canvas!**

### 7. Test Persistence

1. Create a post (follow step 6)
2. **Reload the page** (F5 or Cmd+R)
3. **Posts should still be there!** ✨

They're stored on-chain permanently!

## What's Running?

| Terminal | Service | Purpose               | Port |
| -------- | ------- | --------------------- | ---- |
| 1        | Katana  | Local blockchain      | 5050 |
| 2        | -       | Deployment (one-time) | -    |
| 3        | Torii   | Indexer/GraphQL       | 8080 |
| 4        | Vite    | Frontend dev server   | 5173 |

## Troubleshooting

### "Cartridge Controller popup not appearing"

**This is the most common issue!**

1. **Check extension is installed:**

   - Look for Cartridge icon in browser toolbar
   - If not there, install from https://cartridge.gg/controller

2. **Check extension is enabled:**

   - Go to `chrome://extensions/` (or `brave://extensions/`)
   - Find "Cartridge Controller"
   - Ensure it's enabled (toggle should be blue/on)

3. **Allow pop-ups:**

   - Browser might be blocking the popup
   - Check for blocked popup notification in address bar
   - Add `localhost:5173` to allowed sites

4. **Refresh and retry:**

   - Close all tabs with the app
   - Restart browser if needed
   - Open `http://localhost:5173` again

5. **Check console for errors:**
   - Press F12 to open DevTools
   - Look at Console tab for error messages
   - Look for "controller" or "connection" errors

### "Failed to connect" error

- Check Katana is running (Terminal 1)
- Check Cartridge Controller is installed
- Refresh the page
- Clear browser cache and try again

### "Transaction failed"

- Check Torii is running (Terminal 3)
- Verify world address is correct
- Check browser console for errors

### "Posts not loading"

- Verify Torii is running on port 8080
- Check console: `http://localhost:8080/graphql` should be accessible
- Ensure world address matches between Torii and manifest

### "No posts after reload"

- Verify you're using the blockchain version (not mock data)
- Check `main.js` has `DojoManager` imported
- Look for "Connected to wallet" in console

## Verifying Blockchain Storage

To verify posts are on-chain, you can:

1. **Check Torii GraphQL:**

   - Open: `http://localhost:8080/graphql`
   - Run query:

   ```graphql
   query {
     entities {
       edges {
         node {
           models {
             __typename
           }
         }
       }
     }
   }
   ```

2. **Check Console Logs:**
   - Open browser DevTools (F12)
   - Look for "Loading posts from Dojo..."
   - You should see the posts array

## Next Steps

Once everything works:

- ✅ Posts persist after reload
- ✅ Multiple users can see the same posts
- ✅ Posts are permanently on-chain
- 🚀 Ready to build more features!

## Stopping Everything

When done testing:

1. Press `Ctrl+C` in Terminal 4 (Frontend)
2. Press `Ctrl+C` in Terminal 3 (Torii)
3. Press `Ctrl+C` in Terminal 1 (Katana)
4. Deployment terminal (2) can be closed

## Production Deployment

For production on Starknet mainnet/testnet:

1. Update RPC URL in `controller.js`
2. Update chain ID
3. Deploy to Starknet using `sozo migrate`
4. Update frontend with production world address

See `README_POSTS.md` for full documentation.
