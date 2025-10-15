import { stringToByteArray } from './utils.js';
import { ToriiQueryBuilder, KeysClause } from "@dojoengine/sdk";


export class DojoManager {
  constructor(account, manifest, toriiClient) {
    this.account = account;
    this.manifest = manifest;
    this.toriiClient = toriiClient;
    this.actionsContract = manifest.contracts.find((c) => c.tag === 'di-actions');
  }

  /**
   * Create a post on-chain
   * @param {string} imageUrl - URL of the image
   * @param {string} caption - Post caption
   * @param {number} xPosition - X coordinate
   * @param {number} yPosition - Y coordinate
   * @param {boolean} isPaid - Whether it's a paid post
   * @returns {Promise<number>} - The ID of the created post
   */
  async createPost(imageUrl, caption, xPosition, yPosition, isPaid) {
    console.log('📝 Creating post with params:', {
      imageUrl,
      caption,
      xPosition,
      yPosition,
      isPaid
    });

    // Convert strings to ByteArray format for Cairo
    const imageUrlBytes = stringToByteArray(imageUrl);
    const captionBytes = stringToByteArray(caption);

    console.log('📦 Converted calldata:', {
      imageUrlBytes,
      captionBytes,
      contractAddress: this.actionsContract.address
    });

    const calldata = [
      ...imageUrlBytes,
      ...captionBytes,
      xPosition,
      yPosition,
      isPaid ? 1 : 0,
    ];

    console.log('🚀 Executing transaction with calldata length:', calldata.length);

    try {
      const tx = await this.account.execute({
        contractAddress: this.actionsContract.address,
        entrypoint: 'create_post',
        calldata,
      });

      console.log('✅ Transaction sent:', tx.transaction_hash);
      
      // Wait for transaction to be accepted
      console.log('⏳ Waiting for transaction confirmation...');
      const receipt = await this.account.waitForTransaction(tx.transaction_hash);
      console.log('✅ Transaction confirmed!', receipt);
      
      return tx;
    } catch (error) {
      console.error('❌ Transaction failed:', error);
      throw error;
    }
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

      const posts = this.parseSDKEntities(entities.items);
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
    console.log('🔍 Parsing SDK entities...');
    console.log('  Items count:', items.length);
    
    const posts = [];

    items.forEach((entity, index) => {
      console.log(`  Processing item ${index}:`, entity);
      
      // SDK format: entity.models.di.Post
      const postData = entity.models?.di?.Post;
      
      if (postData) {
        console.log('    ✓ Found Post model:', postData);
        
        const post = {
          id: Number(postData.id),
          image_url: this.byteArrayToString(postData.image_url),
          caption: this.byteArrayToString(postData.caption),
          x_position: Number(postData.x_position),
          y_position: Number(postData.y_position),
          size: Number(postData.size || 1),
          is_paid: Boolean(postData.is_paid),
          created_at: new Date(Number(postData.created_at) * 1000).toISOString(),
          created_by: postData.created_by,
          current_owner: postData.current_owner,
        };
        
        console.log('    ✅ Parsed post:', post);
        posts.push(post);
      } else {
        console.log('    ✗ No Post model, available models:', entity.models);
      }
    });

    console.log(`📊 Total posts parsed: ${posts.length}`);
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
}

