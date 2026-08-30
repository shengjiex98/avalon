import { API_PROTOCOL } from '../src/contracts/api-protocol.ts';

export function browserConfig(apiBase, target) {
  return `// Generated for the ${target}.\nglobalThis.AVALON_CONFIG = Object.freeze(${JSON.stringify({
    apiBase,
    apiProtocol: API_PROTOCOL,
  })});\n`;
}
