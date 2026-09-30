# Keyword Sieve

A keyword sorter for Google Ads. You describe a business and point the tool at its website, then feed it up to 1000 keywords from any source. It sorts them into four lists:

| List | Meaning | Suggested use |
| --- | --- | --- |
| Priority | Strong match to what you sell, with buying intent | Search targeting (exact or phrase) |
| Relevant | Related, weaker buying signal | Test in a separate ad group |
| Review | Loosely related, research intent, or only a place name matches | Check by hand |
| Negative | Job seekers, freebie hunters, piracy, support queries, your exclusions, unrelated terms | Negative keywords |

## Run it

Needs Node 20 or newer. There are no npm dependencies.

```
node server.js          # http://localhost:3000
npm test
```

Optional environment variables:

- `PORT` (default 3000)
- `DATA_DIR` where projects are stored as JSON (default `./data`)
- `ANTHROPIC_API_KEY` turns on the AI layer (see below)
- `ANTHROPIC_MODEL` overrides the model used for that layer
- `ALLOW_PRIVATE_HOSTS=1` lets the crawler fetch localhost and private addresses. Leave it off unless you are testing.

## How it works

1. **Project brief.** Website address, description, products or services, starting keywords, and a "never show for" list (competitors, things you do not sell).
2. **Crawl.** Up to 8 same-site pages are fetched (service, product and about pages first). Titles, meta text, headings, image alt text and body copy are read. The crawler refuses private network addresses.
3. **Profile.** Terms and two-word phrases are weighted by where they appear. Text you typed counts most, then titles and H1s, then subheadings, then body copy. Place names ("in Leeds") are detected so a location alone never makes a keyword relevant.
4. **Keywords.** Paste them, or upload CSV, TSV, TXT or XLSX. The keyword column is found by its header, and volume, competition, bid, clicks and cost columns are kept when present. Google Keyword Planner exports (UTF-16, two title lines, ranges like `1K – 10K`) are handled. Duplicates and `[exact]`, `"phrase"` and `+broad` decoration are cleaned.
5. **Scoring.** Each keyword gets relevance against the profile, an intent label (transactional, commercial, informational, unclear), a 0 to 100 score, a suggested match type and a plain-language reason. You can change any category by hand and it will stick when the list is re-scored.
6. **Export.** CSVs for each list, plus two files shaped for Google Ads Editor: search targeting (campaign, ad group, keyword, match type, status) and campaign negatives. Ad group names are suggested from the strongest shared term. A list of repeating junk words for an account-level negative list is also generated.

## The AI layer

Without an API key everything above works with local scoring only. With `ANTHROPIC_API_KEY` set:

- the crawl is summarised and specific offerings plus things you clearly do not sell are extracted, and
- an "Ask AI about borderline ones" button sends only the uncertain keywords (up to 400) to Claude in batches of 80 for a verdict and a one-line reason.

This layer has not been run against the live API in development, since no key was available. The local engine is what the tests cover. If an AI call fails, the local result is kept and the error is shown.

## Limits worth knowing

- Scoring is vocabulary based. It cannot tell that "combi" is a kind of boiler unless your site or brief says so. That is what the Review list, the manual override, and the AI layer are for.
- Sites that render their content entirely with JavaScript will crawl poorly. Add a description and starting keywords in that case.
- There are no user accounts. Projects are stored in one JSON file, so run it locally or behind your own authentication.
- Negative match suggestions are a starting point. Broad negatives can block good traffic, so skim the Negative list before uploading.
