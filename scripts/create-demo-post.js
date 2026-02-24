/**
 * Crea un post de ejemplo en Starkwall usando una cuenta prefundada de Katana.
 * Útil para ver cómo se ve un post sin usar la UI.
 *
 * Requisitos: Katana y Torii en marcha; sozo migrate ya ejecutado.
 * Uso: node scripts/create-demo-post.js
 */

const fs = require('fs');
const path = require('path');

// Cuenta prefundada de Katana (primera de la lista)
const KATANA_ACCOUNT = {
  address: '0x127fd5f1fe78a71f8bcd1fec63e3fe2f0486b6ecd5c86a0466c3a21fa5cfcec',
  privateKey: '0xc5b2fcab997346f3ea1c00b002ecf6f382c5f9c9659a3894eb783c5320f912',
};

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

async function main() {
  const manifestPath = path.join(
    __dirname,
    '..',
    'contracts',
    'manifest_dev.json'
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const actionsContract = manifest.contracts.find((c) => c.tag === 'di-actions');
  if (!actionsContract) {
    console.error('No se encontró el contrato di-actions en el manifest.');
    process.exit(1);
  }

  // Usar starknet del client (v8) para compatibilidad con Katana
  const starknetPath = path.join(__dirname, '..', 'client', 'node_modules', 'starknet');
  const { Account } = require(starknetPath);
  const account = new Account({
    provider: { nodeUrl: 'http://127.0.0.1:5050/rpc' },
    address: KATANA_ACCOUNT.address,
    signer: KATANA_ACCOUNT.privateKey,
  });

  const imageUrl =
    'https://picsum.photos/seed/starkwall/393/852';
  const caption = 'Post de prueba desde el script — Starkwall 🧱';
  const creatorUsername = 'demo-user';
  const xPosition = 0;
  const yPosition = 0;
  const isPaid = 0;

  const imageUrlBytes = stringToByteArray(imageUrl);
  const captionBytes = stringToByteArray(caption);
  const usernameBytes = stringToByteArray(creatorUsername);
  const calldata = [
    ...imageUrlBytes,
    ...captionBytes,
    ...usernameBytes,
    xPosition,
    yPosition,
    isPaid,
  ];

  console.log('📝 Creando post de ejemplo...');
  console.log('   Image URL:', imageUrl);
  console.log('   Caption:', caption);
  console.log('   Posición: (%d, %d)', xPosition, yPosition);

  const tx = await account.execute([
    {
      contractAddress: actionsContract.address,
      entrypoint: 'create_post',
      calldata,
    },
  ]);

  console.log('✅ Transacción enviada:', tx.transaction_hash);
  console.log('⏳ Esperando confirmación...');
  if (account.provider && typeof account.provider.waitForTransaction === 'function') {
    await account.provider.waitForTransaction(tx.transaction_hash);
  } else {
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log('✅ Post creado. Recarga la app en http://localhost:5173 para verlo.');
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
