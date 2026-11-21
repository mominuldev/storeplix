import base from '@storeplix/config/eslint';

export default [
  ...base,
  { ignores: ['next-env.d.ts', 'public/**'] },
  {
    // PHASE-3-CONTRACT P3-11: no raw HTML anywhere in the storefront (equivalent of react/no-danger).
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Merchant content is rendered with React elements only; dangerouslySetInnerHTML is forbidden.',
        },
        {
          selector: "Property[key.name='dangerouslySetInnerHTML']",
          message: 'Merchant content is rendered with React elements only; dangerouslySetInnerHTML is forbidden.',
        },
      ],
    },
  },
];
