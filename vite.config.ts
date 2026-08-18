import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// GitHub Pages statik bir hosting olduğu için gerçek olmayan bir yola
// (ör. /1, "Stay Tuned" kapısının arkasındaki gizli önizleme yolu) doğrudan
// gidildiğinde normalde kendi 404 sayfasını döner. Bunun yerine index.html'i
// dist/404.html olarak da kopyalıyoruz — GitHub Pages, eşleşmeyen her yol
// için bu dosyayı sunar, böylece uygulamamızın JS'i her yolda yüklenir ve
// src/main.tsx'teki yönlendirme kararını (Stay Tuned mı, gerçek uygulama mı)
// tarayıcıda kendisi verir.
function copyIndexTo404(): Plugin {
  return {
    name: 'copy-index-to-404',
    closeBundle() {
      const outDir = resolve(__dirname, 'dist')
      copyFileSync(resolve(outDir, 'index.html'), resolve(outDir, '404.html'))
    },
  }
}

// Bu site kendi alan adında (solofluck.xyz vb.) kök (/) dizininde
// yayınlanacak. GitHub Pages'te özel alan adı kullanılacaksa public/CNAME
// dosyasına o alan adını yazın; repo adı altında (ör. /SoLofLuck/) yayınlamak
// isterseniz base değerini o şekilde güncelleyin.
export default defineConfig({
  base: '/',
  plugins: [
    react(),
    copyIndexTo404(),
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
