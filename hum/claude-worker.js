// Hum × Claude relay — Cloudflare Worker
// Receives the notes of a hummed tune from the Hum page, asks Claude for an arrangement and a few
// lines of musical context, and returns them. The prompt lives here, so the page can only send music.
// Needs one secret: ANTHROPIC_API_KEY (Settings → Variables and Secrets, type Secret).

const ALLOWED_ORIGINS = ['https://mvanpassel-cmyk.github.io'];
const MODEL = 'claude-sonnet-5-5';
const MAX_NOTES = 400;

const LEADS = ['piano', 'violin', 'clarinet', 'oboe', 'trumpet', 'horn', 'harp', 'organ', 'strings', 'synth', 'square'];
const PART_INSTRUMENTS = ['piano', 'softpiano', 'violin', 'strings', 'violas', 'cellos', 'clarinet', 'oboe', 'trumpet', 'horn',
  'harp', 'organ', 'pizz', 'arco', 'cpizz', 'timp', 'synth', 'square', 'sqbass'];
const DRUMS = ['kick', 'kick_s', 'snare', 'snare_s', 'hat', 'hat_s', 'open', 'ride', 'lkick', 'lsnare', 'lhat', 'boom'];

const SYSTEM = `You are a skilled arranger and composer with a warm, plain way of explaining music.
Someone hummed or whistled a tune into a small web app. The app turned it into notes and plays them on
recorded instruments. Your job: write a tasteful arrangement around the tune and a few lines of musical context.

How the data works
- Time is in beats (quarter notes), counted from 0, in 4/4. The piece is exactly BARS bars long (4 × BARS beats); every note you write must end by then.
- Pitches are MIDI numbers (60 = middle C).
- The melody you get is final: never change it, only accompany it.

Writing the arrangement
- Follow the melody's key and phrasing. Harmonise phrase by phrase, usually one or two chords per bar, with smooth voice leading; a good cadence at the end.
- Use 2 to 4 parts. Possible roles: "pad" (held chords), "bass", "counter" (a counter-melody), "arp" (broken chords), "drone".
- Registers: bass 28–50; pad and arp voicings mostly 48–74 and below the melody where it is low; a counter-melody may sit above or below the melody but should not double it, should move mostly when the melody holds or rests, and favour contrary motion.
- Leave space. Fewer, well-chosen notes beat busy ones. Velocities 0.25–0.9; accompaniment quieter than the tune.
- Drums only if the wish or the character of the tune calls for them; keep them simple and give one bar of hits that the app repeats over the bars you name.
- Respect the person's wish if they gave one (a mood, a genre, a scene). If there is none, choose what suits the tune and say why.
- Never reproduce a copyrighted song, even if the tune resembles one: you may mention a resemblance, but the arrangement is your own.

The note
- 2 to 4 short sentences in plain English for a curious non-musician: what kind of tune this is (mode, shape, character), what it reminds you of in terms of style or era, and the idea behind your arrangement. No flattery, no headings.

Return everything through the "arrangement" tool.`;

const TOOL = {
  name: 'arrangement',
  description: 'The arrangement around the hummed tune, plus a short note on the music.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A short evocative title for this arrangement (max 6 words).' },
      note: { type: 'string', description: '2–4 sentences of musical context, plain English.' },
      lead: { type: 'string', enum: LEADS, description: 'Instrument for the hummed melody.' },
      space: { type: 'integer', minimum: 0, maximum: 100, description: 'Reverb amount.' },
      echo: { type: 'boolean', description: 'A soft echo on the melody.' },
      chords: {
        type: 'array', description: 'Chord symbols for display, in order.',
        items: { type: 'object', properties: { b: { type: 'number' }, name: { type: 'string' } }, required: ['b', 'name'] }
      },
      parts: {
        type: 'array', maxItems: 4,
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ['pad', 'bass', 'counter', 'arp', 'drone'] },
            instrument: { type: 'string', enum: PART_INSTRUMENTS },
            notes: {
              type: 'array',
              items: {
                type: 'object',
                properties: { b: { type: 'number', description: 'start, in beats' }, d: { type: 'number', description: 'length, in beats' }, m: { type: 'integer' }, v: { type: 'number' } },
                required: ['b', 'd', 'm']
              }
            }
          },
          required: ['role', 'instrument', 'notes']
        }
      },
      drums: {
        type: 'object',
        description: 'Optional. One bar of hits (b from 0 to 4), repeated from fromBar to toBar (0-based, inclusive).',
        properties: {
          hits: { type: 'array', items: { type: 'object', properties: { b: { type: 'number' }, type: { type: 'string', enum: DRUMS }, v: { type: 'number' } }, required: ['b', 'type'] } },
          fromBar: { type: 'integer' }, toBar: { type: 'integer' }
        }
      }
    },
    required: ['title', 'note', 'lead', 'chords', 'parts']
  }
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'Origin not allowed' }, 403);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'The ANTHROPIC_API_KEY secret is missing in the Worker.' }, 500);
    const url = new URL(request.url);
    if (url.pathname === '/ping') return json({ ok: true, model: MODEL });
    if (url.pathname !== '/arrange' || request.method !== 'POST') return json({ error: 'Not found' }, 404);

    let body;
    try {
      const text = await request.text();
      if (text.length > 60000) return json({ error: 'Tune too long' }, 413);
      body = JSON.parse(text);
    } catch (e) { return json({ error: 'Bad request' }, 400); }

    // Only music goes into the prompt: numbers, a key name, the rule-based chords and a short wish.
    const num = (x, lo, hi) => Math.min(hi, Math.max(lo, Number(x) || 0));
    const bars = Math.round(num(body.bars, 1, 64)), bpm = Math.round(num(body.bpm, 40, 220));
    const melody = (Array.isArray(body.melody) ? body.melody : []).slice(0, MAX_NOTES)
      .map(n => ({ b: +num(n.b, 0, bars * 4).toFixed(3), d: +num(n.d, 0.05, 32).toFixed(3), m: Math.round(num(n.m, 20, 108)) }));
    if (!melody.length) return json({ error: 'No notes' }, 400);
    const key = String(body.key || '').slice(0, 40).replace(/[^\w ♯♭#-]/g, '');
    const hint = (Array.isArray(body.chords) ? body.chords : []).slice(0, 128).map(c => String(c).slice(0, 8)).join(' ');
    const wish = String(body.wish || '').slice(0, 240).replace(/[<>]/g, '');
    const prompt = `Key (as detected): ${key}\nTempo: ${bpm} bpm, 4/4, ${bars} bars (${bars * 4} beats)\n` +
      (hint ? `A simple rule-based harmonisation the app found, one chord per segment (use it or improve on it): ${hint}\n` : '') +
      `Wish from the person: ${wish ? '"' + wish + '"' : '(none, choose yourself)'}\n` +
      `Melody as [start beat, length in beats, MIDI pitch]:\n${JSON.stringify(melody.map(n => [n.b, n.d, n.m]))}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 12000, system: SYSTEM.replace('BARS', String(bars)),
        tools: [TOOL], tool_choice: { type: 'tool', name: 'arrangement' },
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: (data.error && data.error.message) || 'Claude returned ' + r.status }, 502);
    const use = (data.content || []).find(c => c.type === 'tool_use');
    if (!use) return json({ error: 'Claude did not return an arrangement' }, 502);
    return json({ arrangement: use.input, usage: data.usage, model: data.model || MODEL });
  }
};
