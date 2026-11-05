---
name: gtm-brief
description: The format of a product's GTM brief (docs/gtm.md in the product repo) - who the customer is, positioning, voice, proof with sources, what we never claim, compliance - and the rules marketing and sales agents follow when they use it. Use when writing or checking marketing or sales output, or when creating or checking a brief.
---

# gtm-brief

Every marketing and sales graph (SEO now; research, scout, and sdr later)
works from one brief per product. The brief lives in the product's repo at
`docs/gtm.md`, never in PandaStack: products differ, and the facts belong
with the product. This skill owns only the format and the rules.

## The format

Markdown with these `##` headings, in any order, each one non-empty. Other
headings may be added. Copy the template and replace every `<...>`:

```markdown
# <Product name> GTM brief

## Product
<One paragraph: what it is and what it does, in plain words.>

## Customer
<Who buys it, the problem they have, and how they describe that problem in their own words.>

## Positioning
<The category, what they use today instead, and why we win against that.>

## Voice
<Do: how we sound. Don't: what we never sound like.>

## Proof
- <A claim we can make> - source: <url, file:line, or interview YYYY-MM-DD>

## Never claim
- <A claim we must never make, and why>

## Compliance
<Regulated words, consent rules for outreach, or "none".>
```

Each Proof line is a list item (`- ` or `* `) with a claim, then a dash
(`-`, `–`, or `—`), then `source:` and the source. A Proof line without one is
a claim nobody can check, and `n/a`, `none`, `unknown`, or `?` is not a
source. A placeholder is a phrase of two or more words in angle brackets, like
`<Product name>`. A one-word `<name>` looks like an HTML tag, so the check
can't catch it: use phrases.

## Checking a brief

```bash
node ~/.claude/skills/gtm-brief/gtm-brief.mjs check docs/gtm.md
```

It prints each problem with its line number, and its last line is
`GTM-BRIEF: PASS` or `GTM-BRIEF: FAIL` (exit code 0 or 1). It reports:
- a missing, empty, or duplicated section;
- a Proof or Never claim line that is not a list item;
- a Proof item without a claim or a source;
- a placeholder left in (`<...>`, `TODO`, `TBD`).

Headings and placeholders inside fenced code blocks don't count, and neither
do placeholders inside inline code. The check covers the format only: it can't tell whether a source is real.

## Rules for agents

- Read the brief and never edit it. If it is wrong or missing something,
  propose the change to the human in your report.
- Every claim in marketing or sales output appears in Proof or follows
  directly from Product. Anything else is a new claim, and the human approves
  it first.
- Anything in Never claim is a blocking problem wherever it appears.
- Without a brief that passes the check, stop and say so. Never invent the
  customer, the positioning, or a proof point.
