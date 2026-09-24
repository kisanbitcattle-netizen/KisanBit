// vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: true, // exposes it on your LAN IP too, not just localhost
  },
  build: {
    chunkSizeWarningLimit: 1600, // వార్నింగ్ లిమిట్‌ని 1600kB కి పెంచుతుంది
  },
});