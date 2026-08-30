import { API_PROTOCOL } from '../src/contracts/api-protocol.ts';

export function browserConfig(apiBase, target) {
  return `// Generated for the ${target}.\nexport const API_BASE = ${JSON.stringify(apiBase)};\nexport const API_PROTOCOL = ${API_PROTOCOL};\n`;
}
