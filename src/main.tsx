import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import './advanced.css'
import './results.css'
import './saved-scenarios.css'
import './comparison.css'
import './compact.css'
import './interactions.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
