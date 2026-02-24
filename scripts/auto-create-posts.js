/**
 * Crea posts automáticamente en bucle con posiciones adyacentes aleatorias.
 * Útil para ver cómo se van creando posts y cómo se expande el canvas.
 *
 * Requisitos: Katana y Torii en marcha; sozo migrate ya ejecutado.
 * Uso: node scripts/auto-create-posts.js [intervalo_segundos]
 * Ejemplo: node scripts/auto-create-posts.js 20  (crea un post cada 20 segundos)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

// Cuenta prefundada de Katana (primera de la lista)
const KATANA_ACCOUNT = {
  address: '0x127fd5f1fe78a71f8bcd1fec63e3fe2f0486b6ecd5c86a0466c3a21fa5cfcec',
  privateKey: '0xc5b2fcab997346f3ea1c00b002ecf6f382c5f9c9659a3894eb783c5320f912',
};

const POST_WIDTH = 393;
const POST_HEIGHT = 852;
const INTERVAL_SECONDS = parseInt(process.argv[2]) || 20; // Default 20 segundos

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
          
          // Parsear posts desde la respuesta GraphQL
          const posts = [];
          if (result.data?.entities?.edges) {
            result.data.entities.edges.forEach((edge) => {
              const models = edge.node?.models;
              if (models && Array.isArray(models)) {
                // Buscar el modelo di_Post en el array de models
                models.forEach((model) => {
                  if (model && typeof model === 'object' && 'x_position' in model && 'y_position' in model) {
                    posts.push({
                      x_position: Number(model.x_position),
                      y_position: Number(model.y_position),
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
 * Calcula la siguiente posición adyacente aleatoria (igual que getAdjacentPosition del cliente)
 */
function getAdjacentPosition(existingPosts) {
  if (existingPosts.length === 0) {
    return { x: 0, y: 0 };
  }

  const possiblePositions = [];
  
  existingPosts.forEach((post) => {
    const adjacentPositions = [
      { x: post.x_position, y: post.y_position - POST_HEIGHT, direction: 'top' },
      { x: post.x_position, y: post.y_position + POST_HEIGHT, direction: 'bottom' },
      { x: post.x_position - POST_WIDTH, y: post.y_position, direction: 'left' },
      { x: post.x_position + POST_WIDTH, y: post.y_position, direction: 'right' },
    ];
    
    possiblePositions.push(...adjacentPositions);
  });

  // Filtrar posiciones ocupadas y no negativas
  const availablePositions = possiblePositions.filter((pos) => {
    const isNonNegative = pos.x >= 0 && pos.y >= 0;
    const isNotOccupied = !existingPosts.some(
      (p) => p.x_position === pos.x && p.y_position === pos.y
    );
    return isNonNegative && isNotOccupied;
  });

  if (availablePositions.length === 0) {
    console.log('⚠️  No hay posiciones adyacentes disponibles, usando (0, 0)');
    return { x: 0, y: 0 };
  }

  // Elegir una posición aleatoria
  const randomIndex = Math.floor(Math.random() * availablePositions.length);
  const selected = availablePositions[randomIndex];
  console.log(
    `✅ Posición seleccionada: (${selected.x}, ${selected.y}) - dirección: ${selected.direction}`
  );
  return { x: selected.x, y: selected.y };
}

/**
 * Crea un post en la blockchain
 */
async function createPost(imageUrl, caption, creatorUsername, xPosition, yPosition) {
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
    0, // isPaid = false
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

/**
 * Genera una URL de imagen aleatoria de Picsum
 */
function getRandomImageUrl() {
  const seed = Math.floor(Math.random() * 1000);
  return `https://picsum.photos/seed/starkwall-${seed}/393/852`;
}

/**
 * Genera un caption aleatorio
 */
function getRandomCaption() {
  const captions = [
    'Un nuevo post en Starkwall 🧱',
    'Explorando el canvas infinito',
    'Post creado automáticamente',
    '¿Dónde aparecerá el siguiente?',
    'El blockchain nunca duerme',
    'Cada post es único',
    'Construyendo el muro',
    'Posición aleatoria, contenido único',
    'Starkwall crece',
    'Otro tile en el canvas',
  ];
  return captions[Math.floor(Math.random() * captions.length)];
}

async function main() {
  console.log(`🚀 Iniciando auto-creación de posts cada ${INTERVAL_SECONDS} segundos...`);
  console.log('   Presiona Ctrl+C para detener\n');

  let postCount = 0;

  while (true) {
    try {
      // 1. Consultar posts existentes desde Torii
      console.log('📡 Consultando posts existentes desde Torii...');
      const existingPosts = await queryPostsFromTorii();
      console.log(`   Encontrados ${existingPosts.length} posts existentes`);

      // 2. Calcular siguiente posición adyacente aleatoria
      const position = getAdjacentPosition(existingPosts);

      // 3. Generar contenido aleatorio
      const imageUrl = getRandomImageUrl();
      const caption = getRandomCaption();
      const username = 'auto-bot';

      console.log(`📝 Creando post #${++postCount}...`);
      console.log(`   Imagen: ${imageUrl}`);
      console.log(`   Caption: "${caption}"`);
      console.log(`   Posición: (${position.x}, ${position.y})`);

      // 4. Crear post en blockchain
      const txHash = await createPost(
        imageUrl,
        caption,
        username,
        position.x,
        position.y
      );

      console.log(`✅ Post creado! TX: ${txHash}`);
      console.log(`⏳ Esperando ${INTERVAL_SECONDS} segundos hasta el siguiente post...\n`);

      // 5. Esperar antes del siguiente post
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_SECONDS * 1000));
    } catch (error) {
      console.error('❌ Error:', error.message || error);
      console.log(`⏳ Reintentando en ${INTERVAL_SECONDS} segundos...\n`);
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_SECONDS * 1000));
    }
  }
}

main().catch((err) => {
  console.error('Error fatal:', err.message || err);
  process.exit(1);
});
