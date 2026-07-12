import { createContext, useContext } from 'react'

// App-wide data context. App() still owns all state and handlers; this context only
// delivers them to the extracted route pages so they no longer need long prop chains.
// The value is App's existing state/setters/handlers, so consuming a slice here is
// behavior-identical to reading it directly inside App().
const AppDataContext = createContext(null)

export const AppDataProvider = AppDataContext.Provider

export function useAppData() {
  const ctx = useContext(AppDataContext)
  if (ctx === null) {
    throw new Error('useAppData must be used within an AppDataProvider')
  }
  return ctx
}
