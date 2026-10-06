const SIGNATURES: Array<{ type: RegExp; matches: (b: Buffer) => boolean }> = [
  {
    type: /^image\/png$/,
    matches: (b) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { type: /^image\/jpe?g$/, matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: /^image\/gif$/, matches: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  {
    type: /^image\/webp$/,
    matches: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  { type: /^image\/hei[cf]$/, matches: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' },
  { type: /^application\/pdf$/, matches: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
];

export function contentMatchesType(buffer: Buffer, contentType: string): boolean {
  const rule = SIGNATURES.find((s) => s.type.test(contentType));
  return rule ? rule.matches(buffer) : true;
}
