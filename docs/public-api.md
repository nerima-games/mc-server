# Public API

The current export in `src/index.ts` is `serverPackageName`, the package identifier string. It exposes no server operations.

The planned host implementation will add a `startMultiplayerServer` export. Its arguments and return type are not defined yet, so callers cannot depend on it.
