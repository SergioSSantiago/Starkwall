# Debugging Post Creation

When you create a post, you should now see detailed logs in the browser console. Here's what to check:

## ✅ Checklist Before Testing

### 1. Verify Contracts Are Deployed

```bash
cd contracts
sozo migrate apply
```

**Look for this output:**

```
World address: 0x...
✓ Contract deployed: di-actions
✓ Model registered: Post
✓ Model registered: PostCounter
```

**Copy the World Address!** You'll need it for Torii.

### 2. Verify Torii Is Running

```bash
# Use the world address from step 1
torii --world <WORLD_ADDRESS>
```

**Should see:**

```
Starting torii...
Listening on http://0.0.0.0:8080
```

**Test it:** Open `http://localhost:8080/graphql` in your browser. You should see a GraphQL playground.

### 3. Verify Katana Is Running

```bash
# In another terminal
cd contracts
katana --disable-fee
```

Should see block numbers increasing.

## 🔍 What to Look For in Console

When you click "Create Post" and submit the form, you should see these logs in order:

### Expected Log Sequence:

```
1. Creating post at position: {x: 0, y: 0}
   ↓
2. 🎨 Creating post on-chain...
   ↓
3. 📝 Creating post with params: {...}
   ↓
4. 📦 Converted calldata: {...}
   ↓
5. 🚀 Executing transaction with calldata length: X
   ↓
6. ✅ Transaction sent: 0x...
   ↓
7. ⏳ Waiting for transaction confirmation...
   ↓
8. ✅ Transaction confirmed! {...}
   ↓
9. ⏳ Waiting for Torii to index...
   ↓
10. 🔄 Reloading posts...
   ↓
11. ✅ Posts reloaded! Total posts: 1
   ↓
12. 📍 Centering on new post: 1
```

## 🐛 Common Issues and Solutions

### Issue 1: "Contract not found" or "No actionsContract"

**Problem:** Contracts not deployed or manifest not updated

**Solution:**

```bash
cd contracts
sozo migrate apply
# Refresh your browser (Ctrl+Shift+R)
```

### Issue 2: Transaction stuck at "Executing transaction..."

**Problem:** Katana not running or wallet has no funds

**Solution:**

1. Check Katana terminal - should show new blocks
2. In Controller, check you have ETH balance
3. Katana gives test accounts free ETH automatically

### Issue 3: Transaction confirms but post doesn't appear

**Problem:** Torii not indexing or wrong world address

**Solutions:**

**A. Check Torii logs:**
Look for errors in the Torii terminal. Should see:

```
Indexed block #X
Processing entity...
```

**B. Verify world address matches:**

```bash
# Check manifest
cat contracts/manifest_dev.json | grep "world.*address"

# Should match what you passed to Torii
ps aux | grep torii
```

**C. Restart Torii:**

```bash
# Kill Torii (Ctrl+C)
# Get world address from manifest
torii --world <CORRECT_WORLD_ADDRESS>
```

### Issue 4: "Failed to load image" in console

**Problem:** Image URL is invalid or CORS issue

**Solution:**

- Use image URLs from `https://picsum.photos/` (they support CORS)
- Example: `https://picsum.photos/400/400`
- Or use any CORS-enabled image URL

### Issue 5: No logs appearing at all

**Problem:** Button click not registering or form not submitting

**Solution:**

1. Open DevTools (F12)
2. Go to Console tab
3. Try creating post again
4. If you see no logs, check:
   - Is the modal closing? (It should stay open if there's an error)
   - Check Network tab for any failed requests
   - Try hard refresh (Cmd+Shift+R or Ctrl+Shift+F5)

### Issue 6: "Position occupied" error

**Problem:** Trying to place post in occupied position

**Solution:** This is normal after creating multiple posts. The code should find adjacent positions automatically.

## 🧪 Manual Testing Steps

1. **Clear everything and start fresh:**

   ```bash
   # Kill all running processes (Ctrl+C in each terminal)

   # Restart Katana
   cd contracts
   katana --disable-fee

   # In new terminal: Deploy contracts
   cd contracts
   sozo build
   sozo migrate apply
   # COPY THE WORLD ADDRESS!

   # In new terminal: Start Torii
   torii --world <PASTE_WORLD_ADDRESS>

   # In new terminal: Start frontend
   cd client
   npm run dev
   ```

2. **Open browser in Incognito/Private mode** (fresh state)

3. **Open DevTools Console** (F12) BEFORE doing anything

4. **Navigate to** `http://localhost:5173`

5. **Click "Connect Wallet"**

   - Should see: "✓ Wallet connected!"
   - Should see: "✓ Loaded X posts"

6. **Click "Add Post"**

   - Enter image URL: `https://picsum.photos/400/400`
   - Enter caption: "Test Post"
   - Click "Create Post"

7. **Watch the console** - You should see all the logs listed above

8. **Wait ~2-3 seconds** - Post should appear on canvas!

## 📊 Verify Post Was Created On-Chain

### Option 1: Check Torii GraphQL

Open: `http://localhost:8080/graphql`

Run this query:

```graphql
query {
  entities(limit: 10) {
    totalCount
    edges {
      node {
        keys
        models {
          __typename
        }
      }
    }
  }
}
```

Should see your Post entities!

### Option 2: Check with Sozo

```bash
cd contracts
sozo model get Post --world <WORLD_ADDRESS>
```

## 🆘 Still Not Working?

1. **Share the console logs** - Copy everything from the Console tab
2. **Check all terminals** - Look for errors in Katana/Torii output
3. **Verify versions:**
   ```bash
   dojo --version
   sozo --version
   ```

## ✅ Success Indicators

You'll know it's working when:

- ✅ Console shows all 12 log steps
- ✅ Modal closes automatically
- ✅ Post appears on canvas within 2-3 seconds
- ✅ After refresh, post is still there (persisted on-chain!)
