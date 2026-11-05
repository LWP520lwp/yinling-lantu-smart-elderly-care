/* ==========================================================================
   通用工具：DOM / 格式化 / 伪随机 / 下载 / 动画
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL = global.YL || {};

  /* ---------------- DOM ---------------- */
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = String(html).trim();
    return tpl.content.firstElementChild;
  }

  function on(root, type, sel, fn) {
    (root || document).addEventListener(type, function (e) {
      var target = e.target.closest(sel);
      if (target && root.contains(target)) fn.call(target, e, target);
    });
  }

  function delegate(root, type, sel, fn) { on(root, type, sel, fn); }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /* ---------------- 数字 / 文本 ---------------- */
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function num(n, digits) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var d = digits || 0;
    return Number(n).toLocaleString('zh-CN', {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    });
  }

  /** 千分位 + 固定小数（不依赖 locale，保证展示稳定） */
  function fmt(n, digits) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var d = digits || 0;
    var fixed = Number(n).toFixed(d);
    var parts = fixed.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  function pct(n, digits) {
    return fmt(n, digits === undefined ? 1 : digits) + '%';
  }

  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  /* ---------------- 日期 ---------------- */
  var WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  function toDate(v) { return v instanceof Date ? v : new Date(v); }

  function fmtDate(v, pattern) {
    var d = toDate(v);
    if (isNaN(d.getTime())) return '—';
    var p = pattern || 'YYYY-MM-DD HH:mm';
    var map = {
      YYYY: d.getFullYear(),
      MM: pad2(d.getMonth() + 1),
      DD: pad2(d.getDate()),
      HH: pad2(d.getHours()),
      mm: pad2(d.getMinutes()),
      ss: pad2(d.getSeconds())
    };
    return p.replace(/YYYY|MM|DD|HH|mm|ss/g, function (k) { return map[k]; });
  }

  function fmtDateCN(d) {
    d = toDate(d);
    return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · ' + WEEK[d.getDay()];
  }

  function fmtClock(d) { return fmtDate(d, 'HH:mm:ss'); }

  function relTime(v, now) {
    var t = toDate(v).getTime();
    var base = (now || Date.now());
    var diff = Math.max(0, base - t);
    var min = 60 * 1000, hour = 60 * min, day = 24 * hour;
    if (diff < min) return '刚刚';
    if (diff < hour) return Math.floor(diff / min) + ' 分钟前';
    if (diff < day) return Math.floor(diff / hour) + ' 小时前';
    if (diff < 2 * day) return '昨天 ' + fmtDate(t, 'HH:mm');
    if (diff < 7 * day) return Math.floor(diff / day) + ' 天前';
    return fmtDate(t, 'MM-DD HH:mm');
  }

  function daysAgo(n, h, m) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    d.setHours(h === undefined ? 9 : h, m === undefined ? 0 : m, 0, 0);
    return d.getTime();
  }

  function daysFromNow(n) {
    var d = new Date();
    d.setDate(d.getDate() + n);
    return d;
  }

  function ageFromBirth(year, month, day) {
    var now = new Date();
    var age = now.getFullYear() - year;
    var cur = (now.getMonth() + 1) * 100 + now.getDate();
    if (cur < month * 100 + day) age--;
    return age;
  }

  /* ---------------- 脱敏 ---------------- */
  function maskIdCard(id) {
    if (!id || id.length < 10) return id || '—';
    return id.slice(0, 6) + '********' + id.slice(-4);
  }

  function maskPhone(p) {
    if (!p || p.length < 7) return p || '—';
    return p.slice(0, 3) + '****' + p.slice(-4);
  }

  /* ---------------- 伪随机（固定种子，保证每次打开数据一致） ---------------- */
  function rng(seed) {
    var s = (seed >>> 0) || 20261103;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function randInt(r, min, max) { return Math.floor(r() * (max - min + 1)) + min; }
  function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }
  function pickMany(r, arr, n) {
    var pool = arr.slice();
    var out = [];
    while (out.length < n && pool.length) {
      out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
    }
    return out;
  }
  function round(n, d) {
    var p = Math.pow(10, d || 0);
    return Math.round(n * p) / p;
  }

  /* ---------------- 下载 ---------------- */
  function download(filename, content, mime) {
    var blob = new Blob(['\ufeff' + content], { type: mime || 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1200);
  }

  function csvCell(v) {
    var s = String(v === null || v === undefined ? '' : v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCSV(headers, rows) {
    var lines = [headers.map(csvCell).join(',')];
    rows.forEach(function (row) { lines.push(row.map(csvCell).join(',')); });
    return lines.join('\r\n');
  }

  /* ---------------- 动画 / 交互辅助 ---------------- */
  function countUp(node, to, opts) {
    if (!node) return;
    var o = opts || {};
    var from = o.from === undefined ? 0 : o.from;
    var dur = o.duration || 780;
    var digits = o.digits || 0;
    var prefix = o.prefix || '';
    var suffix = o.suffix || '';
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      node.textContent = prefix + fmt(to, digits) + suffix;
      return;
    }
    var start = performance.now();
    var raf;
    function step(now) {
      var p = clamp((now - start) / dur, 0, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      var cur = from + (to - from) * eased;
      node.textContent = prefix + fmt(cur, digits) + suffix;
      if (p < 1) raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return function cancel() { cancelAnimationFrame(raf); };
  }

  function stagger(root, selector, delay) {
    qsa(selector || '.page > *', root || document).forEach(function (node, i) {
      node.style.animation = 'yl-fade-up .38s cubic-bezier(.16,1,.3,1) both';
      node.style.animationDelay = ((i * (delay || 55)) + 'ms');
    });
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait || 260);
    };
  }

  function scrollTop(node) {
    if (node) node.scrollTop = 0;
    var view = document.getElementById('view');
    if (view) view.scrollTop = 0;
  }

  /* ---------------- 存储 ---------------- */
  var store = {
    get: function (k, fallback) {
      try {
        var raw = localStorage.getItem(k);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) { return fallback; }
    },
    set: function (k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ }
    },
    remove: function (k) {
      try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
    }
  };

  function escapeAttr(s) { return esc(s).replace(/`/g, '&#96;'); }

  YL.utils = {
    qs: qs, qsa: qsa, el: el, on: on, delegate: delegate, esc: esc, escapeAttr: escapeAttr,
    clear: clear, pad2: pad2, num: num, fmt: fmt, pct: pct, clamp: clamp,
    fmtDate: fmtDate, fmtDateCN: fmtDateCN, fmtClock: fmtClock, relTime: relTime,
    daysAgo: daysAgo, daysFromNow: daysFromNow, ageFromBirth: ageFromBirth, WEEK: WEEK,
    maskIdCard: maskIdCard, maskPhone: maskPhone,
    rng: rng, randInt: randInt, pick: pick, pickMany: pickMany, round: round,
    download: download, toCSV: toCSV, csvCell: csvCell,
    countUp: countUp, stagger: stagger, debounce: debounce, scrollTop: scrollTop,
    store: store
  };
})(window);