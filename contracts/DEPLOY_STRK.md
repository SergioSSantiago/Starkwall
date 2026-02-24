# Desplegar STRK en Katana

El token STRK está en `contracts/strk/`.

## 1. Compilar

```bash
cd contracts/strk && scarb build
```

## 2. Desplegar con starkli (Katana no soporta block_id "pending")

```bash
# Instalar starkli
curl https://get.starkli.sh | sh
source ~/.starkli/env
starkliup

# Crear keystore (clave de dojo_dev.toml)
echo '0xc5b2fcab997346f3ea1c00b002ecf6f382c5f9c9659a3894eb783c5320f912' | starkli signer keystore from-key ~/dojo.keystore.json

# Declarar (con Katana en marcha)
cd contracts/strk/target/dev
starkli declare strk_token_strk_token.contract_class.json \
  --rpc http://localhost:5050 \
  --account 0x127fd5f1fe78a71f8bcd1fec63e3fe2f0486b6ecd5c86a0466c3a21fa5cfcec \
  --keystore ~/dojo.keystore.json

# Desplegar (reemplaza CLASS_HASH con el output del declare)
starkli deploy <CLASS_HASH> \
  u256:1000000000000000000000000 \
  0x127fd5f1fe78a71f8bcd1fec63e3fe2f0486b6ecd5c86a0466c3a21fa5cfcec \
  --rpc http://localhost:5050 \
  --account 0x127fd5f1fe78a71f8bcd1fec63e3fe2f0486b6ecd5c86a0466c3a21fa5cfcec \
  --keystore ~/dojo.keystore.json
```

## 3. Configurar la app

Copia la dirección desplegada y en el frontend:
- Crea `.env` con `VITE_STRK_TOKEN=0x...` (la dirección del contrato)
- O edita `client/config.js` y asigna `STRK_TOKEN_ADDRESS`

Sin STRK desplegado, la app usa el token ETH de Katana por defecto (misma interfaz).
