/* ==========================================================================
   运行时状态：登录会话 / 角色权限 / 业务数据副本 / 变更订阅
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL;
  var U = YL.utils;
  var D = YL.data;

  var SESSION_KEY = 'yl_session_v2';   // 会话键：含后端 token 与 user
  var LEGACY_KEY = 'yl_session';       // 旧版演示会话键：无 token，只清理不迁移

  var ROLES = {
    admin: {
      label: '超级管理员',
      short: '管理员',
      desc: '全域数据权限 · 系统配置',
      scope: '全域 42 个村居',
      avatar: '林',
      name: '林晓岚',
      account: 'admin',
      perms: ['overview', 'elders', 'devices', 'alerts', 'orders', 'reports', 'ai', 'settings',
        'alerts:handle', 'orders:create', 'orders:assign', 'elders:edit', 'devices:control',
        'settings:manage', 'export', 'batch']
    },
    social: {
      label: '社区社工',
      short: '社工',
      desc: '流水镇 6 个村居 · 服务执行',
      scope: '流水镇 · 北港村',
      avatar: '蔡',
      name: '蔡文静',
      account: 'shegong01',
      perms: ['overview', 'elders', 'devices', 'alerts', 'orders', 'ai',
        'alerts:handle', 'orders:create', 'elders:edit', 'export']
    },
    family: {
      label: '老人家属',
      short: '家属',
      desc: '仅本人绑定老人 · 只读',
      scope: '林水妹（母亲）',
      avatar: '林',
      name: '林小雅',
      account: 'family01',
      perms: ['family', 'elders:read', 'alerts:read', 'orders:read']
    }
  };

  var DEFAULT_THRESHOLDS = {
    hrHigh: 105,
    hrLow: 50,
    spo2Low: 92,
    sbpHigh: 150,
    fallSensitivity: '高',
    fenceRadius: 800,
    sosNumber: '0591-2431 8800'
  };

  var state = {
    session: null,
    alerts: [],
    orders: [],
    elders: [],
    devices: [],
    sound: true,
    navCollapsed: false,
    thresholds: Object.assign({}, DEFAULT_THRESHOLDS),
    packages: [
      { key: 'ankang', name: '安康版', price: 199, period: '年', services: ['每月 1 次上门关怀', '7×24 小时健康监测', '跌倒自动告警'] },
      { key: 'kanghu', name: '康护版', price: 399, period: '年', services: ['每月 2 次上门关怀', '每季度 1 次陪诊', '康复护理指导'] },
      { key: 'zunxiang', name: '尊享版', price: 699, period: '年', services: ['每月 4 次上门关怀', '每月 1 次陪诊', '专属健康管家'] },
      { key: 'free', name: '兜底免费', price: 0, period: '政府购买', services: ['基础健康监测', '应急告警处置', '志愿者结对帮扶'] }
    ]
  };

  var listeners = [];

  function emit(type, payload) {
    listeners.forEach(function (fn) {
      try { fn(type, payload); } catch (e) { /* 隔离单个订阅异常 */ }
    });
  }

  function on(fn) {
    listeners.push(fn);
    return function () {
      listeners = listeners.filter(function (item) { return item !== fn; });
    };
  }

  function clone(list) {
    return list.map(function (item) { return Object.assign({}, item); });
  }

  function init() {
    state.alerts = clone(D.ALERTS);
    state.orders = clone(D.ORDERS);
    state.elders = clone(D.ELDERS);
    state.devices = clone(D.DEVICES);

    var pref = U.store.get('yl_pref', {});
    state.sound = pref.sound !== false;
    state.navCollapsed = pref.navCollapsed === true;
    state.thresholds = Object.assign({}, DEFAULT_THRESHOLDS, pref.thresholds || {});

    var session = U.store.get(SESSION_KEY, null);
    // 真实会话看 token、离线演示会话看 offline 标记，二者有其一即为有效登录态
    var valid = !!(session && session.user && (session.token || session.offline));
    if (valid) {
      // 兼容字段缺失时从 user 回填，保证 role()、session().name 等既有调用稳定
      session.account = session.account || session.user.account || '';
      session.role = session.role || session.user.role || '';
      session.name = session.name || session.user.name || '';
      session.demoUserId = session.demoUserId || session.user.id || '';
      valid = !!ROLES[session.role];   // 角色必须在 ROLES 中认识，避免恢复出未知权限
    }
    if (valid) {
      state.session = session;
    } else {
      // 旧键里只有演示会话、没有 token，恢复出来就是假登录态，直接丢弃
      U.store.remove(LEGACY_KEY);
      // 非法 v2 会话同样清掉，避免脏键反复参与启动判定
      U.store.remove(SESSION_KEY);
    }
    return state;
  }

  /**
   * 组装统一会话结构
   * account / role / name / demoUserId 均从 user 派生，作为兼容字段保留，
   * 使 session().name、role()、applySession 等既有调用不需要改
   * @param {object} payload { token, user, offline }
   */
  function buildSession(payload) {
    var p = payload || {};
    var u = p.user || {};
    return {
      token: p.token || '',
      user: {
        id: u.id || '',
        name: u.name || '',
        account: u.account || '',
        role: u.role || '',
        scope: u.scope || ''
      },
      account: u.account || '',
      role: u.role || '',
      name: u.name || '',
      loginAt: Date.now(),
      demoUserId: u.id || '',
      offline: p.offline === true
    };
  }

  /**
   * 保存登录会话，真实登录与离线演示共用
   * @param {object} payload login({token, user}) 或 login({token:'', user, offline:true})
   */
  function login(payload) {
    state.session = buildSession(payload);
    U.store.set(SESSION_KEY, state.session);
    emit('session', state.session);
    return state.session;
  }

  function logout() {
    state.session = null;
    U.store.remove(SESSION_KEY);
    U.store.remove(LEGACY_KEY);   // 保险起见，旧键一并清理
    emit('session', null);
  }

  /** 角色切换仅用于演示，真实鉴权以后端 token 为准 */
  function setRole(role) {
    if (!ROLES[role]) return null;
    var conf = ROLES[role];
    var found = D.ACCOUNTS.filter(function (a) { return a.account === conf.account; })[0];
    var user = {
      id: found ? found.id : '',
      name: conf.name,
      account: conf.account,
      role: role,
      scope: role === 'admin' ? '全域' : ((found && found.village) || '')
    };
    login({ token: '', user: user, offline: true });
    return state.session;
  }

  function token() { return (state.session && state.session.token) || ''; }
  function isAuthed() { return !!token(); }

  function session() { return state.session; }
  function role() { return state.session ? state.session.role : 'admin'; }
  function roleConf(r) { return ROLES[r || role()] || ROLES.admin; }

  function can(perm) {
    return roleConf().perms.indexOf(perm) !== -1;
  }

  function scopeTown() {
    return role() === 'social' ? '流水镇' : null;
  }

  function inScope(item) {
    if (role() === 'admin') return true;
    if (role() === 'family') return item.id === 'E01' || item.elderId === 'E01';
    return item.town === '流水镇';
  }

  /** 当前角色可见的数据集合 */
  function scopeList(list) {
    return list.filter(inScope);
  }

  function elders() { return scopeList(state.elders); }
  function alerts() { return scopeList(state.alerts); }
  function orders() { return scopeList(state.orders); }
  function devices() {
    if (role() === 'admin') return state.devices;
    if (role() === 'family') return state.devices.filter(function (d) { return d.elderId === 'E01'; });
    return state.devices.filter(function (d) { return d.town === '流水镇'; });
  }

  function pendingAlertCount() {
    return alerts().filter(function (a) { return a.status === 'pending'; }).length;
  }

  /** 更新告警（处置闭环） */
  function handleAlert(id, patch) {
    var target = null;
    state.alerts = state.alerts.map(function (a) {
      if (a.id !== id) return a;
      target = Object.assign({}, a, patch, { handledAt: Date.now() });
      return target;
    });
    emit('alerts', target);
    return target;
  }

  function setAlertStatus(id, status) {
    return handleAlert(id, { status: status });
  }

  /** 新增工单 */
  function addOrder(data) {
    var now = Date.now();
    var order = Object.assign({
      id: 'WO' + U.fmtDate(now, 'YYYYMMDD') + U.pad2(state.orders.length + 1),
      createdAt: now,
      status: 'pending',
      summary: '',
      rating: 0,
      duration: 0,
      photos: 0
    }, data);
    state.orders.unshift(order);
    emit('orders', order);
    return order;
  }

  function updateOrder(id, patch) {
    var target = null;
    state.orders = state.orders.map(function (o) {
      if (o.id !== id) return o;
      target = Object.assign({}, o, patch);
      return target;
    });
    emit('orders', target);
    return target;
  }

  /** 新增老人档案 */
  function addElder(data) {
    var elder = Object.assign({
      id: 'E' + U.pad2(state.elders.length + 1),
      avatarClass: '',
      risk: 'low',
      chronic: [],
      joinedAt: Date.now(),
      deviceBound: false,
      deviceId: '',
      lastVitals: { hr: 74, spo2: 97, sbp: 128, dbp: 78, temp: 36.5, at: Date.now() }
    }, data);
    state.elders.unshift(elder);
    emit('elders', elder);
    return elder;
  }

  function updateElder(id, patch) {
    var target = null;
    state.elders = state.elders.map(function (e) {
      if (e.id !== id) return e;
      target = Object.assign({}, e, patch);
      return target;
    });
    emit('elders', target);
    return target;
  }

  function unbindDevice(deviceId) {
    state.devices = state.devices.map(function (d) {
      return d.id === deviceId ? Object.assign({}, d, { elderId: null, elderName: '未绑定' }) : d;
    });
    state.elders = state.elders.map(function (e) {
      return e.deviceId === deviceId ? Object.assign({}, e, { deviceBound: false }) : e;
    });
    emit('devices', deviceId);
  }

  function savePref() {
    U.store.set('yl_pref', {
      sound: state.sound,
      navCollapsed: state.navCollapsed,
      thresholds: state.thresholds
    });
  }

  function setSound(v) {
    state.sound = !!v;
    savePref();
    emit('sound', state.sound);
  }

  function setNavCollapsed(v) {
    state.navCollapsed = !!v;
    savePref();
    emit('nav', state.navCollapsed);
  }

  function setThresholds(patch) {
    state.thresholds = Object.assign({}, state.thresholds, patch);
    savePref();
    emit('thresholds', state.thresholds);
  }

  /** 演示：生成一条新告警（仅管理员/社工，用于实时滚动展示） */
  function simulateAlert() {
    var pool = elders().filter(function (e) { return e.risk === 'high'; });
    if (!pool.length) return null;
    var elder = U.pick(Math.random, pool);
    var types = ['hr', 'spo2', 'bp', 'fence'];
    var type = U.pick(Math.random, types);
    var alert = {
      id: 'AL' + U.fmtDate(Date.now(), 'YYYYMMDD') + U.pad2(90 + Math.floor(Math.random() * 9)),
      time: Date.now(),
      elderId: elder.id,
      elderName: elder.name,
      elderAge: elder.age,
      village: elder.village,
      town: elder.town,
      address: elder.address,
      phone: elder.phone,
      familyName: elder.familyName,
      relation: elder.relation,
      type: type,
      level: Math.random() > .45 ? 'critical' : 'normal',
      status: 'pending',
      handler: '',
      handleWay: '',
      result: '',
      metric: type === 'hr' ? (108 + Math.floor(Math.random() * 12) + ' bpm') :
        type === 'spo2' ? (88 + Math.floor(Math.random() * 4) + '%') :
          type === 'bp' ? (152 + Math.floor(Math.random() * 16) + '/96 mmHg') : '偏离围栏 260m',
      location: 'E 119.78 62° / N 25.50 18°',
      duration: '1 分钟'
    };
    state.alerts.unshift(alert);
    emit('alerts:new', alert);
    return alert;
  }

  global.YL.store = {
    ROLES: ROLES,
    state: state,
    init: init, on: on, emit: emit,
    login: login, logout: logout, setRole: setRole, session: session,
    token: token, isAuthed: isAuthed,
    role: role, roleConf: roleConf, can: can,
    scopeTown: scopeTown, elders: elders, alerts: alerts, orders: orders, devices: devices,
    pendingAlertCount: pendingAlertCount,
    handleAlert: handleAlert, setAlertStatus: setAlertStatus,
    addOrder: addOrder, updateOrder: updateOrder,
    addElder: addElder, updateElder: updateElder, unbindDevice: unbindDevice,
    setSound: setSound, setNavCollapsed: setNavCollapsed, setThresholds: setThresholds,
    simulateAlert: simulateAlert
  };
})(window);