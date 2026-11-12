#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const iso = time => new Date(time).toISOString().slice(0, 10);

function dateValue(value) {
  const time = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (!Number.isFinite(time) || iso(time) !== value) throw new Error(`Invalid date: ${value}`);
  return time;
}

function options(args) {
  const result = { user: 'BeNTz16', today: iso(Date.now()) };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--out', '--input', '--user', '--today'].includes(key) || seen.has(key)
        || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Usage: node scripts/build-stats.mjs --out file.svg [--input fixture.json] [--user BeNTz16] [--today YYYY-MM-DD]');
    }
    seen.add(key);
    result[key.slice(2)] = args[i + 1];
  }
  if (!result.out) throw new Error('--out is required.');
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(result.user)) throw new Error('Invalid GitHub username.');
  dateValue(result.today);
  return result;
}

async function githubDays(user, today) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required when --input is omitted.');
  if (typeof fetch !== 'function') throw new Error('This script requires Node.js with global fetch.');
  async function query(query, variables) {
    let response;
    try {
      response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15000),
      });
    } catch { throw new Error('GitHub request failed or timed out.'); }
    if (!response.ok) throw new Error(`GitHub request failed (HTTP ${response.status}).`);
    let body;
    try { body = await response.json(); } catch { throw new Error('GitHub returned invalid JSON.'); }
    if (!body || body.errors || !body.data?.user) throw new Error('GitHub GraphQL response is invalid; check the username and token permissions.');
    return body.data.user;
  }
  const account = await query('query($login:String!){user(login:$login){createdAt}}', { login: user });
  if (typeof account.createdAt !== 'string' || !Number.isFinite(Date.parse(account.createdAt))) {
    throw new Error('GitHub returned an invalid account creation date.');
  }
  const created = dateValue(account.createdAt.slice(0, 10));
  const end = dateValue(today);
  if (created > end) throw new Error('--today precedes account creation.');
  const days = new Map();
  for (let year = new Date(created).getUTCFullYear(); year <= new Date(end).getUTCFullYear(); year++) {
    const from = `${year}-01-01T00:00:00Z`;
    const to = `${year === new Date(end).getUTCFullYear() ? today : `${year}-12-31`}T23:59:59Z`;
    const data = await query('query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to){contributionCalendar{weeks{contributionDays{date contributionCount}}}}}}', { login: user, from, to });
    const weeks = data.contributionsCollection?.contributionCalendar?.weeks;
    if (!Array.isArray(weeks) || !weeks.length) throw new Error(`GitHub returned an invalid calendar for ${year}.`);
    const batch = [];
    for (const week of weeks) {
      if (!Array.isArray(week?.contributionDays) || !week.contributionDays.length) throw new Error(`GitHub returned an invalid week for ${year}.`);
      for (const day of week.contributionDays) batch.push({ date: day?.date, count: day?.contributionCount });
    }
    const validated = normalize(batch, today);
    const lower = dateValue(from.slice(0, 10));
    const upper = dateValue(to.slice(0, 10));
    for (let t = lower; t <= upper; t += DAY) {
      if (!validated.has(iso(t))) throw new Error(`GitHub calendar is incomplete for ${year}.`);
    }
    for (const [date, count] of validated) {
      const time = dateValue(date);
      if (time >= created && time >= lower && time <= upper) days.set(date, count);
    }
  }
  return [...days].map(([date, count]) => ({ date, count }));
}

function normalize(rows, today) {
  if (!Array.isArray(rows)) throw new Error('Input must be an array of {date, count} entries.');
  const days = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new Error('Invalid contribution entry.');
    dateValue(row.date);
    if (!Number.isSafeInteger(row.count) || row.count < 0) throw new Error(`Invalid count for ${row.date}.`);
    if (days.has(row.date)) throw new Error(`Duplicate date: ${row.date}`);
    if (row.date > today) throw new Error(`Contribution date is after --today: ${row.date}`);
    days.set(row.date, row.count);
  }
  return new Map([...days].sort(([a], [b]) => a.localeCompare(b)));
}

function statistics(days, today) {
  let total = 0;
  let run = 0;
  let start = null;
  let previous = null;
  const longest = { count: 0, start: null, end: null };
  for (const [date, count] of days) {
    total += count;
    if (!Number.isSafeInteger(total)) throw new Error('Total contributions exceed the safe integer range.');
    const time = dateValue(date);
    if (count > 0) {
      run = previous !== null && time - previous === DAY ? run + 1 : 1;
      if (run === 1) start = date;
      if (run > longest.count) Object.assign(longest, { count: run, start, end: date });
      previous = time;
    } else { run = 0; previous = null; }
  }
  let cursor = dateValue(today);
  if (!(days.get(today) > 0)) cursor -= DAY;
  const current = { count: 0, start: null, end: null };
  while (days.get(iso(cursor)) > 0) {
    if (!current.end) current.end = iso(cursor);
    current.start = iso(cursor);
    current.count++;
    cursor -= DAY;
  }
  const dates = [...days.keys()];
  return { total, totalStart: dates[0] ?? null, totalEnd: dates.at(-1) ?? null, current, longest };
}

function range(start, end) {
  if (!start || !end) return '—';
  const show = (date, year) => {
    const d = new Date(dateValue(date));
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${year ? `, ${d.getUTCFullYear()}` : ''}`;
  };
  const years = start.slice(0, 4) !== end.slice(0, 4);
  return start === end ? show(start, false) : `${show(start, years)} – ${show(end, years)}`;
}

function render(days, today, stats) {
  const height = 286;
  // Exact s5 bottom tear, translated down by 118 px; side zigzags extend in 16 px steps.
  const bottom = [[16,158],[33,154],[51,161],[69,155],[88,159],[108,153],[129,160],[149,156],[168,162],[189,155],[210,159],[230,152],[251,160],[272,156],[294,161],[314,153],[334,158],[355,154],[376,161],[396,156],[418,160],[439,152],[460,158],[480,155],[501,162],[521,156],[541,160],[562,153],[583,159],[604,155],[625,161],[646,154],[667,159],[688,153],[709,161],[730,155],[750,160],[769,154],[784,158]].map(([x,y]) => [x,y+118]);
  const leftX = [22,17,19,11,21,14,23,10,18];
  const rightX = [779,788,777,786,790,781,789,778,787];
  const left = Array.from({length:16}, (_,i) => [leftX[i%leftX.length],(i+1)*16]);
  const right = Array.from({length:16}, (_,i) => [rightX[i%rightX.length],(i+1)*16]);
  const commands = points => points.map(([x,y]) => `L${x} ${y}`).join(' ');
  const outline = `M16 0 ${commands(left)} ${commands(bottom)} ${commands([...right].reverse())} L784 0 L784 -6 L16 -6 L16 0 Z`;
  const burn = `M16 0 ${commands(left)} ${commands(bottom)} ${commands([...right].reverse())} L784 0`;
  const end = dateValue(today);
  const first = end - new Date(end).getUTCDay()*DAY - 52*7*DAY;
  const positives = [...days].filter(([date,count]) => dateValue(date)>=first && count>0).map(([,count])=>count).sort((a,b)=>a-b);
  // Nearest-rank quartiles; ties stay in the lower band.
  const quartiles = [0.25,0.5,0.75].map(q => positives[Math.max(0,Math.ceil(positives.length*q)-1)] ?? 0);
  const colors = ['#c9a66b','#a8743a','#7a4a1f','#4a2a10'];
  const cells = [];
  const months = [];
  for (let col=0; col<53; col++) {
    for (let row=0; row<7; row++) {
      const time = first+(col*7+row)*DAY;
      if (time>end) continue;
      const date = iso(time);
      const d = new Date(time);
      if ((col===0 && row===0) || d.getUTCDate()===1) {
        // Keep month names apart when the first column is a partial month.
        if (!months.length || col-months.at(-1).col>=3) months.push({col,month:MONTHS[d.getUTCMonth()]});
      }
      const count = days.get(date) ?? 0;
      const level = quartiles.filter(q=>count>q).length;
      cells.push(`<rect class="day" x="${57+col*13}" y="${162+row*13}" width="10" height="10" rx="2" fill="${count ? colors[level] : '#5a3413'}"${count ? '' : ' fill-opacity=".10"'}><title>${date}: ${count} contributions</title></rect>`);
    }
  }
  const label = `${stats.total} total contributions; current streak ${stats.current.count} days; longest streak ${stats.longest.count} days`;
  return `<svg viewBox="0 0 800 ${height}" width="800" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label}">
  <defs>
    <linearGradient id="pg" gradientUnits="userSpaceOnUse" x1="16" y1="0" x2="784" y2="0">
      <stop offset="0" stop-color="#dcc592"/><stop offset=".07" stop-color="#e9d7ab"/><stop offset=".5" stop-color="#f0e2bd"/><stop offset=".93" stop-color="#e9d7ab"/><stop offset="1" stop-color="#dcc592"/>
    </linearGradient>
    <filter id="paper" filterUnits="userSpaceOnUse" x="-8" y="-8" width="816" height="302" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" seed="9" result="fine"/>
      <feColorMatrix in="fine" type="matrix" values="0 0 0 0 0.36  0 0 0 0 0.25  0 0 0 0 0.12  0.9 0 0 0 -0.30" result="speck"/>
      <feComposite in="speck" in2="SourceAlpha" operator="in" result="texIn"/>
      <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="texIn"/></feMerge>
    </filter>
    <filter id="edge-burn" filterUnits="userSpaceOnUse" x="-8" y="-8" width="816" height="302"><feGaussianBlur stdDeviation="2.5"/></filter>
    <clipPath id="paper-clip"><path d="${outline}" fill-rule="evenodd" clip-rule="evenodd"/></clipPath>
  </defs>
  <style>
    .number{font-family:'Segoe Script','Snell Roundhand','Apple Chancery','Lucida Handwriting','URW Chancery L',cursive;font-size:34px;fill:#3b2a1a}
    .label,.date,.month{font-family:'Courier New',Courier,'Liberation Mono',monospace}
    .label{font-size:13px;font-weight:bold;fill:#5a3f24}.accent{fill:#7a1f1f}
    .date{font-size:10px;fill:#8a6a3a}.month{font-size:11px;fill:#8a6a3a}
    @media (prefers-reduced-motion:reduce){*{animation:none!important}}
  </style>
  <path id="paper-shape" d="${outline}" fill-rule="evenodd" fill="url(#pg)" filter="url(#paper)"/>
  <g clip-path="url(#paper-clip)">
    <path d="${burn}" fill="none" stroke="#6b3f14" stroke-opacity=".35" stroke-width="5" filter="url(#edge-burn)"/>
    <path d="M${bottom[0].join(' ')} ${commands(bottom.slice(1))}" fill="none" stroke="#5a3413" stroke-opacity=".55" stroke-width="1.4"/>
    <g text-anchor="middle">
      <text class="number" x="180" y="69">${stats.total}</text>
      <text class="label" x="180" y="101">Total Contributions</text>
      <text class="date" x="180" y="121">${range(stats.totalStart,stats.totalEnd)}</text>
      <circle cx="400" cy="57" r="33" fill="none" stroke="#7a1f1f" stroke-width="2"/>
      <text class="number" x="400" y="69">${stats.current.count}</text>
      <text class="label accent" x="400" y="108">Current Streak</text>
      <text class="date" x="400" y="128">${range(stats.current.start,stats.current.end)}</text>
      <text class="number" x="620" y="69">${stats.longest.count}</text>
      <text class="label" x="620" y="101">Longest Streak</text>
      <text class="date" x="620" y="121">${range(stats.longest.start,stats.longest.end)}</text>
    </g>
    ${months.map(({col,month})=>`<text class="month" x="${57+col*13}" y="153">${month}</text>`).join('\n    ')}
    ${cells.join('\n    ')}
  </g>
</svg>
`;
}

try {
  const opts = options(process.argv.slice(2));
  const rows = opts.input ? JSON.parse(await readFile(opts.input, 'utf8')) : await githubDays(opts.user, opts.today);
  const days = normalize(rows, opts.today);
  const stats = statistics(days, opts.today);
  const svg = render(days, opts.today, stats);
  await writeFile(opts.out, svg, 'utf8');
  console.log(`Total: ${stats.total}; current: ${stats.current.count}; longest: ${stats.longest.count}`);
} catch (error) {
  console.error(`build-stats: ${error.message}`);
  process.exitCode = 1;
}
