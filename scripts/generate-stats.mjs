// Generates the GitHub stats, top-languages and streak cards as static SVGs.
// Runs in GitHub Actions (see .github/workflows/profile-assets.yml), so the
// README no longer depends on public card services that get rate-limited or paused.
//
// Usage: GITHUB_TOKEN=... GITHUB_USER=Akashkrp node scripts/generate-stats.mjs [outDir]

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const USER = process.env.GITHUB_USER;
const TOKEN = process.env.GITHUB_TOKEN;
const OUT = process.argv[2] || "dist";

if (!USER || !TOKEN) {
  console.error("GITHUB_USER and GITHUB_TOKEN are required");
  process.exit(1);
}

const theme = {
  bg: "#1a1b27",
  title: "#e879f9",
  text: "#a9b1d6",
  value: "#70a5fd",
  icon: "#7ee0ff",
  sub: "#38bdae",
  divider: "#414868",
};

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-stats-generator",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors || json)}`);
  }
  return json.data;
}

// ---------- data ----------

async function fetchProfile() {
  const data = await gql(
    `query($login: String!) {
      user(login: $login) {
        name
        createdAt
        pullRequests { totalCount }
        issues { totalCount }
        repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) { totalCount }
        contributionsCollection { totalCommitContributions restrictedContributionsCount }
      }
    }`,
    { login: USER }
  );
  return data.user;
}

async function fetchRepos() {
  const repos = [];
  let after = null;
  do {
    const data = await gql(
      `query($login: String!, $after: String) {
        user(login: $login) {
          repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false) {
            pageInfo { hasNextPage endCursor }
            nodes {
              stargazerCount
              languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
                edges { size node { name color } }
              }
            }
          }
        }
      }`,
      { login: USER, after }
    );
    const page = data.user.repositories;
    repos.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return repos;
}

async function fetchCalendar(createdAt) {
  const days = [];
  const now = new Date();
  let from = new Date(createdAt);
  while (from < now) {
    const to = new Date(Math.min(from.getTime() + 365 * 864e5, now.getTime()));
    const data = await gql(
      `query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            contributionCalendar { weeks { contributionDays { date contributionCount } } }
          }
        }
      }`,
      { login: USER, from: from.toISOString(), to: to.toISOString() }
    );
    for (const w of data.user.contributionsCollection.contributionCalendar.weeks) {
      days.push(...w.contributionDays);
    }
    from = to;
  }
  // de-duplicate overlapping boundary days, sort ascending
  const map = new Map();
  for (const d of days) map.set(d.date, d.contributionCount);
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, count]) => ({ date, count }));
}

function computeStreaks(days) {
  const total = days.reduce((s, d) => s + d.count, 0);
  const firstDay = days.find((d) => d.count > 0)?.date || days[0]?.date;

  let longest = { len: 0, start: null, end: null };
  let run = { len: 0, start: null };
  for (const d of days) {
    if (d.count > 0) {
      if (run.len === 0) run.start = d.date;
      run.len++;
      if (run.len > longest.len) longest = { len: run.len, start: run.start, end: d.date };
    } else {
      run = { len: 0, start: null };
    }
  }

  // current streak: today may still be empty without breaking the streak
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--;
  let current = { len: 0, start: null, end: null };
  if (i >= 0 && days[i].count > 0) {
    current.end = days[i].date;
    while (i >= 0 && days[i].count > 0) {
      current.len++;
      current.start = days[i].date;
      i--;
    }
  }
  return { total, firstDay, longest, current, today: days[days.length - 1]?.date };
}

function topLanguages(repos, limit = 8) {
  const totals = new Map();
  for (const r of repos) {
    for (const e of r.languages.edges) {
      const prev = totals.get(e.node.name) || { size: 0, color: e.node.color || "#858585" };
      prev.size += e.size;
      totals.set(e.node.name, prev);
    }
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, limit);
  const sum = sorted.reduce((s, [, v]) => s + v.size, 0) || 1;
  return sorted.map(([name, v]) => ({ name, color: v.color, pct: (v.size / sum) * 100 }));
}

// ---------- rendering ----------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => n.toLocaleString("en-US");
const fmtDate = (iso, withYear = true) => {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
};
const FONT = `font-family="'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif"`;

const ICONS = {
  star: "M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z",
  commit: "M1.643 3.143L.427 1.927A.25.25 0 000 2.104V5.75c0 .138.112.25.25.25h3.646a.25.25 0 00.177-.427L2.715 4.215a6.5 6.5 0 11-1.18 4.458.75.75 0 10-1.493.154 8.001 8.001 0 101.6-5.684zM7.75 4a.75.75 0 01.75.75v2.992l2.028.812a.75.75 0 01-.557 1.392l-2.5-1A.75.75 0 017 8.25v-3.5A.75.75 0 017.75 4z",
  pr: "M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z",
  issue: "M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z",
  repo: "M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z",
  fire: "M7.998 14.5c2.832 0 5-1.98 5-4.5 0-1.463-.68-2.19-1.879-3.383l-.036-.037c-1.013-1.008-2.3-2.29-2.834-4.434-.322.256-.63.579-.864.953-.432.696-.621 1.58-.046 2.73.473.947.67 2.284-.278 3.232-.61.61-1.545.84-2.403.633a2.788 2.788 0 01-1.436-.874A3.21 3.21 0 003 10c0 2.53 2.164 4.5 4.998 4.5zM9.533.753C9.496.34 9.16.009 8.77.146 7.035.75 4.34 3.187 5.997 6.5c.344.689.285 1.218.003 1.5-.419.419-1.54.487-2.04-.832-.173-.454-.659-.762-1.035-.454C1.33 8.007.5 9.42.5 10c0 3.507 3.033 6 7.498 6 3.733 0 6.502-2.65 6.502-6 0-2.045-1.074-3.12-2.29-4.336-1.104-1.105-2.317-2.35-2.677-4.911z",
};

function statsCard(p, stars, streak) {
  const year = new Date().getUTCFullYear();
  const rows = [
    ["star", "Total stars earned", stars],
    ["commit", `Commits (${year})`, p.contributionsCollection.totalCommitContributions + p.contributionsCollection.restrictedContributionsCount],
    ["pr", "Pull requests", p.pullRequests.totalCount],
    ["issue", "Issues", p.issues.totalCount],
    ["repo", "Contributed to", p.repositoriesContributedTo.totalCount],
    ["fire", "Total contributions", streak.total],
  ];
  const W = 420, H = 210;
  const items = rows
    .map(([icon, label, value], i) => {
      const y = 62 + i * 24;
      return `<g transform="translate(25 ${y})">
      <svg width="16" height="16" viewBox="0 0 16 16" y="-12"><path fill="${theme.icon}" d="${ICONS[icon]}"/></svg>
      <text x="26" y="0" fill="${theme.text}" font-size="14" font-weight="600">${esc(label)}:</text>
      <text x="235" y="0" fill="${theme.value}" font-size="14" font-weight="700">${fmt(value)}</text>
    </g>`;
    })
    .join("\n    ");
  const name = p.name || USER;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${FONT} role="img" aria-label="${esc(name)}'s GitHub stats">
  <rect width="${W}" height="${H}" rx="6" fill="${theme.bg}"/>
  <text x="25" y="35" fill="${theme.title}" font-size="18" font-weight="600">${esc(name)}'s GitHub Stats</text>
    ${items}
</svg>`;
}

function langsCard(langs) {
  const W = 320;
  const cols = 2;
  const rowsN = Math.ceil(langs.length / cols);
  const H = 90 + rowsN * 24;
  let x = 0;
  const barW = W - 50;
  const bar = langs
    .map((l) => {
      const w = (l.pct / 100) * barW;
      const r = `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="8" fill="${l.color}"/>`;
      x += w;
      return r;
    })
    .join("");
  const items = langs
    .map((l, i) => {
      const cx = (i % cols) * 140;
      const cy = Math.floor(i / cols) * 24;
      return `<g transform="translate(${cx} ${cy})">
      <circle cx="5" cy="6" r="5" fill="${l.color}"/>
      <text x="15" y="10" fill="${theme.text}" font-size="12">${esc(l.name)} ${l.pct.toFixed(1)}%</text>
    </g>`;
    })
    .join("\n    ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${FONT} role="img" aria-label="Most used languages">
  <rect width="${W}" height="${H}" rx="6" fill="${theme.bg}"/>
  <text x="25" y="35" fill="${theme.title}" font-size="18" font-weight="600">Most Used Languages</text>
  <clipPath id="bar"><rect x="0" y="0" width="${barW}" height="8" rx="4"/></clipPath>
  <g clip-path="url(#bar)" transform="translate(25 55)">${bar}</g>
  <g transform="translate(25 78)">
    ${items}
  </g>
</svg>`;
}

function streakCard(s) {
  const W = 495, H = 195;
  const range = (a, b) => (a && b ? (a === b ? fmtDate(a) : `${fmtDate(a)} - ${fmtDate(b)}`) : "No streak yet");
  const currentRange = s.current.len
    ? s.current.start === s.current.end
      ? fmtDate(s.current.end, false)
      : `${fmtDate(s.current.start, false)} - ${fmtDate(s.current.end, false)}`
    : fmtDate(s.today, false);
  const col = (cx, value, label, sub, color = theme.value) => `
  <g text-anchor="middle">
    <text x="${cx}" y="79" fill="${color}" font-size="28" font-weight="700">${value}</text>
    <text x="${cx}" y="115" fill="${theme.value}" font-size="14">${esc(label)}</text>
    <text x="${cx}" y="145" fill="${theme.sub}" font-size="12">${esc(sub)}</text>
  </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${FONT} role="img" aria-label="Contribution streak">
  <rect width="${W}" height="${H}" rx="6" fill="${theme.bg}"/>
  <line x1="165" y1="28" x2="165" y2="170" stroke="${theme.divider}"/>
  <line x1="330" y1="28" x2="330" y2="170" stroke="${theme.divider}"/>
  ${col(82.5, fmt(s.total), "Total Contributions", `${fmtDate(s.firstDay)} - Present`)}
  <g text-anchor="middle">
    <circle cx="247.5" cy="71" r="40" fill="none" stroke="${theme.title}" stroke-width="5"/>
    <g transform="translate(239.5 18)"><rect x="-4" y="-2" width="24" height="22" fill="${theme.bg}"/><svg width="16" height="16" viewBox="0 0 16 16"><path fill="${theme.title}" d="${ICONS.fire}"/></svg></g>
    <text x="247.5" y="81" fill="${theme.title}" font-size="28" font-weight="700">${fmt(s.current.len)}</text>
    <text x="247.5" y="140" fill="${theme.icon}" font-size="14" font-weight="700">Current Streak</text>
    <text x="247.5" y="165" fill="${theme.sub}" font-size="12">${esc(currentRange)}</text>
  </g>
  ${col(412.5, fmt(s.longest.len), "Longest Streak", range(s.longest.start, s.longest.end))}
</svg>`;
}

// ---------- main ----------

const profile = await fetchProfile();
const [repos, days] = await Promise.all([fetchRepos(), fetchCalendar(profile.createdAt)]);
const stars = repos.reduce((s, r) => s + r.stargazerCount, 0);
const streak = computeStreaks(days);
const langs = topLanguages(repos);

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "stats.svg"), statsCard(profile, stars, streak));
await writeFile(join(OUT, "top-langs.svg"), langsCard(langs));
await writeFile(join(OUT, "streak.svg"), streakCard(streak));

console.log(
  `Wrote cards to ${OUT}: ${fmt(streak.total)} contributions, current streak ${streak.current.len}, longest ${streak.longest.len}, ${langs.length} languages`
);
