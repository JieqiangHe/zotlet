// zotlet's glue around citeproc-js, run by Rhino (see Js.java). Data crosses the Java/JS
// boundary as JSON strings. Building a citeproc engine is slow in Rhino (seconds for a large
// style such as APA), so engines are kept per style file and reused: citeproc's updateItems
// and rebuildProcessorState re-read every item and start the citation state from scratch.
var ZL = { locale: null, engines: {}, items: {} };

(function () {
  // Rhino pays dearly for citeproc's recursive walk over the whole style to find one macro
  // (CSL.expandMacro). Macros are children of <style>, so look there first; anything else,
  // or a macro not found there, takes the original path.
  var original = CSL.XmlJSON.prototype.getNodesByName;
  CSL.XmlJSON.prototype.getNodesByName = function (myjson, name, nameattrval, ret) {
    if (!ret && name === 'macro' && nameattrval && myjson && myjson.name === 'style' && myjson.children) {
      var kids = myjson.children;
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k && typeof k === 'object' && k.name === 'macro' && k.attrs && k.attrs.name === nameattrval) return [k];
      }
    }
    return original.call(this, myjson, name, nameattrval, ret);
  };
})();

function zlSys() {
  return {
    retrieveLocale: function () { return ZL.locale; },
    retrieveItem: function (id) { return ZL.items[String(id)]; },
  };
}

function zlSetLocale(xml) { ZL.locale = String(xml); }

// A copy of each item (fresh from JSON), with a string id and only object names.
function zlSetItems(list) {
  ZL.items = {};
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    item.id = String(item.id);
    var keys = ['author', 'editor', 'container-author', 'translator'];
    for (var k = 0; k < keys.length; k++) {
      var names = item[keys[k]];
      if (Object.prototype.toString.call(names) === '[object Array]') {
        item[keys[k]] = names.filter(function (n) { return n && typeof n === 'object'; });
      }
    }
    ZL.items[item.id] = item;
  }
}

function zlEngine(key, xml) {
  var engine = ZL.engines[key];
  if (!engine) {
    engine = new CSL.Engine(zlSys(), String(xml), 'en-US', true);
    ZL.engines[key] = engine;
  }
  return engine;
}

function zlForget(key) { delete ZL.engines[key]; }

// Build an engine (so a later call is fast), or check that a style can be read at all.
function zlPrepare(key, xml) { zlEngine(key, xml).setOutputFormat('html'); return 'ok'; }
function zlCheck(xml) { new CSL.Engine(zlSys(), String(xml), 'en-US', true).setOutputFormat('html'); return 'ok'; }

/** The same result as formatCitations in src/citations.js. */
function zlFormat(key, xml, itemsJson) {
  var list = JSON.parse(itemsJson);
  zlSetItems(list);
  var ids = list.map(function (i) { return String(i.id); });
  var engine = zlEngine(key, xml);
  var out = {};
  var formats = ['html', 'text'];
  for (var f = 0; f < formats.length; f++) {
    var format = formats[f];
    engine.setOutputFormat(format);
    engine.updateItems(ids);
    var cluster = engine.makeCitationCluster(ids.map(function (id) { return { id: id }; }));
    var bib = false;
    try { bib = engine.makeBibliography(); } catch (e) { bib = false; }
    var entries = bib ? bib[1].map(function (e) { return e.trim(); }) : [];
    if (format === 'html') {
      out.citation = { html: cluster };
      out.bibliography = { html: entries.length ? '<div class="csl-bib-body">' + entries.join('\n') + '</div>' : '', entries: entries.length };
    } else {
      out.citation.text = cluster.trim();
      out.bibliography.text = entries.join('\n');
    }
  }
  return JSON.stringify(out);
}

/** render() of src/integration.js: [{ citationID: text }, bibliography | false]. */
function zlRender(key, xml, itemsJson, citationsJson, mode) {
  zlSetItems(JSON.parse(itemsJson));
  var engine = zlEngine(key, xml);
  engine.setOutputFormat(mode);
  var out = engine.rebuildProcessorState(JSON.parse(citationsJson), mode);
  var bib = false;
  try { bib = engine.makeBibliography(); } catch (e) { bib = false; }
  var texts = {};
  for (var i = 0; i < out.length; i++) texts[out[i][0]] = out[i][2];
  return JSON.stringify([texts, bib]);
}
