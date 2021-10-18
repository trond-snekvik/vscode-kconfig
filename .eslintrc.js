module.exports = {
    root: true,
    parser: '@typescript-eslint/parser',
    parserOptions: {
        ecmaVersion: 6,
        sourceType: 'module',
    },
    env: {
        node: true,
        es6: true,
        browser: true,
        mocha: true,
    },
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended',
        'prettier',
        'prettier/@typescript-eslint',
        'plugin:@getify/proper-arrows/getify-says',
    ],
    plugins: ['@typescript-eslint'],
    rules: {
        curly: 'warn',
        eqeqeq: 'warn',
        'no-throw-literal': 'warn',
        semi: 'off',
        'no-async-promise-executor': 'off',
        '@typescript-eslint/naming-convention': [
            'warn',
            {
                selector: 'class',
                format: ['PascalCase'],
            },
        ],
        '@typescript-eslint/semi': 'warn',
        '@typescript-eslint/no-use-before-define': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-var-requires': 'off',
        '@typescript-eslint/ban-ts-comment': 'off',
        '@typescript-eslint/ban-types': 'off',
        '@typescript-eslint/ban-ts-ignore': 'off',
        '@getify/proper-arrows/where': ['error', { global: true, property: false, export: true }],
        '@getify/proper-arrows/this': 'off',
        '@getify/proper-arrows/name': 'off',
        '@getify/proper-arrows/params': 'off',
    },
    ignorePatterns: ['scripts/**/*.js', './dist'],
    overrides: [
        {
            files: ['*.tsx'],
            rules: {
                // Since it is so common to write React components like
                // `const MyComponent = props => (...)`
                '@getify/proper-arrows/where': 'off',
            },
        },
        {
            files: ['messages.ts'],
            rules: {
                // Since these files contain action creators that just return an object.
                '@typescript-eslint/explicit-module-boundary-types': 'off',
            },
        },
    ],
};
