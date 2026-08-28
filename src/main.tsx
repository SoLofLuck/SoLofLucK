import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { StayTuned } from './components/StayTuned.tsx'
import { PREVIEW_ACCESS_PATH } from './config.ts'

// The "Stay Tuned" gate used during testing — see the PREVIEW_ACCESS_PATH note
// in config.ts for the details.
const isPreviewPath = window.location.pathname.replace(/\/+$/, '') === PREVIEW_ACCESS_PATH

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isPreviewPath ? <App /> : <StayTuned />}</StrictMode>,
)
