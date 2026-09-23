Drive real Chromium tabs from JavaScript or Python Eval via global `browser`.

<instruction>
- Static content → `read`; browser → JavaScript, authenticated sessions, interaction.
- Open before use: JS `await browser.open(options)`; Python `await browser.open(name=…, url=…)`. `browser.tab(name)` only retrieves an opened tab. Close with `browser.close`; options: `name`, `all`, `kill`, `timeout`.
- Open options: `name`, `url`, `app`, `viewport`, `wait_until`, `dialogs`, `timeout`, `persist`.
- Tab helpers: navigation `url/title/goto`; inspect `observe/ariaSnapshot/screenshot/extract`; act `click/type/fill/press/scroll/drag/scrollIntoView/select/uploadFile`; wait `waitFor/waitForSelector/waitForUrl`; page-global `evaluate` (string cannot use top-level `return`).
- `tab.id(n)`/`ref("e5")` → element helpers: click/type/fill/press/hover/focus/select/uploadFile/scrollIntoView/boundingBox/visibility/evaluate. Re-render/navigation invalidates refs: re-observe and act in one cell. `<select>` requires `select`, not `fill`.
- `tab.run(fnOrCode,{args?,timeout?})` runs isolated JS with `{tab,page,browser,wait,assert}`, raw Puppeteer, Bun/Node, and tool bridge; closures are not captured and it is NOT sandboxed. Python accepts JS code only: `tab.run(code, timeout=…)`.
- Selectors: CSS or Puppeteer `aria/`, `text/`, `xpath/`, `pierce/`. Raw request interception lasts only for that `tab.run`.
- Calls return structured values; inner `display` prints outward; screenshots surface as Eval images.

Application modes:
- No `app`: managed Chromium. `app.path`: browser/Electron; omp profile unless `--user-data-dir`. `app.cdp_url`: attach CDP.
- `app.relay:true`: user's logged-in Chrome. Select `app.target` or adopt visible tab; NEVER navigate the visible tab without authorization. Sites attribute actions to the user.
- Close releases managed/attached tabs; it never closes relay/CDP pages. `kill:true` terminates only processes spawned here.
- Idle tabs freeze and later auto-close. `persist:true` keeps one live across turns; explicit close still releases it.
</instruction>

<examples>
```javascript
const tab = await browser.open({ name: "docs", url: "https://example.com" });
const o = await tab.observe(); await tab.id(o.elements[0].id).click();
const title = await tab.run(async ({ tab }, s) => (await tab.title()) + s, { args: ["!"] });
await tab.close();
```
```python
tab = await browser.open(name="docs", url="https://example.com")
o = await tab.observe(); await tab.id(o["elements"][0]["id"]).click()
await tab.close()
```
</examples>

<critical>
- Default to `observe`; use screenshots for visual confirmation.
- `tab.run` is privileged, not sandboxed. Relay/CDP acts as the user.
</critical>
