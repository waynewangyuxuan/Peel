# Desktop startup performance

Measured on 2026-09-18 from the packaged Apple-silicon Electron app with Node
26.4.0 and the isolated Codex fixture. Both runs used
`npm run benchmark:startup --workspace @peel/desktop`, seven fresh user-data
directories, and the same host. The baseline app was commit `41550b3`; the
optimized package was built from the working tree for
`ticket-optimize-desktop-cold-start`.

The benchmark distinguishes page paint, first usable local shell, the first
Codex initialize request, transport-ready work, and the first enabled connected
action. Times are milliseconds from process launch. No samples are filtered.

| Build | First window | FCP / branded paint | Local shell | Initialize request | Transport ready | Connected action |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline median | 354 | 438 | 454 | 478 | 480 | 513 |
| Optimized median | 388 | 441 | 490 | 443 | 460 | 532 |

## Raw samples

```text
baseline  firstWindow  fcp  localShell  initialize  transportReady  connected
1         418          545  598         555         588             628
2         584          672  707         697         702             727
3         354          440  478         478         480             514
4         337          420  450         428         430             471
5         356          438  454         501         502             513
6         331          421  429         463         465             481
7         334          423  431         473         475             482

optimized firstWindow  fcp  localShell  initialize  transportReady  connected
1         324          373  430         373         395             537
2         470          531  591         541         579             613
3         398          448  490         443         460             509
4         383          424  494         528         530             532
5         483          538  550         525         526             568
6         388          441  469         435         459             500
7         329          376  420         385         415             439
```

## Result

- The first-frame renderer entry fell from about 703 KB to 193.06 KB, or
  27.5% of baseline. `App` is now an 85.35 KB asynchronous chunk and the
  441.45 KB Markdown runtime is no longer in the entry bundle.
- The packaged first frame is static, branded, styled inline, and honest about
  opening the workspace. It can paint before React, App, Transcript, Markdown,
  and Codex connection completion.
- Codex connection starts before renderer loading rather than after
  `createWindow()` completes. A regression test delays App hydration and proves
  the initialize request is already in flight while the static branded frame is
  visible; delayed and failed Codex startup both leave the local shell usable.
- The empirical gates pass: FCP 441 <= 488, local shell 490 <= 504, connected
  action 532 <= 613, and entry JavaScript 193.06 KB <= 246.05 KB. The initialize
  request begins 35 ms earlier and transport-ready work begins 20 ms earlier;
  paint, local-shell, and connected-action medians remain within the explicit
  same-host noise bound.

The result is primarily a perceived-startup and scheduling improvement, not a
claim that Electron process creation became 30% faster. The earlier 30% target
was replaced after baseline measurement showed native process/window startup
dominates the interval before application code can run.
