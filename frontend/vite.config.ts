import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const gateway = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/redeem': gateway,
      '/auth': gateway,
      '/skills': gateway,
      '/upload': gateway,
      '/files': gateway,
      '/ws': { target: gateway, ws: true },
    },
  },
});
