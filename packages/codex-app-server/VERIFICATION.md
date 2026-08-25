# Codex App Server adapter verification

Verified on 2026-08-25 against the locally installed Codex App Server 0.149.0.

## Fixture suite

`npm test` compiled the strict TypeScript package and passed 17 tests covering:

- initialize/initialized, correlation, notifications, server requests, stderr,
  RPC errors, local cancellation, graceful shutdown, reconnect, and no replay;
- list/search/read/resume, exact completed-turn Fork, Turn start, name, status
  and event subscriptions, approval response shapes, handshake-bound startup
  capability detection, and reconnect resubscription;
- snapshot/event reduction, duplicate and out-of-order handling, completed
  authority, aggregate diff reconstruction, and real subagent activity fields;
- stable, experimental-enabled, and unavailable capability classification.

## Installed schema check

`npm run check:schema` generated TypeScript from `/opt/homebrew/bin/codex` and
confirmed all 10 required methods and 8 required notifications:

```json
{"schema":"compatible","binary":"/opt/homebrew/bin/codex","methods":10,"notifications":8}
```

## Isolated real-server smoke

`npm run test:live` passed with the local authenticated Codex App Server. The
test created a temporary Git repository, created and named one root Thread,
started a Turn that wrote an exact fixture file, observed status and aggregated
diff notifications, listed/searched/read the Thread, forked at that exact
completed `lastTurnId`, named the child, completed a child Turn, and then
deleted only the two recorded test Thread IDs plus the temporary repository.

```json
{"result":"passed","server":"peel/0.149.0 (Mac OS 26.5.2; arm64) dumb (peel; 0.1.0)","rootThreadId":"01a03abb-d1c6-71a2-8c07-492d812da186","exactForkTurnId":"01a03abb-d6ee-7c90-b531-a43f6aa51223","childThreadId":"01a03abc-09de-7d61-a959-fd9aa113d4ee","childTurnId":"01a03abc-0a67-7212-bd3a-6ec0bc8dcf03","statusEvents":4,"approvalRequests":[],"aggregateDiffObserved":true}
```

The smoke uses no Project API and uses `approvalPolicy: "never"`; it received
no approval requests.
