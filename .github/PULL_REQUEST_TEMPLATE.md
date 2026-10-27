## What changed

<!-- One or two sentences. What does this do, not how. -->

## Why

<!-- Link the issue or ADR. An architectural choice needs an ADR in docs/adr/
     before merge, not after. -->

## Author checklist

- [ ] I read the full `pulumi preview` output, including every replace and its reason
- [ ] No resource holding data is deleted or replaced (or the `destroy-approved` label is applied and the reason is stated below)
- [ ] The policy pack passes with no new advisory findings I cannot explain
- [ ] `scripts/verify.sh` passes against a fresh k3d cluster (CI e2e job)
- [ ] No credentials or personal data in the diff or the commit history
- [ ] Image tags, chart version, and npm dependencies are pinned, lock files committed

## Rollback

<!-- How this gets undone. "Revert the commit" only counts if that is actually
     safe for stateful resources. -->
