# Revyl Appium driver

This repository owns the standalone, experimental Appium extension. The Revyl
backend and device workers are external dependencies, not vendored source.

- Keep the driver attach-only. Deleting an Appium session must never stop,
  reset, or uninstall anything from the externally owned Revyl session.
- Use the authenticated backend proxy. Never expose worker addresses or
  credentials, accept client-supplied API credentials, or bypass session access
  checks. Keep examples and fixtures public-safe.
- Preserve explicit unsupported-operation errors and snapshot-scoped element
  references. Do not simulate success or silently rebind stale elements.
- Keep dependencies in the package manifest and regenerate the npm lockfile
  with npm. Validate changes with `npm test`, `npm run check`, and
  `npm pack --dry-run`.
- Protocol tests must load the extension through real Appium and use real
  clients, with all Revyl traffic restricted to loopback mocks. A passing mock
  suite is not proof of real-device compatibility.
- Live-device runs and package publication require explicit approval. Keep
  supported commands, installation, and release limitations aligned with the
  implementation in `README.md`.
