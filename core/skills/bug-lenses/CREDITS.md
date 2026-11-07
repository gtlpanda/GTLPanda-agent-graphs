# Credits

This skill and the `/bughunt` graph adapt methods from these projects. They
were read in November 2026, and nothing from them is installed or run. The
wording here is ours; the ideas are theirs.

| Project | License | What we took |
|---------|---------|--------------|
| [Ovid/paad](https://github.com/Ovid/paad) agentic-review | MIT, Copyright (c) 2026 Curtis "Ovid" Poe | a finding names its trigger, path, and observable output, or it is dropped; asymmetry between sibling paths; a confidence floor, plus a cap until a finding is reproduced; "do not invent races from purely local code"; proof that a specialist read its reference |
| [danpeg/bug-hunt](https://github.com/danpeg/bug-hunt) | MIT, Copyright (c) 2026 Dan Peguine | the Hunter, Skeptic, and Referee roles; the skeptic sees only the structured claim; dismiss only when confident, because missing a real bug costs more |
| [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) code-review | Apache-2.0, Anthropic | the list of what never to report (pre-existing, linter-catchable, nitpicks, deliberately silenced); one fresh validator per issue |
| [JUNERDD/skills](https://github.com/JUNERDD/skills) bugbot | MIT, Copyright (c) 2026 JUNERDD | a coverage record per lens, so a run that skipped part of the change says so; a disposition computed from the findings; re-verifying a finding against the current code before fixing it |
| [obra/superpowers](https://github.com/obra/superpowers) | MIT, Copyright (c) 2025 Jesse Vincent | no fix before a root-cause investigation; a failing test first; "done" needs a diff, not a report |
| [Pablo-aps/prove-it](https://github.com/Pablo-aps/prove-it) | Apache-2.0 | freeze the claim and what would prove it false before looking; ask whether the evidence could pass while the claim is false; a list of counterfeit proofs |
| [trailofbits/skills](https://github.com/trailofbits/skills) | CC-BY-SA-4.0 | ideas only, no text: a reproduction must print an exact marker; a fix is proven by failing on the head, passing with the fix, and failing again with it reverted; the validator never sees the reproducer's reasoning |

The full MIT and Apache-2.0 license texts are in each project's repository.
