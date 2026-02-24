/**
 * Crea 2 posts gratis (size 1) y 1 post de pago (size 2x2) para probar el sistema.
 *
 * Requisitos: Katana y Torii en marcha; sozo migrate ya ejecutado.
 * Uso: node scripts/create-test-posts.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

// Cuenta prefundada de Katana
const KATANA_ACCOUNT = {
  address: '0x127fd5f1fe78a71f8bcd1fec63e3fe2f0486b6ecd5c86a0466c3a21fa5cfcec',
  privateKey: '0xc5b2fcab997346f3ea1c00b002ecf6f382c5f9c9659a3894eb783c5320f912',
};

const POST_WIDTH = 393;
const POST_HEIGHT = 852;

function stringToByteArray(str) {
  const bytes = Buffer.from(str, 'utf8');
  const chunkSize = 31;
  const dataArray = [];
  let i = 0;
  while (i + chunkSize <= bytes.length) {
    const chunk = bytes.slice(i, i + chunkSize);
    let value = BigInt(0);
    for (let j = 0; j < chunk.length; j++) {
      value = (value << BigInt(8)) | BigInt(chunk[j]);
    }
    dataArray.push(value.toString());
    i += chunkSize;
  }
  const remainingBytes = bytes.slice(i);
  const pendingWord =
    remainingBytes.length > 0
      ? (() => {
          let v = BigInt(0);
          for (let j = 0; j < remainingBytes.length; j++) {
            v = (v << BigInt(8)) | BigInt(remainingBytes[j]);
          }
          return v.toString();
        })()
      : '0';
  return [
    dataArray.length.toString(),
    ...dataArray,
    pendingWord,
    remainingBytes.length.toString(),
  ];
}

/**
 * Consulta Torii GraphQL para obtener todos los posts existentes
 */
async function queryPostsFromTorii() {
  const query = JSON.stringify({
    query: `
      query {
        entities(limit: 100) {
          edges {
            node {
              keys
              models {
                __typename
                ... on di_Post {
                  id
                  x_position
                  y_position
                  size
                }
              }
            }
          }
        }
      }
    `,
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 8080,
      path: '/graphql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(query),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.errors) {
            reject(new Error(JSON.stringify(result.errors)));
            return;
          }

          const posts = [];
          if (result.data?.entities?.edges) {
            result.data.entities.edges.forEach((edge) => {
              const models = edge.node?.models;
              if (models && Array.isArray(models)) {
                models.forEach((model) => {
                  if (model && typeof model === 'object' && 'x_position' in model && 'y_position' in model) {
                    posts.push({
                      x_position: Number(model.x_position),
                      y_position: Number(model.y_position),
                      size: Number(model.size || 1),
                    });
                  }
                });
              }
            });
          }
          resolve(posts);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.write(query);
    req.end();
  });
}

/**
 * Calcula la siguiente posición adyacente aleatoria que quepa el bloque de tamaño size
 */
function getAdjacentPosition(existingPosts, size) {
  if (existingPosts.length === 0) {
    return { x: 0, y: 0 };
  }

  const blockW = POST_WIDTH * size;
  const blockH = POST_HEIGHT * size;
  const possiblePositions = [];

  existingPosts.forEach((post) => {
    const postSize = post.size || 1;
    const postRight = post.x_position + postSize * POST_WIDTH;
    const postBottom = post.y_position + postSize * POST_HEIGHT;
    possiblePositions.push(
      { x: post.x_position, y: post.y_position - blockH, direction: 'top' },
      { x: post.x_position, y: postBottom, direction: 'bottom' },
      { x: post.x_position - blockW, y: post.y_position, direction: 'left' },
      { x: postRight, y: post.y_position, direction: 'right' }
    );
  });

  // Filtrar posiciones válidas
  const seen = new Set();
  const availablePositions = possiblePositions.filter((pos) => {
    const key = `${pos.x},${pos.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const isNonNegative = pos.x >= 0 && pos.y >= 0;
    const blockFree = !isBlockOccupied(existingPosts, pos.x, pos.y, size);
    return isNonNegative && blockFree;
  });

  if (availablePositions.length === 0) {
    console.log('⚠️  No hay posiciones adyacentes disponibles, usando (0, 0)');
    return { x: 0, y: 0 };
  }

  const randomIndex = Math.floor(Math.random() * availablePositions.length);
  const selected = availablePositions[randomIndex];
  console.log(
    `✅ Posición seleccionada: (${selected.x}, ${selected.y}) - dirección: ${selected.direction}, tamaño: ${size}x${size}`
  );
  return { x: selected.x, y: selected.y };
}

function isBlockOccupied(existingPosts, x, y, size) {
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const checkX = x + i * POST_WIDTH;
      const checkY = y + j * POST_HEIGHT;
      if (isPositionOccupied(existingPosts, checkX, checkY)) return true;
    }
  }
  return false;
}

function isPositionOccupied(existingPosts, x, y) {
  return existingPosts.some((post) => {
    const postSize = post.size || 1;
    const pw = POST_WIDTH * postSize;
    const ph = POST_HEIGHT * postSize;
    return (
      x >= post.x_position &&
      x < post.x_position + pw &&
      y >= post.y_position &&
      y < post.y_position + ph
    );
  });
}

/**
 * Crea un post en la blockchain
 */
async function createPost(imageUrl, caption, creatorUsername, xPosition, yPosition, size, isPaid) {
  const manifestPath = path.join(
    __dirname,
    '..',
    'contracts',
    'manifest_dev.json'
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const actionsContract = manifest.contracts.find((c) => c.tag === 'di-actions');
  if (!actionsContract) {
    throw new Error('No se encontró el contrato di-actions en el manifest.');
  }

  const starknetPath = path.join(__dirname, '..', 'client', 'node_modules', 'starknet');
  const { Account } = require(starknetPath);
  const account = new Account({
    provider: { nodeUrl: 'http://127.0.0.1:5050/rpc' },
    address: KATANA_ACCOUNT.address,
    signer: KATANA_ACCOUNT.privateKey,
  });

  const imageUrlBytes = stringToByteArray(imageUrl);
  const captionBytes = stringToByteArray(caption);
  const usernameBytes = stringToByteArray(creatorUsername);
  const calldata = [
    ...imageUrlBytes,
    ...captionBytes,
    ...usernameBytes,
    xPosition,
    yPosition,
    size, // Ahora incluimos size en el calldata
    isPaid ? 1 : 0,
  ];

  const tx = await account.execute([
    {
      contractAddress: actionsContract.address,
      entrypoint: 'create_post',
      calldata,
    },
  ]);

  return tx.transaction_hash;
}

async function main() {
  console.log('🚀 Creando posts de prueba: 2 gratis (1x1) + 1 de pago (2x2)\n');

  try {
    // 1. Consultar posts existentes
    console.log('📡 Consultando posts existentes desde Torii...');
    const existingPosts = await queryPostsFromTorii();
    console.log(`   Encontrados ${existingPosts.length} posts existentes\n`);

    // 2. Crear primer post gratis (size 1)
    console.log('📝 Creando POST 1 (Gratis, 1x1)...');
    const pos1 = getAdjacentPosition(existingPosts, 1);
    const tx1 = await createPost(
      'https://picsum.photos/seed/free1/393/852',
      'Post gratis #1 - Tamaño 1x1',
      'user-free-1',
      pos1.x,
      pos1.y,
      1,
      false
    );
    console.log(`✅ Post 1 creado! TX: ${tx1}\n`);
    await new Promise((r) => setTimeout(r, 3000));

    // Actualizar lista de posts
    existingPosts.push({ x_position: pos1.x, y_position: pos1.y, size: 1 });

    // 3. Crear segundo post gratis (size 1)
    console.log('📝 Creando POST 2 (Gratis, 1x1)...');
    const pos2 = getAdjacentPosition(existingPosts, 1);
    const tx2 = await createPost(
      'https://picsum.photos/seed/free2/393/852',
      'Post gratis #2 - Tamaño 1x1',
      'user-free-2',
      pos2.x,
      pos2.y,
      1,
      false
    );
    console.log(`✅ Post 2 creado! TX: ${tx2}\n`);
    await new Promise((r) => setTimeout(r, 3000));

    existingPosts.push({ x_position: pos2.x, y_position: pos2.y, size: 1 });

    // 4. Crear post de pago (size 2x2)
    console.log('📝 Creando POST 3 (Pago, 2x2)...');
    const pos3 = getAdjacentPosition(existingPosts, 2);
    const tx3 = await createPost(
      'https://picsum.photos/seed/paid1/786/1704', // Imagen más grande para 2x2
      'Post de pago - Tamaño 2x2 (más visible!)',
      'user-paid-1',
      pos3.x,
      pos3.y,
      2,
      true
    );
    console.log(`✅ Post 3 creado! TX: ${tx3}\n`);

    console.log('✅ Todos los posts creados exitosamente!');
    console.log('   - Post 1: Gratis, 1x1, posición (' + pos1.x + ', ' + pos1.y + ')');
    console.log('   - Post 2: Gratis, 1x1, posición (' + pos2.x + ', ' + pos2.y + ')');
    console.log('   - Post 3: Pago, 2x2, posición (' + pos3.x + ', ' + pos3.y + ')');
    console.log('\n   Recarga la app en http://localhost:5173 para verlos!');
  } catch (error) {
    console.error('❌ Error:', error.message || error);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  }
}

main();
