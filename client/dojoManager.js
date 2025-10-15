import { stringToByteArray } from './utils.js';

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
    // Convert strings to ByteArray format for Cairo
    const imageUrlBytes = stringToByteArray(imageUrl);
    const captionBytes = stringToByteArray(caption);

    const tx = await this.account.execute({
      contractAddress: this.actionsContract.address,
      entrypoint: 'create_post',
      calldata: [
        ...imageUrlBytes,
        ...captionBytes,
        xPosition,
        yPosition,
        isPaid ? 1 : 0,
      ],
    });

    console.log('Post creation transaction:', tx);
    
    // Wait for transaction to be accepted
    await this.account.waitForTransaction(tx.transaction_hash);
    
    return tx;
  }

  /**
   * Query all posts from Torii
   * @returns {Promise<Array>} - Array of post objects
   */
  async queryAllPosts() {
    try {
      // Query all entities - Torii will return Post models
      const entities = await this.toriiClient.getEntities();
      
      if (!entities) {
        console.log('No entities found');
        return [];
      }

      return this.parsePostEntities(entities);
    } catch (error) {
      console.error('Error querying posts:', error);
      return [];
    }
  }

  /**
   * Parse post entities from Torii response
   * @param {Object} entities - Raw entities data from Torii
   * @returns {Array} - Parsed post objects
   */
  parsePostEntities(entities) {
    const posts = [];

    for (const [entityId, entity] of Object.entries(entities)) {
      if (entity.models?.di?.Post) {
        const postData = entity.models.di.Post;
        
        posts.push({
          id: Number(postData.id || entityId),
          image_url: this.byteArrayToString(postData.image_url),
          caption: this.byteArrayToString(postData.caption),
          x_position: Number(postData.x_position),
          y_position: Number(postData.y_position),
          size: Number(postData.size || 1),
          is_paid: Boolean(postData.is_paid),
          created_at: new Date(Number(postData.created_at) * 1000).toISOString(),
          created_by: postData.created_by,
          current_owner: postData.current_owner,
        });
      }
    }

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

