# Revyl Appium driver

This repository owns the standalone Appium extension. The Revyl
backend and device workers are external dependencies, not vendored source.

- Keep the driver attach-only. Deleting an Appium session must never stop,
  reset, or uninstall anything from the externally owned Revyl session.
- Use the authenticated backend proxy. Never expose worker addresses or
  credentials, accept client-supplied API credentials, or bypass session access
  checks. Keep examples and fixtures public-safe.
- Preserve explicit unsupported-operation errors and snapshot-scoped element
  references. Do not simulate success or silently rebind stale elements.
- Preserve raw native locator/attribute semantics and descendant-only scoped
  searches. Do not invent visibility or substitute labels for identifiers.
- Expose native gesture extensions only through the documented `revyl:`
  command allowlist. Reject unknown options before dispatch, validate native
  coordinate units and bounds, and never replay uncertain mutations.
- Keep clear, install, reset, WebViews, and arbitrary W3C actions unsupported
  until their owning backend/worker contracts can provide the required target,
  outcome, authorization, and transport guarantees. Native context selection
  is not browser support, and restarting an app is not resetting its data.
- Keep dependencies in the package manifest and regenerate the npm lockfile
  with npm. Validate changes with `npm test`, `npm run check`, and
  `npm pack --dry-run`.
- Protocol tests must load the extension through real Appium and use real
  clients, with all Revyl traffic restricted to loopback mocks. A passing mock
  suite is not proof of real-device compatibility.
- Run dependency and test subprocesses with an allowlisted environment that
  excludes real runtime secrets; use synthetic credentials for loopback mocks.
- Live-device runs and package publication require explicit approval. Keep
  supported commands, installation, and release limitations aligned with the
  implementation in `README.md`.
