// Sparkle fx — two accent glints floating beside the head (no outline, drawn on top).
export default {
  name: 'sparkle',
  slot: 'fx',
  outline: false,
  layers: [
    { paint: { x: 26, y: 2, key: { '+': 'accent.hi', '*': 'accent.base', '-': 'accent.lo' }, rows: [
      '..-..',
      '..*..',
      '-*+*-',
      '..*..',
      '..-..',
    ] } },
    { paint: { x: 2, y: 9, key: { '+': 'accent.hi', '-': 'accent.lo' }, rows: [
      '.-.',
      '-+-',
      '.-.',
    ] } },
  ],
};
