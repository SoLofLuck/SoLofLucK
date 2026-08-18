import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { StayTuned } from './components/StayTuned.tsx'
import { PREVIEW_ACCESS_PATH } from './config.ts'

// Test aşamasındaki "Stay Tuned" kapısı — ayrıntı için config.ts'teki
// PREVIEW_ACCESS_PATH açıklamasına bakın.
const isPreviewPath = window.location.pathname.replace(/\/+$/, '') === PREVIEW_ACCESS_PATH

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isPreviewPath ? <App /> : <StayTuned />}</StrictMode>,
)
