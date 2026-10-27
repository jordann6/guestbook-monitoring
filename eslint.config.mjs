import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    { ignores: ["bin/", "node_modules/", "policy/bin/", "policy/node_modules/"] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
);
