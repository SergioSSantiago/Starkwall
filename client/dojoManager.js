import { stringToByteArray } from './utils.js';
import { ToriiQueryBuilder, KeysClause } from "@dojoengine/sdk";
import { PAYMENT_TOKEN_ADDRESS, RPC_URL } from './config.js';
import { RpcProvider } from 'starknet';

const ONE_STRK = 10n ** 18n;
const PAID_POST_MULTIPLIER = 4;
const AUCTION_POST_CREATION_FEE_STRK = 10;
const POST_KIND_NORMAL = 0;
const POST_KIND_AUCTION_CENTER = 1;
const POST_KIND_AUCTION_SLOT = 2;

function getPaidPostPrice(size) {
  if (size < 2) return 0;
  return Math.max(1, Math.floor(PAID_POST_MULTIPLIER ** (size - 2)));
}


function isTxReceiptSuccessful(receipt) {
  const execution = receipt?.execution_status || receipt?.executionStatus || '';
  const finality = receipt?.finality_status || receipt?.finalityStatus || '';

  if (String(execution).toUpperCase() === 'REVERTED') return false;
  if (String(finality).toUpperCase() === 'REJECTED') return false;

  // Some providers only return tx hash/finality; treat non-reverted receipts as success.
  return true;
}

function feltToU256(val) {
  const n = BigInt(val);
  const low = n & ((1n << 128n) - 1n);
  const high = n >> 128n;
  return { low: low.toString(), high: high.toString() };
}

export class DojoManager {
  constructor(account, manifest, toriiClient) {
    this.account = account;
    this.manifest = manifest;
    this.toriiClient = toriiClient;
    this.actionsContract = manifest.contracts.find((c) => c.tag === 'di-actions');
    this.balanceProvider = new RpcProvider({ nodeUrl: RPC_URL });
  }

  async getTokenBalance(address) {
    const tokenAddr = PAYMENT_TOKEN_ADDRESS
    if (!tokenAddr) return 0

    // Starknet ERC20s usually expose `balanceOf`, but our local minimal token uses `balance_of`.
    const entrypoints = ['balanceOf', 'balance_of']

    for (const entrypoint of entrypoints) {
      const call = {
        contractAddress: tokenAddr,
        entrypoint,
        calldata: [address],
      }

      try {
        // Some nodes reject `pending`; prefer `latest`.
        let result
        try {
          result = await this.balanceProvider.callContract(call, 'latest')
        } catch {
          result = await this.balanceProvider.callContract(call)
        }

        // Some providers return { result: [low, high] }, others return [low, high].
        const parts = Array.isArray(result) ? result : (result?.result || [])
        const low = BigInt(parts[0] || 0)
        const high = BigInt(parts[1] || 0)
        const wei = low + (high << 128n)
        return Number(wei / ONE_STRK)
      } catch (e) {
        // Try next entrypoint.
        continue
      }
    }

    return 0
  }

  async buyPostWithPayment(postId, sellerAddress, price) {
    const tokenAddr = PAYMENT_TOKEN_ADDRESS;
    if (!tokenAddr) throw new Error('No token configured. Set VITE_STRK_TOKEN or deploy STRK (see contracts/DEPLOY_STRK.md).');
    const amountWei = BigInt(price) * ONE_STRK;
    const { low, high } = feltToU256(amountWei);
    const calls = [
      // Contract enforces payment via transfer_from inside buy_post.
      { contractAddress: tokenAddr, entrypoint: 'approve', calldata: [this.actionsContract.address, low, high] },
      { contractAddress: this.actionsContract.address, entrypoint: 'buy_post', calldata: [postId] },
    ];

    const tx = await this.account.execute(calls);
    const receipt = await this.account.waitForTransaction(tx.transaction_hash);

    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Buy transaction reverted';
      throw new Error(reason);
    }

    return tx;
  }

  async sendStrk(recipientAddress, amountStrk) {
    const tokenAddr = PAYMENT_TOKEN_ADDRESS;
    if (!tokenAddr) throw new Error('No token configured.');

    const recipient = String(recipientAddress || '').trim();
    if (!recipient.startsWith('0x')) throw new Error('Invalid recipient address.');

    const amountNum = Number(amountStrk);
    if (!Number.isFinite(amountNum) || amountNum <= 0) throw new Error('Invalid amount.');

    const amountWei = BigInt(Math.floor(amountNum * 1_000_000)) * (ONE_STRK / 1_000_000n);
    if (amountWei <= 0n) throw new Error('Amount too small.');

    const { low, high } = feltToU256(amountWei);
    const tx = await this.account.execute({
      contractAddress: tokenAddr,
      entrypoint: 'transfer',
      calldata: [recipient, low, high],
    });

    const receipt = await this.account.waitForTransaction(tx.transaction_hash);
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Token transfer reverted';
      throw new Error(reason);
    }

    return tx;
  }

  /**
   * Create a post on-chain
   * @param {string} imageUrl - URL of the image
   * @param {string} caption - Post caption
   * @param {string} creatorUsername - Username of the creator
   * @param {number} xPosition - X coordinate
   * @param {number} yPosition - Y coordinate
   * @param {number} size - Post size (1 = free, 2+ = paid)
   * @param {boolean} isPaid - Whether it's a paid post
   * @returns {Promise<number>} - The ID of the created post
   */
  async createPost(imageUrl, caption, creatorUsername, xPosition, yPosition, size, isPaid) {
    console.log('📝 Creating post with params:', {
      imageUrl,
      caption,
      creatorUsername,
      xPosition,
      yPosition,
      size,
      isPaid
    });

    // Convert strings to ByteArray format for Cairo
    const imageUrlBytes = stringToByteArray(imageUrl);
    const captionBytes = stringToByteArray(caption);
    const usernameBytes = stringToByteArray(creatorUsername);

    console.log('📦 Converted calldata:', {
      imageUrlBytes,
      captionBytes,
      usernameBytes,
      contractAddress: this.actionsContract.address
    });

    const calldata = [
      ...imageUrlBytes,
      ...captionBytes,
      ...usernameBytes,
      xPosition,
      yPosition,
      size, // Tamaño del post (1, 2, 3, 4...)
      isPaid ? 1 : 0,
    ];

    console.log('🚀 Executing transaction with calldata length:', calldata.length);

    try {
      const tokenAddr = PAYMENT_TOKEN_ADDRESS;
      const shouldChargePaidPost = Boolean(isPaid) && Number(size) >= 2;

      if (shouldChargePaidPost) {
        console.log('💸 Paid post price (STRK):', getPaidPostPrice(Number(size)));
      }

      // Paid post: atomic multicall (charge -> create post)
      const tx = shouldChargePaidPost
        ? await (() => {
            const priceInStrk = getPaidPostPrice(Number(size));
            const amountWei = BigInt(priceInStrk) * ONE_STRK;
            const { low, high } = feltToU256(amountWei);
            return this.account.execute([
              {
                contractAddress: tokenAddr,
                entrypoint: 'approve',
                // Contract enforces payment via transfer_from inside create_post.
                calldata: [this.actionsContract.address, low, high],
              },
              {
                contractAddress: this.actionsContract.address,
                entrypoint: 'create_post',
                calldata,
              },
            ]);
          })()
        : await this.account.execute({
            contractAddress: this.actionsContract.address,
            entrypoint: 'create_post',
            calldata,
          });

      console.log('✅ Transaction sent:', tx.transaction_hash);

      // Wait for transaction to be accepted
      console.log('⏳ Waiting for transaction confirmation...');
      const receipt = await this.account.waitForTransaction(tx.transaction_hash);
      console.log('✅ Transaction receipt:', receipt);

      if (!isTxReceiptSuccessful(receipt)) {
        const reason = receipt?.revert_reason || receipt?.revertReason || 'Transaction reverted';
        throw new Error(reason);
      }

      console.log('✅ Transaction confirmed!');
      return tx;
    } catch (error) {
      console.error('❌ Transaction failed:', error);
      throw error;
    }
  }

  async createAuctionPost3x3(imageUrl, caption, creatorUsername, centerX, centerY, endTimeUnix) {
    const imageUrlBytes = stringToByteArray(imageUrl || '');
    const captionBytes = stringToByteArray(caption || '');
    const usernameBytes = stringToByteArray(creatorUsername || '');

    const calldata = [
      ...imageUrlBytes,
      ...captionBytes,
      ...usernameBytes,
      centerX,
      centerY,
      Number(endTimeUnix),
    ];

    const amountWei = BigInt(AUCTION_POST_CREATION_FEE_STRK) * ONE_STRK;
    const { low, high } = feltToU256(amountWei);

    const tx = await this.account.execute([
      {
        contractAddress: PAYMENT_TOKEN_ADDRESS,
        entrypoint: 'approve',
        calldata: [this.actionsContract.address, low, high],
      },
      {
        contractAddress: this.actionsContract.address,
        entrypoint: 'create_auction_post_3x3',
        calldata,
      },
    ]);

    const receipt = await this.account.waitForTransaction(tx.transaction_hash);
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Create auction transaction reverted';
      throw new Error(reason);
    }

    return tx;
  }

  async placeAuctionBid(slotPostId, bidAmountStrk) {
    const tokenAddr = PAYMENT_TOKEN_ADDRESS;
    if (!tokenAddr) throw new Error('No token configured.');

    const amountStrk = Number(bidAmountStrk);
    if (!Number.isFinite(amountStrk) || amountStrk <= 0) throw new Error('Invalid bid amount');

    const amountWei = BigInt(Math.floor(amountStrk)) * ONE_STRK;
    const { low, high } = feltToU256(amountWei);

    const calls = [
      {
        contractAddress: tokenAddr,
        entrypoint: 'approve',
        calldata: [this.actionsContract.address, low, high],
      },
      {
        contractAddress: this.actionsContract.address,
        entrypoint: 'place_bid',
        calldata: [slotPostId, Math.floor(amountStrk)],
      },
    ];

    const tx = await this.account.execute(calls);
    const receipt = await this.account.waitForTransaction(tx.transaction_hash);

    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Bid transaction reverted';
      throw new Error(reason);
    }

    return tx;
  }

  async finalizeAuctionSlot(slotPostId) {
    const tx = await this.account.execute({
      contractAddress: this.actionsContract.address,
      entrypoint: 'finalize_auction_slot',
      calldata: [slotPostId],
    });

    const receipt = await this.account.waitForTransaction(tx.transaction_hash);
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Finalize auction transaction reverted';
      throw new Error(reason);
    }

    return tx;
  }

  async setWonSlotContent(slotPostId, imageUrl, caption) {
    const imageUrlBytes = stringToByteArray(imageUrl || '');
    const captionBytes = stringToByteArray(caption || '');

    const tx = await this.account.execute({
      contractAddress: this.actionsContract.address,
      entrypoint: 'set_won_slot_content',
      calldata: [slotPostId, ...imageUrlBytes, ...captionBytes],
    });

    const receipt = await this.account.waitForTransaction(tx.transaction_hash);
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Set slot content transaction reverted';
      throw new Error(reason);
    }

    return tx;
  }

  /**
   * Query all posts from Torii
   * @returns {Promise<Array>} - Array of post objects
   */
  async queryAllPosts() {
    try {
      console.log('🔍 Querying Post entities from Torii...');
      console.log('  ToriiClient:', this.toriiClient);
      console.log('  Available methods:', Object.keys(this.toriiClient));
      
      // Build query for all entities (we'll filter for Posts)
      console.log('  Step 1: Creating ToriiQueryBuilder...');
      const builder = new ToriiQueryBuilder();
      console.log('  Builder created:', builder);
      
      console.log('  Step 2: Creating KeysClause...');
      // KeysClause is a function: KeysClause([models], [keys], pattern)
      // To get all posts: empty keys array with VariableLen pattern
      const keysClause = KeysClause(['di-Post'], [], 'VariableLen').build();
      console.log('  KeysClause created:', keysClause);
      
      console.log('  Step 3: Adding clause to builder...');
      const withClause = builder.withClause(keysClause);
      console.log('  Clause added:', withClause);
      
      console.log('  Step 4: Calling getEntities (SDK will build query automatically)...');
      
      // Add timeout to prevent infinite hanging
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Query timeout after 10s')), 10000);
      });
      
      // Don't call .build() - SDK builds it automatically!
      const queryPromise = this.toriiClient.getEntities({
        query: withClause
      });
      
      const entities = await Promise.race([queryPromise, timeoutPromise]);
      
      console.log('  ✅ getEntities returned!');
      console.log('📦 Raw entities response:', entities);
      console.log('📊 Items count:', entities?.items?.length || 0);
      
      if (!entities || !entities.items || entities.items.length === 0) {
        console.log('⚠️ No Post entities found');
        return [];
      }

      // Query auction models too; they are not guaranteed to be included in Post envelopes.
      let slotItems = [];
      let groupItems = [];

      try {
        const slotQuery = new ToriiQueryBuilder()
          .withClause(KeysClause(['di-AuctionSlot'], [], 'VariableLen').build());
        const slotEntities = await this.toriiClient.getEntities({ query: slotQuery });
        slotItems = slotEntities?.items || [];
      } catch (e) {
        console.warn('⚠️ AuctionSlot query failed:', e?.message || e);
      }

      try {
        const groupQuery = new ToriiQueryBuilder()
          .withClause(KeysClause(['di-AuctionGroup'], [], 'VariableLen').build());
        const groupEntities = await this.toriiClient.getEntities({ query: groupQuery });
        groupItems = groupEntities?.items || [];
      } catch (e) {
        console.warn('⚠️ AuctionGroup query failed:', e?.message || e);
      }

      const mergedItems = [...entities.items, ...slotItems, ...groupItems];
      const posts = this.parseSDKEntities(mergedItems);
      console.log(`✅ Parsed ${posts.length} posts`);
      
      return posts;
    } catch (error) {
      console.error('❌ Error querying posts:', error);
      console.error('Error name:', error.name);
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      
      // If it timed out, the SDK method might not work, so return empty
      if (error.message.includes('timeout')) {
        console.error('⏱️ Query timed out - SDK getEntities may not be working');
        console.error('💡 Torii is working (GraphQL works), but SDK client query is hanging');
      }
      
      return [];
    }
  }

  /**
   * Parse post entities from SDK response (entities.items)
   * @param {Array} items - Array of entity items from SDK
   * @returns {Array} - Parsed post objects
   */
  parseSDKEntities(items) {
    const posts = [];
    const slotByPostId = new Map();
    const groupById = new Map();

    // First pass: collect AuctionSlot and AuctionGroup models from entity envelopes.
    items.forEach((entity) => {
      const slot = entity.models?.di?.AuctionSlot;
      if (slot) {
        const slotPostId = Number(slot.slot_post_id ?? slot.slotPostId ?? slot.slot_post ?? 0);
        if (slotPostId > 0) {
          slotByPostId.set(slotPostId, {
            slot_post_id: slotPostId,
            group_id: Number(slot.group_id ?? 0),
            highest_bid: Number(slot.highest_bid ?? 0),
            highest_bidder: slot.highest_bidder || null,
            has_bid: Boolean(slot.has_bid),
            finalized: Boolean(slot.finalized),
            content_initialized: Boolean(slot.content_initialized),
          });
        }
      }

      const group = entity.models?.di?.AuctionGroup;
      if (group) {
        const groupId = Number(group.group_id ?? 0);
        if (groupId > 0) {
          groupById.set(groupId, {
            group_id: groupId,
            center_post_id: Number(group.center_post_id ?? 0),
            creator: group.creator || null,
            end_time: Number(group.end_time ?? 0),
            active: Boolean(group.active),
          });
        }
      }
    });

    // Second pass: parse Post models and attach auction metadata.
    items.forEach((entity) => {
      const postData = entity.models?.di?.Post;
      if (!postData) return;

      let salePrice = 0;
      if (postData.sale_price !== undefined && postData.sale_price !== null) {
        const rawPrice = postData.sale_price;
        if (typeof rawPrice === 'object' && rawPrice !== null) {
          if ('low' in rawPrice) salePrice = Number(rawPrice.low);
          else if ('0' in rawPrice) salePrice = Number(rawPrice['0']);
        } else {
          salePrice = Number(rawPrice);
        }
      }

      const postId = Number(postData.id);
      const postKind = Number(postData.post_kind ?? POST_KIND_NORMAL);
      const auctionGroupId = Number(postData.auction_group_id ?? 0);
      const auctionSlotIndex = Number(postData.auction_slot_index ?? 0);

      const slot = slotByPostId.get(postId) || null;
      const group = auctionGroupId > 0 ? (groupById.get(auctionGroupId) || null) : null;

      posts.push({
        id: postId,
        image_url: this.byteArrayToString(postData.image_url),
        caption: this.byteArrayToString(postData.caption),
        x_position: Number(postData.x_position),
        y_position: Number(postData.y_position),
        size: Number(postData.size || 1),
        is_paid: Boolean(postData.is_paid),
        created_at: new Date(Number(postData.created_at) * 1000).toISOString(),
        created_by: postData.created_by,
        creator_username: this.byteArrayToString(postData.creator_username),
        current_owner: postData.current_owner,
        sale_price: salePrice,
        post_kind: postKind,
        auction_group_id: auctionGroupId,
        auction_slot_index: auctionSlotIndex,
        auction_slot: slot,
        auction_group: group,
      });
    });

    return posts;
  }

  /**
   * Convert ByteArray from Cairo to JavaScript string
   * @param {Object} byteArray - ByteArray object from Cairo
   * @returns {string} - Converted string
   */
  byteArrayToString(byteArray) {
    if (typeof byteArray === 'string') return byteArray;
    if (!byteArray?.data) return '';
    
    // ByteArray format: { data: [u256, ...], pending_word: u256, pending_word_len: u32 }
    let str = '';
    
    // Process full words (31 bytes each)
    for (const word of byteArray.data) {
      const bytes = this.u256ToBytes(word);
      str += new TextDecoder().decode(bytes);
    }
    
    // Process pending word if exists
    if (byteArray.pending_word_len > 0) {
      const pendingBytes = this.u256ToBytes(byteArray.pending_word).slice(0, byteArray.pending_word_len);
      str += new TextDecoder().decode(pendingBytes);
    }
    
    return str;
  }

  /**
   * Convert u256 to bytes
   * @param {string|number} u256 - u256 value
   * @returns {Uint8Array} - Byte array
   */
  u256ToBytes(u256) {
    const hex = BigInt(u256).toString(16).padStart(62, '0'); // 31 bytes = 62 hex chars
    const bytes = new Uint8Array(31);
    
    for (let i = 0; i < 31; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    
    return bytes;
  }

  /**
   * Set the sale price for a post
   * @param {number} postId - ID of the post
   * @param {number} price - Price in wei (0 to remove from sale)
   * @returns {Promise} - Transaction result
   */
  async setPostPrice(postId, price) {
    console.log('💰 Setting post price:', { postId, price });
    
    // Try passing u128 as a single value (Cairo might handle it automatically)
    const calldata = [postId, price];
    console.log('📤 Sending calldata (trying single u128 value):', calldata);
    console.log('📤 Contract address:', this.actionsContract.address);
    console.log('📤 Entrypoint:', 'set_post_price');

    try {
      const tx = await this.account.execute({
        contractAddress: this.actionsContract.address,
        entrypoint: 'set_post_price',
        calldata: calldata,
      });

      console.log('✅ Price set! Transaction:', tx.transaction_hash);
      console.log('📊 Full transaction object:', tx);
      
      // Wait for transaction confirmation
      const receipt = await this.account.waitForTransaction(tx.transaction_hash);
      console.log('✅ Transaction confirmed!', receipt);
      
      return tx;
    } catch (error) {
      console.error('❌ Failed to set price:', error);
      throw error;
    }
  }

  /**
   * Buy a post that is for sale
   * @param {number} postId - ID of the post to buy
   * @returns {Promise} - Transaction result
   */
  async buyPost(postId) {
    console.log('🛒 Buying post:', postId);

    try {
      const tx = await this.account.execute({
        contractAddress: this.actionsContract.address,
        entrypoint: 'buy_post',
        calldata: [postId],
      });

      console.log('✅ Post purchased! Transaction:', tx.transaction_hash);
      
      // Wait for transaction confirmation
      const receipt = await this.account.waitForTransaction(tx.transaction_hash);
      console.log('✅ Transaction confirmed!', receipt);
      
      return tx;
    } catch (error) {
      console.error('❌ Failed to buy post:', error);
      throw error;
    }
  }

  /**
   * Query a specific post directly from the blockchain (not Torii)
   * @param {number} postId - ID of the post
   * @returns {Promise} - The post data
   */
  async queryPostDirect(postId) {
    console.log('🔍 Querying post directly from blockchain:', postId);
    
    try {
      const post = await this.toriiClient.getEntities({
        query: new ToriiQueryBuilder()
          .withClause(KeysClause(['di-Post'], [postId], 'FixedLen').build())
      });
      
      console.log('📦 Direct query result:', post);
      
      if (post.items && post.items.length > 0) {
        const postData = post.items[0].models?.di?.Post;
        console.log('📊 Post data:', postData);
        console.log('💰 sale_price from blockchain:', postData?.sale_price);
        return postData;
      } else {
        console.log('❌ Post not found');
        return null;
      }
    } catch (error) {
      console.error('❌ Error querying post:', error);
      throw error;
    }
  }
}

