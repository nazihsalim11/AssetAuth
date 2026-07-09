import { api } from './api';

/**
 * Opens a stored file in a new tab.
 *
 * The storage bucket is private, so what the database holds is a path, not a URL.
 * We exchange it for a signed link that expires in a couple of minutes.
 *
 * The blank tab is opened *before* awaiting the network call: browsers only allow
 * window.open() during the click's user-gesture, and an await would end it.
 */
export async function openStoredFile(filePath, onError) {
  if (!filePath) {
    onError?.('This record has no file attached.');
    return;
  }

  const tab = window.open('', '_blank');
  try {
    const { url } = await api.getFileUrl(filePath);
    if (tab) {
      tab.location.href = url;
    } else {
      // Popup blocked despite the gesture — fall back to a direct navigation.
      window.open(url, '_blank', 'noopener');
    }
  } catch (err) {
    tab?.close();
    onError?.(err.message || 'This file could not be opened.');
  }
}
