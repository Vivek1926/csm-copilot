// Answer formatting: Astra returns markdown with citation link clutter —
// "[[1]](url)", "[](url)", and bare "(url)" clusters mid-sentence. This
// module parses that into a small AST (pure JS, node-testable) and renders
// it to DOM: headings, bold, lists, plus numbered citation chips [1] and a
// deduplicated "Sources" footer with human-readable names.
//
// Rendering builds elements and text nodes only — model output is never
// injected as HTML.

// ---------------------------------------------------------------------------
// Parsing (pure — no DOM)
// ---------------------------------------------------------------------------

const INLINE_RE = new RegExp(
  [
    /\[\[?(\d*)\]?\]\((https?:[^)\s]+)\)/.source, // 1,2: [[1]](url) [1](url) [](url)
    /\((https?:[^)\s]+)\)/.source,                // 3:   bare (url)
    /`([^`]+)`/.source,                           // 4:   `code`
    /\*\*([^*]+)\*\*/.source,                     // 5:   **bold**
    /\[([^\]]+)\]\((https?:[^)\s]+)\)/.source,    // 6,7: [text](url)
  ].join('|'),
  'g'
);

function parseInline(text, sources) {
  const inlines = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) inlines.push({ type: 'text', text: text.slice(last, m.index) });
    last = INLINE_RE.lastIndex;

    if (m[2] !== undefined) {
      inlines.push({ type: 'cite', n: citeNumber(m[2], sources) });
    } else if (m[3] !== undefined) {
      inlines.push({ type: 'cite', n: citeNumber(m[3], sources) });
    } else if (m[4] !== undefined) {
      inlines.push({ type: 'code', text: m[4] });
    } else if (m[5] !== undefined) {
      inlines.push({ type: 'bold', text: m[5] });
    } else if (m[6] !== undefined) {
      inlines.push({ type: 'link', text: m[6], url: m[7] });
    }
  }
  if (last < text.length) inlines.push({ type: 'text', text: text.slice(last) });
  return inlines;
}

function citeNumber(url, sources) {
  let entry = sources.find((s) => s.url === url);
  if (!entry) {
    entry = { n: sources.length + 1, url, label: sourceLabel(url) };
    sources.push(entry);
  }
  return entry.n;
}

/** Human-readable source name: file name if present, else last path segment,
 *  else hostname. */
export function sourceLabel(url) {
  try {
    const u = new URL(url);
    const file = u.searchParams.get('file');
    if (file) return trimLabel(decodeURIComponent(file));
    const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    let seg = segs.pop() || '';
    // A purely numeric tail (ticket/page ids) is meaningless alone — prefix
    // its parent segment: "tickets/106975".
    if (/^\d+$/.test(seg) && segs.length > 0) seg = `${segs.pop()}/${seg}`;
    if (seg.length > 3) return trimLabel(seg.replace(/\+/g, ' '));
    return u.hostname;
  } catch {
    return trimLabel(url);
  }
}

function trimLabel(s) {
  return s.length > 70 ? s.slice(0, 67) + '…' : s;
}

/**
 * @returns {{blocks: Array, sources: Array<{n, url, label}>}}
 * block: {type:'heading'|'para', inlines} | {type:'list', ordered, items:[inlines[]]} | {type:'hr'}
 */
export function parseAnswer(md) {
  const sources = [];
  const blocks = [];
  let para = [];
  let list = null;

  const flushPara = () => {
    const text = para.join(' ').trim();
    if (text) blocks.push({ type: 'para', inlines: parseInline(text, sources) });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  for (const rawLine of String(md || '').split(/\r?\n/)) {
    const line = rawLine.trim();

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    // Astra sometimes emits bullets with no space before a citation:
    // "-(https://…) **AES 128-bit**" — accept "-(" and "-[" as bullets too.
    const bullet = line.match(/^[-*•]\s+(.*)$/) || line.match(/^[-*•]([([].*)$/);
    const numbered = line.match(/^\d+[.)]\s+(.*)$/);

    if (heading) {
      flushPara();
      flushList();
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        inlines: parseInline(heading[2], sources),
      });
    } else if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { type: 'list', ordered, items: [] };
      }
      list.items.push(parseInline((bullet || numbered)[1], sources));
    } else if (/^([-_*]){3,}$/.test(line)) {
      flushPara();
      flushList();
      blocks.push({ type: 'hr' });
    } else if (line === '') {
      flushPara();
      flushList();
    } else if (list) {
      // continuation of the previous list item
      const prev = list.items[list.items.length - 1];
      prev.push({ type: 'text', text: ' ' });
      prev.push(...parseInline(line, sources));
    } else {
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return { blocks, sources };
}

// ---------------------------------------------------------------------------
// DOM rendering (browser only)
// ---------------------------------------------------------------------------

function safeHref(url) {
  return /^https?:\/\//i.test(url) ? url : null;
}

function renderInlines(parent, inlines, sources) {
  for (const inline of inlines) {
    switch (inline.type) {
      case 'text':
        parent.appendChild(document.createTextNode(inline.text));
        break;
      case 'bold': {
        const b = document.createElement('strong');
        b.textContent = inline.text;
        parent.appendChild(b);
        break;
      }
      case 'code': {
        const c = document.createElement('code');
        c.textContent = inline.text;
        parent.appendChild(c);
        break;
      }
      case 'link': {
        const href = safeHref(inline.url);
        if (href) {
          const a = document.createElement('a');
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = inline.text;
          parent.appendChild(a);
        } else {
          parent.appendChild(document.createTextNode(inline.text));
        }
        break;
      }
      case 'cite': {
        const src = sources.find((s) => s.n === inline.n);
        const href = src && safeHref(src.url);
        const chip = document.createElement(href ? 'a' : 'span');
        chip.className = 'cite';
        chip.textContent = inline.n;
        if (href) {
          chip.href = href;
          chip.target = '_blank';
          chip.rel = 'noopener noreferrer';
          chip.title = src.label;
        }
        parent.appendChild(chip);
        break;
      }
    }
  }
}

/** Render an Astra answer (markdown + citations) into `container`. */
export function renderAnswerInto(container, md) {
  const { blocks, sources } = parseAnswer(md);
  container.textContent = '';

  for (const block of blocks) {
    if (block.type === 'heading') {
      const h = document.createElement(block.level <= 3 ? 'h4' : 'h5');
      renderInlines(h, block.inlines, sources);
      container.appendChild(h);
    } else if (block.type === 'list') {
      const listEl = document.createElement(block.ordered ? 'ol' : 'ul');
      for (const item of block.items) {
        const li = document.createElement('li');
        renderInlines(li, item, sources);
        listEl.appendChild(li);
      }
      container.appendChild(listEl);
    } else if (block.type === 'hr') {
      container.appendChild(document.createElement('hr'));
    } else {
      const p = document.createElement('p');
      renderInlines(p, block.inlines, sources);
      container.appendChild(p);
    }
  }

  if (sources.length > 0) {
    const footer = document.createElement('div');
    footer.className = 'sources';
    const title = document.createElement('div');
    title.className = 'sources-title';
    title.textContent = 'Sources';
    footer.appendChild(title);
    for (const src of sources) {
      const row = document.createElement('div');
      row.className = 'source-row';
      const href = safeHref(src.url);
      const a = document.createElement(href ? 'a' : 'span');
      a.textContent = `[${src.n}] ${src.label}`;
      if (href) {
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = src.url;
      }
      row.appendChild(a);
      footer.appendChild(row);
    }
    container.appendChild(footer);
  }
}
