/* ==========================================================================
   UI 组件：Toast / 模态框 / 抽屉 / 分页 / 头像 / 状态标签 / 提示音
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL;
  var U = YL.utils;
  var D = YL.data;
  var esc = U.esc;

  /* ------------------------------------------------------------------
     Toast
     ------------------------------------------------------------------ */
  var TOAST_ICONS = { success: 'check-circle', warn: 'alert-circle', error: 'alert-circle', info: 'info' };

  function toast(message, type, duration) {
    var root = document.getElementById('toastRoot');
    if (!root) return;
    var kind = type || 'info';
    var node = U.el(
      '<div class="toast ' + kind + '" role="status">' +
      YL.icon(TOAST_ICONS[kind] || 'info') +
      '<span class="toast-msg">' + esc(message) + '</span>' +
      '</div>'
    );
    root.appendChild(node);
    var timer = setTimeout(remove, duration || 2800);
    function remove() {
      clearTimeout(timer);
      node.classList.add('out');
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 220);
    }
    node.addEventListener('click', remove);
    return remove;
  }

  /* ------------------------------------------------------------------
     弹层基础（Esc 关闭最上层）
     ------------------------------------------------------------------ */
  var stack = [];

  function lockScroll() {
    document.body.style.overflow = 'hidden';
  }
  function unlockScroll() {
    if (!stack.length) document.body.style.overflow = '';
  }

  function bindOverlay(overlay, api, opts) {
    stack.push(api);
    lockScroll();
    var lastFocus = document.activeElement;

    function close() {
      if (api.closed) return;
      api.closed = true;
      var idx = stack.indexOf(api);
      if (idx >= 0) stack.splice(idx, 1);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      unlockScroll();
      if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* ignore */ } }
      if (opts.onClose) opts.onClose();
    }

    api.close = close;
    api.root = overlay;

    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay && opts.maskClose !== false) close();
    });
    U.qsa('[data-close]', overlay).forEach(function (btn) {
      btn.addEventListener('click', close);
    });

    var body = overlay.querySelector('.modal-body') || overlay.querySelector('.drawer');
    var focusable = U.qsa('input, select, textarea, button, [tabindex]', overlay).filter(function (n) {
      return n.offsetParent !== null && !n.disabled;
    });
    if (focusable.length) {
      setTimeout(function () {
        var first = focusable.filter(function (n) { return n.tagName === 'INPUT'; })[0] || focusable[0];
        if (first) first.focus();
      }, 40);
    }
    return api;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !stack.length) return;
    var top = stack[stack.length - 1];
    if (top && top.close) top.close();
  });

  /* ------------------------------------------------------------------
     模态框
     ------------------------------------------------------------------ */
  function modal(opts) {
    var o = opts || {};
    var size = o.size === 'sm' ? ' modal-sm' : (o.size === 'lg' ? ' modal-lg' : '');
    var overlay = U.el('<div class="overlay" role="dialog" aria-modal="true"></div>');
    overlay.innerHTML =
      '<div class="modal' + size + '">' +
        '<div class="modal-head">' +
          '<div>' +
            '<div class="modal-title">' + esc(o.title || '') + '</div>' +
            (o.desc ? '<div class="modal-desc">' + o.desc + '</div>' : '') +
          '</div>' +
          '<button type="button" class="modal-close" data-close aria-label="关闭">' + YL.icon('x') + '</button>' +
        '</div>' +
        '<div class="modal-body">' + (o.body || '') + '</div>' +
        (o.footer ? '<div class="modal-foot">' + o.footer + '</div>' : '') +
      '</div>';

    document.getElementById('overlayRoot').appendChild(overlay);
    YL.hydrateIcons(overlay);
    var api = bindOverlay(overlay, { opts: o }, o);
    if (o.onMount) o.onMount(api, overlay);
    return api;
  }

  function confirm(opts) {
    var o = opts || {};
    return new Promise(function (resolve) {
      var danger = o.danger === true;
      var api = modal({
        size: 'sm',
        title: '',
        body:
          '<div class="confirm-body">' +
            '<div class="confirm-icon' + (danger ? ' danger' : '') + '">' + YL.icon(danger ? 'alert' : 'info') + '</div>' +
            '<div class="confirm-text"><b>' + esc(o.title || '确认操作') + '</b><p>' + esc(o.message || '') + '</p></div>' +
          '</div>',
        footer:
          '<button type="button" class="btn btn-outline" data-close>' + esc(o.cancelText || '取消') + '</button>' +
          '<button type="button" class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + '" data-ok>' + esc(o.okText || '确定') + '</button>',
        maskClose: o.maskClose !== false,
        onMount: function (api, overlay) {
          overlay.querySelector('[data-ok]').addEventListener('click', function () {
            resolve(true);
            api.close();
          });
        },
        onClose: function () { resolve(false); }
      });
      return api;
    });
  }

  /* ------------------------------------------------------------------
     抽屉
     ------------------------------------------------------------------ */
  function drawer(opts) {
    var o = opts || {};
    var overlay = U.el('<div class="overlay is-drawer" role="dialog" aria-modal="true"></div>');
    overlay.innerHTML =
      '<div class="drawer">' +
        '<div class="modal-head">' +
          '<div>' +
            '<div class="modal-title">' + esc(o.title || '') + '</div>' +
            (o.desc ? '<div class="modal-desc">' + o.desc + '</div>' : '') +
          '</div>' +
          '<button type="button" class="modal-close" data-close aria-label="关闭">' + YL.icon('x') + '</button>' +
        '</div>' +
        '<div class="modal-body">' + (o.body || '') + '</div>' +
        (o.footer ? '<div class="modal-foot">' + o.footer + '</div>' : '') +
      '</div>';
    document.getElementById('overlayRoot').appendChild(overlay);
    YL.hydrateIcons(overlay);
    var api = bindOverlay(overlay, { opts: o }, o);
    if (o.onMount) o.onMount(api, overlay);
    return api;
  }

  /* ------------------------------------------------------------------
     分页
     ------------------------------------------------------------------ */
  function pager(opts) {
    var total = opts.total || 0;
    var size = opts.size || 10;
    var page = opts.page || 1;
    var pages = Math.max(1, Math.ceil(total / size));
    if (page > pages) page = pages;

    var items = [];
    function push(n) {
      items.push('<button type="button" class="page-btn' + (n === page ? ' active' : '') + '" data-page="' + n + '">' + n + '</button>');
    }
    if (pages <= 7) {
      for (var i = 1; i <= pages; i++) push(i);
    } else {
      push(1);
      if (page > 4) items.push('<span class="page-ellipsis">···</span>');
      var start = Math.max(2, page - 2);
      var end = Math.min(pages - 1, page + 2);
      for (var j = start; j <= end; j++) push(j);
      if (page < pages - 3) items.push('<span class="page-ellipsis">···</span>');
      push(pages);
    }

    return '<div class="pagination">' +
      '<div class="page-total">共 <b>' + U.fmt(total) + '</b> 条记录</div>' +
      '<div class="page-list">' +
        '<button type="button" class="page-btn" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + ' aria-label="上一页">' + YL.icon('arrow-left') + '</button>' +
        items.join('') +
        '<button type="button" class="page-btn" data-page="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + ' aria-label="下一页">' + YL.icon('arrow-right') + '</button>' +
      '</div>' +
      '<label class="page-size">每页' +
        '<select data-page-size>' + [10, 20, 50].map(function (n) {
          return '<option value="' + n + '"' + (n === size ? ' selected' : '') + '>' + n + ' 条</option>';
        }).join('') + '</select>' +
      '</label>' +
    '</div>';
  }

  /** 绑定分页容器：点击页码 / 切换每页条数 */
  function bindPager(root, onChange) {
    if (!root) return;
    root.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-page]');
      if (!btn || btn.disabled) return;
      var page = Number(btn.getAttribute('data-page'));
      if (!page) return;
      onChange(page, null);
    });
    root.addEventListener('change', function (e) {
      if (!e.target.matches('[data-page-size]')) return;
      onChange(1, Number(e.target.value));
    });
  }

  /* ------------------------------------------------------------------
     展示片段
     ------------------------------------------------------------------ */
  function tag(text, cls) {
    return '<span class="tag ' + (cls || '') + '">' + esc(text) + '</span>';
  }

  function healthTag(key) {
    var d = D.DICT.health[key] || D.DICT.health.healthy;
    return '<span class="tag ' + d.cls + '"><span class="dot"></span>' + d.text + '</span>';
  }

  function memberTag(key) {
    var d = D.DICT.member[key] || D.DICT.member.ankang;
    return '<span class="tag ' + d.cls + '">' + d.text + '</span>';
  }

  function statusTag(dict, key) {
    var d = dict[key];
    if (!d) return '<span class="tag tag-gray">—</span>';
    return '<span class="tag ' + d.cls + '">' + d.text + '</span>';
  }

  function avatar(elder, sizeCls) {
    if (!elder) return '<span class="avatar ' + (sizeCls || '') + ' x-slate">?</span>';
    return '<span class="avatar ' + (elder.avatarClass || '') + ' ' + (sizeCls || '') + '" aria-hidden="true">' +
      esc(elder.name.slice(0, 1)) + '</span>';
  }

  function person(elder, sub) {
    return '<div class="person">' + avatar(elder) +
      '<div class="person-info"><div class="person-name">' + esc(elder ? elder.name : '—') + '</div>' +
      '<div class="person-meta">' + esc(sub || '') + '</div></div></div>';
  }

  function empty(iconName, title, desc, action) {
    return '<div class="empty">' +
      '<div class="empty-art">' + YL.icon(iconName || 'search') + '</div>' +
      '<b>' + esc(title || '暂无数据') + '</b>' +
      (desc ? '<p>' + esc(desc) + '</p>' : '') +
      (action || '') +
      '</div>';
  }

  function sortTh(key, label, state, extra) {
    var active = state && state.key === key;
    var caret = !active ? '↕' : (state.dir === 'asc' ? '↑' : '↓');
    return '<button type="button" class="th-sort' + (active ? ' active' : '') + '" data-sort="' + key + '">' +
      esc(label) + '<span class="caret">' + caret + '</span></button>' + (extra || '');
  }

  /** 现场照片占位（纯 SVG，不依赖外部图片） */
  function photoThumb(seed, label) {
    var s = seed || 0;
    var skies = ['#E8F1FF', '#FFF3E4', '#EAFBF0', '#F2F0FF'];
    var roofs = ['#8FA8CC', '#D2A06A', '#7FB894', '#A79BC8'];
    var sky = skies[s % skies.length];
    var roof = roofs[s % roofs.length];
    return '<figure class="photo-thumb">' +
      '<svg viewBox="0 0 120 84" preserveAspectRatio="none" aria-hidden="true">' +
        '<rect width="120" height="84" fill="' + sky + '"/>' +
        '<path d="M0 62h120v22H0z" fill="#DCE5D8"/>' +
        '<path d="M26 50 44 36l18 14v20H26z" fill="#F4F6FB" stroke="#C9D3E3" stroke-width="1"/>' +
        '<path d="M23 50 44 34l21 16z" fill="' + roof + '" opacity=".85"/>' +
        '<rect x="39" y="54" width="8" height="16" fill="#C6D2E4"/>' +
        '<path d="M86 52c0-8 5-13 5-13s5 5 5 13-5 8-5 8-5 0-5-8Z" fill="#9CC4A8" opacity=".8"/>' +
        '<path d="M91 60v14" stroke="#8AA894" stroke-width="1.5"/>' +
      '</svg>' +
      '<figcaption>' + esc(label || '服务现场') + '</figcaption>' +
    '</figure>';
  }

  /* ------------------------------------------------------------------
     交互辅助
     ------------------------------------------------------------------ */
  function copyText(text) {
    var value = String(text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value).then(function () {
        toast('已复制到剪贴板', 'success');
        return true;
      }).catch(function () { return legacyCopy(value); });
    }
    return Promise.resolve(legacyCopy(value));
  }

  function legacyCopy(value) {
    var ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择号码', ok ? 'success' : 'warn');
    return ok;
  }

  function phoneModal(phone, name, relation) {
    var display = String(phone || '').replace(/(\d{3})(\d{4})(\d{4})/, '$1 $2 $3');
    modal({
      size: 'sm',
      title: '联系家属',
      desc: (name || '') + (relation ? ' · ' + relation : ''),
      body:
        '<div style="text-align:center;padding:8px 0 4px">' +
          '<div class="num" style="font-size:30px;font-weight:600;letter-spacing:1px">' + esc(display || '—') + '</div>' +
          '<p class="t3 t-sm" style="margin-top:6px">通话记录将同步至老人档案的服务台账</p>' +
        '</div>',
      footer:
        '<button type="button" class="btn btn-outline" data-close>关闭</button>' +
        '<button type="button" class="btn btn-primary" data-copy>' + YL.icon('file-text') + '复制号码</button>' +
        '<a class="btn btn-soft" href="tel:' + esc(phone) + '">' + YL.icon('phone') + '一键拨号</a>',
      onMount: function (api, overlay) {
        overlay.querySelector('[data-copy]').addEventListener('click', function () {
          copyText(phone);
        });
      }
    });
  }

  /* ------------------------------------------------------------------
     提示音：WebAudio 合成，无外部音频依赖
     ------------------------------------------------------------------ */
  var audioCtx = null;

  function playSound(kind) {
    if (!YL.store || !YL.store.state.sound) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t = audioCtx.currentTime;
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = 'sine';
      var base = kind === 'critical' ? 884 : 660;
      osc.frequency.setValueAtTime(base, t);
      osc.frequency.setValueAtTime(base * 1.34, t + 0.15);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.07, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.46);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.5);
    } catch (e) { /* 浏览器限制时静默降级 */ }
  }

  /* ------------------------------------------------------------------
     表单辅助
     ------------------------------------------------------------------ */
  function formData(form) {
    var data = {};
    U.qsa('[name]', form).forEach(function (node) {
      if (node.type === 'checkbox') data[node.name] = node.checked;
      else if (node.type === 'radio') { if (node.checked) data[node.name] = node.value; }
      else data[node.name] = node.value.trim();
    });
    return data;
  }

  function fieldError(form, name, message) {
    var field = form.querySelector('[name="' + name + '"]');
    if (!field) return;
    var wrap = field.closest('.field');
    if (!wrap) return;
    var err = wrap.querySelector('.field-error');
    if (!err) {
      err = document.createElement('p');
      err.className = 'field-error';
      wrap.appendChild(err);
    }
    if (message) {
      err.innerHTML = YL.icon('alert-circle') + '<span>' + esc(message) + '</span>';
      err.hidden = false;
      var inputWrap = field.closest('.input-wrap');
      if (inputWrap) inputWrap.classList.add('is-error');
    } else {
      err.hidden = true;
      err.textContent = '';
      var iw = field.closest('.input-wrap');
      if (iw) iw.classList.remove('is-error');
    }
  }

  function clearErrors(form) {
    U.qsa('.field-error', form).forEach(function (n) { n.hidden = true; n.textContent = ''; });
    U.qsa('.is-error', form).forEach(function (n) { n.classList.remove('is-error'); });
  }

  global.YL.ui = {
    toast: toast,
    modal: modal,
    confirm: confirm,
    drawer: drawer,
    pager: pager,
    bindPager: bindPager,
    tag: tag,
    healthTag: healthTag,
    memberTag: memberTag,
    statusTag: statusTag,
    avatar: avatar,
    person: person,
    empty: empty,
    sortTh: sortTh,
    photoThumb: photoThumb,
    copyText: copyText,
    phoneModal: phoneModal,
    playSound: playSound,
    formData: formData,
    fieldError: fieldError,
    clearErrors: clearErrors
  };
})(window);