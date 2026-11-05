/* ==========================================================================
   实时体征推送：WebSocket 通道
   职责：
     1. 向前端页面暴露 window.YL.realtime，统一封装与后端实时通道的连接；
     2. start(handlers) 建立连接并分发 vitals / alert 消息，stop() 主动断开；
     3. 内置 25s 心跳与指数退避重连（1s→2s→4s→8s→16s，最多 5 次），
        重试耗尽后回调一次 onUnavailable，由页面决定是否降级为轮询；
     4. DEVICE_ELDER_MAP 维护云端 device_id → 老人 id 的绑定关系。
   说明：本文件不包含任何密钥、token 或设备密钥，鉴权由后端网关自行完成。
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL = global.YL || {};

  /* ---------------- 常量 ---------------- */
  // 与 api.js 的 API_BASE 同源规则：仅协议由 http 换成 ws，主机端口保持一致；
  // 若 YL.api.API_BASE 可用则自动推导（见 resolveWsBase），推导失败回落此常量。
  var WS_BASE = 'ws://localhost:8000/ws';
  var HEARTBEAT_INTERVAL = 25000;           // 心跳间隔 25s，需小于网关空闲超时
  var HEARTBEAT_TEXT = 'ping';              // 心跳报文为纯文本
  var MAX_ATTEMPTS = 5;                     // 最多重连 5 次
  var RETRY_BASE_DELAY = 1000;              // 退避基数 1s，按 2 的幂递增
  var MAX_FRAME_LENGTH = 128 * 1024;        // 单帧缓存上限，防御性防止内存膨胀

  /**
   * 云端设备 ID → 老人 ID
   * 将 IOTDA_DEVICE_ID 对应的设备绑定到演示老人 E01（张桂芳）；
   * 新增设备只需在此登记：'<IoTDA 设备ID>': '<老人id>'
   */
  var DEVICE_ELDER_MAP = {
    IOTDA_DEVICE_ID: 'E01'
  };

  /* ---------------- 内部状态 ---------------- */
  var socket = null;            // 当前 WebSocket 实例
  var handlers = null;          // 调用方回调集合
  var enabled = false;          // 对外只读语义：连接成功置 true
  var attempts = 0;             // 当前一轮已进行的重连次数
  var lastErrorAt = 0;          // 最近一次失败时间戳（毫秒）
  var stopped = false;          // 已调用 stop()，期间禁止重连
  var gaveUp = false;           // 重试已耗尽，保证 onUnavailable 只触发一次
  var heartbeatTimer = null;    // 心跳定时器
  var retryTimer = null;        // 重连定时器
  var pendingFrame = '';        // 半包缓存（消息被切分为多段时使用）

  var realtimeApi = null;       // 对外对象，setEnabled 会同步其 enabled 字段

  /* ---------------- 工具函数 ---------------- */
  /** 更新连接状态：内部变量与对外字段同步，避免两处状态漂移 */
  function setEnabled(value) {
    enabled = !!value;
    if (realtimeApi) realtimeApi.enabled = enabled;
  }

  /** 安全执行回调：UI 侧回调异常不得打断连接主流程 */
  function safeCall(fn, arg) {
    if (typeof fn !== 'function') return;
    try { fn(arg); } catch (e) { /* 忽略回调内部异常 */ }
  }

  /** 读取 WebSocket 静态常量，兼容自定义实现（stub）缺失常量的情况 */
  function wsConstant(name, fallback) {
    var WS = global.WebSocket;
    return WS && typeof WS[name] === 'number' ? WS[name] : fallback;
  }

  /** 是否处于连接中 / 已连接状态（用于 start() 幂等判断） */
  function isAlive(ws) {
    if (!ws) return false;
    return ws.readyState === wsConstant('CONNECTING', 0) ||
      ws.readyState === wsConstant('OPEN', 1);
  }

  /**
   * 推导 WS 地址：优先复用 api.js 暴露的 API_BASE，保持前后端同源；
   * YL.api 缺失或字段异常时回落 WS_BASE 常量，绝不抛错。
   */
  function resolveWsBase() {
    try {
      if (YL.api && typeof YL.api.API_BASE === 'string' && YL.api.API_BASE) {
        return YL.api.API_BASE.replace(/^http/, 'ws') + '/ws';
      }
    } catch (e) { /* 推导异常：忽略并回落常量 */ }
    return WS_BASE;
  }

  /** 规整回调集合，非函数项一律丢弃，避免后续 each 调用时报错 */
  function normalizeHandlers(input) {
    var src = input || {};
    function pick(name) {
      return typeof src[name] === 'function' ? src[name] : null;
    }
    return {
      onVitals: pick('onVitals'),
      onAlert: pick('onAlert'),
      onUnavailable: pick('onUnavailable'),
      onOpen: pick('onOpen')
    };
  }

  /**
   * 给消息数据补全老人 id：调用方通常只拿到设备编号（契约里写作 deviceId，
   * 华为云上报帧习惯用 device_id，两种都兼容），这里按 DEVICE_ELDER_MAP
   * 翻译成页面内的老人 id；未登记时保持原样，不覆盖已有 elderId。
   */
  function attachElder(data) {
    if (!data || typeof data !== 'object') return data;
    if (data.elderId) return data;
    var raw = data.deviceId;
    if (raw === null || raw === undefined || raw === '') raw = data.device_id;
    var deviceId = raw === null || raw === undefined ? '' : String(raw).trim();
    if (!deviceId) return data;
    var elderId = DEVICE_ELDER_MAP[deviceId];
    if (!elderId) return data;
    data.elderId = elderId;
    return data;
  }

  /* ---------------- 定时器管理 ---------------- */
  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function stopRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  /** 建立心跳：连接成功后每 25s 发送一次 ping，仅在 OPEN 状态发送 */
  function startHeartbeat(ws) {
    stopHeartbeat();
    heartbeatTimer = setInterval(function () {
      if (socket !== ws) return;                      // 连接已被替换 / 关闭
      if (ws.readyState !== wsConstant('OPEN', 1)) return;
      try { ws.send(HEARTBEAT_TEXT); } catch (e) { /* 发送失败交由 onclose 重连 */ }
    }, HEARTBEAT_INTERVAL);
  }

  /* ---------------- 消息处理 ---------------- */
  /**
   * 分发已解析的消息
   * 契约：{"type":"vitals","data":{...}} / {"type":"alert","data":{...}} / {"type":"hello","data":{...}}
   */
  function dispatchFrame(msg) {
    if (!msg || typeof msg !== 'object') return;
    var data = attachElder(msg.data);
    if (msg.type === 'vitals') {
      safeCall(handlers && handlers.onVitals, data);
    } else if (msg.type === 'alert') {
      safeCall(handlers && handlers.onAlert, data);
    }
    // hello 为握手帧，仅表示链路可用，不对外回调
  }

  /**
   * 判断一段以 { 开头的文本是否"尚未闭合"（可能是被切分的半包）
   * 逐字符扫描并忽略字符串内部的括号与转义，避免把 `{"a":{"b":1}` 这种
   * 恰好以嵌套对象右括号结尾的半包误判为坏帧（否则该帧会被直接丢弃）。
   */
  function isIncompleteJson(text) {
    var depth = 0;
    var inString = false;
    var escaped = false;
    for (var i = 0; i < text.length; i += 1) {
      var ch = text.charAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') depth -= 1;
    }
    return inString || depth > 0;
  }

  /**
   * 处理原始消息帧
   * 正常情况一帧即一条完整 JSON；若解析失败但仍是未闭合的 JSON 片段，
   * 先缓存等待后续片段拼接；其余坏帧只告警并丢弃。
   */
  function handleMessage(raw) {
    if (typeof raw !== 'string' || raw === '') return;
    var text = raw;
    if (pendingFrame) {
      text = pendingFrame + text;
      pendingFrame = '';
    }
    var msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      if (text.charAt(0) === '{' && text.length <= MAX_FRAME_LENGTH && isIncompleteJson(text)) {
        pendingFrame = text;                          // 半包：缓存等下一段
        return;
      }
      pendingFrame = '';
      if (global.console && typeof global.console.warn === 'function') {
        global.console.warn('[YL.realtime] 丢弃无法解析的消息帧：', text.slice(0, 80));
      }
      return;                                        // 坏帧不影响后续消息
    }
    // 收到任何可解析消息即视为链路正常
    dispatchFrame(msg);
  }

  /* ---------------- 连接生命周期 ---------------- */
  /** 重试耗尽：关闭链路并只回调一次 onUnavailable */
  function giveUp() {
    if (gaveUp) return;
    gaveUp = true;
    setEnabled(false);
    socket = null;
    stopHeartbeat();
    stopRetry();
    safeCall(handlers && handlers.onUnavailable);
  }

  /** 安排一次重连：次数用尽即放弃，否则按 1s→2s→4s→8s→16s 退避 */
  function scheduleRetry() {
    if (stopped || retryTimer) return;
    if (attempts >= MAX_ATTEMPTS) {
      giveUp();
      return;
    }
    attempts += 1;
    var delay = RETRY_BASE_DELAY * Math.pow(2, attempts - 1);
    retryTimer = setTimeout(function () {
      retryTimer = null;
      connect();
    }, delay);
  }

  function onOpen(ws) {
    if (socket !== ws) return;                        // 已被 stop / 替换的旧连接
    setEnabled(true);
    attempts = 0;                                     // 连接成功，重置退避轮次
    startHeartbeat(ws);
    safeCall(handlers && handlers.onOpen);
  }

  function onMessage(ws, evt) {
    if (socket !== ws) return;
    handleMessage(evt ? evt.data : '');
  }

  function onClose(ws) {
    if (socket !== ws) return;                        // 主动 stop 或已处理过的失败
    socket = null;
    setEnabled(false);
    stopHeartbeat();
    pendingFrame = '';
    scheduleRetry();
  }

  function onError(ws) {
    if (socket !== ws) return;
    lastErrorAt = Date.now();
    // 先摘除引用并关闭：随后的 close 事件据 socket !== ws 判定为同一次失败，避免重复重连
    socket = null;
    setEnabled(false);
    stopHeartbeat();
    pendingFrame = '';
    try { ws.close(); } catch (e) { /* ignore */ }
    scheduleRetry();
  }

  /** 创建连接；不支持的浏览器直接按“不可用”处理 */
  function connect() {
    if (stopped) return;
    var WS = global.WebSocket;
    if (typeof WS !== 'function') {
      lastErrorAt = Date.now();
      setEnabled(false);
      giveUp();
      return;
    }
    var ws;
    try {
      ws = new WS(resolveWsBase());
    } catch (e) {
      lastErrorAt = Date.now();
      scheduleRetry();
      return;
    }
    socket = ws;
    try {
      ws.onopen = function () { onOpen(ws); };
      ws.onmessage = function (evt) { onMessage(ws, evt); };
      ws.onclose = function () { onClose(ws); };
      ws.onerror = function () { onError(ws); };
    } catch (e) {
      onError(ws);
    }
  }

  /* ---------------- 对外 API ---------------- */
  /**
   * 建立实时通道
   * @param {object} callbacks { onVitals(data), onAlert(data), onUnavailable(), onOpen() }，均可选
   * @returns {boolean} 是否已建立 / 正在建立连接
   */
  function start(callbacks) {
    handlers = normalizeHandlers(callbacks);
    // 幂等：连接中或已连接时直接返回 true，不新建实例
    if (isAlive(socket)) return true;

    stopped = false;
    gaveUp = false;
    attempts = 0;                                     // 手动重新开启，重置退避轮次
    lastErrorAt = 0;
    pendingFrame = '';
    connect();
    return isAlive(socket);
  }

  /** 主动关闭：清定时器、置 enabled=false，之后不再触发任何回调 */
  function stop() {
    stopped = true;
    setEnabled(false);
    attempts = 0;
    lastErrorAt = 0;
    pendingFrame = '';
    stopHeartbeat();
    stopRetry();

    var ws = socket;
    socket = null;
    if (ws) {
      // 先解绑事件：部分实现 close() 仍会异步触发 onclose
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
      } catch (e) { /* ignore */ }
      try { ws.close(); } catch (e) { /* ignore */ }
    }
    handlers = null;
  }

  /** 调试快照：当前连接态、已重试次数、最近失败时间 */
  function state() {
    return {
      enabled: enabled,
      attempts: attempts,
      lastErrorAt: lastErrorAt
    };
  }

  realtimeApi = {
    DEVICE_ELDER_MAP: DEVICE_ELDER_MAP,
    start: start,
    stop: stop,
    state: state,
    enabled: false          // 占位：下面优先改写为只读 getter
  };

  /**
   * enabled 以 getter 暴露（只读语义）：读取时即时返回内部真实状态，
   * 避免公开字段与连接状态不一致；不支持 defineProperty 的环境退化为普通字段。
   */
  try {
    Object.defineProperty(realtimeApi, 'enabled', {
      enumerable: true,
      get: function () { return enabled; },
      set: function (v) { enabled = !!v; }   // 内部赋值兼容：外部写入不生效但也不报错
    });
  } catch (e) {
    realtimeApi.enabled = enabled;
  }

  YL.realtime = realtimeApi;
})(window);