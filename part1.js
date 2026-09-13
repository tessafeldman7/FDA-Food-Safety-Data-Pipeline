#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const DEFAULT_START = '20020101';
const DEFAULT_END = '20260101';
const DEFAULT_LIMIT = 100;
const DEFAULT_OUT = path.resolve(process.cwd(), 'data', 'events.ndjson');
const PROGRESS_FILE = DEFAULT_OUT + '.progress.json';
const CONCURRENCY_LIMIT = 3;

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

const https = require('https');
const { URL } = require('url');

// http GET that returns both parsed JSON and response headers
function httpGetWithMeta(url, retries = 5) {
  return new Promise((resolve, reject) => {
    const attemptRequest = (attempt) => {
      const u = new URL(url);
      const opts = { method: 'GET', headers: { 'User-Agent': 'node.js' } };
      const req = https.request(u, opts, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const status = res.statusCode || 0;
          // Treat openFDA 404 "No matches found" as an empty result set
          if (status === 404) {
            try {
              const parsedErr = JSON.parse(data);
              if (parsedErr && parsedErr.error && parsedErr.error.code === 'NOT_FOUND') {
                return resolve({ json: { results: [] }, headers: res.headers });
              }
            } catch (e) {
              // fallthrough to error handling below
            }
          }
          if (status === 429 || (status >= 500 && status < 600)) {
            if (attempt >= retries) return reject(new Error(`HTTP ${status}`));
            const backoff = Math.pow(2, attempt) * 500 + 300;
            return setTimeout(() => attemptRequest(attempt + 1), backoff);
          }
          if (status < 200 || status >= 300) {
            let msg = `HTTP ${status}`;
            try {
              const parsedErr = JSON.parse(data);
              msg += `: ${JSON.stringify(parsedErr)}`;
            } catch (e) {
              if (data && data.length) msg += `: ${data}`;
            }
            const err = new Error(msg);
            err.status = status;
            err.body = data;
            return reject(err);
          }
          try {
            const parsed = JSON.parse(data);
            resolve({ json: parsed, headers: res.headers });
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', err => {
        if (attempt >= retries) return reject(err);
        const backoff = Math.pow(2, attempt) * 500 + 300;
        setTimeout(() => attemptRequest(attempt + 1), backoff);
      });
      req.end();
    };
    attemptRequest(0);
  });
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { start: DEFAULT_START, end: DEFAULT_END, limit: DEFAULT_LIMIT, out: DEFAULT_OUT, resume: false, apiKey: process.env.OPENFDA_API_KEY || process.env.FDA_API_KEY || null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--start' && args[i+1]) { out.start = args[++i]; }
    else if (a === '--end' && args[i+1]) { out.end = args[++i]; }
    else if (a === '--limit' && args[i+1]) { out.limit = Number(args[++i]); }
    else if (a === '--out' && args[i+1]) { out.out = path.resolve(args[++i]); }
    else if (a === '--api-key' && args[i+1]) { out.apiKey = args[++i]; }
    else if (a === '--resume') { out.resume = true; }
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node download-fda-food-events.js [--start YYYYMMDD] [--end YYYYMMDD] [--limit N] [--out PATH] [--resume] [--api-key KEY]');
      process.exit(0);
    }
  }
  return out;
}

async function countLines(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) return resolve(0);
    let count = 0;
    const rs = fs.createReadStream(filePath);
    rs.on('error', reject);
    rs.on('data', chunk => {
      for (let i=0;i<chunk.length;++i) if (chunk[i] === 10) count++; // \n
    });
    rs.on('end', () => resolve(count));
  });
}

async function main() {
  const opts = parseArgs();
  const outFile = opts.out;
  ensureDir(outFile);
  const endpoint = 'https://api.fda.gov/food/event.json';
  const search = `date_created:[${opts.start}+TO+${opts.end}]`;
  const encodeSearch = s => encodeURIComponent(s).replace(/%2B/g, '+');

  console.log(`Querying FDA food events from ${opts.start} to ${opts.end}`);

  // split overall date range into monthly subranges
  function splitRangeByMonth(startYMD, endYMD) {
    const parseYMD = (ymd) => {
      const y = Number(ymd.slice(0,4));
      const m = Number(ymd.slice(4,6)) - 1;
      const d = Number(ymd.slice(6,8));
      return new Date(Date.UTC(y, m, d));
    };
    const formatYMD = (date) => {
      const y = date.getUTCFullYear();
      const m = (date.getUTCMonth() + 1).toString().padStart(2,'0');
      const d = date.getUTCDate().toString().padStart(2,'0');
      return `${y}${m}${d}`;
    };
    const start = parseYMD(startYMD);
    const end = parseYMD(endYMD);
    const ranges = [];
    let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    while (cur <= end) {
      const monthStart = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), 1));
      const monthEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0));
      const rStart = (monthStart < start) ? start : monthStart;
      const rEnd = (monthEnd > end) ? end : monthEnd;
      ranges.push({ start: formatYMD(rStart), end: formatYMD(rEnd) });
      cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    }
    return ranges;
  }

  // download a single date subrange into a part file using search_after pagination
  async function downloadRange(idx, range, partFile) {
    ensureDir(partFile);
    const progressPart = partFile + '.progress.json';
    let fetched = 0;
    let nextToken = null;
    const searchStr = `date_created:[${range.start}+TO+${range.end}]`;
    const streamPart = fs.createWriteStream(partFile, { flags: 'a' });
    const apiKeyParam = opts.apiKey ? `&api_key=${encodeURIComponent(opts.apiKey)}` : '';
    try {
      // resume if progress exists
      if (opts.resume && fs.existsSync(progressPart)) {
        try {
          const p = JSON.parse(fs.readFileSync(progressPart,'utf8'));
          nextToken = p && p.search_after ? p.search_after : null;
          fetched = p && p.fetched ? p.fetched : 0;
        } catch (e) { nextToken = null; }
      }

      // initial request if no token
      if (!nextToken) {
        const firstUrl = `${endpoint}?search=${encodeSearch(searchStr)}&limit=${opts.limit}${apiKeyParam}`;
        const firstResp = await httpGetWithMeta(firstUrl);
        const json = firstResp.json;
        if (json && json.results && json.results.length) {
          for (const r of json.results) {
            streamPart.write(JSON.stringify(r) + '\n');
            fetched++;
          }
        }
        // parse next token from headers
        const link = firstResp.headers && firstResp.headers.link;
        if (link) {
          const m = link.match(/<([^>]+)>;\s*rel="next"/);
          if (m) {
            try { nextToken = new URL(m[1]).searchParams.get('search_after'); } catch(e) { nextToken = null; }
          }
        }
        fs.writeFileSync(progressPart, JSON.stringify({ search_after: nextToken, fetched: fetched, range: range }, null, 2));
      }

      // page through via search_after
      while (nextToken) {
        const u = `${endpoint}?search=${encodeSearch(searchStr)}&limit=${opts.limit}&search_after=${encodeURIComponent(nextToken)}${apiKeyParam}`;
        const resp = await httpGetWithMeta(u);
        const json = resp.json;
        if (!json.results || json.results.length === 0) break;
        for (const r of json.results) {
          streamPart.write(JSON.stringify(r) + '\n');
          fetched++;
        }
        // update token
        const link = resp.headers && resp.headers.link;
        let newToken = null;
        if (link) {
          const m = link.match(/<([^>]+)>;\s*rel="next"/);
          if (m) {
            try { newToken = new URL(m[1]).searchParams.get('search_after'); } catch(e) { newToken = null; }
          }
        }
        nextToken = newToken;
        fs.writeFileSync(progressPart, JSON.stringify({ search_after: nextToken, fetched: fetched, range: range }, null, 2));
        await sleep(300);
      }
      console.log(`Part ${idx} complete: fetched ${fetched} records for ${range.start}→${range.end}`);
    } finally {
      streamPart.end();
    }
  }

  // orchestrate parallel downloads of monthly ranges
  const ranges = splitRangeByMonth(opts.start, opts.end);
  if (ranges.length === 0) {
    console.log('No ranges to download.');
    return;
  }
  console.log(`Split into ${ranges.length} subranges (by month). Running up to ${CONCURRENCY_LIMIT} workers.`);

  const partFiles = ranges.map((r, i) => `${outFile}.part${i}.ndjson`);
  for (let i = 0; i < ranges.length; i += CONCURRENCY_LIMIT) {
    const batch = ranges.slice(i, i + CONCURRENCY_LIMIT).map((r, idx) => {
      const globalIdx = i + idx;
      return downloadRange(globalIdx, r, partFiles[globalIdx]);
    });
    await Promise.all(batch);
  }

  // merge parts into final outFile (streaming to preserve newlines)
  ensureDir(outFile);
  const outStream = fs.createWriteStream(outFile, { flags: 'w' });
  let totalWritten = 0;
  for (let i = 0; i < partFiles.length; i++) {
    const pf = partFiles[i];
    if (!fs.existsSync(pf)) continue;
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(pf, { encoding: 'utf8' });
      rs.on('error', reject);
      rs.on('data', chunk => {
        const m = chunk.match(/\n/g);
        if (m) totalWritten += m.length;
      });
      rs.on('end', resolve);
      rs.pipe(outStream, { end: false });
    });
  }
  outStream.end();
  // cleanup parts and progress
  for (const pf of partFiles) {
    try { fs.unlinkSync(pf); } catch(e) {}
    try { fs.unlinkSync(pf + '.progress.json'); } catch(e) {}
  }
  console.log(`Merged parts into ${outFile} (${totalWritten} records).`);
}

main().catch(err => { console.error(err); process.exit(1); });
