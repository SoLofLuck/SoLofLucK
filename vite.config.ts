import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// Bu site kendi alan adında (solofluck.xyz vb.) kök (/) dizininde
// yayınlanacak. GitHub Pages'te özel alan adı kullanılacaksa public/CNAME
// dosyasına o alan adını yazın; repo adı altında (ör. /SoLofLuck/) yayınlamak
// isterseniz base değerini o şekilde güncelleyin.
export default defineConfig({
  base: '/',
  plugins: [
    react(),
    // Irys/Solana kütüphaneleri tarayıcıda Node'un crypto/stream/buffer gibi
    // yerleşik modüllerini bekliyor; bunlar olmadan görsel yükleme (Irys)
    // sırasında runtime hatası oluşur.
    nodePolyfills({
      include: ['crypto', 'stream', 'buffer', 'util', 'process'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  optimizeDeps: {
    // @solana/zk-sdk, wasm-bindgen'in "bundler" hedefiyle derlenmiş bir WASM
    // modülü içeriyor; dev sunucusunun bağımlılık ön-derlemesi (optimizeDeps)
    // bu WASM'ı yeniden sarmalayınca `__wbindgen_export_2` hatasıyla
    // çöküyor. Üretim build'inde (vite build) sorun yok; dev'de düzgün
    // çalışması için ön-derlemeden hariç tutuyoruz.
    exclude: ['@solana/zk-sdk'],
  },
})
