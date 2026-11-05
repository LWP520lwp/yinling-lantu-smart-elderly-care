/* ==========================================================================
   极简 Hash 路由：支持 /path/:id 与 query
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL;
  var routes = [];
  var currentRoute = null;

  function register(pattern, handler) {
    routes.push({
      pattern: pattern,
      parts: pattern.split('/').filter(Boolean),
      handler: handler
    });
  }

  function parseQuery(str) {
    var query = {};
    if (!str) return query;
    str.split('&').forEach(function (pair) {
      if (!pair) return;
      var idx = pair.indexOf('=');
      var k = idx >= 0 ? pair.slice(0, idx) : pair;
      var v = idx >= 0 ? pair.slice(idx + 1) : '';
      query[decodeURIComponent(k)] = decodeURIComponent(v);
    });
    return query;
  }

  function parseHash() {
    var raw = location.hash.replace(/^#/, '');
    if (!raw) raw = '/overview';
    var qi = raw.indexOf('?');
    var path = qi >= 0 ? raw.slice(0, qi) : raw;
    var query = parseQuery(qi >= 0 ? raw.slice(qi + 1) : '');
    if (path.charAt(0) !== '/') path = '/' + path;
    return { path: path, query: query, raw: raw };
  }

  function match(path) {
    var segs = path.split('/').filter(Boolean);
    for (var i = 0; i < routes.length; i++) {
      var r = routes[i];
      if (r.parts.length !== segs.length) continue;
      var params = {};
      var ok = true;
      for (var j = 0; j < r.parts.length; j++) {
        var p = r.parts[j];
        if (p.charAt(0) === ':') {
          params[p.slice(1)] = decodeURIComponent(segs[j]);
        } else if (p !== segs[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route: r, params: params };
    }
    return null;
  }

  function resolve() {
    var info = parseHash();
    var found = match(info.path);
    currentRoute = {
      path: info.path,
      query: info.query,
      params: found ? found.params : {},
      route: found ? found.route : null,
      raw: info.raw
    };
    return currentRoute;
  }

  function go(path, replace) {
    var target = '#' + path;
    if (replace) {
      location.replace(target);
      return;
    }
    if (location.hash === target) resolve();
    else location.hash = target;
  }

  function start(onChange) {
    window.addEventListener('hashchange', function () {
      onChange(resolve());
    });
    onChange(resolve());
  }

  function current() { return currentRoute; }

  global.YL.router = {
    register: register,
    resolve: resolve,
    start: start,
    go: go,
    current: current
  };
})(window);