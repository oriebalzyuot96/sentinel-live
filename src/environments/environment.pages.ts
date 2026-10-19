/** Static-hosting build (e.g. GitHub Pages): start straight in demo mode, no server probe. */
export const environment = {
  feedMode: 'demo' as 'auto' | 'demo' | 'live',
};
