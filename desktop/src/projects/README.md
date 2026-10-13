# Read-only project workspace integration

`ProjectWorkspaceReader` is a main-process service. Construction reads no user files.
Call `read(rootPath)` only with the exact absolute folder returned by the native
directory picker. Never expose arbitrary root/path parameters to the renderer.
`refresh(project_id)` uses the registered root. The reader keeps snapshots in
memory; the main process persists authorized roots in isolated preview state.
There is no disk snapshot, project initialization, migration,
record editing, scheduler, model call, or public Run abstraction here.

The DTOs preserve v1 task/run fields. `historical: true` and `is_live: false`
explicitly describe history; `status: running` does not prove a live process.
A successful project identity without bound history returns `empty` with an
informational diagnostic. First-load failures return `error` without partial
tasks/runs. Failed refreshes retain an old snapshot as `stale`. The UI must show
its diagnostic and stale state and cannot preview from that snapshot.

Validation compiles the shared [`record-schema.ts`](record-schema.ts) with strict
AJV draft 2020-12, including its five-field v2 identity
and v1 history/task/run records. It additionally checks root binding, record
filenames and IDs, bidirectional task/run links, acceptance IDs, timestamp
ordering, completed acceptance, and git facts. Migration backup paths are
provenance only and are never opened. Task/run files are capped at 2 MiB each,
1000 records each, and 32 MiB total JSON; limits can only be reduced in tests.

`preview(project_id, reference_id)` accepts a reference ID created from a
validated registered snapshot, not a caller-provided path or file URL. Project
relative files and current-project private `artifacts` URIs support bounded
UTF-8 text (`md`, `txt`, `log`, `json`) and raster images (`png`, `jpg`, `jpeg`,
`gif`, `webp`). Known credential names/directories, SVG/HTML, arbitrary URLs,
cross-project URIs, and private tasks/runs preview are rejected. Render text as
text; construct image data URLs only from the returned MIME type and base64.
Do not pass project contents or private roots to the provider.

Every path component rejects symlinks and traversal. Leaf opens use
`O_NOFOLLOW`; descriptor/path identities and full file signatures are checked
before/after reading and before publishing a complete snapshot. Native Node
does not expose `openat`, so these checks do not provide an OS sandbox or the
Swift reader's descriptor-relative guarantee against a malicious concurrent
process racing ancestor replacements. This limitation must remain in the
handoff and must not be presented as equivalent to `openat`.

The tests use disposable directories under the canonical system temporary directory and never operate on
the user's project identity or private task/capture records.
