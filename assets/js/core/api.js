/* ==========================================================================
   大模型网关 API：登录鉴权 / SSE 流式问答 / 健康探测
   职责：
     1. 向前端页面暴露 window.YL.api，统一封装与后端网关的 HTTP 交互；
     2. chatStream() 以 fetch + ReadableStream 增量解析 SSE，逐 token 回调，
        并通过 AbortController 支持页面销毁时中断请求；
     3. 所有异常均在内部消化为 onError 回调，绝不向调用方抛未捕获异常；
     4. login / me / logout 维护登录态，并为受保护接口注入 Bearer token；
     5. audit() 静默上报操作审计，后端不可用时自动丢弃，不影响主流程。
   说明：本文件不包含任何密钥信息；token 由 store 持久化，此处只负责读取并注入请求头。
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL = global.YL || {};

  var API_BASE = (global.YL_API_BASE || 'http://localhost:8000');   // 可修改：后端地址，可用 window.YL_API_BASE 覆盖
  var MAX_MESSAGES = 20;                    // 单次请求最多携带的对话条数

  /* ---------------- 错误构造 ---------------- */
  /**
   * 生成带业务错误码的 Error 对象
   * @param {string} code    错误码：HTTP_ERROR / SERVER_ERROR / NETWORK_ERROR / UNSUPPORTED
   * @param {string} message 中文错误描述
   * @param {object} extra   附加信息（status / cause）
   */
  function makeError(code, message, extra) {
    var err = new Error(message || code);
    err.code = code;
    if (extra) {
      if (extra.status !== undefined) err.status = extra.status;
      if (extra.cause !== undefined) err.cause = extra.cause;
    }
    return err;
  }

  /** 安全执行回调：UI 侧回调抛错不应破坏流解析主流程 */
  function safeCall(fn, arg) {
    if (typeof fn !== 'function') return;
    try { fn(arg); } catch (e) { /* 忽略回调内部异常 */ }
  }

  /**
   * ES5 的对象属性合并：source 的自有属性覆盖到 target，并返回 target。
   * 不使用 Object.assign，保证老版本浏览器可运行。
   * @param {object} target 目标对象
   * @param {object} source 来源对象
   * @returns {object} 合并后的 target
   */
  function mergeInto(target, source) {
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
    }
    return target;
  }

  /* ---------------- 会话鉴权 ---------------- */
  /**
   * 取本地 token 组装鉴权头；无 token 或读取异常时返回空对象，绝不阻断请求
   * @returns {object} 形如 { Authorization: 'Bearer xxx' }
   */
  function authHeaders() {
    try {
      var store = global.YL ? global.YL.store : null;
      var token = store && typeof store.token === 'function' ? store.token() : '';
      if (!token) return {};
      return { Authorization: 'Bearer ' + token };
    } catch (e) {
      return {};
    }
  }

  /**
   * 登录态失效的统一处理：清本地会话，并交由 app.js 跳回登录页
   * 注意：日志只提示状态，不输出 token
   */
  function handleUnauthorized() {
    try {
      var store = global.YL && global.YL.store;
      if (store && typeof store.logout === 'function') store.logout();
      var app = global.YL && global.YL.app;
      if (app && typeof app.handleUnauthorized === 'function') app.handleUnauthorized();
    } catch (e) { /* 失效处理本身异常不应影响调用方流程 */ }
    console.warn('[YL.api] 登录状态已失效，已退出登录');
  }

  /** 解析响应 JSON：空响应体 / 非 JSON 一律返回 null，避免二次抛错 */
  function readJson(response) {
    try {
      return Promise.resolve(response.json()).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  /**
   * 统一 JSON 请求：2xx resolve 响应体，非 2xx reject { code, status, detail }
   * login / me 共用此入口，避免出现两套错误处理
   * @param {string} method   HTTP 方法
   * @param {string} path     以 / 开头的接口路径
   * @param {object} body     请求体（为空表示无 body）
   * @param {boolean} withAuth 是否注入 Bearer token
   * @param {string} netDetail 网络层失败时的中文提示
   */
  function requestJson(method, path, body, withAuth, netDetail) {
    if (typeof global.fetch !== 'function') {
      return Promise.reject({ code: 'NETWORK_ERROR', status: 0, detail: netDetail });
    }

    var headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (withAuth) mergeInto(headers, authHeaders());

    var options = { method: method, headers: headers };
    if (body) options.body = JSON.stringify(body);

    var pending;
    try {
      pending = global.fetch(API_BASE + path, options);
    } catch (e) {
      // 组装请求阶段的同步异常同样归一化为网络错误，调用方只需处理 Promise
      return Promise.reject({ code: 'NETWORK_ERROR', status: 0, detail: netDetail });
    }

    return pending.then(function (response) {
      var status = response.status;
      if (response.ok) return readJson(response);
      // 非 2xx：解析后端错误体，缺字段时按 HTTP_ERROR 兜底
      return readJson(response).then(function (data) {
        return Promise.reject({
          code: (data && data.code) || 'HTTP_ERROR',
          status: status,
          detail: (data && data.detail) || ''
        });
      });
    }).catch(function (err) {
      if (err && err.code) return Promise.reject(err);   // 已归一化的业务错误，原样抛出
      return Promise.reject({ code: 'NETWORK_ERROR', status: 0, detail: netDetail });
    });
  }

  /**
   * 账号密码登录；成功后自动写入本地会话，调用方无需再手动保存
   * @param {string} account  登录账号
   * @param {string} password 登录密码
   * @param {string} role     可选角色，缺省由后端按账号判定
   * @returns {Promise} resolve { token, expires_at, user }
   */
  function login(account, password, role) {
    var body = { account: account, password: password };
    if (role) body.role = role;

    return requestJson('POST', '/api/auth/login', body, false, '无法连接认证服务')
      .then(function (data) {
        var payload = data || {};
        // 响应缺 token 视为认证服务异常：绝不能落库成无 token 的假会话
        if (!payload.token) {
          return Promise.reject({ code: 'BAD_RESPONSE', status: 200, detail: '认证服务响应异常，请稍后重试' });
        }
        try {
          var store = global.YL && global.YL.store;
          if (store && typeof store.login === 'function') {
            store.login({ token: payload.token, user: payload.user });
          }
        } catch (e) { /* 本地持久化失败不影响本次登录结果 */ }
        return payload;
      });
  }

  /**
   * 校验当前 token 并取回用户信息
   * @returns {Promise} resolve user；401 时清会话后 reject { code: 'UNAUTHORIZED', status: 401 }
   */
  function me() {
    return requestJson('GET', '/api/auth/me', null, true, '无法连接认证服务')
      .then(function (data) {
        return data && data.user ? data.user : null;
      })
      .catch(function (err) {
        if (err && err.status === 401) {
          handleUnauthorized();
          return Promise.reject({ code: 'UNAUTHORIZED', status: 401 });
        }
        return Promise.reject(err);   // 网络异常只上报，不清会话
      });
  }

  /** 退出登录：仅清理本地会话，不请求后端（token 无状态，后端无注销接口） */
  function logout() {
    try {
      var store = global.YL && global.YL.store;
      if (store && typeof store.logout === 'function') store.logout();
    } catch (e) { /* 清理失败不向调用方抛出 */ }
  }

  /* ---------------- 操作审计 ---------------- */
  /** 允许透传的扩展字段：与后端审计请求模型保持一致，其他字段一律丢弃 */
  var AUDIT_FIELDS = ['target_type', 'target_id', 'result', 'detail'];

  /**
   * 静默上报一条操作审计（登录 / 退出等关键动作）。
   * 后端不可用、返回非 2xx、无 token 时一律吞掉错误并 resolve null，
   * 调用方无需 then/catch，也不得因此中断主流程。
   * @param {string} action  动作标识，如 login / logout / elder_view
   * @param {object} payload 可选扩展字段 { target_type, target_id, result, detail }
   * @returns {Promise} 恒为 resolve：成功返回响应体，失败返回 null
   */
  function audit(action, payload) {
    var input = payload || {};
    var body = { action: action };
    for (var i = 0; i < AUDIT_FIELDS.length; i++) {
      var key = AUDIT_FIELDS[i];
      if (input[key] !== undefined) body[key] = input[key];
    }

    try {
      // 复用统一请求封装：自动注入 Bearer token，非 2xx 会 reject
      return requestJson('POST', '/api/audit', body, true, '审计上报失败')
        .catch(function () {
          if (global.console && typeof global.console.debug === 'function') {
            global.console.debug('[YL.api] 审计上报失败，已忽略');
          }
          return null;
        });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  /* ---------------- 契约字段裁剪（防御性默认值） ---------------- */
  function isArray(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  function toText(v, def) {
    if (v === null || v === undefined || v === '') return def;
    return String(v);
  }

  function toNumber(v, def) {
    var n = Number(v);
    return isFinite(n) ? n : def;
  }

  /**
   * 只向后端传递契约内允许的老人字段，避免把手机号、住址等隐私数据带到模型侧
   * 姓名统一脱敏为“该老人”，不向模型侧传递真实姓名
   * @param {object} elder 前端老人档案对象
   *
   * 数值字段缺失 / 非法时一律传 0：0 表示未记录（后端 schemas 与 prompts 均按此语义渲染
   * 为“未记录”），禁止用 72、120 等假数据填充，避免模型把虚构体征当成真实测量值引用。
   */
  function pickElder(elder) {
    var e = elder || {};
    var v = e.lastVitals || {};
    var chronic = [];
    if (isArray(e.chronic)) {
      e.chronic.forEach(function (item) {
        if (item !== null && item !== undefined) chronic.push(String(item));
      });
    }
    return {
      name: '该老人',   // 姓名脱敏：固定占位，不向后端/模型侧暴露真实姓名
      gender: toText(e.gender, '未知'),
      age: toNumber(e.age, 0),
      village: toText(e.village, ''),
      town: toText(e.town, ''),
      health: toText(e.health, 'healthy'),
      chronic: chronic,
      lastVitals: {
        hr: toNumber(v.hr, 0),
        sbp: toNumber(v.sbp, 0),
        dbp: toNumber(v.dbp, 0),
        spo2: toNumber(v.spo2, 0),
        temp: toNumber(v.temp, 0),
        at: v.at   // 测量时间，可选字段；缺失时保持 undefined，由后端按无记录处理
      }
    };
  }

  /**
   * 规整对话历史：仅保留 role / content，过滤非法角色与空内容，最多 MAX_MESSAGES 条
   * @param {Array} messages 形如 [{ role: 'user', content: '...' }]
   */
  function pickMessages(messages) {
    var out = [];
    if (!isArray(messages)) return out;
    messages.forEach(function (m) {
      if (!m) return;
      var role = m.role === 'user' ? 'user' : (m.role === 'assistant' ? 'assistant' : '');
      if (!role) return;
      var content = m.content === null || m.content === undefined ? '' : String(m.content).trim();
      if (!content) return;
      out.push({ role: role, content: content });
    });
    return out.length > MAX_MESSAGES ? out.slice(out.length - MAX_MESSAGES) : out;
  }

  /* ---------------- SSE 解析 ---------------- */
  /**
   * 解析单个事件块：逐行查找以 data: 开头的行，JSON.parse 后交给 onEvent
   * 解析失败静默跳过（心跳 / 注释行 / 半包数据都属于正常情况）
   */
  function dispatchBlock(block, onEvent) {
    var lines = String(block).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var match = /^\s*data:(.*)$/.exec(lines[i]);
      if (!match) continue;
      var raw = match[1].trim();
      if (!raw) continue;
      var msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        continue;   // 非 JSON 数据行直接忽略，保证不中断后续解析
      }
      onEvent(msg);
    }
  }

  /* ---------------- 主流程：流式对话 ---------------- */
  /**
   * 发起流式问答
   * @param {object} elder     老人对象（内部自动裁剪为契约字段）
   * @param {Array}  messages  对话历史（内部自动裁剪为 {role, content}，最多 20 条）
   * @param {object} callbacks { onToken(text), onDone(), onError(err) }
   * @returns {{abort: Function}} 控制器，调用 abort() 可静默中断
   */
  function chatStream(elder, messages, callbacks) {
    var cb = callbacks || {};
    var settled = false;     // done / error 只允许触发一次
    var aborted = false;     // 主动中断标记：中断后不再回调任何事件
    var buffer = '';         // SSE 文本缓冲区
    var reader = null;       // 当前流读取器
    var ac = null;           // AbortController 实例

    function finishDone() {
      if (settled) return;
      settled = true;
      safeCall(cb.onDone);
    }

    function finishError(err) {
      if (settled || aborted) return;
      settled = true;
      safeCall(cb.onError, err || makeError('UNKNOWN_ERROR', '问答服务异常'));
    }

    /** 释放流读取器；连接已自然结束时 cancel 会抛错，需忽略 */
    function stopReader() {
      if (!reader) return;
      var r = reader;
      reader = null;
      try { r.cancel(); } catch (e) { /* ignore */ }
    }

    var controller = {
      abort: function () {
        if (settled) {
          stopReader();
          return;
        }
        aborted = true;
        settled = true;      // 中断不触发 onDone / onError，交由调用方忽略
        stopReader();
        if (ac) { try { ac.abort(); } catch (e) { /* ignore */ } }
      }
    };

    // 事件分发：token → 增量文本；done → 收尾；error → 服务端错误
    function handleEvent(msg) {
      if (settled) return;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'token') {
        safeCall(cb.onToken, msg.content === null || msg.content === undefined ? '' : String(msg.content));
      } else if (msg.type === 'done') {
        finishDone();
        stopReader();        // 服务端已声明结束，主动关闭连接
      } else if (msg.type === 'error') {
        finishError(makeError('SERVER_ERROR', msg.message || msg.content || '问答服务返回错误'));
        stopReader();
      }
    }

    /**
     * 消费缓冲区：按空行（\n\n 或 \r\n\r\n）切分事件块
     * @param {boolean} final 是否为流末尾（需要处理无结尾空行的残留块）
     */
    function consume(final) {
      var match;
      while (!settled && (match = buffer.match(/\r?\n\r?\n/)) !== null) {
        var block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        dispatchBlock(block, handleEvent);
      }
      if (!settled && final && buffer.trim()) {
        var tail = buffer;
        buffer = '';
        dispatchBlock(tail, handleEvent);
      }
    }

    /** 不支持流式读取时的整包兜底解析 */
    function feedWhole(text) {
      if (settled) return;
      buffer += String(text || '');
      consume(true);
      finishDone();
    }

    /** 增量读取 ReadableStream，TextDecoder 以 stream 模式避免多字节字符被截断 */
    function readStream(body) {
      reader = body.getReader();
      var decoder = new global.TextDecoder('utf-8');

      function pump() {
        return reader.read().then(function (res) {
          if (settled) return;
          if (res.done) {
            consume(true);
            finishDone();
            return;
          }
          buffer += decoder.decode(res.value, { stream: true });
          consume(false);
          if (settled) return;
          return pump();
        });
      }

      return pump();
    }

    // 无 AbortController 的旧浏览器：仍可接收，只是无法真正中断
    if (global.AbortController) {
      ac = new global.AbortController();
    }

    var options = {
      method: 'POST',
      headers: mergeInto({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({
        elder: pickElder(elder),
        messages: pickMessages(messages),
        stream: true
      })
    };
    if (ac) options.signal = ac.signal;

    try {
      if (typeof global.fetch !== 'function') {
        finishError(makeError('NETWORK_ERROR', '当前浏览器不支持流式问答，请使用较新版本的浏览器。'));
        return controller;
      }

      global.fetch(API_BASE + '/api/chat', options).then(function (response) {
        // 401：token 过期或无效，统一清理会话并提示重新登录
        if (response.status === 401) {
          handleUnauthorized();
          throw makeError('UNAUTHORIZED', '登录状态已失效，请重新登录', { status: 401 });
        }
        // 非 2xx 统一视为 HTTP 错误，交由调用方降级
        if (!response.ok) {
          throw makeError('HTTP_ERROR', '问答服务返回异常（HTTP ' + response.status + '）', { status: response.status });
        }
        // 现代浏览器走流式；否则退回整包文本解析
        if (!global.TextDecoder || !response.body || typeof response.body.getReader !== 'function') {
          return response.text().then(function (txt) { feedWhole(txt); });
        }
        return readStream(response.body);
      }).catch(function (err) {
        if (aborted) return;                                   // 主动中断：静默
        if (err && err.name === 'AbortError') return;          // 浏览器中断：静默
        if (err && err.code) {                                 // 已带业务错误码
          finishError(err);
          return;
        }
        // 网络层失败（后端未启动 / 跨域 / 断网）
        finishError(makeError(
          'NETWORK_ERROR',
          '无法连接 AI 问答服务（' + API_BASE + '），已切换为本地健康知识库回答。',
          { cause: err }
        ));
      });
    } catch (e) {
      // 组装请求阶段的同步异常也兜底，保证调用方一定能收到反馈
      finishError(makeError('NETWORK_ERROR', '问答请求发起失败，已切换为本地健康知识库回答。', { cause: e }));
    }

    return controller;
  }

  /* ---------------- 健康探测 ---------------- */
  /** 便捷方法：查询网关健康状态，失败统一返回 null，不影响主流程 */
  function health() {
    try {
      if (typeof global.fetch !== 'function') return Promise.resolve(null);
      return global.fetch(API_BASE + '/api/health', { method: 'GET', headers: authHeaders() })
        .then(function (res) { return res.ok ? res.json() : null; })
        .catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  YL.api = {
    API_BASE: API_BASE,          // 供 realtime.js 推导 WS 地址
    chatStream: chatStream,
    health: health,
    login: login,
    audit: audit,
    me: me,
    logout: logout
  };
})(window);