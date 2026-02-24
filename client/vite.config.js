import { defineConfig } from 'vite';
import mkcert from 'vite-plugin-mkcert';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  // mkcert() requiere sudo la primera vez; descomenta si necesitas HTTPS (p. ej. Cartridge)
  plugins: [/* mkcert(), */ wasm()],
  server: {
    // Desactivar HMR para evitar bucle de recargas (WebSocket falla y el navegador reintenta)
    hmr: false,
  },
});
