import { describe, expect, it } from 'vitest';
import { parseCsv } from '../server/csv.ts';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, commas and newlines in fields, CRLF and a byte-order mark', () => {
    expect(parseCsv('﻿name,note\r\n"Smith, Jo","said ""hi""\nthen left"\r\nAli,\r\n\r\n')).toEqual([
      ['name', 'note'], ['Smith, Jo', 'said "hi"\nthen left'], ['Ali', ''],
    ]);
  });
  it('keeps a final row without a trailing newline', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});
