#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const root = process.cwd();
const archiveUrl = 'https://www.richardkauli.com/portfolio/';
const archiveTitle = 'PORTFOLIO | Richard Kauli';
const archivePageRelative = path.join('portfolio', 'index.html');
const targetExtensions = new Set(['.html', '.htm', '.css', '.js', '.json', '.xml', '.md']);
const changedFiles = new Set();

function log(msg) {
  console.log(msg);
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function recordChange(filePath) {
  changedFiles.add(path.relative(root, filePath));
}

async function renameFolderIfNeeded() {
  const aboutPath = path.join(root, 'about');
  const archivePath = path.join(root, 'portfolio');
  const aboutExists = await pathExists(aboutPath);
  const archiveExists = await pathExists(archivePath);

  if (aboutExists && !archiveExists) {
    log('Renaming about -> portfolio using git mv');
    execSync(`git mv "${aboutPath}" "${archivePath}"`, { stdio: 'inherit' });
    recordChange(archivePath);
  } else if (aboutExists && archiveExists) {
    log('Both about and portfolio folders exist, skipping rename');
  } else {
    log('No about folder to rename');
  }
}

function transformUrlValue(value) {
  let updated = value;
  const original = value;

  updated = updated.replace(/https:\/\/www\.richardkauli\.com\/about\/?/g, 'https://www.richardkauli.com/portfolio/');
  updated = updated.replace(/https:\/\/richardkauli\.com\/about\/?/g, 'https://richardkauli.com/portfolio/');
  updated = updated.replace(/(^|\/)(about)(?=\/|$|\?)/g, (_, prefix) => `${prefix}portfolio`);

  return updated === original ? value : updated;
}

function updateAttributeUrls(content) {
  return content.replace(/((?:href|src|data-href|data-src|action|content)=)(["'])([^"']*)(\2)/gi, (match, attr, quote, value, closingQuote) => {
    const newValue = transformUrlValue(value);
    if (newValue !== value) {
      return `${attr}${quote}${newValue}${quote}`;
    }
    return match;
  });
}

function updateStringLiterals(content) {
  return content.replace(/(["'])([^"'\n]*)(\1)/g, (match, quote, value, closing) => {
    const newValue = transformUrlValue(value);
    if (newValue !== value) {
      return `${quote}${newValue}${quote}`;
    }
    return match;
  });
}

function updateNavLabels(content) {
  return content
    .replace(/(<a[^>]*>)(ABOUT)(<\/a>)/g, '$1ARCHIVE$3')
    .replace(/(<a[^>]*>)(About)(<\/a>)/g, '$1Archive$3')
    .replace(/(<button[^>]*>)(ABOUT)(<\/button>)/g, '$1ARCHIVE$3')
    .replace(/(<button[^>]*>)(About)(<\/button>)/g, '$1Archive$3')
    .replace(/(<div[^>]*>)(ABOUT)(<\/div>)/g, '$1ARCHIVE$3')
    .replace(/(<div[^>]*>)(About)(<\/div>)/g, '$1Archive$3')
    .replace(/(<li[^>]*>\s*<a[^>]*>)(ABOUT)(<\/a>\s*<\/li>)/g, '$1ARCHIVE$3')
    .replace(/(<li[^>]*>\s*<a[^>]*>)(About)(<\/a>\s*<\/li>)/g, '$1Archive$3');
}

function ensureMetaTag(content, regex, tag) {
  if (regex.test(content)) {
    return content.replace(regex, tag);
  }
  return content.replace(/<\/head>/i, `${tag}\n</head>`);
}

function updateArchivePage(content) {
  let updated = content;

  updated = updated.replace(/<title>[^<]*<\/title>/i, `<title>${archiveTitle}</title>`);

  if (/<h1[^>]*>/i.test(updated)) {
    updated = updated.replace(/<h1[^>]*>[^<]*<\/h1>/i, '<h1>Portfolio</h1>');
  } else {
    updated = updated.replace(/<body[^>]*>/i, match => `${match}\n<h1>Portfolio</h1>`);
  }

  const canonicalTag = `<link rel="canonical" href="${archiveUrl}" />`;
  updated = ensureMetaTag(updated, /<link[^>]+rel=["']canonical["'][^>]*>/i, canonicalTag);

  const ogTitleTag = `<meta property="og:title" content="${archiveTitle}" />`;
  updated = ensureMetaTag(updated, /<meta[^>]+property=["']og:title["'][^>]*>/i, ogTitleTag);

  const ogUrlTag = `<meta property="og:url" content="${archiveUrl}" />`;
  updated = ensureMetaTag(updated, /<meta[^>]+property=["']og:url["'][^>]*>/i, ogUrlTag);

  const twitterTitleTag = `<meta name="twitter:title" content="${archiveTitle}" />`;
  updated = ensureMetaTag(updated, /<meta[^>]+name=["']twitter:title["'][^>]*>/i, twitterTitleTag);

  return updated;
}

async function writeFileIfChanged(filePath, original, updated) {
  if (original !== updated) {
    await fs.writeFile(filePath, updated);
    recordChange(filePath);
  }
}

async function processFile(filePath) {
  const ext = path.extname(filePath);
  if (!targetExtensions.has(ext)) {
    return;
  }
  let content = await fs.readFile(filePath, 'utf8');
  let updated = content;

  updated = updateAttributeUrls(updated);
  updated = updateStringLiterals(updated);
  updated = updateNavLabels(updated);

  if (path.relative(root, filePath) === archivePageRelative) {
    updated = updateArchivePage(updated);
  }

  await writeFileIfChanged(filePath, content, updated);
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath);
    } else if (entry.isFile()) {
      await processFile(fullPath);
    }
  }
}

async function ensureRedirect() {
  const redirectDir = path.join(root, 'about');
  const redirectFile = path.join(redirectDir, 'index.html');
  const redirectHtml = `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <meta http-equiv="refresh" content="0; url=${archiveUrl}" />\n  <link rel="canonical" href="${archiveUrl}" />\n  <title>Redirecting to Portfolio</title>\n</head>\n<body>\n  <p>This page has moved to <a href="${archiveUrl}">Portfolio</a>.</p>\n</body>\n</html>\n`;

  await fs.mkdir(redirectDir, { recursive: true });
  await fs.writeFile(redirectFile, redirectHtml);
  recordChange(redirectFile);
  log('Created HTML redirect at about/index.html');
}

async function main() {
  await renameFolderIfNeeded();
  await walk(root);
  await ensureRedirect();

  if (changedFiles.size) {
    log('\nSummary of updated files:');
    for (const file of Array.from(changedFiles).sort()) {
      log(` - ${file}`);
    }
  } else {
    log('No files were updated.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
