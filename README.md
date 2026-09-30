# Keyword Sieve

A keyword sorter for Google Ads. You describe a business and point the tool at its website, then drop in keyword files from any source. Every keyword is sorted into one of four lists:

| List | Meaning | Suggested use |
| --- | --- | --- |
| Priority | The searcher wants what you sell, in a place you serve | Search targeting (exact or phrase) |
| Relevant | Related to your offer, intent weaker or broader | Test in a separate ad group |
| Review | Genuinely unclear. A person should look | Check by hand |
| Negative | Wrong product, job seekers, freebie hunters, competitor brands, places you do not serve, research with no buying path | Negative keywords |

## Run it

Needs Node 22.13 or newer (it uses the built-in SQLite driver, which Node still labels experimental and warns about at start-up). There are no npm dependencies.

```
node server.js          # http://localhost:3000
npm test
```

Environment variables:

- `OPENAI_API_KEY` turns on the AI specialist review (see below). Without it the tool sorts by built-in rules only.
- `OPENAI_MODEL` picks the model. The default is `gpt-4.1`. Use any chat model that supports structured output.
- `OPENAI_BASE_URL` points at a different OpenAI-compatible endpoint. Used by the tests.
- `PORT` (default 3000)
- `DATA_DIR` where the SQLite database `app.db` lives (default `./data`)
- `DB_PATH` full path to the database file, or `:memory:` for tests
- `BASE_PATH` mounts the app under a path on an existing site, for example `/keyword-selector`. It works whether or not your web server strips the prefix, and the login cookie is limited to that path.
- `ALLOW_SIGNUP=0` closes public sign-up once the first account exists (see Accounts)
- `COOKIE_SECURE=1` marks the session cookie Secure. Set it whenever the app is served over HTTPS.
- `ALLOW_PRIVATE_HOSTS=1` lets the crawler fetch localhost and private addresses. Leave it off unless you are testing.

## Daily workflow

1. **Business tab, once.** Website, what you sell, where you work, the keywords you already want, and anything to never show for. The site is read and turned into a profile.
2. **Keywords tab, every day.** Drop one or more files, or paste a list. Keyword Planner exports, Google Ads search terms reports, Semrush, Ahrefs and plain lists all work. **Each file or paste becomes its own upload**, with its own counts, its own AI status and its own downloads. Add new keywords tomorrow and they arrive as a new upload, without touching yesterday's.
3. **Pick an upload or "All uploads together"** to see its results. Change any category with the dropdown. The Download button and each upload's menu give Google Ads Editor files (keywords to target, negative keywords) and plain spreadsheets, limited to what you are looking at.

A keyword already in the project is not added again. If a later file carries clicks, cost or conversions for a keyword you already hold, the results are added to it. Each upload holds up to 1000 keywords. Larger files are cut at 1000, and the message says how many were left out so you can upload the rest as another file.

Search terms reports are not a separate feature. Upload them like anything else. Rows with clicks, cost or conversions are judged on those numbers first: converting keywords become Priority, keywords already excluded in your account become Negative, and keywords that spent money, never converted, and either do not fit or have had enough clicks become Negative. "Enough clicks" is about three times the clicks a conversion usually takes at your account's own rate (between 10 and 200). This is a rule of thumb, not a significance test.

## The AI specialist

With `OPENAI_API_KEY` set, every new upload is read by an AI keyword specialist after the rules have sorted it, so the list is usable straight away and improves as the checks finish (progress shows in the upload's row).

How it is set up to be accurate:

- **It knows the business.** The prompt carries the business summary, what you sell and do not sell, where you work, your starting keywords, your exclusions, competitor brands and the research-query setting.
- **Every keyword is judged**, not just the borderline ones, in batches of 100. Each answer has a label, a confidence from 0 to 100, an intent and a short reason.
- **Shaky answers get a second opinion.** Anything under 70 confidence, or where the AI and the rules disagree sharply, is sent back with both opinions for a final call. If it is still under 60 after that, it goes to Review with "Unsure" and the reason. The tool prefers showing you a doubt over hiding one.
- **It learns from your corrections.** When you move a keyword, the last 40 corrections go into the next check as examples.
- **Hard facts outrank opinions.** Your exclusions, competitor brands, and real campaign results are never overruled by the AI. Those keywords are not even sent.
- **Unknown file layouts** are mapped by the AI, so exports without recognisable column titles still load.

What it cannot do: no method reaches 100% on this. Whether a keyword is worth buying depends on facts only you know, and the same words can be a buyer for one business and waste for another. The design aims to make errors rare, to make the uncertain ones visible, and to let your corrections stick. Skim the Negative and Review lists before uploading them to Google Ads.

Cost: every keyword is sent to OpenAI, plus extra calls for the uncertain ones. Check OpenAI's current pricing for your model. The key stays on the server in the environment, is never sent to the browser, and is not stored in the database. Business text and keywords do go to OpenAI, so do not use this for material you cannot share with them. If a call fails, the rules result is kept and the upload shows "AI check failed" with the reason. "Re-check with AI" in the upload's menu runs it again. When you change the business details and read the website again, earlier checks are marked "out of date" until you re-check them.

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

## Competitors

Enter up to three competitor sites. About five pages are read from each.

- **Brand names** come from the domain, the `og:site_name` tag and the end of the page title. A name is only used as a negative if it contains a word that is not already part of your own vocabulary, so "Leeds Plumbing Ltd" cannot block "plumbing leeds". Each name can be switched off, and the whole behaviour can be turned off if you want to bid on competitor names deliberately.
- **Topic gaps** are competitor headings that share a word with your business and add a word your site never mentions. You tick the ones you want and they arrive as a new upload called "Competitor topics", to be judged like any other.

## How it works

1. **Project brief.** Website address, description, products or services, starting keywords, and a "never show for" list (competitors, things you do not sell).
2. **Crawl.** Up to 8 same-site pages are fetched (service, product and about pages first). Titles, meta text, headings, image alt text and body copy are read. The crawler refuses private network addresses.
3. **Profile.** Terms and two-word phrases are weighted by where they appear. Text you typed counts most, then titles and H1s, then subheadings, then body copy. Place names ("in Leeds") are detected so a location alone never makes a keyword relevant.
4. **Keywords.** Paste them, or upload CSV, TSV, TXT or XLSX. The keyword column is found by its header, and volume, competition, bid, clicks and cost columns are kept when present. Google Keyword Planner exports (UTF-16, two title lines, ranges like `1K – 10K`) are handled. Duplicates and `[exact]`, `"phrase"` and `+broad` decoration are cleaned.
5. **Scoring.** Each keyword gets relevance against the profile, an intent label (transactional, commercial, informational, unclear), a 0 to 100 score, a suggested match type and a plain-language reason. You can change any category by hand and it will stick when the list is re-scored.
6. **Export.** CSVs for each list, plus two files shaped for Google Ads Editor: search targeting (campaign, ad group, keyword, match type, status) and campaign negatives. Ad group names are suggested from the strongest shared term. A list of repeating junk words for an account-level negative list is also generated.

## Limits worth knowing

- Scoring is vocabulary based. It cannot tell that "combi" is a kind of boiler unless your site or brief says so. That is what the Review list, the manual override, and the AI layer are for.
- Sites that render their content entirely with JavaScript will crawl poorly. Add a description and starting keywords in that case.
- Projects are stored as one JSON document each inside SQLite. That is plenty for a few hundred projects. It is not built for thousands of concurrent users, and there is one process with in-memory login throttling, so do not run several copies behind a load balancer.
- The app sends no email, so there are no password resets or invitations. An admin who can reach the database file has to reset a forgotten password.
- The tests cover the rules, uploads, accounts, performance logic and the AI plumbing. The AI calls are tested against a stand-in server, not the real OpenAI API, so how well the real model judges your keywords has to be checked by you on the first few uploads. Nothing has been run against a real Google Ads export or live competitor sites.
- Negative match suggestions are a starting point. Broad negatives can block good traffic, so skim the Negative list before uploading.
