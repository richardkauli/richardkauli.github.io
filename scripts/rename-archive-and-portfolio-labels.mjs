#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const EXCLUDED_DIRS = new Set(['.git', 'node_modules']);
const TARGET_EXTENSIONS = new Set(['.html', '.htm']);

const REPLACEMENTS = [
  { from: 'PORTFOLIO', to: 'CLOTHES' },
  { from: 'Portfolio', to: 'Clothes' },
  { from: 'ARCHIVE', to: 'PORTFOLIO' },
  { from: 'Archive', to: 'Portfolio' },
];

function applyLabelReplacements(input, counts) {
  let output = input;
  const placeholders = [
    { token: '__TMP_UPPER_PORTFOLIO__', from: 'PORTFOLIO', to: 'CLOTHES' },
    { token: '__TMP_TITLE_PORTFOLIO__', from: 'Portfolio', to: 'Clothes' },
    { token: '__TMP_UPPER_ARCHIVE__', from: 'ARCHIVE', to: 'PORTFOLIO' },
    { token: '__TMP_TITLE_ARCHIVE__', from: 'Archive', to: 'Portfolio' },
  ];

  for (const { token, from } of placeholders) {
    const regex = new RegExp(from, 'g');
    const matches = output.match(regex);
    if (matches) {
      counts[from] += matches.length;
      output = output.replace(regex, token);
    }
  }

  output = output
    .replace(/__TMP_UPPER_PORTFOLIO__/g, 'CLOTHES')
    .replace(/__TMP_TITLE_PORTFOLIO__/g, 'Clothes')
    .replace(/__TMP_UPPER_ARCHIVE__/g, 'PORTFOLIO')
    .replace(/__TMP_TITLE_ARCHIVE__/g, 'Portfolio');

  return output;
}

function processHtmlSegment(segment, counts) {
  // Replace visible tag text nodes: > ... <
  segment = segment.replace(/>([^<]+)</g, (match, innerText) => {
    const replaced = applyLabelReplacements(innerText, counts);
    return `>${replaced}<`;
  });


  // Replace OG/Twitter title meta content
  segment = segment.replace(
    /<meta\s+([^>]*?(?:property|name)\s*=\s*["'](?:og:title|twitter:title)["'][^>]*?)>/gi,
    (metaTag, attrs) => {
      const contentRegex = /(content\s*=\s*["'])([^"']*)(["'])/i;
      if (!contentRegex.test(attrs)) return metaTag;
      const updatedAttrs = attrs.replace(contentRegex, (full, start, value, end) => {
        const replaced = applyLabelReplacements(value, counts);
        return `${start}${replaced}${end}`;
      });
      return `<meta ${updatedAttrs}>`;
    }
  );

  return segment;
}

function processHtmlContent(content, counts) {
  // Protect script/style blocks from text replacement.
  const blocks = [];
  let stripped = content.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (block) => {
    const token = `__BLOCK_${blocks.length}__`;
    blocks.push(block);
    return token;
  });

  stripped = processHtmlSegment(stripped, counts);

  return stripped.replace(/__BLOCK_(\d+)__/g, (_, idx) => blocks[Number(idx)]);
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        files.push(...(await walk(fullPath)));
      }
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (TARGET_EXTENSIONS.has(ext)) {
      files.push(fullPath);
    }
  }

  return files;
}

async function main() {
  const files = await walk(ROOT);
  const totals = Object.fromEntries(REPLACEMENTS.map((r) => [r.from, 0]));
  const changed = [];

  for (const file of files) {
    const original = await fs.readFile(file, 'utf8');
    const fileCounts = Object.fromEntries(REPLACEMENTS.map((r) => [r.from, 0]));
    const updated = processHtmlContent(original, fileCounts);

    if (updated !== original) {
      await fs.writeFile(file, updated, 'utf8');
      const rel = path.relative(ROOT, file);
      changed.push({ rel, fileCounts });
      for (const key of Object.keys(totals)) {
        totals[key] += fileCounts[key];
      }
    }
  }

  console.log('Rename labels report');
  console.log(`Files changed: ${changed.length}`);
  for (const item of changed) {
    const entries = Object.entries(item.fileCounts)
      .filter(([, count]) => count > 0)
      .map(([label, count]) => `${label}:${count}`)
      .join(', ');
    console.log(`- ${item.rel}${entries ? ` (${entries})` : ''}`);
  }

  console.log('Totals:');
  for (const [label, count] of Object.entries(totals)) {
    console.log(`  ${label} -> ${count}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
