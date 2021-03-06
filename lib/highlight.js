'use strict';

const htmlparser = require('htmlparser2'),
  render = require('dom-serializer'),
  domUtils = require('domutils'),
  traverse = require('./traverse'),
  entities = require('entities'),
  Match = require('./match');

/**
 * Pre-order traversal that retrieves the text content 
 * @param {DOM Array} dom - see: https://github.com/fb55/htmlparser2
 * @returns {String} Text content of dom
 */
const getText = (dom) => {
  let text = '';
  traverse(dom, ({type, data, parent}) => {
    parent = parent || {};
    if (type === 'text' && parent.type !== 'script' && data) {
      text += data;
    }
  });
  return text;
};

// http://stackoverflow.com/questions/3561493/is-there-a-regexp-escape-function-in-javascript
function escape(s) {
    return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
};

/**
 * Finds all matches of query in text 
 * @param {String} query - search term
 * @param {String} text - text content to search
 * @returns {Array} Array of match objects: text and start, end values
 */
const findMatches = (query, text, decoded) => {
  const matches = [];
  const entitiesList = [];
  let q = escape(query);
  let target = text;
  if (text.length !== decoded.length) {
    q = q.replace(/ /g, '\\s');
    target = decoded;
    const regx = new RegExp(/&([A-Za-z]+|#x[\dA-Fa-f]+|#\d+);/, 'ig');
    let found;
    while ((found = regx.exec(text)) !== null) {
      const entity = {
        text: found.input.substring(found.index, regx.lastIndex),
        start: { index: found.index },
        end: { index: regx.lastIndex },
        get decoded () {
          return entities.decodeHTML(this.text);
        }
      };
      entitiesList.push(entity);
    }
  }
  const regex = new RegExp(q, 'ig');
  let found;
  while ((found = regex.exec(target)) !== null) {
    const match = new Match({
      text: found.input.substring(found.index, regex.lastIndex),
      start: { index: found.index },
      end: { index: regex.lastIndex }
    });
    matches.push(match);
  }
  entitiesList.forEach( entity => {
    matches.forEach( match => {
      if(entity.start.index <= match.start.index) {
        match.keys.forEach( key => {
          match[key].index += (entity.text.length - 1);
        });
      } else if(entity.start.index > match.start.index && (entity.end.index <= match.end.index || entity.end.index <= (match.end.index + entity.text.length -1))) {
        match.end.index += (entity.text.length - 1);
      }
    });
  });
  return matches;
};

const isCurrentNode = (type, length, index) => {
  return type === 'start' ? (length > index) : (length >= index);
};
/**
 * Attaches corresponding node to each matched index 
 */
const determineNodes = (matches, dom) => {
  let text = '';
  let i = 0;
  traverse(dom, (node) => {
    const parent = node.parent || {};
    let match = matches[i];
    if (node.type !== 'text' || parent.type === 'script' || !node.data || !match) {
      return;
    }
    let checkNextNode = false;
    let nodeStart = text.length;
    text += node.data;
    let nodeEnd = text.length;
    while (match && !checkNextNode) {
      let prevMatch = matches[i - 1] || { end: { index: nodeStart } };
      let nextMatch = matches[i + 1] || { start: { index: nodeEnd } };
      match.keys.forEach(key => {
        if (!match[key].node && isCurrentNode(key, text.length, match[key].index)) {
          match[key].node = node;
          let index = match[key].index - nodeStart;
          let adjustedStartIndex = prevMatch.end.index - nodeStart;
          adjustedStartIndex = adjustedStartIndex > 0 ? adjustedStartIndex : 0;
          match[key].data = {
            prev: node.data.substring(adjustedStartIndex, index),
            next: node.data.substring(index, nextMatch.start.index - nodeStart)
          };
        }
      });

      if (match.start.node && match.end.node) {
        let node = match.end.node.prev;
        while (node && node !== match.start.node) {
          match.intermediate = match.intermediate || [];
          match.intermediate.unshift(node);
          node = node.prev;
        }
        i++;
        match = matches[i];
      } else {
        checkNextNode = true;
      }
    }
  });
};

/**
 * highlight.js
 * 
 * @param {String} query - text to highlight in html content
 * @param {String} html - HTML content.
 * @param {Object} [options] - Parser and serializer options
 */
const highlight = (query, html, {parser = {}, serializer = {}} = {}) => {
  if(!query) {
    return html;
  }
  const dom = htmlparser.parseDOM(html, parser);
  const text = getText(dom);
  const decoded = entities.decodeHTML(text);
  const matches = findMatches(query, text, decoded);
  if(!matches.length) {
    return html;
  }
  determineNodes(matches, dom);
  const toRemove = new Set();
  matches.forEach((match, i) => {
    if (match.start.node === match.end.node) {
      const node = match.start.node;
      const parent = node.parent || null;
      const container = parent ? parent.children : dom;
      const mark = match.mark;
      const prev = match.prev;
      mark.children.forEach( child => {child.parent = mark;});
      let index = container.findIndex( (child) => (child === node));
      container.splice(index, 0, prev, mark, match.next);
      const lastMatch = matches[i - 1];
      if(lastMatch && node === lastMatch.start.node) {
        container.splice(index, 1);
      }
      toRemove.add(node);
    } else {
      match.keys.forEach(key => {
        const parent = match[key].node.parent || null;
        const container = parent ? parent.children : dom;
        let index = container.findIndex( (node) => (node === match[key].node));
        key === 'start' && container.splice(index + 1, 0, match.prev, match.markStart);
        key === 'end' && container.splice(index, 0, match.markEnd, match.next);
        toRemove.add(match[key].node);
      });
      
      traverse(match.intermediate, (node) => {
        if (node.type === 'text' && node.data) {
          let mark = {
            type: 'tag',
            name: 'mark',
            attribs: {},
            children: [node],
            next: match.end.node,
            prev: null,
            parent: node.parent
          };
          domUtils.replaceElement(node, mark);
        }
      });
    }
  });
  toRemove.forEach( node => {
    if(node.parent) {
      domUtils.removeElement(node);
    } else {
      const index = dom.findIndex( item => (item === node));
      dom.splice(index, 1);
    }
  });

  return render(dom, serializer);
};

module.exports = highlight;