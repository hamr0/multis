const fs = require('fs');
const path = require('path');
const { DocChunk } = require('./chunk');

/**
 * PDF Parser - uses pdfjs-dist (Mozilla PDF.js) for TOC extraction + per-page text.
 * Ported from aurora_context_doc.parser.pdf (PyMuPDF).
 *
 * Tiered strategy (matching Aurora):
 *   Tier 1: TOC/outline present → one chunk per section, hierarchical sectionPath
 *   Tier 3: No TOC → one chunk per page with clean per-page text
 *   (Tier 2: font-size heading detection — deferred)
 */
async function parsePDF(filePath) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const buffer = fs.readFileSync(filePath);
  const data = new Uint8Array(buffer);
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const absPath = path.resolve(filePath);

  try {
    // Extract per-page text (needed for both tiers)
    const pageTexts = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const text = tc.items.map(item => item.str).join(' ').trim();
      pageTexts.push(text);
    }

    // Try Tier 1: TOC-based chunking
    const outline = await pdf.getOutline();
    if (outline && outline.length > 0) {
      const chunks = await _chunksFromOutline(pdf, outline, pageTexts, absPath);
      if (chunks.length > 0) return chunks;
    }

    // Tier 3: page-based fallback with real per-page text
    return _chunksFromPages(pageTexts, absPath, filePath);
  } finally {
    await pdf.destroy();
  }
}

/**
 * Tier 1: Build chunks from PDF outline/TOC.
 * Each TOC entry becomes a section chunk with content from its page range.
 */
async function _chunksFromOutline(pdf, outline, pageTexts, absPath) {
  // Flatten outline into [{title, level, pageNum}] with resolved page numbers
  const toc = await _flattenOutline(pdf, outline, 1);
  if (toc.length === 0) return [];

  const chunks = [];
  const fileName = path.basename(absPath);

  for (let i = 0; i < toc.length; i++) {
    const entry = toc[i];
    const nextEntry = toc[i + 1];

    // Page range: from this entry's page to next entry's page (or end of doc)
    const startPage = entry.pageNum;
    const endPage = nextEntry ? Math.max(nextEntry.pageNum, startPage) : pdf.numPages;

    // Collect text from page range
    const sectionText = pageTexts
      .slice(startPage - 1, endPage === startPage ? startPage : (nextEntry ? nextEntry.pageNum - 1 : endPage))
      .join('\n\n')
      .trim();

    // Build sectionPath from nesting
    const sectionPath = _buildSectionPath(toc, i);

    if (sectionText) {
      chunks.push(new DocChunk({
        filePath: absPath,
        pageStart: startPage,
        pageEnd: endPage,
        element: 'pdf',
        name: entry.title,
        content: sectionText,
        sectionPath,
        sectionLevel: entry.level,
        type: 'kb'
      }));
    }
  }

  return chunks;
}

/**
 * Flatten nested outline into a flat array with level tracking.
 * PDF.js outlines are nested: each item has .items[] children.
 */
async function _flattenOutline(pdf, items, level) {
  const result = [];
  for (const item of items) {
    let pageNum = 1;
    try {
      if (typeof item.dest === 'string') {
        const dest = await pdf.getDestination(item.dest);
        if (dest) pageNum = (await pdf.getPageIndex(dest[0])) + 1;
      } else if (Array.isArray(item.dest) && item.dest.length > 0) {
        pageNum = (await pdf.getPageIndex(item.dest[0])) + 1;
      }
    } catch {
      // Destination resolution can fail for malformed PDFs
    }

    result.push({ title: (item.title || '').trim(), level, pageNum });

    if (item.items && item.items.length > 0) {
      const children = await _flattenOutline(pdf, item.items, level + 1);
      result.push(...children);
    }
  }
  return result;
}

/**
 * Build breadcrumb sectionPath for a TOC entry by looking at ancestors.
 * Walks backward to find the parent at each level above current.
 */
function _buildSectionPath(toc, index) {
  const entry = toc[index];
  const path = [entry.title];

  // Walk backward to find ancestors at each decreasing level
  let targetLevel = entry.level - 1;
  for (let j = index - 1; j >= 0 && targetLevel >= 1; j--) {
    if (toc[j].level === targetLevel) {
      path.unshift(toc[j].title);
      targetLevel--;
    }
  }

  return path;
}

/**
 * Tier 3: One chunk per page (fallback when no TOC).
 */
function _chunksFromPages(pageTexts, absPath, filePath) {
  const chunks = [];
  const fileName = path.basename(filePath);
  const numPages = pageTexts.length;

  // Small/single-page docs → single chunk
  const fullText = pageTexts.join('\n\n').trim();
  if (numPages <= 1 || fullText.length < 500) {
    if (fullText) {
      chunks.push(new DocChunk({
        filePath: absPath,
        pageStart: 1,
        pageEnd: numPages,
        element: 'pdf',
        name: fileName,
        content: fullText,
        sectionPath: [fileName],
        sectionLevel: 1,
        type: 'kb'
      }));
    }
    return chunks;
  }

  // Multi-page → one chunk per page
  for (let i = 0; i < numPages; i++) {
    const pageText = pageTexts[i];
    if (!pageText) continue;

    chunks.push(new DocChunk({
      filePath: absPath,
      pageStart: i + 1,
      pageEnd: i + 1,
      element: 'pdf',
      name: `Page ${i + 1}`,
      content: pageText,
      sectionPath: [fileName, `Page ${i + 1}`],
      sectionLevel: 1,
      type: 'kb'
    }));
  }

  return chunks;
}

/**
 * DOCX Parser - uses mammoth to extract HTML, then parses headings for hierarchy.
 * Ported from aurora_context_doc.parser.docx (python-docx).
 * mammoth converts to HTML — we parse headings from that.
 */
async function parseDOCX(filePath) {
  const mammoth = require('mammoth');
  const absPath = path.resolve(filePath);

  const result = await mammoth.convertToHtml({ path: filePath });
  const html = result.value;

  // Parse HTML for headings and content blocks
  const chunks = [];
  const sectionStack = []; // track current heading hierarchy

  // Split HTML by heading tags
  const parts = html.split(/(<h[1-6][^>]*>.*?<\/h[1-6]>)/gi);

  let currentContent = '';
  let currentName = path.basename(filePath);
  let currentLevel = 0;

  for (const part of parts) {
    const headingMatch = part.match(/<h([1-6])[^>]*>(.*?)<\/h[1-6]>/i);

    if (headingMatch) {
      // Save previous section if it has content
      if (currentContent.trim()) {
        const cleanContent = stripHtml(currentContent);
        if (cleanContent) {
          chunks.push(new DocChunk({
            filePath: absPath,
            element: 'docx',
            name: currentName,
            content: cleanContent,
            sectionPath: sectionStack.map(s => s.name).concat(currentLevel > 0 ? [] : [currentName]),
            sectionLevel: currentLevel,
            type: 'kb'
          }));
        }
      }

      // Start new section
      const level = parseInt(headingMatch[1]);
      const title = stripHtml(headingMatch[2]);

      // Update section stack
      while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1].level >= level) {
        sectionStack.pop();
      }
      sectionStack.push({ level, name: title });

      currentName = title;
      currentLevel = level;
      currentContent = '';
    } else {
      currentContent += part;
    }
  }

  // Save last section
  if (currentContent.trim()) {
    const cleanContent = stripHtml(currentContent);
    if (cleanContent) {
      chunks.push(new DocChunk({
        filePath: absPath,
        element: 'docx',
        name: currentName,
        content: cleanContent,
        sectionPath: sectionStack.map(s => s.name),
        sectionLevel: currentLevel,
        type: 'kb'
      }));
    }
  }

  // If no headings found, treat as single chunk
  if (chunks.length === 0 && html.trim()) {
    const cleanContent = stripHtml(html);
    if (cleanContent) {
      chunks.push(new DocChunk({
        filePath: absPath,
        element: 'docx',
        name: path.basename(filePath),
        content: cleanContent,
        sectionPath: [path.basename(filePath)],
        sectionLevel: 0,
        type: 'kb'
      }));
    }
  }

  return chunks;
}

/**
 * Markdown Parser - native, splits by headings.
 * No external dependency needed.
 */
function parseMD(filePath) {
  const absPath = path.resolve(filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const chunks = [];
  const sectionStack = [];

  let currentContent = '';
  let currentName = path.basename(filePath);
  let currentLevel = 0;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

    if (headingMatch) {
      // Save previous section
      if (currentContent.trim()) {
        chunks.push(new DocChunk({
          filePath: absPath,
          element: 'md',
          name: currentName,
          content: currentContent.trim(),
          sectionPath: sectionStack.map(s => s.name),
          sectionLevel: currentLevel,
          type: 'kb'
        }));
      }

      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();

      while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1].level >= level) {
        sectionStack.pop();
      }
      sectionStack.push({ level, name: title });

      currentName = title;
      currentLevel = level;
      currentContent = '';
    } else {
      currentContent += line + '\n';
    }
  }

  // Save last section
  if (currentContent.trim()) {
    chunks.push(new DocChunk({
      filePath: absPath,
      element: 'md',
      name: currentName,
      content: currentContent.trim(),
      sectionPath: sectionStack.map(s => s.name),
      sectionLevel: currentLevel,
      type: 'kb'
    }));
  }

  if (chunks.length === 0 && content.trim()) {
    chunks.push(new DocChunk({
      filePath: absPath,
      element: 'md',
      name: path.basename(filePath),
      content: content.trim(),
      sectionPath: [path.basename(filePath)],
      sectionLevel: 0,
      type: 'kb'
    }));
  }

  return chunks;
}

/**
 * Plain text parser - single chunk per file
 */
function parseTXT(filePath) {
  const absPath = path.resolve(filePath);
  const content = fs.readFileSync(filePath, 'utf8');

  if (!content.trim()) return [];

  return [new DocChunk({
    filePath: absPath,
    element: 'txt',
    name: path.basename(filePath),
    content: content.trim(),
    sectionPath: [path.basename(filePath)],
    sectionLevel: 0,
    type: 'kb'
  })];
}

/**
 * Get the appropriate parser for a file extension
 */
function getParser(filePath) {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  switch (ext) {
    case 'pdf': return parsePDF;
    case 'docx': return parseDOCX;
    case 'md': return parseMD;
    case 'txt': return parseTXT;
    default: return null;
  }
}

/** Strip HTML tags and decode entities */
function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { parsePDF, parseDOCX, parseMD, parseTXT, getParser };
