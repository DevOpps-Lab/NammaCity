/**
 * `inferencejs` ships type declarations that its own package.json "exports"
 * map doesn't correctly surface under bundler module resolution (confirmed:
 * TS7016 pointing at dist/index.d.ts, which exists but isn't resolvable).
 * Declared here as untyped so dynamic imports don't fail the build; call
 * sites in dashcam-detect.ts cast the result explicitly instead.
 */
declare module "inferencejs";
