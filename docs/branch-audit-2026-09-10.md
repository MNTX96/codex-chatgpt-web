# Branch audit — 2026-09-10

Scope: `feature/upload-download-image` working tree versus local `main` at
`e85e3693fdb4e3e033348c08df0298c20fcdb612`, including the Image Factory commit,
uncommitted edits, and new untracked source files. Existing user changes were preserved.

## Reported defects

- **Pause / next message:** automatic turns now consume native aborted-turn metadata,
  retire the old browser owner, and wait for its physical cleanup. Interrupted turn
  identities remain terminal for the replay window, including delayed requests with
  a different revision and already-completed results. Ordinary transport reconnects
  still reuse the existing submission. Tests cover a missing Interrupt hook, repeated
  instructions, delayed old requests, and reconnect without resubmission.
- **Launcher Setup recovery:** POSIX zombie processes no longer count as live owners.
  Failed Setup and forced cleanup preserve an orphaned daemon's marker. A failed or
  external marker with a missing daemon PID can be repaired only after an authenticated
  idle drain and a second PID health check; a conflicting non-null PID remains rejected.
  Recovery still follows the existing graceful shutdown/start lifecycle. It is not
  hot adoption of a running daemon.

## Additional defects fixed

- Image Factory services were recreated for each adapter request. Polling in a later
  round could mark a live job as lost after restart. Services now share live state per
  provider namespace and state directory.
- Separate image sessions shared a maintenance worker and could reject one another's
  project setup while a generation was running. Workers are now isolated by session;
  all still use the shared browser admission limit. Pending service reservations also
  participate in the admission check.
- A rejected parent activity could leave a journal claiming a job was running before
  execution started. Activity acquisition now precedes journal creation. Cancellation
  is checked before execution and before project-instruction mutations.
- Project bindings hashed a generic profile-button label. They now require a unique
  account email from the profile menu and reject unavailable or ambiguous identity.
- Project listing compared the result count with itself and revisited the same rows.
  It now tracks visited rows and checks directory growth after scrolling.
- Setup cleanup could leak a browser slot if the launcher release acknowledgement
  failed. Slot release is now guaranteed by `finally`.
- Artifact containment checks now reject absolute relative-path results on Windows
  drives. Persistent project validation requires the exact project path boundary.
- Large blob download chunks could exceed JavaScript's argument limit. Download
  failures also risked unobserved event rejection and leftover temporary files.
  Chunk copying, event observation, and cleanup have been corrected.
- Capture retries leaked abort listeners and could persist an image after cancellation.
  Retry delays now remove their listeners, and persistence checks cancellation.
- Image-source fallback now requires a labeled original/download link, rather than any
  HTTPS anchor in an image card. Architecture documentation reflects manual project creation.

## Coverage and limits

Reviewed the changed core adapter, broker/MCP routing, browser/helper protocol,
artifact and Image Factory modules, launcher IPC/state/onboarding, dependency locks,
Bun version/installer/release changes, documentation, and associated tests.
No additional actionable defect was established in onboarding or the version updates.

Validation uses isolated automated tests, core/launcher typechecking, and diff checks.
The full core run passed 715 tests with one platform-specific skip; the full launcher
run passed 298 tests with one skip. After the final adjustments, the 19 Image Factory /
artifact tests and five targeted pause/steering/reconnect tests also passed. Both
TypeScript checks and `git diff --check` passed.
No production daemon, launcher, browser tab, route configuration, or ownership marker
was restarted, stopped, or rewritten as part of this work. Browser UI changes and the
native Desktop pause flow still need a live smoke test after the user schedules loading
the patched runtime. The existing running application does not hot-load these fixes.
