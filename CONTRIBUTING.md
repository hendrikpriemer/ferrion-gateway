# Contributing

Thank you for helping. Bug reports, device support and fixes are welcome.

## Before you start

- **Vulnerabilities** go through private reporting, never a public issue; see
  [SECURITY.md](SECURITY.md).
- For anything larger than a small fix, open an issue first and describe the
  problem, so we can agree on the approach before you spend time on code.
- Read [docs/architecture.md](docs/architecture.md); it explains the process
  model, the data flows and the trust boundaries you will touch.

## Development setup

```sh
npm install          # Node.js 22.13 or later; also installs the git hooks
npm test
npm run typecheck
npm run lint
npm run start:control-plane   # web UI on http://127.0.0.1:4000
```

You do not need real hardware: the simulated devices run real protocol servers.
Running against a ferrion installation is needed only to see readings arrive.
More in [docs/development.md](docs/development.md).

## Pull requests

- One topic per pull request, small enough to review.
- **Tests for every change.** A bug fix comes with a test that fails without it.
  We check that a test actually bites by reverting the change and watching it
  go red; a test that stays green either way does not count.
- `npm test`, `npm run typecheck` and `npm run lint` pass; CI runs the same.
- Code, comments, test names and file names are in English. Commit messages and
  pull request descriptions may be in English or German.
- Comments explain **why**, especially where something was found live on a
  real device. Many guards in this code look unnecessary until you read the
  comment that says which device broke without it; please keep that habit.
- New dependencies: prefer none. If one is needed, say why in the pull request;
  `npm run notice` regenerates the third-party notices.
- The git hook raises the version in `package.json` with each commit; keep that
  change in your commits.

## Device support

A new device usually means a template in `src/device-catalog/` (node IDs,
registers or topics, measuring ranges from the manufacturer's documentation)
and, ideally, a simulator in `src/drivers/simulated/devices/` so others can run
it without the hardware. Say where each value comes from: a datasheet, a
NodeSet2 export, or a capture from a real unit (with serial numbers and site
details removed).

## License

This project is licensed under the [Apache License 2.0](LICENSE). By submitting
a contribution you agree that it is licensed under the same terms (Apache 2.0,
section 5). No separate contributor agreement is required.
