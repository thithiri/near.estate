// Run before module loading: Zod reads this global object when it initializes.
// Its jitless mode avoids the Function() probe blocked by the game CSP.
globalThis.__zod_globalConfig ??= {};
globalThis.__zod_globalConfig.jitless = true;
