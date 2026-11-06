#!/usr/bin/env node
// A fake `gh` for the driver tests: records its args in $FAKE_GH_LOG; `pr list`
// prints $FAKE_GH_EXISTING (an open PR's URL) when set; `pr create` prints a URL.
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(args)}\n`)
if (args[0] === 'pr' && args[1] === 'list') console.log(process.env.FAKE_GH_EXISTING || '')
else if (args[0] === 'pr' && args[1] === 'create') console.log('https://github.com/example/toy/pull/7')
else process.exit(1)
