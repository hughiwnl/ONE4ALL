import { describe, expect, it } from 'vitest';
import { parseDotenv } from '../dotenv.js';

describe('parseDotenv', () => {
  it('parses keys, quotes and comments', () => {
    const parsed = parseDotenv(`
# comment
A=1
B="quoted value"
C='single'
D=with # trailing comment
export E=exported
INVALID LINE
`);
    expect(parsed).toEqual({ A: '1', B: 'quoted value', C: 'single', D: 'with', E: 'exported' });
  });
});
