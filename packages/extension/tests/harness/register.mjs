// Installs the `.tsx` hooks. Passed to `node --import` by the test script.
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);
