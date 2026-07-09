import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'framer-motion'
import ErrorBoundary from './ErrorBoundary.jsx'
import './index.css'
import App from './App.jsx'

// `reducedMotion="user"` makes Framer honour prefers-reduced-motion, matching
// the CSS media query in index.css. Without it only the CSS animations stop.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </MotionConfig>
  </StrictMode>,
)
