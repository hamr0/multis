const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { DocChunk } = require('../src/indexer/chunk');

// We test parsers through the indexer to get the full pipeline (parse → chunk → store)
// but also test getParser directly for coverage.
const parsersPath = path.join(__dirname, '..', 'src', 'indexer', 'parsers');
const { getParser } = require(parsersPath);

const FIXTURES = path.join(__dirname, 'fixtures');

// ---------------------------------------------------------------------------
// getParser routing
// ---------------------------------------------------------------------------

describe('getParser', () => {
  it('returns a function for .md', () => {
    assert.strictEqual(typeof getParser('/tmp/file.md'), 'function');
  });

  it('returns a function for .txt', () => {
    assert.strictEqual(typeof getParser('/tmp/file.txt'), 'function');
  });

  it('returns a function for .pdf', () => {
    assert.strictEqual(typeof getParser('/tmp/file.pdf'), 'function');
  });

  it('returns a function for .docx', () => {
    assert.strictEqual(typeof getParser('/tmp/file.docx'), 'function');
  });

  it('returns null for unsupported extension', () => {
    assert.strictEqual(getParser('/tmp/file.xlsx'), null);
    assert.strictEqual(getParser('/tmp/file.jpg'), null);
    assert.strictEqual(getParser('/tmp/file'), null);
  });

  it('handles uppercase extensions', () => {
    assert.strictEqual(typeof getParser('/tmp/file.MD'), 'function');
    assert.strictEqual(typeof getParser('/tmp/file.PDF'), 'function');
  });
});

// ---------------------------------------------------------------------------
// Markdown parser
// ---------------------------------------------------------------------------

describe('parseMD', () => {
  const parseMD = getParser('/tmp/file.md');

  it('extracts sections from headings', async () => {
    const chunks = await parseMD(path.join(FIXTURES, 'sample.md'));
    assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);

    // All chunks should be DocChunk instances
    for (const c of chunks) {
      assert.ok(c instanceof DocChunk);
      assert.strictEqual(c.type, 'kb');
    }
  });

  it('builds correct sectionPath from heading hierarchy', async () => {
    const chunks = await parseMD(path.join(FIXTURES, 'sample.md'));

    // Find the "Prerequisites" chunk — should have path like ["Installation", "Prerequisites"]
    const prereq = chunks.find(c => c.name === 'Prerequisites');
    assert.ok(prereq, 'should find Prerequisites section');
    assert.ok(prereq.sectionPath.includes('Installation'),
      `sectionPath should include Installation, got ${JSON.stringify(prereq.sectionPath)}`);
    assert.ok(prereq.sectionPath.includes('Prerequisites'),
      `sectionPath should include Prerequisites, got ${JSON.stringify(prereq.sectionPath)}`);
  });

  it('sets sectionLevel from heading depth', async () => {
    const chunks = await parseMD(path.join(FIXTURES, 'sample.md'));

    // h1 = level 1, h2 = level 2, h3 = level 3
    const h1 = chunks.find(c => c.name === 'Widget User Manual');
    const h2 = chunks.find(c => c.name === 'Installation');
    const h3 = chunks.find(c => c.name === 'Prerequisites');

    if (h1) assert.strictEqual(h1.sectionLevel, 1);
    if (h2) assert.strictEqual(h2.sectionLevel, 2);
    if (h3) assert.strictEqual(h3.sectionLevel, 3);
  });

  it('includes content text in chunks', async () => {
    const chunks = await parseMD(path.join(FIXTURES, 'sample.md'));
    const allContent = chunks.map(c => c.content).join(' ');
    assert.match(allContent, /Node\.js/);
    assert.match(allContent, /config\.json/);
    assert.match(allContent, /debug\.log/);
  });

  it('handles markdown without headings as single chunk', async () => {
    const chunks = await parseMD(path.join(FIXTURES, 'no-headings.md'));
    assert.strictEqual(chunks.length, 1);
    assert.match(chunks[0].content, /plain text paragraphs/);
  });
});

// ---------------------------------------------------------------------------
// Text parser
// ---------------------------------------------------------------------------

describe('parseTXT', () => {
  const parseTXT = getParser('/tmp/file.txt');

  it('returns single chunk for text file', async () => {
    const chunks = await parseTXT(path.join(FIXTURES, 'sample.txt'));
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].type, 'kb');
    assert.match(chunks[0].content, /versatile components/);
  });

  it('returns empty array for empty file', async () => {
    const chunks = await parseTXT(path.join(FIXTURES, 'empty.txt'));
    assert.strictEqual(chunks.length, 0);
  });

  it('sets element to txt', async () => {
    const chunks = await parseTXT(path.join(FIXTURES, 'sample.txt'));
    assert.strictEqual(chunks[0].element, 'txt');
    assert.strictEqual(chunks[0].sectionLevel, 0);
  });
});

// ---------------------------------------------------------------------------
// PDF parser
// ---------------------------------------------------------------------------

describe('parsePDF', () => {
  const parsePDF = getParser('/tmp/file.pdf');
  const pdfPath = path.join(FIXTURES, 'sample.pdf');

  it('parses PDF and extracts text', async () => {
    const chunks = await parsePDF(pdfPath);
    assert.ok(chunks.length > 0, 'should extract at least one chunk');
    assert.strictEqual(chunks[0].type, 'kb');

    const allText = chunks.map(c => c.content).join(' ');
    assert.match(allText, /widgets/i);
  });

  it('sets filePath on chunks', async () => {
    const chunks = await parsePDF(pdfPath);
    assert.strictEqual(chunks[0].filePath, pdfPath);
  });

  it('chunks are DocChunk instances', async () => {
    const chunks = await parsePDF(pdfPath);
    for (const c of chunks) {
      assert.ok(c instanceof DocChunk);
    }
  });
});

// ---------------------------------------------------------------------------
// DOCX parser
// ---------------------------------------------------------------------------

describe('parseDOCX', () => {
  let tmpDir;
  const parseDOCX = getParser('/tmp/file.docx');

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-docx-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses a DOCX and extracts text', async () => {
    const docxPath = path.join(tmpDir, 'test.docx');
    createMinimalDOCX(docxPath, [
      { heading: 1, text: 'Introduction' },
      { text: 'This document describes widgets in detail.' },
      { heading: 2, text: 'Features' },
      { text: 'Widgets support dark mode and auto-update.' }
    ]);

    const chunks = await parseDOCX(docxPath);
    assert.ok(chunks.length > 0, 'should extract chunks');
    assert.strictEqual(chunks[0].type, 'kb');

    const allText = chunks.map(c => c.content).join(' ');
    assert.match(allText, /widgets/i);
    assert.match(allText, /dark mode/i);
  });

  it('extracts heading hierarchy into sectionPath', async () => {
    const docxPath = path.join(tmpDir, 'headings.docx');
    createMinimalDOCX(docxPath, [
      { heading: 1, text: 'Chapter One' },
      { text: 'Chapter content here.' },
      { heading: 2, text: 'Section A' },
      { text: 'Section A content.' }
    ]);

    const chunks = await parseDOCX(docxPath);
    // Find a chunk that has Section A in its path
    const sectionA = chunks.find(c => c.name === 'Section A' ||
      c.sectionPath.includes('Section A'));
    assert.ok(sectionA, 'should find Section A chunk');
    assert.ok(sectionA.sectionPath.length > 0, 'should have sectionPath');
  });

  it('handles DOCX without headings as single chunk', async () => {
    const docxPath = path.join(tmpDir, 'no-headings.docx');
    createMinimalDOCX(docxPath, [
      { text: 'Just a plain paragraph without any headings at all.' }
    ]);

    const chunks = await parseDOCX(docxPath);
    assert.ok(chunks.length >= 1);
    assert.match(chunks[0].content, /plain paragraph/);
  });
});

// ---------------------------------------------------------------------------
// Helpers to create minimal test files
// ---------------------------------------------------------------------------

/**
 * Create a minimal DOCX file (which is a ZIP with XML inside).
 * @param {string} outPath - where to write the .docx
 * @param {Array<{heading?: number, text: string}>} paragraphs
 */
function createMinimalDOCX(outPath, paragraphs) {
  // DOCX is a ZIP file with specific XML files inside
  // We use Node's built-in zlib to create a minimal valid DOCX
  const { createDeflateRaw } = require('zlib');

  // Build document.xml content
  const bodyParts = paragraphs.map(p => {
    if (p.heading) {
      return `<w:p><w:pPr><w:pStyle w:val="Heading${p.heading}"/></w:pPr><w:r><w:t>${escapeXml(p.text)}</w:t></w:r></w:p>`;
    }
    return `<w:p><w:r><w:t>${escapeXml(p.text)}</w:t></w:r></w:p>`;
  }).join('');

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${bodyParts}</w:body>
</w:document>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  // Build ZIP manually (store method — no compression needed for tiny files)
  const files = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml) },
    { name: '_rels/.rels', data: Buffer.from(relsXml) },
    { name: 'word/document.xml', data: Buffer.from(documentXml) }
  ];

  const zipParts = [];
  const centralDir = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.name);
    // Local file header
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header signature
    header.writeUInt16LE(20, 4);         // version needed
    header.writeUInt16LE(0, 6);          // flags
    header.writeUInt16LE(0, 8);          // compression: store
    header.writeUInt16LE(0, 10);         // mod time
    header.writeUInt16LE(0, 12);         // mod date
    header.writeUInt32LE(crc32(file.data), 14); // CRC-32
    header.writeUInt32LE(file.data.length, 18); // compressed size
    header.writeUInt32LE(file.data.length, 22); // uncompressed size
    header.writeUInt16LE(nameBytes.length, 26); // filename length
    header.writeUInt16LE(0, 28);         // extra field length

    zipParts.push(header, nameBytes, file.data);

    // Central directory entry
    const cdEntry = Buffer.alloc(46);
    cdEntry.writeUInt32LE(0x02014b50, 0); // central dir signature
    cdEntry.writeUInt16LE(20, 4);          // version made by
    cdEntry.writeUInt16LE(20, 6);          // version needed
    cdEntry.writeUInt16LE(0, 8);           // flags
    cdEntry.writeUInt16LE(0, 10);          // compression
    cdEntry.writeUInt16LE(0, 12);          // mod time
    cdEntry.writeUInt16LE(0, 14);          // mod date
    cdEntry.writeUInt32LE(crc32(file.data), 16); // CRC-32
    cdEntry.writeUInt32LE(file.data.length, 20); // compressed
    cdEntry.writeUInt32LE(file.data.length, 24); // uncompressed
    cdEntry.writeUInt16LE(nameBytes.length, 28); // filename length
    cdEntry.writeUInt16LE(0, 30);          // extra field length
    cdEntry.writeUInt16LE(0, 32);          // comment length
    cdEntry.writeUInt16LE(0, 34);          // disk number
    cdEntry.writeUInt16LE(0, 36);          // internal attrs
    cdEntry.writeUInt32LE(0, 38);          // external attrs
    cdEntry.writeUInt32LE(offset, 42);     // local header offset

    centralDir.push(cdEntry, nameBytes);
    offset += 30 + nameBytes.length + file.data.length;
  }

  const cdOffset = offset;
  const cdSize = centralDir.reduce((sum, b) => sum + b.length, 0);

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4);          // disk number
  eocd.writeUInt16LE(0, 6);          // disk with CD
  eocd.writeUInt16LE(files.length, 8);  // entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12);       // CD size
  eocd.writeUInt32LE(cdOffset, 16);     // CD offset
  eocd.writeUInt16LE(0, 20);            // comment length

  const zip = Buffer.concat([...zipParts, ...centralDir, eocd]);
  fs.writeFileSync(outPath, zip);
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * CRC-32 computation for ZIP files.
 */
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
