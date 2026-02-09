const fs = require('fs');
const path = require('path');
const { DocChunk } = require('./chunk');

/**
 * PDF Parser - uses pdf-parse to extract text, creates page-level chunks.
 * Ported from aurora_context_doc.parser.pdf (PyMuPDF).
 * pdf-parse is simpler than PyMuPDF — no TOC extraction, no font detection.
 * We get page-level text and chunk from there.
 */
async function parsePDF(filePath) {
  const pdfParse = require('pdf-parse');
  const buffer = fs.readFileSync(filePath);

  const data = await pdfParse(buffer, {
    // Custom page renderer to get per-page text
    pagerender: function (pageData) {
      return pageData.getTextContent().then(function (textContent) {
        return textContent.items.map(item => item.str).join(' ');
      });
    }
  });

  // pdf-parse doesn't give per-page text easily with custom renderer,
  // but data.text has full text. Split by form feeds if available.
  // Fallback: use numpages and split evenly, or treat as single doc.
  const chunks = [];
  const absPath = path.resolve(filePath);

  // Try to split by page using the raw text
  // pdf-parse joins pages - we re-parse with page tracking
  const pdf = await pdfParse(buffer);
  const fullText = pdf.text;
  const numPages = pdf.numpages;

  if (numPages <= 1 || fullText.length < 500) {
    // Single chunk for small docs
    if (fullText.trim()) {
      chunks.push(new DocChunk({
        filePath: absPath,
        pageStart: 1,
        pageEnd: numPages,
        elementType: 'section',
        name: path.basename(filePath),
        content: fullText.trim(),
        sectionPath: [path.basename(filePath)],
        sectionLevel: 1,
        documentType: 'pdf'
      }));
    }
  } else {
    // Split full text roughly by page count
    // This is approximate — pdf-parse doesn't give clean page breaks
    const avgChars = Math.ceil(fullText.length / numPages);
    for (let i = 0; i < numPages; i++) {
      const start = i * avgChars;
      const end = Math.min((i + 1) * avgChars, fullText.length);
      const pageText = fullText.slice(start, end).trim();

      if (!pageText) continue;

      chunks.push(new DocChunk({
        filePath: absPath,
        pageStart: i + 1,
        pageEnd: i + 1,
        elementType: 'paragraph',
        name: `Page ${i + 1}`,
        content: pageText,
        sectionPath: [path.basename(filePath), `Page ${i + 1}`],
        sectionLevel: 1,
        documentType: 'pdf'
      }));
    }
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
            elementType: currentLevel > 0 ? 'section' : 'paragraph',
            name: currentName,
            content: cleanContent,
            sectionPath: sectionStack.map(s => s.name).concat(currentLevel > 0 ? [] : [currentName]),
            sectionLevel: currentLevel,
            documentType: 'docx'
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
        elementType: currentLevel > 0 ? 'section' : 'paragraph',
        name: currentName,
        content: cleanContent,
        sectionPath: sectionStack.map(s => s.name),
        sectionLevel: currentLevel,
        documentType: 'docx'
      }));
    }
  }

  // If no headings found, treat as single chunk
  if (chunks.length === 0 && html.trim()) {
    const cleanContent = stripHtml(html);
    if (cleanContent) {
      chunks.push(new DocChunk({
        filePath: absPath,
        elementType: 'paragraph',
        name: path.basename(filePath),
        content: cleanContent,
        sectionPath: [path.basename(filePath)],
        sectionLevel: 0,
        documentType: 'docx'
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
          elementType: currentLevel > 0 ? 'section' : 'paragraph',
          name: currentName,
          content: currentContent.trim(),
          sectionPath: sectionStack.map(s => s.name),
          sectionLevel: currentLevel,
          documentType: 'md'
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
      elementType: currentLevel > 0 ? 'section' : 'paragraph',
      name: currentName,
      content: currentContent.trim(),
      sectionPath: sectionStack.map(s => s.name),
      sectionLevel: currentLevel,
      documentType: 'md'
    }));
  }

  if (chunks.length === 0 && content.trim()) {
    chunks.push(new DocChunk({
      filePath: absPath,
      elementType: 'paragraph',
      name: path.basename(filePath),
      content: content.trim(),
      sectionPath: [path.basename(filePath)],
      sectionLevel: 0,
      documentType: 'md'
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
    elementType: 'paragraph',
    name: path.basename(filePath),
    content: content.trim(),
    sectionPath: [path.basename(filePath)],
    sectionLevel: 0,
    documentType: 'txt'
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
