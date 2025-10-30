import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
process.chdir(repoRoot);

const archiveDirName = 'archive';
const aboutDirName = 'about';
const archiveUrl = 'https://www.richardkauli.com/archive/';
const targetExtensions = new Set(['.html', '.htm', '.css', '.js', '.json', '.xml', '.md']);
const changedFiles = new Set();

function log(message) {
  console.log(message);
}

function pathExists(targetPath) {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch (error) {
    return false;
  }
}

function ensureGitMv(from, to) {
  if (!pathExists(from)) {
    log(`No ${from} directory found, skipping rename.`);
    return;
  }
  if (pathExists(to)) {
    log(`${to} already exists, skipping git mv.`);
    return;
  }
  log(`Renaming ${from} to ${to} with git mv.`);
  execSync(`git mv "${from}" "${to}"`, { stdio: 'inherit' });
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function writeFileIfChanged(filePath, content, original) {
  if (content !== original) {
    fs.writeFileSync(filePath, content);
    changedFiles.add(path.relative(repoRoot, filePath));
  }
}

function transformUrl(url) {
  if (/^(#|mailto:|tel:|javascript:|about:)/i.test(url)) {
    return url;
  }
  let updated = url;
  updated = updated.replace(/(https?:\/\/[^"'\s]*)about(?=(\/(?!\/)|\/|$|[#?]))/gi, (match) => {
    return match.replace(/about/gi, 'archive');
  });
  updated = updated.replace(/(?<=^|\/|\.)about(?=(\/(?!\/)|\/|$|[#?]))/g, 'archive');
  return updated;
}

function replaceAttributeUrls(content) {
  return content.replace(/((?:href|src)\s*=\s*["'])([^"']+)(["'])/gi, (match, prefix, value, suffix) => {
    const newValue = transformUrl(value);
    return prefix + newValue + suffix;
  });
}

function replaceLocationHref(content) {
  return content.replace(/(location\.href\s*=\s*["'])([^"']+)(["'])/gi, (match, prefix, value, suffix) => {
    const newValue = transformUrl(value);
    return prefix + newValue + suffix;
  });
}

function replaceAbsoluteAboutUrls(content) {
  return content.replace(/(https?:\/\/[\w.-]+\/)about(?=(\/(?!\/)|\/|$|[#?]))/gi, '$1archive');
}

function replaceNavLabels(content) {
  let updated = content.replace(/(<a[^>]*>)(\s*)(ABOUT|About)(\s*)(<\/a>)/g, (match, start, pre, text, postSpace, end) => {
    const replacement = text === 'ABOUT' ? 'ARCHIVE' : 'Archive';
    return `${start}${pre}${replacement}${postSpace}${end}`;
  });
  updated = updated.replace(/(<(?:button|div)[^>]*>)(\s*)ABOUT(\s*)(<\/\s*(?:button|div)\s*>)/g, (match, start, pre, postSpace, end) => {
    return `${start}${pre}ARCHIVE${postSpace}${end}`;
  });
  updated = updated.replace(/(<(?:button|div)[^>]*>)(\s*)About(\s*)(<\/\s*(?:button|div)\s*>)/g, (match, start, pre, postSpace, end) => {
    return `${start}${pre}Archive${postSpace}${end}`;
  });
  return updated;
}

function ensureArchiveMeta(content) {
  let updated = content;
  updated = updated.replace(/<title>[^<]*<\/title>/i, '<title>ARCHIVE | Richard Kauli</title>');
  if (!/<title>ARCHIVE \| Richard Kauli<\/title>/i.test(updated)) {
    updated = updated.replace(/<head>/i, '<head>\n<title>ARCHIVE | Richard Kauli</title>');
  }

  const h1Regex = /<h1[^>]*>.*?<\/h1>/is;
  if (h1Regex.test(updated)) {
    updated = updated.replace(h1Regex, '<h1>Archive</h1>');
  } else {
    updated = updated.replace(/<body[^>]*>/i, (match) => `${match}\n<h1>Archive</h1>`);
  }

  const metaDefinitions = [
    { pattern: /<meta[^>]+property=["']og:title["'][^>]*>/i, tag: `<meta property="og:title" content="ARCHIVE | Richard Kauli"/>` },
    { pattern: /<meta[^>]+property=["']og:url["'][^>]*>/i, tag: `<meta property="og:url" content="${archiveUrl}"/>` },
    { pattern: /<meta[^>]+name=["']twitter:title["'][^>]*>/i, tag: `<meta name="twitter:title" content="ARCHIVE | Richard Kauli"/>` },
    { pattern: /<meta[^>]+name=["']twitter:url["'][^>]*>/i, tag: `<meta name="twitter:url" content="${archiveUrl}"/>` }
  ];

  for (const { pattern, tag } of metaDefinitions) {
    if (pattern.test(updated)) {
      updated = updated.replace(pattern, tag);
    } else {
      updated = updated.replace(/<\/head>/i, `${tag}\n</head>`);
    }
  }

  const canonicalRegex = /<link[^>]+rel=["']canonical["'][^>]*>/i;
  const canonicalTag = `<link rel="canonical" href="${archiveUrl}"/>`;
  if (canonicalRegex.test(updated)) {
    updated = updated.replace(canonicalRegex, canonicalTag);
  } else {
    updated = updated.replace(/<\/head>/i, `${canonicalTag}\n</head>`);
  }

  return updated;
}

function updateSitemap(content) {
  return content.replace(/(https?:\/\/[\w.-]+\/)about\/?/gi, '$1archive/');
}

function processFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!targetExtensions.has(ext)) {
    return;
  }
  const original = fs.readFileSync(filePath, 'utf8');
  let updated = original;
  updated = replaceAttributeUrls(updated);
  updated = replaceLocationHref(updated);
  updated = replaceAbsoluteAboutUrls(updated);
  updated = replaceNavLabels(updated);

  const relativePath = path.relative(repoRoot, filePath);
  if (relativePath === path.join(archiveDirName, 'index.html') || relativePath === path.join(archiveDirName, 'index1.html')) {
    updated = ensureArchiveMeta(updated);
  }
  if (path.basename(filePath).toLowerCase() === 'sitemap.xml') {
    updated = updateSitemap(updated);
  }

  writeFileIfChanged(filePath, updated, original);
}

function ensureRedirect() {
  const aboutDir = path.join(repoRoot, aboutDirName);
  fs.mkdirSync(aboutDir, { recursive: true });
  const redirectPath = path.join(aboutDir, 'index.html');
  const redirectHtml = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8"/>\n<meta http-equiv="refresh" content="0; url=/archive/"/>\n<link rel="canonical" href="${archiveUrl}"/>\n<title>Redirecting to Archive</title>\n</head>\n<body>\n<p>This page has moved to <a href="/archive/">/archive/</a>.</p>\n</body>\n</html>\n`;
  fs.writeFileSync(redirectPath, redirectHtml);
  changedFiles.add(path.relative(repoRoot, redirectPath));
}

function summarizeChanges() {
  if (changedFiles.size === 0) {
    log('No files were modified.');
  } else {
    log('\nChanged files:');
    for (const file of Array.from(changedFiles).sort()) {
      log(`- ${file}`);
    }
  }
}

function scanForRemainingAboutLinks(files) {
  const issues = [];
  const hrefRegex = /href=["'][^"']*about[^"']*/i;
  const contentRegex = /content=["'][^"']*about[^"']*/i;
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!targetExtensions.has(ext)) {
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const hrefMatch = text.match(hrefRegex);
    const contentMatch = text.match(contentRegex);
    if (hrefMatch || contentMatch) {
      const relative = path.relative(repoRoot, file);
      if (hrefMatch) {
        issues.push(`${relative}: ${hrefMatch[0]}`);
      }
      if (contentMatch) {
        issues.push(`${relative}: ${contentMatch[0]}`);
      }
    }
  }
  if (issues.length === 0) {
    log('\nChecklist: PASS (no remaining about links in href/content attributes).');
  } else {
    log('\nChecklist: FAIL (remaining about references found):');
    for (const issue of issues) {
      log(`- ${issue}`);
    }
  }
}

function main() {
  ensureGitMv(aboutDirName, archiveDirName);

  let allFiles = walk(repoRoot);
  for (const file of allFiles) {
    processFile(file);
  }

  ensureRedirect();
  allFiles = walk(repoRoot);
  summarizeChanges();
  scanForRemainingAboutLinks(allFiles);
}

main();
