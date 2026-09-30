# Keyword Selector

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

## Pages and addresses

| Address | What it shows |
| --- | --- |
| `/` | The home page. People with no project see "Create your first project", everyone else sees "Create new project" and a "View projects" button |
| `/projects` | The list of your projects |
| `/projects/new` | The form for a new project |
| `/projects/<slug>` | One project, on its **All keywords** page. The slug comes from the project name, for example `/projects/dinesh-aarjav` |
| `/projects/<slug>/campaigns/<campaign>` | One campaign: its landing page, uploads and results |
| `/projects/<slug>/business`, `/competitors`, `/team` | The other project pages |

Every address works as a bookmark, a reload, and a link you can send to a teammate who has access. Back and forward behave as expected. A link opened while signed out is kept, and you land on it after signing in. Slugs are made when a project is created, stay the same if the project is renamed, and get `-2`, `-3` if you own two projects with the same name. The name "new" is reserved, so a project called New gets `new-project`. All of this works under `BASE_PATH`, for example `/keyword-selector/projects/dinesh-aarjav`.

A project page has a **sidebar** with everything for that project: All keywords, your campaigns (with a + to add one), Business, Competitors, and Team and sharing.

## Campaigns

A campaign holds the keyword uploads for one Google Ads campaign. Open a campaign and add keywords as often as you like. Each add is its own upload with its own counts, status and downloads.

- A campaign has a **name** and an optional **landing page**. An upload without a page of its own is judged against its campaign's page. Change the campaign page and its uploads show as "Out of date" until you analyse them again.
- The **Google Ads Editor files use the campaign name** in the Campaign column, so you no longer type it in. Downloads can be taken for one upload, one campaign, or the whole project.
- Uploads can be **moved** to another campaign, and a campaign can be renamed (its address stays the same) or deleted (with its uploads and keywords, after a confirmation).
- With no campaign yet, the first upload creates one called "General". Projects saved before campaigns existed get a "General" campaign holding all their uploads.
- The **All keywords** page shows every campaign together, read only apart from changing a keyword's category. Keywords are added inside campaigns.

## Look and feel

Crimson theme with light and dark modes. The sun and moon switch in the top bar changes it, and the choice is remembered in the browser. Icons are drawn inline, so there are no icon libraries to load. The only outside resource is the Inter font from Google Fonts, and the page falls back to the system font without it. On a phone the sidebar sits above the page as a row of buttons.

## Daily workflow

1. **Business page, once.** Website, what you sell, where you work, the keywords you already want, and anything to never show for. Save, and the website is read in the background (up to 50 pages, with a progress bar). When it finishes you land on All keywords.
2. **Create a campaign** from the sidebar, for example one per Google Ads campaign.
3. **Open the campaign, every day.** Press **New upload**. Give it a name, optionally the landing page the keywords are for, then upload files or paste a list. Keyword Planner exports, Google Ads search terms reports, Semrush, Ahrefs and plain lists all work. **Every upload is kept on its own**, so tomorrow's keywords arrive as a new upload without touching yesterday's. Choosing several files at once makes one upload per file, each named after its file.
4. **Pick an upload or "Whole campaign"** to see its results. Change any category with the dropdown. The Download button and each upload's menu give Google Ads Editor files (keywords to target, negative keywords) and plain spreadsheets, limited to what you are looking at. Each upload's menu also lets you rename it, change its landing page, move it, analyse it again, or delete it.

A keyword already in the project is not added again. If a later file carries clicks, cost or conversions for a keyword you already hold, the results are added to it. Each upload holds up to 1000 keywords. Larger files are cut at 1000, and the message says how many were left out so you can upload the rest as another file.

Search terms reports are not a separate feature. Upload them like anything else. Rows with clicks, cost or conversions are judged on those numbers first: converting keywords become Priority, keywords already excluded in your account become Negative, and keywords that spent money, never converted, and either do not fit or have had enough clicks become Negative. "Enough clicks" is about three times the clicks a conversion usually takes at your account's own rate (between 10 and 200). This is a rule of thumb, not a significance test.

## What the analysis knows

Without `OPENAI_API_KEY` the tool sorts by built-in rules. With it, every upload is analysed automatically the moment it is added, after the rules have given a first sort, so the list is usable straight away and improves as the analysis finishes.

**The crawler does the reading. The model is given what it found.** The model never browses anything.

- The crawler reads up to 50 pages of the business website: breadth first, service-like pages first, from links and from the sitemap, five at a time, on the same host only, honouring `robots.txt`, and stopping early after 80 seconds.
- The pages are condensed once into a **service catalogue** (what each service is, who it is for, which page describes it) and stored with the project, together with the text of every page (first 2,500 characters each).
- Every analysis receives that catalogue, plus the few stored pages whose wording is closest to the keywords in that batch.
- If an upload has a **landing page**, that page is fetched fresh when the upload is analysed and given in full. Keywords are then judged against that exact service: a keyword that fits the business but belongs to a different service is marked Relevant and the reason names the service it belongs to. If the page cannot be read, the upload is analysed without it and says so.
- Each keyword gets a matched **service** from the catalogue, shown in the results and included in the downloads.

How it is set up to be accurate:

- **Every keyword is judged**, not just the borderline ones, in batches of 100, each with a label, a confidence from 0 to 100, an intent, a matched service and a short reason.
- **Shaky answers get a second opinion.** Anything under 70 confidence, or where the analysis and the keyword rules disagree sharply, is sent back with both opinions for a final call. If it is still under 60, it goes to Review marked "Unsure" with the reason. The tool prefers showing you a doubt over hiding one.
- **It learns from your corrections.** When you move a keyword, the last 40 corrections go into the next analysis as examples.
- **Hard facts outrank opinions.** Your exclusions, competitor brands and real campaign results are never overruled. Those keywords are not even sent.
- **Uploads are analysed one at a time**, in the order added, so a burst of files cannot run into rate limits.
- **Unknown file layouts** are mapped by the model, so exports without recognisable column titles still load.

What it cannot do: no method reaches 100% on this. Whether a keyword is worth buying depends on facts only you know, and the same words can be a buyer for one business and waste for another. The design aims to make errors rare, to make the uncertain ones visible, and to let your corrections stick. Skim the Negative and Review lists before uploading them to Google Ads.

Cost and privacy: every keyword is sent to OpenAI, plus extra calls for the uncertain ones, plus one larger call per website read and a slice of the stored pages with each batch. Check OpenAI's current pricing for your model. The key stays on the server, is never sent to the browser and is not stored in the database. Business text, page text and keywords do go to OpenAI, so do not use this for material you cannot share with them. If a call fails, the basic sorting is kept and the upload shows "Analysis failed" with the reason. When you change the business details and read the website again, earlier analyses are marked "Out of date" until you analyse them again.

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
2. **Crawl.** Up to 50 same-site pages (see above). Titles, meta text, headings, image alt text and body copy are read. The crawler refuses private network addresses and honours `robots.txt`.
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
