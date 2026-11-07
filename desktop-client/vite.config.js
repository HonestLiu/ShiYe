import { defineConfig } from 'vite';
export default defineConfig({ clearScreen: false, server: { port: 1420, strictPort: true }, build: { target: 'es2022', rollupOptions: { input: { main: 'index.html', worker: 'worker.html', settings: 'settings.html' } } } });
