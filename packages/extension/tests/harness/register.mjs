// Installs the `.tsx` hooks. Passed to `node --import` by the test script.
// `registerHooks` runs the hooks synchronously on this thread; the older
// `module.register` (off-thread, async hooks) is deprecated as of Node 26
// (DEP0205).
import { registerHooks } from "node:module";
import { resolve, load } from "./hooks.mjs";
registerHooks({ resolve, load });
