// Engine outline options on the same robot, for picking a house style.
const scout = { head: 'boxy', face: 'square', eyes: 'pill', top: 'antenna', body: 'basic', arms: 'nub', accent: 'mint' };
export default [
  { name: 'opt-default', ...scout },
  { name: 'opt-selout', ...scout, outline: { selout: true } },
  { name: 'opt-soft-lines', ...scout, outline: { internal: 'soft' } },
  { name: 'opt-no-lines', ...scout, outline: { internal: false } },
  { name: 'opt-bust', ...scout, body: null, arms: null, shadow: null, align: 'center' },
];
