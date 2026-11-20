import typescriptEslint from "typescript-eslint";

export default [{
    files: ["**/*.ts"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint.plugin,
    },

    languageOptions: {
        parser: typescriptEslint.parser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",

        // Paths from VS Code must be normalized; see src/utils/fs-path.ts and AGENTS.md.
        "no-restricted-syntax": ["error", {
            selector: "MemberExpression[property.name='fsPath']",
            message: "Use uriToPath() from src/utils/fs-path.ts instead of reading uri.fsPath.",
        }],
    },
}, {
    files: ["src/utils/fs-path.ts"],
    rules: {
        "no-restricted-syntax": "off",
    },
}];