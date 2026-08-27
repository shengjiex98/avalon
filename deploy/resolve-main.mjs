const [, , url] = process.argv;
const sha = /^[0-9a-f]{40}$/;

try {
  if (!url) throw new Error('main commit URL is required');
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'avalon-release-controller',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`main lookup returned ${response.status}`);
  const body = await response.json();
  const commit = body.sha ?? body.object?.sha;
  if (!sha.test(commit ?? '')) throw new Error('main lookup returned no valid commit');
  process.stdout.write(`${commit}\n`);
} catch (error) {
  console.error(`cannot resolve Avalon main: ${error.message}`);
  process.exitCode = 1;
}
