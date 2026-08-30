// Resolve the deployment before loading the app. The stable bootstrap makes a
// normal refresh fetch the current version even when older assets are cached.
const manifestUrl = new URL('./version.json', import.meta.url);
manifestUrl.searchParams.set('load', String(Date.now()));

let version = 'dev';
try {
  const response = await fetch(manifestUrl, { cache: 'no-store' });
  const candidate = String((await response.json()).version ?? '');
  if (/^[a-zA-Z0-9._-]{1,128}$/.test(candidate)) version = candidate;
} catch {
  // Offline and older self-hosted servers can still load the checked-in app.
}

const stylesheet = document.querySelector<HTMLLinkElement>('[data-app-styles]');
if (stylesheet) stylesheet.href = new URL(`./styles.css?v=${encodeURIComponent(version)}`, import.meta.url).href;
await import(`./app.js?v=${encodeURIComponent(version)}`);
