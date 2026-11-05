/* ==========================================================================
   大模型网关 API：SSE 流式问答 / 健康探测
   职责：
     1. 向前端页面暴露 window.YL.api，统一封装与后端网关的 HTTP 交互；
     2. chatStream() 以 fetch + ReadableStream 增量解析 SSE，逐 token 回调，
        并通过 AbortController 支持页面销毁时中断请求；
     3. 所有异常均在内部消化为 onError 回调，绝不向调用方抛未捕获异常。
   说明：本文件不包含任何密钥信息，鉴权由后端网关自行完成。
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL = global.YL || {};

  var API_BASE = 'http://localhost:8000';   // 可修改：后端地址
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
      name: toText(e.name, '该老人'),
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
      headers: { 'Content-Type': 'application/json' },
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
      return global.fetch(API_BASE + '/api/health', { method: 'GET' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  YL.api = {
    chatStream: chatStream,
    health: health
  };
})(window);