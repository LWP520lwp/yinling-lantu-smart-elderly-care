/* ==========================================================================
   应用外壳：登录切换 / 导航 / 权限 / 路由分发 / 顶栏交互 / 实时告警
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL;
  var U = YL.utils;
  var UI = YL.ui;
  var S = YL.store;
  var D = YL.data;

  var routerStarted = false;
  var realtimeTimer = null;
  var lastSimulated = 0;
  var lastPageKey = null;

  /* ------------------------------------------------------------------
     导航配置
     ------------------------------------------------------------------ */
  var ADMIN_NAV = [
    {
      group: '运营中枢',
      items: [{ key: 'overview', label: '系统总览', icon: 'dashboard', path: '/overview' }]
    },
    {
      group: '养老服务',
      items: [
        { key: 'elders', label: '老人档案', icon: 'users', path: '/elders' },
        { key: 'devices', label: '智能设备', icon: 'watch', path: '/devices' },
        { key: 'alerts', label: '应急告警', icon: 'alert', path: '/alerts', badge: true },
        { key: 'orders', label: '服务工单', icon: 'clipboard', path: '/orders' }
      ]
    },
    {
      group: '决策支持',
      items: [
        { key: 'reports', label: '数据报表', icon: 'chart', path: '/reports' },
        { key: 'ai', label: 'AI 健康分析', icon: 'spark', path: '/ai' }
      ]
    },
    {
      group: '系统管理',
      items: [{ key: 'settings', label: '系统设置', icon: 'settings', path: '/settings' }]
    }
  ];

  var FAMILY_NAV = [
    {
      group: '我的家人',
      items: [
        { key: 'family', label: '健康详情', icon: 'heart', path: '/family' },
        { key: 'family', label: '体征档案', icon: 'activity', path: '/family?tab=vitals' },
        { key: 'family', label: '告警记录', icon: 'alert', path: '/family?tab=alerts' },
        { key: 'family', label: '服务记录', icon: 'clipboard', path: '/family?tab=orders' },
        { key: 'family', label: '设备状态', icon: 'watch', path: '/family?tab=device' }
      ]
    }
  ];

  var PAGE_ACCESS = {
    overview: 'overview', elders: 'elders', devices: 'devices', alerts: 'alerts',
    orders: 'orders', reports: 'reports', ai: 'ai', settings: 'settings', family: 'family'
  };

  /* ------------------------------------------------------------------
     登录 / 登出视图切换
     ------------------------------------------------------------------ */
  function showApp() {
    document.getElementById('authView').hidden = true;
    document.getElementById('appView').hidden = false;
    document.body.classList.add('is-app');
    applySession();
  }

  function showAuth() {
    document.getElementById('appView').hidden = true;
    document.getElementById('authView').hidden = false;
    document.body.classList.remove('is-app');
    YL.charts.disposeAll();
    YL.hydrateIcons(document.getElementById('authView'));
    YL.auth.refreshCaptcha();
  }

  function defaultHome() {
    return S.role() === 'family' ? '/family' : '/overview';
  }

  function enterApp() {
    showApp();
    var home = defaultHome();
    var current = location.hash.replace(/^#/, '');
    if (!current || current === '/') {
      YL.router.go(home, true);
    }
    if (!routerStarted) {
      routerStarted = true;
      YL.router.start(onRoute);
    } else {
      onRoute(YL.router.resolve());
    }
    startRealtime();
  }

  /**
   * 进入工作台：展示外壳 → 落地默认路由 → 启动路由与实时链路。
   * 登录成功回调与 boot() 的会话校验共用，保证两条路径行为一致。
   */
  function launchApp() {
    showApp();
    var home = defaultHome();
    var raw = location.hash.replace(/^#/, '');
    if (!raw || raw === '/') {
      YL.router.go(home, true);
    }
    routerStarted = true;
    YL.router.start(onRoute);
    startRealtime();
  }

  /** 401 处理去重时间戳：api.js 与 boot 校验可能先后上报同一次失效 */
  var lastUnauthorizedAt = 0;

  /**
   * 登录态失效：由 api.js 收到 401 后调用（此时本地会话可能已被其清理）。
   * 统一收敛为「断开实时链路 → 清会话 → 回登录页 → 提示重新登录」，
   * 避免停留在所有请求都会 401 的残缺工作台上。
   */
  function handleUnauthorized() {
    // 同一次失效只处理一次（api.js 内部已调用过一次，boot 的 catch 还会再报告）
    var now = Date.now();
    if (now - lastUnauthorizedAt < 1500) return;
    lastUnauthorizedAt = now;

    stopRealtime();
    S.logout();
    showAuth();
    UI.toast('登录状态已失效，请重新登录', 'warn', 2600);
  }

  function exitApp() {
    stopRealtime();
    // 审计上报依赖 token，必须赶在清理会话之前发出；失败由 api.audit 内部静默
    if (YL.api && typeof YL.api.audit === 'function') {
      try { YL.api.audit('logout', { result: 'ok', target_type: 'session' }); } catch (e) { /* 审计失败不影响退出 */ }
    }
    // 通知 api 层清理会话（实现只清本地存储，不发起网络请求，可安全调用）
    if (YL.api && typeof YL.api.logout === 'function') {
      try { YL.api.logout(); } catch (e) { /* 清理异常不影响退出流程 */ }
    }
    S.logout();
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.search);
    else location.hash = '';
    showAuth();
    UI.toast('已安全退出登录', 'success');
  }

  /* ------------------------------------------------------------------
     会话应用：导航 / 顶栏 / 徽标
     ------------------------------------------------------------------ */
  function applySession() {
    var conf = S.roleConf();
    document.getElementById('userName').textContent = conf.name;
    document.getElementById('userRole').textContent = conf.label;
    document.getElementById('userAvatar').textContent = conf.name.slice(0, 1);
    document.getElementById('ddName').textContent = conf.name;
    document.getElementById('ddScope').textContent = conf.scope;

    U.qsa('#roleSwitch button').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-role') === S.role());
    });

    renderNav();
    refreshBadge();
  }

  function renderNav() {
    var nav = document.getElementById('sidebarNav');
    var isFamily = S.role() === 'family';
    var conf = S.roleConf();
    var menu = isFamily ? FAMILY_NAV : ADMIN_NAV;
    var activeKey = activeNavKey();
    var html = '';

    menu.forEach(function (group) {
      var items = group.items.filter(function (item) {
        if (isFamily) return true;
        return conf.perms.indexOf(item.key) !== -1;
      });
      if (!items.length) return;
      html += '<div class="nav-group">';
      html += '<div class="nav-group-title">' + U.esc(group.group) + '</div>';
      items.forEach(function (item) {
        var active = item.key === activeKey && (!isFamily || isFamilyTabActive(item.path));
        var badge = '';
        if (item.badge) {
          var n = S.pendingAlertCount();
          if (n > 0) badge = '<span class="nav-badge">' + n + '</span>';
        }
        html += '<a class="nav-item' + (active ? ' active' : '') + '" href="#' + item.path + '" data-nav-key="' + item.key + '">' +
          YL.icon(item.icon) +
          '<span class="nav-label">' + U.esc(item.label) + '</span>' +
          badge +
          '</a>';
      });
      html += '</div>';
    });
    nav.innerHTML = html;
  }

  function isFamilyTabActive(path) {
    var cur = location.hash.replace(/^#/, '');
    return cur === path;
  }

  function activeNavKey() {
    var route = YL.router.current();
    var path = route ? route.path : (location.hash.replace(/^#/, '').split('?')[0] || '/overview');
    if (path.indexOf('/family') === 0) return 'family';
    var seg = path.split('/').filter(Boolean)[0] || 'overview';
    return seg;
  }

  function refreshBadge() {
    var badge = document.getElementById('alertBadge');
    var n = S.pendingAlertCount();
    if (badge) {
      badge.textContent = n > 99 ? '99+' : n;
      badge.hidden = n === 0;
    }
    var navBadge = document.querySelector('.nav-item[data-nav-key="alerts"] .nav-badge');
    if (navBadge) {
      navBadge.textContent = n;
    }
    var iot = document.getElementById('iotStatus');
    if (iot) {
      var online = D.SUMMARY.deviceOnline;
      iot.querySelector('em').textContent = U.fmt(online) + ' 台设备在线';
    }
  }

  /* ------------------------------------------------------------------
     路由
     ------------------------------------------------------------------ */
  function registerRoutes() {
    YL.router.register('/overview', 'overview');
    YL.router.register('/elders', 'elders');
    YL.router.register('/elders/:id', 'elders');
    YL.router.register('/devices', 'devices');
    YL.router.register('/devices/:id', 'devices');
    YL.router.register('/alerts', 'alerts');
    YL.router.register('/orders', 'orders');
    YL.router.register('/orders/:id', 'orders');
    YL.router.register('/reports', 'reports');
    YL.router.register('/ai', 'ai');
    YL.router.register('/settings', 'settings');
    YL.router.register('/family', 'family');
  }

  function onRoute(route) {
    if (!route || !route.route) {
      renderNotFound();
      return;
    }
    var key = route.route.handler;
    var perm = PAGE_ACCESS[key] || key;

    if (!S.can(perm)) {
      UI.toast('当前角色无权访问该页面，已返回工作台', 'warn');
      YL.router.go(defaultHome(), true);
      return;
    }

    if (lastPageKey && YL.pages[lastPageKey] && typeof YL.pages[lastPageKey].destroy === 'function') {
      try { YL.pages[lastPageKey].destroy(); } catch (e) { /* 忽略清理异常 */ }
    }

    YL.charts.disposeAll();
    var view = document.getElementById('view');
    U.clear(view);
    U.scrollTop(view);

    renderCrumb(route, key);

    var page = YL.pages && YL.pages[key];
    if (!page || typeof page.render !== 'function') {
      view.innerHTML = '<div class="page">' + UI.empty('alert-circle', '页面模块未加载', '请刷新页面重试。') + '</div>';
      return;
    }

    try {
      page.render(view, route);
    } catch (err) {
      view.innerHTML = '<div class="page">' + UI.empty('alert-circle', '页面渲染失败', String(err.message || err)) + '</div>';
      if (window.console) console.error(err);
    }

    renderNav();
    refreshBadge();
    lastPageKey = key;
    document.title = documentTitle(route, key);
    view.focus({ preventScroll: true });
  }

  function renderCrumb(route, key) {
    var el = document.getElementById('breadcrumb');
    if (!el) return;
    var parts = [];
    var path = route.path;

    if (key === 'family') {
      parts = ['我的家人', '健康详情'];
    } else if (key === 'elders' && route.params.id) {
      var elder = D.ELDER_MAP[route.params.id];
      // 非管理员（如社工）面包屑只展示脱敏姓名，管理员展示原文
      var crumbName = elder ? (U.canSeeRaw() ? elder.name : U.maskName(elder.name)) : '档案详情';
      parts = ['养老服务', '老人档案', crumbName];
    } else if (key === 'devices' && route.params.id) {
      parts = ['养老服务', '智能设备', route.params.id];
    } else if (key === 'orders' && route.params.id) {
      parts = ['养老服务', '服务工单', '工单详情'];
    } else {
      var map = {
        overview: ['运营中枢', '系统总览'],
        elders: ['养老服务', '老人档案'],
        devices: ['养老服务', '智能设备'],
        alerts: ['养老服务', '应急告警中心'],
        orders: ['养老服务', '服务工单'],
        reports: ['决策支持', '数据统计报表'],
        ai: ['决策支持', 'AI 健康分析'],
        settings: ['系统管理', '系统设置']
      };
      parts = map[key] || ['工作台'];
    }

    el.innerHTML = parts.map(function (p, i) {
      var isLast = i === parts.length - 1;
      return (i > 0 ? '<span class="sep">/</span>' : '') +
        '<span class="crumb' + (isLast ? ' current' : '') + '">' + U.esc(p) + '</span>';
    }).join('');
  }

  function documentTitle(route, key) {
    var names = {
      overview: '系统总览', elders: '老人档案', devices: '智能设备', alerts: '应急告警中心',
      orders: '服务工单', reports: '数据统计报表', ai: 'AI 健康分析', settings: '系统设置', family: '健康详情'
    };
    return '银龄岚途 · ' + (names[key] || '智慧养老');
  }

  function renderNotFound() {
    var view = document.getElementById('view');
    if (!view) return;
    U.clear(view);
    view.innerHTML = '<div class="page">' +
      UI.empty('map-pin', '页面不存在', '您访问的地址可能已失效，可返回系统总览继续浏览。',
        '<a class="btn btn-primary" href="#' + defaultHome() + '">返回工作台</a>') +
      '</div>';
  }

  /* ------------------------------------------------------------------
     顶栏交互
     ------------------------------------------------------------------ */
  function bindShell() {
    // 折叠导航
    document.getElementById('collapseBtn').addEventListener('click', function () {
      if (window.innerWidth <= 860) {
        document.getElementById('appView').classList.toggle('nav-open');
        return;
      }
      var app = document.getElementById('appView');
      var collapsed = app.classList.toggle('nav-collapsed');
      S.setNavCollapsed(collapsed);
      setTimeout(YL.charts.resizeAll, 320);
    });

    // 声音
    var soundBtn = document.getElementById('soundToggle');
    function paintSound() {
      var on = S.state.sound;
      soundBtn.innerHTML = YL.icon(on ? 'volume' : 'volume-off');
      soundBtn.classList.toggle('is-off', !on);
      soundBtn.title = on ? '告警提示音：已开启（点击关闭）' : '告警提示音：已关闭（点击开启）';
    }
    soundBtn.addEventListener('click', function () {
      S.setSound(!S.state.sound);
      paintSound();
      if (S.state.sound) UI.playSound('normal');
      UI.toast(S.state.sound ? '告警提示音已开启' : '告警提示音已关闭', S.state.sound ? 'success' : 'info');
    });
    paintSound();

    // 用户菜单
    var trigger = document.getElementById('userTrigger');
    var dropdown = document.getElementById('userDropdown');
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = dropdown.hidden;
      dropdown.hidden = !open;
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      if (!dropdown.hidden && !e.target.closest('#userMenu')) {
        dropdown.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
      }
    });

    dropdown.addEventListener('click', function (e) {
      var item = e.target.closest('[data-nav]');
      if (!item) return;
      var target = item.getAttribute('data-nav');
      dropdown.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (target === 'logout') {
        confirmLogout();
      } else {
        YL.router.go(target.replace('#', ''));
      }
    });

    // 角色切换
    document.getElementById('roleSwitch').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-role]');
      if (!btn) return;
      var role = btn.getAttribute('data-role');
      if (role === S.role()) return;
      S.setRole(role);
      applySession();
      dropdown.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      UI.toast('已切换为「' + S.roleConf().label + '」演示视角', 'info');
      YL.router.go(defaultHome(), true);
      if (!routerStarted) {
        routerStarted = true;
        YL.router.start(onRoute);
      }
    });

    // 退出
    document.getElementById('logoutBtn').addEventListener('click', confirmLogout);

    // 告警铃铛
    document.getElementById('alertBell').addEventListener('click', function () {
      YL.router.go('/alerts');
    });

    // 移动端点击遮罩关闭导航
    document.addEventListener('click', function (e) {
      var app = document.getElementById('appView');
      if (!app.classList.contains('nav-open')) return;
      if (e.target.closest('.sidebar') || e.target.closest('#collapseBtn')) return;
      app.classList.remove('nav-open');
    });

    // 快捷键：ESC 关闭移动导航
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        document.getElementById('appView').classList.remove('nav-open');
      }
    });

    // 订阅业务变更
    S.on(function (type, payload) {
      if (type === 'alerts' || type === 'alerts:new' || type === 'session') {
        refreshBadge();
        renderNav();
      }
      if (type === 'alerts:new' && payload) {
        showAlertPop(payload);
      }
    });
  }

  function confirmLogout() {
    UI.confirm({
      title: '退出当前账号？',
      message: '退出后需要重新输入账号与验证码才能进入工作台，未提交的编辑内容将不会保留。',
      okText: '退出登录',
      cancelText: '继续使用',
      danger: true
    }).then(function (ok) {
      if (ok) exitApp();
    });
  }

  /* ------------------------------------------------------------------
     实时告警浮窗
     ------------------------------------------------------------------ */
  function showAlertPop(alert) {
    var root = document.getElementById('overlayRoot');
    var old = document.getElementById('liveAlertPop');
    if (old) old.remove();

    // 与面包屑同一规则：admin 显示原文，其他角色只显示脱敏姓名（maskName 对空值安全）
    var raw = U.canSeeRaw();
    var elderRealName = alert.elderName === null || alert.elderName === undefined ? '' : String(alert.elderName);
    var elderShowName = raw ? elderRealName : U.maskName(elderRealName);
    var familyShowName = raw ? alert.familyName : U.maskName(alert.familyName);

    var node = U.el(
      '<div class="alert-pop" id="liveAlertPop" role="alert">' +
        '<div class="alert-pop-bar"></div>' +
        '<div class="alert-pop-head">' +
          '<span class="alert-pop-icon">' + YL.icon('alert') + '</span>' +
          '<div class="alert-pop-title">' +
            '<b>紧急告警 · ' + U.esc(D.DICT.alertType[alert.type].text) + '</b>' +
            '<em>' + U.esc(alert.village) + ' · ' + U.relTime(alert.time) + ' · 设备实时上报</em>' +
          '</div>' +
          '<button type="button" class="modal-close" data-pop-close aria-label="关闭">' + YL.icon('x') + '</button>' +
        '</div>' +
        '<div class="alert-pop-body">' +
          '<div class="alert-pop-person">' +
            '<span class="avatar x-warm">' + U.esc(elderShowName.slice(0, 1)) + '</span>' +
            '<div><b>' + U.esc(elderShowName) + '</b><em>' + alert.elderAge + ' 岁 · 紧急联系人 ' + U.esc(familyShowName) + '</em></div>' +
          '</div>' +
          '<div class="alert-pop-metric"><span>' + U.esc(alert.metric) + '</span><em>处置倒计时</em></div>' +
        '</div>' +
        '<div class="alert-pop-foot">' +
          '<button type="button" class="btn btn-sm btn-outline" data-pop-close>稍后处理</button>' +
          '<button type="button" class="btn btn-sm btn-danger" data-pop-go>立即处置</button>' +
        '</div>' +
      '</div>'
    );
    root.appendChild(node);
    UI.playSound(alert.level === 'critical' ? 'critical' : 'normal');

    var timer = setTimeout(close, 12000);
    function close() {
      clearTimeout(timer);
      node.classList.add('out');
      setTimeout(function () { if (node.parentNode) node.removeChild(node); }, 240);
    }
    U.qsa('[data-pop-close]', node).forEach(function (b) { b.addEventListener('click', close); });
    node.querySelector('[data-pop-go]').addEventListener('click', function () {
      close();
      YL.router.go('/alerts?focus=' + encodeURIComponent(alert.id));
    });
  }

  /* ------------------------------------------------------------------
     实时数据接入：优先真实链路（YL.realtime 推送），不可用时回退本地模拟
     ------------------------------------------------------------------ */
  /** 回退提示只打印一次，避免链路抖动时控制台刷屏 */
  var realtimeFallbackWarned = false;
  /** 同一告警可能被全局订阅与设备页透传各触发一次，按告警标识去重 */
  var lastAlertKey = '';
  var lastAlertAt = 0;

  /** 统一帧时间：兼容毫秒 / 秒级时间戳 / 日期字符串，非法值退回当前时间 */
  function liveTimestamp(v) {
    if (v === null || v === undefined || v === '') return Date.now();
    if (typeof v === 'number') return v < 1000000000000 ? v * 1000 : v;
    var str = String(v).trim();
    if (str && /^-?\d+$/.test(str)) {
      var n = Number(str);
      return n < 1000000000000 ? n * 1000 : n;
    }
    var t = new Date(str).getTime();
    return isNaN(t) ? Date.now() : t;
  }

  /** 云端告警帧补齐展示字段：浮窗模板依赖 village / elderAge / familyName 等本地档案字段 */
  function normalizeLiveAlert(alert, elderId) {
    var a = {};
    var k;
    for (k in alert) {
      if (Object.prototype.hasOwnProperty.call(alert, k)) a[k] = alert[k];
    }
    var elder = (elderId && D.ELDER_MAP && D.ELDER_MAP[elderId]) || null;
    a.elderId = elderId;
    a.time = liveTimestamp(a.event_time || a.time);
    a.elderName = String(a.elderName || (elder ? elder.name : '') || '未知老人');
    a.elderAge = a.elderAge === null || a.elderAge === undefined ? (elder ? elder.age : '—') : a.elderAge;
    a.village = a.village || (elder ? elder.village : '') || '未知村居';
    a.familyName = a.familyName || (elder ? elder.familyName : '') || '—';
    a.metric = a.metric || '设备实时上报';
    a.level = a.level === 'critical' ? 'critical' : 'normal';
    // 云端未下发告警编号时本地补一个，保证告警池去重与列表 key 稳定
    if (!a.id) a.id = 'WS-' + String(a.deviceId || '') + '-' + a.time;
    // 字典外的告警类型按心率异常兜底，保证浮窗文案不会渲染出 undefined
    if (!a.type || !D.DICT.alertType[a.type]) a.type = 'hr';
    if (!a.status) a.status = 'pending';
    return a;
  }

  /** 云端告警写入本地告警池，保证角标 / 总览告警流 / 告警中心与旧链路表现一致
      （用 emit('alerts') 而非 'alerts:new'，避免 bindShell 订阅把浮窗重复弹一次） */
  function ingestLiveAlert(alert) {
    try {
      var list = S.state && S.state.alerts;
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === alert.id) return;
      }
      S.state.alerts.unshift(alert);
      S.emit('alerts', alert);
    } catch (e) { /* 写入异常不影响浮窗与页面提示 */ }
  }

  /** 真实链路告警入口 */
  function handleLiveAlert(alert) {
    if (!alert) return;
    var elderId = String(alert.elderId === null || alert.elderId === undefined ? '' : alert.elderId).trim();
    if (!elderId && alert.deviceId && YL.realtime && YL.realtime.DEVICE_ELDER_MAP) {
      elderId = String(YL.realtime.DEVICE_ELDER_MAP[String(alert.deviceId).trim()] || '').trim();
    }
    // 家庭视图只处理本人绑定老人（E01）的告警
    if (S.role() === 'family' && elderId !== 'E01') return;

    // 同一告警（全局订阅 + 设备页透传）在 1.5 秒内只处理一次，避免重复弹窗与提示音
    var alertKey = String(alert.id || '') ||
      (String(alert.deviceId || '') + '|' + String(alert.event_time || '') + '|' + String(alert.type || ''));
    var nowTs = Date.now();
    if (alertKey && alertKey === lastAlertKey && nowTs - lastAlertAt < 1500) return;
    lastAlertKey = alertKey;
    lastAlertAt = nowTs;

    var item = normalizeLiveAlert(alert, elderId);
    ingestLiveAlert(item);
    // 复用旧浮窗与提示音：showAlertPop 内部按等级调用 UI.playSound（与旧链路同一方法，不重复播放）
    showAlertPop(item);

    var cur = YL.router.current();
    var path = cur ? cur.path : '';
    if (path === '/overview' && YL.pages.overview && YL.pages.overview.onLiveAlert) {
      YL.pages.overview.onLiveAlert(item);
    }
    if (path === '/alerts' && YL.pages.alerts && YL.pages.alerts.onLiveAlert) {
      YL.pages.alerts.onLiveAlert(item);
    }
  }

  /** 体征帧：只有停留在设备详情页时才转交设备页消费 */
  function handleLiveVitals(data) {
    if (!data) return;
    var cur = YL.router.current();
    if (!cur || String(cur.path).indexOf('/devices/') !== 0) return;
    if (YL.pages.devices && typeof YL.pages.devices.onLiveVitals === 'function') {
      YL.pages.devices.onLiveVitals(data);
    }
  }

  /** 链路首次连通 / 恢复：停掉本地模拟，避免真实告警与模拟告警混出 */
  function handleLiveOpen() {
    if (realtimeTimer) { clearInterval(realtimeTimer); realtimeTimer = null; }
  }

  /** 真实链路重连彻底失败：只提示一次，然后静默回退本地模拟 */
  function handleLiveUnavailable() {
    if (!realtimeFallbackWarned) {
      realtimeFallbackWarned = true;
      if (window.console && typeof window.console.warn === 'function') {
        window.console.warn('[实时链路] 设备实时推送暂不可用，已回退本地模拟数据，页面交互不受影响。');
      }
    }
    startSimulation();
  }

  /** 尝试启动真实链路：模块未加载或未连接时返回 false，由调用方回退 */
  function startRealtimeLink() {
    if (!YL.realtime || typeof YL.realtime.start !== 'function') return false;
    try {
      return YL.realtime.start({
        onVitals: handleLiveVitals,
        onAlert: handleLiveAlert,
        onOpen: handleLiveOpen,
        onUnavailable: handleLiveUnavailable
      }) === true;
    } catch (e) {
      return false;
    }
  }

  /** 旧实现：本地低频模拟告警（仅在真实链路不可用时启用，逻辑与节流保持原样） */
  function startSimulation() {
    if (realtimeTimer) return;
    realtimeTimer = setInterval(function () {
      if (S.role() === 'family') return;
      if (document.hidden) return;
      var cur = YL.router.current();
      if (!cur) return;
      if (cur.path !== '/overview' && cur.path !== '/alerts') return;
      if (Date.now() - lastSimulated < 60000) return;
      lastSimulated = Date.now();
      var alert = S.simulateAlert();
      if (alert && cur.path === '/overview' && YL.pages.overview && YL.pages.overview.onLiveAlert) {
        YL.pages.overview.onLiveAlert(alert);
      }
      if (alert && cur.path === '/alerts' && YL.pages.alerts && YL.pages.alerts.onLiveAlert) {
        YL.pages.alerts.onLiveAlert(alert);
      }
    }, 20000);
  }

  function startRealtime() {
    stopRealtime();
    realtimeFallbackWarned = false;
    // 优先真实链路；不可用（模块缺失 / 未连接）则回退本地模拟
    if (!startRealtimeLink()) startSimulation();
  }

  function stopRealtime() {
    // 先断开共享实时链路（模块可能尚未加载，需判空），避免残留 WebSocket 回调
    if (YL.realtime && typeof YL.realtime.stop === 'function') {
      try { YL.realtime.stop(); } catch (e) { /* 断开异常不影响退出流程 */ }
    }
    if (realtimeTimer) clearInterval(realtimeTimer);
    realtimeTimer = null;
  }

  /* ------------------------------------------------------------------
     启动
     ------------------------------------------------------------------ */
  function boot() {
    S.init();
    YL.hydrateIcons(document);
    registerRoutes();
    bindShell();

    YL.auth.init(function () {
      UI.toast('欢迎回来，' + S.roleConf().name, 'success', 2200);
      enterApp();
    });

    var sess = S.session();
    if (!sess) {
      showAuth();
      return;
    }

    // 离线演示会话 / 认证模块缺失：直接进入，不做联网校验（保证无后端可用）
    if (!YL.api || typeof YL.api.me !== 'function' || sess.offline || !S.token()) {
      launchApp();
      return;
    }

    // 在线会话：先向后端确认 token 仍然有效，再进入工作台
    var checking;
    try {
      checking = YL.api.me();
    } catch (e) {
      checking = null;
    }
    if (!checking || typeof checking.then !== 'function') {
      launchApp();
      return;
    }

    // 成功 / 失败回调分开传递：launchApp 内部异常不应被当成 token 失效或网络错误处理
    checking.then(function (user) {
      // 刷新用户信息（后端可能更新 scope / 名称），token 保持不变
      if (user) S.login({ token: S.token(), user: user });
      launchApp();
    }, function (err) {
      if (err && err.code === 'UNAUTHORIZED') {
        // 401：api.js 已清会话并回调 handleUnauthorized，这里兜底回登录页
        handleUnauthorized();
        return;
      }
      // 网络错误：保留本地会话，进入工作台避免白屏
      UI.toast('无法连接认证服务，已进入离线演示模式', 'warn', 2600);
      launchApp();
    });
  }

  YL.app = {
    enter: enterApp,
    exit: exitApp,
    refreshBadge: refreshBadge,
    refreshNav: renderNav,
    applySession: applySession,
    showAlertPop: showAlertPop,
    // 供 api.js 在收到 401 时回调：清理会话并退回登录页
    handleUnauthorized: handleUnauthorized,
    // 供页面透传云端告警 / 链路开闭事件，保证全局实时链路不因页面重新注册而丢失
    onLiveAlert: handleLiveAlert,
    onLiveOpen: handleLiveOpen,
    onLiveUnavailable: handleLiveUnavailable
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);