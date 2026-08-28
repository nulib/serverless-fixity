# Contributing

Bug reports, feature requests and pull requests are all welcome through the
GitHub issue tracker and pull requests on this repository.

## Development loop

Requires Node.js 24+ and the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html).

```bash
npm install        # lint tooling
npm test           # installs src/'s dependencies on first run
npm run lint
npm run validate   # sam validate --lint
npm run build      # sam build
```

The root package holds the lint tooling; `src/` is the deployable package and
declares the AWS SDK dependencies. The tests import `src/`, so both need to be
installed -- `npm test` handles that for you, and CI installs them explicitly.

Please make sure `npm test`, `npm run lint` and `npm run validate` all pass
before opening a pull request. CI runs the same three.

## Things worth knowing

- The tests never call AWS. S3 and Step Functions clients are injected, so add
  a fake in `tests/helpers/` rather than reaching for the network.
- Anything touching `src/lib/hash` needs to keep agreeing with `node:crypto`,
  including across serialize/deserialize cycles. `tests/hash.test.mjs` is the
  contract; extend it rather than working around it.
- Error class names in `src/lib/errors.mjs` are matched by name in
  `statemachine/fixity.asl.json`, so renaming one changes retry behaviour.
- `src/lib/fixityState.mjs` defines the payload every state passes to the next.
  A change there is a change to the state machine's public contract.

## Security

If you think you have found a security issue, please do not open a public
issue. Report it privately to the repository maintainers instead.

## Licensing

Contributions are accepted under the MIT-0 license that covers this project.
See [LICENSE.txt](LICENSE.txt).
