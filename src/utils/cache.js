import { LEGACY_CACHE_KEYS } from '../constants/cacheKeys';

// Removes any values left behind by the retired client-side cache. Called once at
// startup (before the UI renders) so a returning user never sees stale data.
export const clearCachedUserData = () => {
  try {
    LEGACY_CACHE_KEYS.forEach(k => localStorage.removeItem(k));
  } catch {
    // localStorage unavailable (private mode / disabled); nothing to clear.
  }
};
