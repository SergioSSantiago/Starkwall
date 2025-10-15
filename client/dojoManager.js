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
      console.log('🔍 Querying posts via GraphQL...');
      
      // Use GraphQL directly since SDK getEntities() is hanging
      const query = `
        query {
          entities(limit: 100) {
            edges {
              node {
                keys
                models {
                  __typename
                  ... on di_Post {
                    id
                    image_url
                    caption
                    x_position
                    y_position
                    size
                    is_paid
                    created_at
                    created_by
                    current_owner
                  }
                }
              }
            }
          }
        }
      `;

      const response = await fetch('http://localhost:8080/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      });

      const result = await response.json();
      console.log('📦 GraphQL response:', result);

      if (!result.data || !result.data.entities) {
        console.log('⚠️ No entities in response');
        return [];
      }

      const posts = [];
      
      for (const edge of result.data.entities.edges) {
        const models = edge.node.models;
        
        // Find the Post model (skip PostCounter)
        const postModel = models.find(m => m.__typename === 'di_Post');
        
        if (postModel) {
          console.log('✓ Found post:', postModel.id);
          
          posts.push({
            id: Number(postModel.id),
            image_url: this.byteArrayToString(postModel.image_url),
            caption: this.byteArrayToString(postModel.caption),
            x_position: Number(postModel.x_position),
            y_position: Number(postModel.y_position),
            size: Number(postModel.size || 1),
            is_paid: Boolean(postModel.is_paid),
            created_at: new Date(Number(postModel.created_at) * 1000).toISOString(),
            created_by: postModel.created_by,
            current_owner: postModel.current_owner,
          });
        }
      }

      console.log(`✅ Found ${posts.length} posts`);
      return posts;
      
    } catch (error) {
      console.error('❌ Error querying posts:', error);
      console.error('Error details:', error.message, error.stack);
      return [];
    }
  }

  /**
   * Parse post entities from Torii response
   * @param {Object} entities - Raw entities data from Torii
   * @returns {Array} - Parsed post objects
   */
  parsePostEntities(entities) {
    console.log('🔍 Parsing entities...');
    console.log('  Entity type:', typeof entities);
    console.log('  Is array?', Array.isArray(entities));
    console.log('  Keys:', Object.keys(entities || {}));
    
    const posts = [];

    for (const [entityId, entity] of Object.entries(entities || {})) {
      console.log(`  Processing entity ${entityId}:`, entity);
      
      if (entity.models?.di?.Post) {
        console.log('    ✓ Found Post model');
        const postData = entity.models.di.Post;
        
        const post = {
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
        };
        
        console.log('    Parsed post:', post);
        posts.push(post);
      } else {
        console.log('    ✗ No Post model found, models:', entity.models);
      }
    }

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

