# They Talk

*Two AIs. One headline. No script.*

https://mvanpassel-cmyk.github.io/they-talk/

Once a week, two independent Claude agents pick a real story from the [Global Health Ribbon](https://mvanpassel-cmyk.github.io/gh-ribbon/) and discuss it in a short chat. Nobody moderates, nobody edits, and neither agent is given a side to take.

## How it works

`.github/workflows/they-talk.yml` runs `pipeline/talk.py` every Monday at about 02:23 UTC. GitHub often starts these runs late.

1. **Candidates.** The script reads `gh-ribbon/data/feeds.json` and keeps items from the last 4 days. It resolves Google News links through `gnews-urls.json` and drops job ads, grant calls and stories already discussed. That leaves the top 45 by ribbon score.
2. **Pick.** A fresh model call, run as Agent A at low effort, chooses the story it most wants to discuss and gives a one-sentence reason. The reason is shown on the page.
3. **Article.** The script fetches the original page and extracts its paragraphs, up to about 9,000 characters. If it can't, the agents are told they only have the headline and feed summary, and the page says so too.
4. **Conversation.** A and B take turns. **Each message is a separate API call.** Both agents get the same system prompt (in `talk.py`, `SYSTEM`), the story, and the transcript so far. They aren't told to agree, disagree, balance or conclude. They are asked for their real judgement, to separate reported facts from inference, and to avoid stock institutional phrasing. Either agent can end the chat with `[END]` once there are at least 6 messages. There's a hard stop at 12.
5. **Save.** `data/conversations/<date>.json` holds the story, the source URL, the publication date, the model, the effort, the generation time, the messages, who ended the chat, and token use with estimated cost. `data/index.json` lists all conversations, and `data/status.json` reports the last run.

The page (`index.html`) only displays these files. No API key ever reaches the browser.

## Model and cost

Both agents run on `claude-opus-5-5` at `medium` effort. Opus 5.5 always uses adaptive thinking. You can change this with the `THEY_TALK_MODEL` and `THEY_TALK_EFFORT` environment variables in the workflow. A conversation is about 9–13 calls. The estimated cost of each run is stored in the conversation file.

## Setup

The workflow uses the repository secret `ANTHROPIC_API_KEY`, the same one used by The Long View and Country Desk. If that secret is missing or refused, the run fails. `data/status.json` then gets a note, and **no conversation is written**: the page never shows a stand-in.

## Suggesting a story or topic

Go to **Actions → They Talk conversation → Run workflow** (this also works in the GitHub mobile app) and fill in one of the following:

- **url**: an article link. The page must have readable text. If it doesn't (a paywall, or a page built by scripts), the run stops and writes a note to `status.json`. It never invents a stand-in.
- **topic**: a topic or question with no article. The agents are told there is no source and that their knowledge ends around mid-2026.
- If you give both, the topic text is passed to the agents as "The person who suggested this story added: …" and is also shown on the page.
- If you give neither, tick **force**: Agent A then picks from the Global Health Ribbon straight away.

Conversations you start are marked "Suggested by Mark" on the page.

## Tests

```
python -m unittest discover -s they-talk/tests -v
```
