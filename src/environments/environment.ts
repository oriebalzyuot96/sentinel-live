/** Default build: try the live WebSocket server first, fall back to the in-browser simulator. */
export const environment = {
  feedMode: 'auto' as 'auto' | 'demo' | 'live',
};
