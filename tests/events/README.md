# Sample events

Payloads for `sam local invoke`. Replace the bucket and key first; the
functions read real objects out of S3, so local invocations need credentials
that can see them.

```bash
sam local invoke ComputeChecksumFunction --event tests/events/compute-checksum.json
sam local invoke OnRequestFunction --event tests/events/start-fixity.json
```

`ComputeChecksum` returns the state to feed back into itself when an object is
too large for one invocation; pipe its output back in as the next event to walk
through a run by hand.
