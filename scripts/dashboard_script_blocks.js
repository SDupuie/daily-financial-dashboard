// Private, read-only dashboard HTML scanner shared by validation, update,
// fetch, local-refresh, and publish paths. It returns active element/script
// records with normalized attributes and source positions; it performs no I/O.
function decodeHtmlAttributeValue(value) {
  return String(value)
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (_match, hex, decimal) => {
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : '\ufffd';
    })
    .replace(/&(amp|quot|apos|lt|gt);/gi, (_match, name) => ({
      amp: '&', quot: '"', apos: "'", lt: '<', gt: '>'
    })[name.toLowerCase()]);
}

function parseHtmlAttributes(attributeSource) {
  const attributes = {};
  const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of attributeSource.matchAll(attributePattern)) {
    const attributeName = match[1].toLowerCase();
    if (!(attributeName in attributes)) {
      attributes[attributeName] = decodeHtmlAttributeValue(match[2] ?? match[3] ?? match[4] ?? '');
    }
  }
  return attributes;
}

function htmlTagCloseIndex(html, openIndex) {
  let quote = '';
  for (let index = openIndex + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function matchingCloseTag(html, tagName, startIndex) {
  const pattern = new RegExp(`</${tagName}\\s*>`, 'gi');
  pattern.lastIndex = startIndex;
  return pattern.exec(html);
}

function hasInertAncestor(stack) {
  return stack.some((element) => element.inert);
}

function scanHtml(html, options = {}) {
  const activeOnly = options.activeOnly !== false;
  const scripts = [];
  const elements = [];
  const stack = [];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const inertTags = new Set(['iframe', 'noembed', 'noscript', 'plaintext', 'style', 'template', 'textarea', 'title', 'xmp']);
  let cursor = 0;

  while (cursor < html.length) {
    const openIndex = html.indexOf('<', cursor);
    if (openIndex < 0) break;
    if (html.startsWith('<!--', openIndex)) {
      const commentEnd = html.indexOf('-->', openIndex + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    const closing = html[openIndex + 1] === '/';
    const nameOffset = openIndex + (closing ? 2 : 1);
    const nameMatch = html.slice(nameOffset).match(/^([A-Za-z][A-Za-z0-9:-]*)/);
    if (!nameMatch) {
      cursor = openIndex + 1;
      continue;
    }
    const closeIndex = htmlTagCloseIndex(html, openIndex);
    if (closeIndex < 0) break;
    const name = nameMatch[1].toLowerCase();
    if (closing) {
      const matchingIndex = stack.map((element) => element.name).lastIndexOf(name);
      if (matchingIndex >= 0) stack.length = matchingIndex;
      cursor = closeIndex + 1;
      continue;
    }

    const attributes = parseHtmlAttributes(html.slice(nameOffset + nameMatch[1].length, closeIndex));
    const active = !hasInertAncestor(stack);
    const element = {
      index: openIndex,
      openEnd: closeIndex + 1,
      end: closeIndex + 1,
      active,
      name,
      attributes,
      id: attributes.id || '',
      parentIndex: stack.length ? stack[stack.length - 1].elementIndex : -1
    };
    if (name === 'script') {
      const endMatch = matchingCloseTag(html, 'script', closeIndex + 1);
      const contentEnd = endMatch ? endMatch.index : html.length;
      const end = endMatch ? endMatch.index + endMatch[0].length : html.length;
      element.end = end;
      if (active || !activeOnly) {
        elements.push(element);
        scripts.push({
          ...element,
          contentStart: closeIndex + 1,
          contentEnd,
          type: String(attributes.type || '').trim().toLowerCase(),
          content: html.slice(closeIndex + 1, contentEnd)
        });
      }
      cursor = end;
      continue;
    }

    let elementIndex = -1;
    if (active || !activeOnly) {
      elementIndex = elements.length;
      elements.push(element);
    }
    if (!voidTags.has(name)) {
      stack.push({
        name,
        inert: inertTags.has(name) || hasInertAncestor(stack),
        elementIndex
      });
    }
    cursor = closeIndex + 1;
  }
  return { elements, scripts };
}

function blocksWithId(blocks, id) {
  return blocks.filter((block) => block.id === id);
}

function elementsWithId(elements, id) {
  return elements.filter((element) => element.id === id);
}

function singleScriptBlockById(html, id, options = {}) {
  const { elements, scripts } = scanHtml(html);
  const matchingElements = elementsWithId(elements, id);
  if (matchingElements.length !== 1) {
    throw new Error(`Could not find exactly one active #${id} element; found ${matchingElements.length}.`);
  }
  if (matchingElements[0].name !== 'script') {
    throw new Error(`#${id} must be a <script>; found <${matchingElements[0].name}>.`);
  }
  const block = blocksWithId(scripts, id)[0];
  if (options.type && block.type !== options.type) {
    throw new Error(`${id} script block must use type="${options.type}".`);
  }
  return block;
}

module.exports = {
  blocksWithId,
  elementsWithId,
  scanHtml,
  singleScriptBlockById
};
