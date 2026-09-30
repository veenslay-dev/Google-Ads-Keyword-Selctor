# Keyword Sieve

A keyword sorter for Google Ads. You describe a business and point the tool at its website, then feed it up to 1000 keywords from any source. It sorts them into four lists:

| List | Meaning | Suggested use |
| --- | --- | --- |
| Priority | Strong match to what you sell, with buying intent | Search targeting (exact or phrase) |
| Relevant | Related, weaker buying signal | Test in a separate ad group |
| Review | Loosely related, research intent, or only a place name matches | Check by hand |
| Negative | Job seekers, freebie hunters, piracy, support queries, your exclusions, unrelated terms | Negative keywords |

## Run it

Needs Node 22.13 or newer (it uses the built-in SQLite driver, which Node still labels experimental and warns about at start-up). There are no npm dependencies.

```
node server.js          # http://localhost:3000
npm test
```

Optional environment variables:

- `PORT` (default 3000)
- `DATA_DIR` where the SQLite database `app.db` lives (default `./data`)
- `DB_PATH` full path to the database file, or `:memory:` for tests
- `ALLOW_SIGNUP=0` closes public sign-up once the first account exists (see Accounts)
- `BASE_PATH` mounts the app under a path on an existing site, for example `/keyword-selector`. It works whether or not your web server strips the prefix, and the login cookie is limited to that path.
- `COOKIE_SECURE=1` marks the session cookie Secure. Set it whenever the app is served over HTTPS.
- `ANTHROPIC_API_KEY` turns on the AI layer (see below)
- `ANTHROPIC_MODEL` overrides the model used for that layer
- `ALLOW_PRIVATE_HOSTS=1` lets the crawler fetch localhost and private addresses. Leave it off unless you are testing.

## Accounts and sharing

Every project belongs to an account. Sign-up is open by default, and the first account created takes over any projects saved by the earlier single-user version (`data/projects.json`, which is then renamed to `.migrated`).

| Role | Can do |
| --- | --- |
| Owner | Everything, including sharing, removing people and deleting the project |
| Editor | Change the brief, keywords, search terms and competitors, and download |
| Viewer | Look and download only. The controls are disabled and the server refuses writes as well |

The owner shares from the **Share** button by typing the email of someone who already has an account. There are no email invitations, because the app does not send email. For an agency, create the accounts for your team, then set `ALLOW_SIGNUP=0` so strangers cannot register.

A project you have no access to answers "not found", the same as one that does not exist. Passwords are hashed with scrypt, sessions are random tokens stored hashed in the database, failed logins are throttled per address and email, and every change request needs a custom header so another website cannot trigger one from your browser.

Two people editing at once is safe at the level of a single action, because every request reads the current project. If you both edit the same keyword at the same moment, the last save wins. There is no live cursor or refresh: the other person's changes appear when you reload or reopen the project.

## Search terms report

Import the **Search terms** report from Google Ads (Insights and reports, then Search terms) as CSV or XLSX. Header lines, the totals row, and the same term appearing under several campaigns are handled. Each term gets a verdict:

- **Block**: it cost money and either does not fit your business (job seekers, freebies, your exclusions, unrelated topics) or it fits but has had enough clicks with no conversion to judge. The suggested match type is Negative Exact for spend-based blocks and Negative Phrase for off-topic ones.
- **Watch**: it fits your offer but has too few clicks to call.
- **Add**: it converted and is not yet a keyword. One button moves all of these into your keyword list as priority.
- **Ignore**: no spend, already excluded, or already a converting keyword.

"Enough clicks" is not a fixed number. It is about three times the clicks you would expect per conversion at your account's own conversion rate (between 10 and 200), or spend above twice your cost per conversion. If the report has no conversions at all, the bar is 30 clicks and the tool warns you to check that conversion tracking was running. This is a rule of thumb, not a significance test, so skim the Block list before uploading it.

## Competitors

Enter up to three competitor sites. About five pages are read from each.

- **Brand names** come from the domain, the `og:site_name` tag and the end of the page title. A name is only used as a negative if it contains a word that is not already part of your own vocabulary, so "Leeds Plumbing Ltd" cannot block "plumbing leeds". Each name can be switched off, and the whole behaviour can be turned off if you want to bid on competitor names deliberately.
- **Topic gaps** are competitor headings that share a word with your business and add a word your site never mentions. You tick the ones you want and they are added to your keyword list to be scored like any other.

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
- Projects are stored as one JSON document each inside SQLite. That is plenty for a few hundred projects. It is not built for thousands of concurrent users, and there is one process with in-memory login throttling, so do not run several copies behind a load balancer.
- The app sends no email, so there are no password resets or invitations. An admin who can reach the database file has to reset a forgotten password.
- Search term and competitor features are covered by automated tests against local test sites. They have not been run against a real Google Ads export from your account or against live competitor sites, so check the first results by eye.
- Negative match suggestions are a starting point. Broad negatives can block good traffic, so skim the Negative list before uploading.
